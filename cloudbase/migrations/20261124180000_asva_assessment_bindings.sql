-- ASVA assessment customer bindings v2
-- Fixes: UNIQUE constraint handling for transfer/unbind/rebind
-- 
-- Key design: partial unique index on (provider, report_id) WHERE status = 'ACTIVE'
-- This allows:
-- - Only one ACTIVE binding per (provider, report_id) → global uniqueness
-- - Historical records (UNBOUND, TRANSFERRED, REVOKED) can coexist
-- - Transfer: mark old as TRANSFERRED, insert new as ACTIVE (no conflict)
-- - Unbind + rebind: mark as UNBOUND, insert new as ACTIVE (no conflict)

BEGIN;

-- Main bindings table
CREATE TABLE IF NOT EXISTS public.asva_assessment_bindings (
  id text PRIMARY KEY,
  provider text NOT NULL,
  report_id text NOT NULL,
  assessment_id text NOT NULL,
  assessment_name text NOT NULL DEFAULT '',
  assessment_version text NOT NULL DEFAULT '',
  schema_version text NOT NULL DEFAULT '',
  customer_id text NOT NULL,
  customer_name text NOT NULL DEFAULT '',
  report_nickname text NOT NULL DEFAULT '',
  completed_at timestamptz,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  bound_by text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'UNBOUND', 'REVOKED', 'TRANSFERRED')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_hash text NOT NULL DEFAULT '',
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  name_mismatch boolean NOT NULL DEFAULT false,
  name_confirmed_by text,
  name_confirmed_at timestamptz,
  name_confirmed_reason text,
  customer_consent boolean NOT NULL DEFAULT false,
  customer_consent_at timestamptz,
  customer_consent_record text,
  source_revoked boolean NOT NULL DEFAULT false,
  source_revoked_at timestamptz,
  local_revoked boolean NOT NULL DEFAULT false,
  local_revoked_at timestamptz,
  local_revoked_by text,
  local_revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Partial unique index: only one ACTIVE binding per (provider, report_id)
