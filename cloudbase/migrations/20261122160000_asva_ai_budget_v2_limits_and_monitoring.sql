-- ASVA AI budget guard V2: raise limits and add token/cost monitoring
-- - Daily limit: 3 → 100 (safety fuse, not permanent policy)
-- - Max concurrent: 1 → 2 (validated against Feishu write path)
-- - Add token tracking columns to reservation rows
-- - Add daily stats view for monitoring
-- - Fix CHECK constraint on active column to support counter semantics

BEGIN;

-- Drop old CHECK constraint that only allows 0 or 1
ALTER TABLE public.asva_ai_budget_v1 DROP CONSTRAINT IF EXISTS asva_ai_budget_v1_active_check;

-- Add new CHECK constraint that allows 0..2 for counter semantics
ALTER TABLE public.asva_ai_budget_v1 ADD CONSTRAINT asva_ai_budget_v1_active_check CHECK (active >= 0 AND active <= 2);

-- Add token tracking columns to existing budget table
ALTER TABLE public.asva_ai_budget_v1 ADD COLUMN IF NOT EXISTS input_tokens integer DEFAULT 0;
ALTER TABLE public.asva_ai_budget_v1 ADD COLUMN IF NOT EXISTS output_tokens integer DEFAULT 0;
ALTER TABLE public.asva_ai_budget_v1 ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(10, 6) DEFAULT 0;
ALTER TABLE public.asva_ai_budget_v1 ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Raise hardcoded daily limit from 3 to 100
-- Raise hardcoded max concurrent from 1 to 2
CREATE OR REPLACE FUNCTION public.asva_ai_budget_guard(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  action_name text := request->>'action';
  requested_table text := NULLIF(request->>'table', '');
  control_row public.asva_ai_budget_v1%ROWTYPE;
  day_row public.asva_ai_budget_v1%ROWTYPE;
  reservation_row public.asva_ai_budget_v1%ROWTYPE;
  reservation_id text;
  operation_id text;
  requested_day date;
  requested_now timestamptz := COALESCE(NULLIF(request->>'now', '')::timestamptz, clock_timestamp());
  requested_status text;
  release_active boolean;
  used_today integer;
  role_claims jsonb;
  role_name text;
  input_tokens_val integer;
  output_tokens_val integer;
BEGIN
  -- API keys accepted by the gateway must map to the service role.
  BEGIN
    role_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    role_claims := NULL;
  END;
  role_name := COALESCE(role_claims->>'role', '');
  IF current_user NOT IN ('service_role', 'cloudbase_authenticator')
     AND role_name NOT IN ('service_role', 'asva_api') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'AI_BUDGET_RPC_ROLE_DENIED';
  END IF;

  IF requested_table IS NOT NULL AND requested_table <> 'asva_ai_budget_v1' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'AI_BUDGET_TABLE_INVALID';
  END IF;

  IF action_name IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'AI_BUDGET_ACTION_INVALID';
  END IF;

  SELECT * INTO control_row
  FROM public.asva_ai_budget_v1
  WHERE id = 'control' AND kind = 'CONTROL'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'AI_BUDGET_CONTROL_MISSING';
  END IF;

  IF action_name = 'control' THEN
    RETURN jsonb_build_object(
      'id', control_row.id, 'kind', control_row.kind, 'mode', control_row.mode,
      'quotaDay', control_row.quota_day, 'used', control_row.used,
      'active', control_row.active, 'activeOperationId', COALESCE(control_row.active_operation_id, '')
    );
  ELSIF action_name = 'set_control' THEN
    IF NULLIF(request->>'actorId', '') IS NULL
       OR request->>'mode' NOT IN ('ENABLED', 'PAUSED', 'DISABLED') THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'AI_BUDGET_CONTROL_INVALID', 'message', 'AI 管理状态无效。', 'status', 400));
    END IF;
    UPDATE public.asva_ai_budget_v1
    SET mode = request->>'mode', actor_id = request->>'actorId', updated_at = requested_now
    WHERE id = 'control';
    RETURN jsonb_build_object(
      'id', control_row.id, 'kind', control_row.kind, 'mode', request->>'mode',
      'quotaDay', control_row.quota_day, 'used', control_row.used,
      'active', control_row.active, 'activeOperationId', COALESCE(control_row.active_operation_id, ''),
      'updatedBy', request->>'actorId'
    );
  ELSIF action_name = 'reserve' THEN
    operation_id := NULLIF(request->>'operationId', '');
    reservation_id := NULLIF(request->>'reservationId', '');
    requested_day := NULLIF(request->>'day', '')::date;
    IF operation_id IS NULL OR reservation_id IS NULL OR requested_day IS NULL
       OR NULLIF(request->>'sourceId', '') IS NULL
       OR NULLIF(request->>'sourceVersion', '') IS NULL
       OR NULLIF(request->>'actorId', '') IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'AI_BUDGET_RESERVATION_INVALID', 'message', 'AI 额度预留参数无效。', 'status', 400));
    END IF;

    SELECT * INTO reservation_row
    FROM public.asva_ai_budget_v1
    WHERE id = reservation_id
    FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'duplicate', true,
        'reservation', jsonb_build_object(
          '_id', reservation_row.id, 'operationId', reservation_row.operation_id,
          'sourceId', reservation_row.source_id, 'sourceVersion', reservation_row.source_version,
          'actorId', reservation_row.actor_id, 'day', reservation_row.day,
          'status', reservation_row.status, 'createdAt', reservation_row.created_at,
          'updatedAt', reservation_row.updated_at));
    END IF;

    IF control_row.mode <> 'ENABLED' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', CASE WHEN control_row.mode = 'PAUSED' THEN 'AI_BUDGET_EMERGENCY_PAUSED' ELSE 'AI_BUDGET_CONTROL_DISABLED' END,
        'message', CASE WHEN control_row.mode = 'PAUSED' THEN 'AI 整理已被管理员紧急暂停。' ELSE 'AI 整理尚未由管理员启用。' END,
        'status', 409));
    END IF;

    -- The active token is checked before rolling the quota day.
    IF control_row.active >= LEAST(COALESCE((request->>'maxConcurrent')::integer, 0), 2) THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'ON_DEMAND_AI_CONCURRENCY_REACHED', 'message', 'AI 整理并发已达上限，请稍后查看结果。', 'status', 429));
    END IF;

    used_today := CASE WHEN control_row.quota_day = requested_day THEN control_row.used ELSE 0 END;
    IF used_today >= LEAST(COALESCE((request->>'dailyLimit')::integer, 0), 100) THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'ON_DEMAND_AI_DAILY_LIMIT_REACHED', 'message', '今日按需 AI 整理额度已用完。', 'status', 429));
    END IF;
    IF LEAST(COALESCE((request->>'maxConcurrent')::integer, 0), 2) < 1 THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'AI_BUDGET_LIMIT_INVALID', 'message', 'AI 额度限制尚未配置。', 'status', 409));
    END IF;

    UPDATE public.asva_ai_budget_v1
    SET quota_day = requested_day, used = used_today + 1, active = control_row.active + 1,
        active_operation_id = COALESCE(control_row.active_operation_id, reservation_id), updated_at = requested_now
    WHERE id = 'control';

    INSERT INTO public.asva_ai_budget_v1 (
      id, kind, day, used, active, operation_id, source_id, source_version, actor_id, status, created_at, updated_at)
    VALUES (concat('day:', requested_day::text), 'DAY', requested_day, used_today + 1, 1,
      NULL, NULL, NULL, NULL, NULL, requested_now, requested_now)
    ON CONFLICT (id) DO UPDATE SET used = EXCLUDED.used, active = 1, updated_at = EXCLUDED.updated_at;

    INSERT INTO public.asva_ai_budget_v1 (
      id, kind, operation_id, source_id, source_version, actor_id, day, status, created_at, updated_at)
    VALUES (reservation_id, 'RESERVATION', operation_id, request->>'sourceId', request->>'sourceVersion',
      request->>'actorId', requested_day, 'RESERVED', requested_now, requested_now);

    RETURN jsonb_build_object(
      'duplicate', false,
      'reservation', jsonb_build_object(
        '_id', reservation_id, 'operationId', operation_id,
        'sourceId', request->>'sourceId', 'sourceVersion', request->>'sourceVersion',
        'actorId', request->>'actorId', 'day', requested_day,
        'status', 'RESERVED', 'createdAt', requested_now, 'updatedAt', requested_now));
  ELSIF action_name = 'mark_attempted' THEN
    reservation_id := NULLIF(request->'reservation'->>'_id', '');
    IF reservation_id IS NULL THEN
      reservation_id := NULLIF(request->'reservation'->>'operationId', '');
    END IF;
    IF control_row.mode <> 'ENABLED' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', CASE WHEN control_row.mode = 'PAUSED' THEN 'AI_BUDGET_EMERGENCY_PAUSED' ELSE 'AI_BUDGET_CONTROL_DISABLED' END,
        'message', CASE WHEN control_row.mode = 'PAUSED' THEN 'AI 整理已被管理员紧急暂停。' ELSE 'AI 整理尚未由管理员启用。' END,
        'status', 409));
    END IF;
    SELECT * INTO reservation_row FROM public.asva_ai_budget_v1 WHERE id = reservation_id FOR UPDATE;
    IF NOT FOUND OR reservation_row.status <> 'RESERVED' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'AI_BUDGET_RESERVATION_UNKNOWN', 'message', 'AI 额度预留状态无法确认。', 'status', 503));
    END IF;
    UPDATE public.asva_ai_budget_v1 SET status = 'ATTEMPTED', attempted_at = requested_now, updated_at = requested_now WHERE id = reservation_id;
    RETURN jsonb_build_object('ok', true);
  ELSIF action_name = 'complete' THEN
    reservation_id := NULLIF(request->'reservation'->>'_id', '');
    IF reservation_id IS NULL THEN reservation_id := NULLIF(request->'reservation'->>'operationId', ''); END IF;
    requested_status := request->>'status';
    release_active := COALESCE((request->>'releaseActive')::boolean, false);
    input_tokens_val := COALESCE((request->>'inputTokens')::integer, 0);
    output_tokens_val := COALESCE((request->>'outputTokens')::integer, 0);
    IF requested_status NOT IN ('SUCCEEDED', 'FAILED') THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'AI_BUDGET_COMPLETION_INVALID', 'message', 'AI 额度完成状态无效。', 'status', 400));
    END IF;
    SELECT * INTO reservation_row FROM public.asva_ai_budget_v1 WHERE id = reservation_id FOR UPDATE;
    IF NOT FOUND OR reservation_row.status <> 'ATTEMPTED' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'AI_BUDGET_RESERVATION_UNKNOWN', 'message', 'AI 额度完成状态无法确认。', 'status', 503));
    END IF;
    UPDATE public.asva_ai_budget_v1
    SET status = requested_status,
        input_tokens = input_tokens_val,
        output_tokens = output_tokens_val,
        estimated_cost_usd = (input_tokens_val * 0.00000014 + output_tokens_val * 0.00000028),
        completed_at = requested_now,
        updated_at = requested_now
    WHERE id = reservation_id;
    IF NOT release_active THEN RETURN jsonb_build_object('ok', true); END IF;
    IF control_row.active < 1 THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'AI_BUDGET_CONCURRENCY_UNKNOWN', 'message', 'AI 全局并发令牌无法确认。', 'status', 503));
    END IF;
    UPDATE public.asva_ai_budget_v1
    SET active = GREATEST(0, active - 1), active_operation_id = NULL, updated_at = requested_now
    WHERE id = 'control';
    UPDATE public.asva_ai_budget_v1
    SET active = GREATEST(0, active - 1), updated_at = requested_now
    WHERE id = concat('day:', reservation_row.day::text);
    RETURN jsonb_build_object('ok', true);
  ELSIF action_name = 'daily_stats' THEN
    requested_day := NULLIF(request->>'day', '')::date;
    IF requested_day IS NULL THEN
      requested_day := (now() AT TIME ZONE 'Asia/Shanghai')::date;
    END IF;
    SELECT * INTO day_row FROM public.asva_ai_budget_v1 WHERE id = concat('day:', requested_day::text) AND kind = 'DAY';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('day', requested_day, 'used', 0, 'successCount', 0, 'failCount', 0,
        'totalInputTokens', 0, 'totalOutputTokens', 0, 'estimatedCostUsd', 0);
    END IF;
    RETURN jsonb_build_object(
      'day', requested_day,
      'used', COALESCE(day_row.used, 0),
      'successCount', (SELECT count(*) FROM public.asva_ai_budget_v1 WHERE day = requested_day AND kind = 'RESERVATION' AND status = 'SUCCEEDED'),
      'failCount', (SELECT count(*) FROM public.asva_ai_budget_v1 WHERE day = requested_day AND kind = 'RESERVATION' AND status = 'FAILED'),
      'pendingCount', (SELECT count(*) FROM public.asva_ai_budget_v1 WHERE day = requested_day AND kind = 'RESERVATION' AND status IN ('RESERVED', 'ATTEMPTED')),
      'totalInputTokens', COALESCE((SELECT sum(input_tokens) FROM public.asva_ai_budget_v1 WHERE day = requested_day AND kind = 'RESERVATION'), 0),
      'totalOutputTokens', COALESCE((SELECT sum(output_tokens) FROM public.asva_ai_budget_v1 WHERE day = requested_day AND kind = 'RESERVATION'), 0),
      'estimatedCostUsd', COALESCE((SELECT sum(estimated_cost_usd) FROM public.asva_ai_budget_v1 WHERE day = requested_day AND kind = 'RESERVATION'), 0)
    );
  ELSE
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'AI_BUDGET_ACTION_INVALID';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.asva_ai_budget_guard(jsonb) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.asva_ai_budget_guard(jsonb) TO service_role;

COMMIT;