-- This is the key fix: historical records don't conflict with new bindings
CREATE UNIQUE INDEX IF NOT EXISTS asva_assessment_bindings_unique_active_idx
  ON public.asva_assessment_bindings (provider, report_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS asva_assessment_bindings_customer_idx
  ON public.asva_assessment_bindings (customer_id, status);

CREATE INDEX IF NOT EXISTS asva_assessment_bindings_completed_idx
  ON public.asva_assessment_bindings (assessment_id, completed_at DESC)
  WHERE status = 'ACTIVE';

-- Audit events table (append-only)
CREATE TABLE IF NOT EXISTS public.asva_assessment_events (
  id bigserial PRIMARY KEY,
  binding_id text NOT NULL,
  event_type text NOT NULL
    CHECK (event_type IN (
      'BOUND', 'UNBOUND', 'TRANSFERRED_OUT', 'TRANSFERRED_IN',
      'REVOKED_SOURCE', 'REVOKED_LOCAL', 'NAME_CONFIRMED',
      'CONSENT_GRANTED', 'CONSENT_REVOKED'
    )),
  actor_id text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS asva_assessment_events_binding_idx
  ON public.asva_assessment_events (binding_id, created_at);

-- Create CloudBase-specific roles if they don't exist (for local testing compatibility)
-- In production CloudBase, these roles already exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

-- Row-level security: block direct access; all operations go through RPC
REVOKE ALL ON TABLE public.asva_assessment_bindings FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.asva_assessment_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asva_assessment_bindings_service_policy ON public.asva_assessment_bindings;
CREATE POLICY asva_assessment_bindings_service_policy
  ON public.asva_assessment_bindings
  FOR ALL TO service_role
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.asva_assessment_events FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.asva_assessment_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asva_assessment_events_service_policy ON public.asva_assessment_events;
CREATE POLICY asva_assessment_events_service_policy
  ON public.asva_assessment_events
  FOR ALL TO service_role
  USING (false)
  WITH CHECK (false);

-- RPC function for all state transitions (transactional)
-- Variable names prefixed with p_ to avoid conflicts with column names
CREATE OR REPLACE FUNCTION public.asva_assessment_guard(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  p_action text := request->>'action';
  v_binding public.asva_assessment_bindings%ROWTYPE;
  p_binding_id text;
  p_provider text;
  p_report_id text;
  p_customer_id text;
  p_now timestamptz := COALESCE(NULLIF(request->>'now', '')::timestamptz, clock_timestamp());
  v_role_claims jsonb;
  v_role_name text;
  v_existing_customer_id text;
  v_existing_customer_name text;
  p_new_binding_id text;
  p_snapshot_hash text;
  v_existing_hash text;
BEGIN
  -- Role check: verify the SESSION user (actual login) or JWT claims
  -- With SECURITY DEFINER, current_user is the function owner, so we check session_user
  BEGIN
    v_role_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_role_claims := NULL;
  END;
  v_role_name := COALESCE(v_role_claims->>'role', '');
  -- Allow: service_role (CloudBase), cloudbase_authenticator, session owner (local dev), or JWT with service_role/asva_api
  IF session_user NOT IN ('service_role', 'cloudbase_authenticator')
     AND v_role_name NOT IN ('service_role', 'asva_api')
     AND session_user <> current_user THEN
    -- current_user is the function owner (SECURITY DEFINER). 
    -- Only allow if session_user is the same (function calling itself) or is an authorized role
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ASSESSMENT_RPC_ROLE_DENIED';
  END IF;

  IF p_action IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ASSESSMENT_ACTION_INVALID';
  END IF;

  -- ========== bind ==========
  IF p_action = 'bind' THEN
    p_provider := NULLIF(request->>'provider', '');
    p_report_id := NULLIF(request->>'reportId', '');
    p_customer_id := NULLIF(request->>'customerId', '');
    IF p_provider IS NULL OR p_report_id IS NULL OR p_customer_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'ASSESSMENT_BIND_INVALID', 'message', '绑定参数无效', 'status', 400));
    END IF;

    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ASSESSMENT_BIND_ID_MISSING';
    END IF;

    p_snapshot_hash := NULLIF(request->>'snapshotHash', '');

    -- Check for existing ACTIVE binding (global uniqueness via partial unique index)
    SELECT * INTO v_binding
    FROM public.asva_assessment_bindings
    WHERE provider = p_provider AND report_id = p_report_id AND status = 'ACTIVE'
    FOR UPDATE;

    IF FOUND THEN
      -- Existing ACTIVE binding found
      IF v_binding.customer_id = p_customer_id THEN
        -- Same customer: check if snapshot changed (content integrity)
        IF p_snapshot_hash IS NOT NULL AND v_binding.snapshot_hash <> p_snapshot_hash THEN
          -- Snapshot changed — this should not happen for the same report
          RETURN jsonb_build_object('error', jsonb_build_object(
            'code', 'REPORT_CONTENT_CHANGED',
            'message', '报告内容已变化，可能存在篡改或源数据更新',
            'status', 409));
        END IF;
        -- Idempotent: same customer, same content
        INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
        VALUES (v_binding.id, 'BOUND', COALESCE(request->>'boundBy', ''), jsonb_build_object('idempotent', true), p_now);
        RETURN jsonb_build_object(
          'idempotent', true,
          'alreadyBound', true,
          'binding', jsonb_build_object(
            'id', v_binding.id,
            'provider', v_binding.provider,
            'reportId', v_binding.report_id,
            'assessmentId', v_binding.assessment_id,
            'assessmentName', v_binding.assessment_name,
            'customerId', v_binding.customer_id,
            'customerName', v_binding.customer_name,
            'reportNickname', v_binding.report_nickname,
            'completedAt', v_binding.completed_at,
            'boundAt', v_binding.bound_at,
            'boundBy', v_binding.bound_by,
            'status', v_binding.status,
            'snapshotHash', v_binding.snapshot_hash,
            'nameMismatch', v_binding.name_mismatch,
            'customerConsent', v_binding.customer_consent
          ));
      ELSE
        -- Cross-customer conflict
        RETURN jsonb_build_object('error', jsonb_build_object(
          'code', 'REPORT_ALREADY_BOUND',
          'message', '此报告已绑定到其他客户',
          'existingCustomerId', v_binding.customer_id,
          'existingCustomerName', v_binding.customer_name,
          'status', 409));
      END IF;
    END IF;

    -- No existing ACTIVE binding: insert new
    INSERT INTO public.asva_assessment_bindings (
      id, provider, report_id, assessment_id, assessment_name, assessment_version, schema_version,
      customer_id, customer_name, report_nickname, completed_at, bound_at, bound_by, status,
      snapshot, snapshot_hash, preview,
      name_mismatch, name_confirmed_by, name_confirmed_at, name_confirmed_reason,
      customer_consent, customer_consent_at, customer_consent_record,
      created_at, updated_at
    ) VALUES (
      p_binding_id,
      p_provider,
      p_report_id,
      COALESCE(request->>'assessmentId', ''),
      COALESCE(request->>'assessmentName', ''),
      COALESCE(request->>'assessmentVersion', ''),
      COALESCE(request->>'schemaVersion', ''),
      p_customer_id,
      COALESCE(request->>'customerName', ''),
      COALESCE(request->>'reportNickname', ''),
      NULLIF(request->>'completedAt', '')::timestamptz,
      p_now,
      COALESCE(request->>'boundBy', ''),
      'ACTIVE',
      COALESCE(request->'snapshot', '{}'::jsonb),
      p_snapshot_hash,
      COALESCE(request->'preview', '{}'::jsonb),
      COALESCE((request->>'nameMismatch')::boolean, false),
      NULLIF(request->>'nameConfirmedBy', ''),
      NULLIF(request->>'nameConfirmedAt', '')::timestamptz,
      NULLIF(request->>'nameConfirmedReason', ''),
      COALESCE((request->>'customerConsent')::boolean, false),
      NULLIF(request->>'customerConsentAt', '')::timestamptz,
      NULLIF(request->>'customerConsentRecord', ''),
      p_now,
      p_now
    );

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'BOUND', COALESCE(request->>'boundBy', ''),
      jsonb_build_object(
        'provider', p_provider,
        'reportId', p_report_id,
        'customerId', p_customer_id,
        'nameMismatch', COALESCE((request->>'nameMismatch')::boolean, false)
      ), p_now);

    RETURN jsonb_build_object(
      'idempotent', false,
      'alreadyBound', false,
      'binding', jsonb_build_object(
        'id', p_binding_id,
        'provider', p_provider,
        'reportId', p_report_id,
        'assessmentId', COALESCE(request->>'assessmentId', ''),
        'assessmentName', COALESCE(request->>'assessmentName', ''),
        'customerId', p_customer_id,
        'customerName', COALESCE(request->>'customerName', ''),
        'reportNickname', COALESCE(request->>'reportNickname', ''),
        'completedAt', NULLIF(request->>'completedAt', '')::timestamptz,
        'boundAt', p_now,
        'boundBy', COALESCE(request->>'boundBy', ''),
        'status', 'ACTIVE',
        'snapshotHash', p_snapshot_hash,
        'nameMismatch', COALESCE((request->>'nameMismatch')::boolean, false),
        'customerConsent', COALESCE((request->>'customerConsent')::boolean, false)
      ));

  -- ========== unbind ==========
  ELSIF p_action = 'unbind' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO v_binding
    FROM public.asva_assessment_bindings
    WHERE id = p_binding_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    IF v_binding.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '该绑定已不在活跃状态', 'status', 409));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET status = 'UNBOUND', updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'UNBOUND', COALESCE(request->>'actorId', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), p_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id, 'status', 'UNBOUND');

  -- ========== transfer ==========
  ELSIF p_action = 'transfer' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    p_customer_id := NULLIF(request->>'targetCustomerId', '');
    IF p_binding_id IS NULL OR p_customer_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'TRANSFER_INVALID', 'message', '转移参数无效', 'status', 400));
    END IF;

    SELECT * INTO v_binding
    FROM public.asva_assessment_bindings
    WHERE id = p_binding_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    IF v_binding.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '该绑定已不在活跃状态', 'status', 409));
    END IF;

    -- Mark old binding as TRANSFERRED (releases the unique index slot)
    UPDATE public.asva_assessment_bindings
    SET status = 'TRANSFERRED', updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'TRANSFERRED_OUT', COALESCE(request->>'actorId', ''),
      jsonb_build_object(
        'fromCustomerId', v_binding.customer_id,
        'fromCustomerName', v_binding.customer_name,
        'toCustomerId', p_customer_id,
        'toCustomerName', COALESCE(request->>'targetCustomerName', ''),
        'reason', COALESCE(request->>'reason', '')
      ), p_now);

    -- Create new binding for target customer (now safe due to partial unique index)
    -- IMPORTANT: consent is NOT inherited — target customer must re-confirm
    p_new_binding_id := NULLIF(request->>'newBindingId', '');
    IF p_new_binding_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ASSESSMENT_TRANSFER_ID_MISSING';
    END IF;

    INSERT INTO public.asva_assessment_bindings (
      id, provider, report_id, assessment_id, assessment_name, assessment_version, schema_version,
      customer_id, customer_name, report_nickname, completed_at, bound_at, bound_by, status,
      snapshot, snapshot_hash, preview,
      name_mismatch, customer_consent,  -- consent reset to false
      created_at, updated_at
    ) VALUES (
      p_new_binding_id,
      v_binding.provider,
      v_binding.report_id,
      v_binding.assessment_id,
      v_binding.assessment_name,
      v_binding.assessment_version,
      v_binding.schema_version,
      p_customer_id,
      COALESCE(request->>'targetCustomerName', ''),
      v_binding.report_nickname,
      v_binding.completed_at,
      p_now,
      COALESCE(request->>'actorId', ''),
      'ACTIVE',
      v_binding.snapshot,
      v_binding.snapshot_hash,
      v_binding.preview,
      v_binding.name_mismatch,
      false,  -- consent NOT inherited
      p_now,
      p_now
    );

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_new_binding_id, 'TRANSFERRED_IN', COALESCE(request->>'actorId', ''),
      jsonb_build_object(
        'fromBindingId', p_binding_id,
        'fromCustomerId', v_binding.customer_id,
        'reason', COALESCE(request->>'reason', '')
      ), p_now);

    RETURN jsonb_build_object(
      'ok', true,
      'oldBindingId', p_binding_id,
      'newBindingId', p_new_binding_id,
      'status', 'TRANSFERRED');

  -- ========== revoke_local ==========
  ELSIF p_action = 'revoke_local' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET local_revoked = true, local_revoked_at = p_now,
        local_revoked_by = COALESCE(request->>'actorId', ''),
        local_revoke_reason = COALESCE(request->>'reason', ''),
        status = 'REVOKED',
        updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'REVOKED_LOCAL', COALESCE(request->>'actorId', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), p_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id, 'status', 'REVOKED');

  -- ========== confirm_name ==========
  ELSIF p_action = 'confirm_name' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET name_mismatch = false,
        name_confirmed_by = COALESCE(request->>'confirmedBy', ''),
        name_confirmed_at = p_now,
        name_confirmed_reason = COALESCE(request->>'reason', ''),
        updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'NAME_CONFIRMED', COALESCE(request->>'confirmedBy', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), p_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id);

  -- ========== grant_consent ==========
  ELSIF p_action = 'grant_consent' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET customer_consent = true,
        customer_consent_at = p_now,
        customer_consent_record = COALESCE(request->>'consentRecord', ''),
        updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'CONSENT_GRANTED', COALESCE(request->>'actorId', ''),
      jsonb_build_object('consentRecord', COALESCE(request->>'consentRecord', '')), p_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id);

  -- ========== revoke_consent ==========
  ELSIF p_action = 'revoke_consent' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET customer_consent = false,
        customer_consent_at = NULL,
        customer_consent_record = NULL,
        updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'CONSENT_REVOKED', COALESCE(request->>'actorId', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), p_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id);

  -- ========== get ==========
  ELSIF p_action = 'get' THEN
    IF NULLIF(request->>'bindingId', '') IS NOT NULL THEN
      SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = request->>'bindingId';
      IF NOT FOUND THEN
        RETURN jsonb_build_object('binding', NULL::jsonb);
      END IF;
      RETURN jsonb_build_object('binding', jsonb_build_object(
        'id', v_binding.id,
        'provider', v_binding.provider,
        'reportId', v_binding.report_id,
        'assessmentId', v_binding.assessment_id,
        'assessmentName', v_binding.assessment_name,
        'assessmentVersion', v_binding.assessment_version,
        'schemaVersion', v_binding.schema_version,
        'customerId', v_binding.customer_id,
        'customerName', v_binding.customer_name,
        'reportNickname', v_binding.report_nickname,
        'completedAt', v_binding.completed_at,
        'boundAt', v_binding.bound_at,
        'boundBy', v_binding.bound_by,
        'status', v_binding.status,
        'snapshotHash', v_binding.snapshot_hash,
        'snapshot', v_binding.snapshot,
        'preview', v_binding.preview,
        'nameMismatch', v_binding.name_mismatch,
        'nameConfirmedBy', v_binding.name_confirmed_by,
        'nameConfirmedAt', v_binding.name_confirmed_at,
        'nameConfirmedReason', v_binding.name_confirmed_reason,
        'customerConsent', v_binding.customer_consent,
        'customerConsentAt', v_binding.customer_consent_at,
        'sourceRevoked', v_binding.source_revoked,
        'localRevoked', v_binding.local_revoked
      ));
    END IF;

    -- List by customer (only ACTIVE)
    IF NULLIF(request->>'customerId', '') IS NOT NULL THEN
      RETURN jsonb_build_object('bindings', COALESCE(
        (SELECT jsonb_agg(sub ORDER BY sub->>'completedAt' DESC NULLS LAST)
         FROM (
           SELECT jsonb_build_object(
             'id', b.id, 'provider', b.provider, 'reportId', b.report_id,
             'assessmentId', b.assessment_id, 'assessmentName', b.assessment_name,
             'assessmentVersion', b.assessment_version,
             'customerId', b.customer_id, 'customerName', b.customer_name,
             'reportNickname', b.report_nickname,
             'completedAt', b.completed_at, 'boundAt', b.bound_at, 'boundBy', b.bound_by,
             'status', b.status, 'snapshotHash', b.snapshot_hash,
             'preview', b.preview,
             'nameMismatch', b.name_mismatch,
             'customerConsent', b.customer_consent,
             'sourceRevoked', b.source_revoked,
             'localRevoked', b.local_revoked
           ) AS sub
           FROM public.asva_assessment_bindings b
           WHERE b.customer_id = request->>'customerId' AND b.status = 'ACTIVE'
         ) sub),
        '[]'::jsonb
      ));
    END IF;

    -- Find by provider + reportId (only ACTIVE)
    IF NULLIF(request->>'provider', '') IS NOT NULL AND NULLIF(request->>'reportId', '') IS NOT NULL THEN
      SELECT * INTO v_binding
      FROM public.asva_assessment_bindings
      WHERE provider = request->>'provider' AND report_id = request->>'reportId' AND status = 'ACTIVE';
      IF NOT FOUND THEN
        RETURN jsonb_build_object('binding', NULL::jsonb);
      END IF;
      RETURN jsonb_build_object('binding', jsonb_build_object(
        'id', v_binding.id,
        'provider', v_binding.provider,
        'reportId', v_binding.report_id,
        'assessmentId', v_binding.assessment_id,
        'assessmentName', v_binding.assessment_name,
        'customerId', v_binding.customer_id,
        'customerName', v_binding.customer_name,
        'status', v_binding.status,
        'nameMismatch', v_binding.name_mismatch,
        'customerConsent', v_binding.customer_consent,
        'sourceRevoked', v_binding.source_revoked,
        'localRevoked', v_binding.local_revoked
      ));
    END IF;

    RETURN jsonb_build_object('error', jsonb_build_object(
      'code', 'ASSESSMENT_GET_INVALID', 'message', '查询参数无效', 'status', 400));

  -- ========== history (includes all statuses) ==========
  ELSIF p_action = 'history' THEN
    IF NULLIF(request->>'customerId', '') IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'HISTORY_INVALID', 'message', '客户 ID 无效', 'status', 400));
    END IF;
    DECLARE
      p_assessment_id text := NULLIF(request->>'assessmentId', '');
    BEGIN
      IF p_assessment_id IS NOT NULL THEN
        RETURN jsonb_build_object('bindings', COALESCE(
          (SELECT jsonb_agg(sub ORDER BY sub->>'completedAt' DESC NULLS LAST)
           FROM (
             SELECT jsonb_build_object(
               'id', b.id, 'provider', b.provider, 'reportId', b.report_id,
               'assessmentId', b.assessment_id, 'assessmentName', b.assessment_name,
               'reportNickname', b.report_nickname,
               'completedAt', b.completed_at, 'boundAt', b.bound_at,
               'status', b.status, 'preview', b.preview,
               'nameMismatch', b.name_mismatch, 'customerConsent', b.customer_consent
             ) AS sub
             FROM public.asva_assessment_bindings b
             WHERE b.customer_id = request->>'customerId'
               AND b.assessment_id = p_assessment_id
               AND b.status IN ('ACTIVE', 'TRANSFERRED', 'UNBOUND', 'REVOKED')
           ) sub),
          '[]'::jsonb
        ));
      ELSE
        RETURN jsonb_build_object('bindings', COALESCE(
          (SELECT jsonb_agg(sub ORDER BY sub->>'completedAt' DESC NULLS LAST)
           FROM (
             SELECT jsonb_build_object(
               'id', b.id, 'provider', b.provider, 'reportId', b.report_id,
               'assessmentId', b.assessment_id, 'assessmentName', b.assessment_name,
               'reportNickname', b.report_nickname,
               'completedAt', b.completed_at, 'boundAt', b.bound_at,
               'status', b.status, 'preview', b.preview,
               'nameMismatch', b.name_mismatch, 'customerConsent', b.customer_consent
             ) AS sub
             FROM public.asva_assessment_bindings b
             WHERE b.customer_id = request->>'customerId'
               AND b.status IN ('ACTIVE', 'TRANSFERRED', 'UNBOUND', 'REVOKED')
           ) sub),
          '[]'::jsonb
        ));
      END IF;
    END;

  -- ========== events ==========
  ELSIF p_action = 'events' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('events', '[]'::jsonb);
    END IF;
    RETURN jsonb_build_object('events', COALESCE(
      (SELECT jsonb_agg(sub ORDER BY sub->>'createdAt' ASC)
       FROM (
         SELECT jsonb_build_object(
           'id', e.id, 'bindingId', e.binding_id, 'eventType', e.event_type,
           'actorId', e.actor_id, 'detail', e.detail, 'createdAt', e.created_at
         ) AS sub
         FROM public.asva_assessment_events e
         WHERE e.binding_id = p_binding_id
       ) sub),
      '[]'::jsonb
    ));

  ELSE
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ASSESSMENT_ACTION_INVALID';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.asva_assessment_guard(jsonb) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.asva_assessment_guard(jsonb) TO service_role;
GRANT USAGE ON SEQUENCE asva_assessment_events_id_seq TO service_role;

COMMIT;
