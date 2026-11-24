-- ASVA assessment customer bindings
-- Separate table from budget guard. All state transitions happen inside
-- the RPC function's transaction. No model code touches tables directly.
--
-- Design principles:
-- - provider + report_id UNIQUE: global report uniqueness (cross-customer conflict)
-- - snapshot JSONB: immutable full report (survives upstream revocation)
-- - status enum: ACTIVE / UNBOUND / REVOKED / TRANSFERRED
-- - audit trail via events table
-- - customer consent tracked separately
-- - no linkSecret or credentials stored

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
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, report_id)
);

CREATE INDEX IF NOT EXISTS asva_assessment_bindings_customer_idx
  ON public.asva_assessment_bindings (customer_id, status);
CREATE INDEX IF NOT EXISTS asva_assessment_bindings_completed_idx
  ON public.asva_assessment_bindings (assessment_id, completed_at DESC);

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
CREATE OR REPLACE FUNCTION public.asva_assessment_guard(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  action_name text := request->>'action';
  binding_row public.asva_assessment_bindings%ROWTYPE;
  binding_id text;
  requested_provider text;
  requested_report_id text;
  requested_customer_id text;
  requested_now timestamptz := COALESCE(NULLIF(request->>'now', '')::timestamptz, clock_timestamp());
  role_claims jsonb;
  role_name text;
  existing_customer_id text;
  existing_customer_name text;
  new_binding_id text;
BEGIN
  -- Role check (same pattern as budget guard)
  BEGIN
    role_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    role_claims := NULL;
  END;
  role_name := COALESCE(role_claims->>'role', '');
  IF current_user NOT IN ('service_role', 'cloudbase_authenticator')
     AND role_name NOT IN ('service_role', 'asva_api') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ASSESSMENT_RPC_ROLE_DENIED';
  END IF;

  IF action_name IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ASSESSMENT_ACTION_INVALID';
  END IF;

  -- ========== bind ==========
  IF action_name = 'bind' THEN
    requested_provider := NULLIF(request->>'provider', '');
    requested_report_id := NULLIF(request->>'reportId', '');
    requested_customer_id := NULLIF(request->>'customerId', '');
    IF requested_provider IS NULL OR requested_report_id IS NULL OR requested_customer_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'ASSESSMENT_BIND_INVALID', 'message', '绑定参数无效', 'status', 400));
    END IF;

    binding_id := NULLIF(request->>'bindingId', '');
    IF binding_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ASSESSMENT_BIND_ID_MISSING';
    END IF;

    -- Check for existing active binding (global uniqueness)
    SELECT * INTO binding_row
    FROM public.asva_assessment_bindings
    WHERE provider = requested_provider AND report_id = requested_report_id AND status = 'ACTIVE'
    FOR UPDATE;

    IF FOUND THEN
      IF binding_row.customer_id = requested_customer_id THEN
        -- Idempotent: same customer, return existing
        INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
        VALUES (binding_row.id, 'BOUND', COALESCE(request->>'boundBy', ''), jsonb_build_object('idempotent', true), requested_now);
        RETURN jsonb_build_object(
          'idempotent', true,
          'alreadyBound', true,
          'binding', jsonb_build_object(
            'id', binding_row.id,
            'provider', binding_row.provider,
            'reportId', binding_row.report_id,
            'assessmentId', binding_row.assessment_id,
            'assessmentName', binding_row.assessment_name,
            'customerId', binding_row.customer_id,
            'customerName', binding_row.customer_name,
            'reportNickname', binding_row.report_nickname,
            'completedAt', binding_row.completed_at,
            'boundAt', binding_row.bound_at,
            'boundBy', binding_row.bound_by,
            'status', binding_row.status,
            'snapshotHash', binding_row.snapshot_hash,
            'nameMismatch', binding_row.name_mismatch
          ));
      ELSE
        -- Cross-customer conflict
        RETURN jsonb_build_object('error', jsonb_build_object(
          'code', 'REPORT_ALREADY_BOUND',
          'message', '此报告已绑定到其他客户',
          'existingCustomerId', binding_row.customer_id,
          'existingCustomerName', binding_row.customer_name,
          'status', 409));
      END IF;
    END IF;

    -- Insert new binding
    INSERT INTO public.asva_assessment_bindings (
      id, provider, report_id, assessment_id, assessment_name, assessment_version, schema_version,
      customer_id, customer_name, report_nickname, completed_at, bound_at, bound_by, status,
      snapshot, snapshot_hash, preview,
      name_mismatch, name_confirmed_by, name_confirmed_at, name_confirmed_reason,
      customer_consent, customer_consent_at, customer_consent_record,
      created_at, updated_at
    ) VALUES (
      binding_id,
      requested_provider,
      requested_report_id,
      COALESCE(request->>'assessmentId', ''),
      COALESCE(request->>'assessmentName', ''),
      COALESCE(request->>'assessmentVersion', ''),
      COALESCE(request->>'schemaVersion', ''),
      requested_customer_id,
      COALESCE(request->>'customerName', ''),
      COALESCE(request->>'reportNickname', ''),
      NULLIF(request->>'completedAt', '')::timestamptz,
      requested_now,
      COALESCE(request->>'boundBy', ''),
      'ACTIVE',
      COALESCE(request->'snapshot', '{}'::jsonb),
      COALESCE(request->>'snapshotHash', ''),
      COALESCE(request->'preview', '{}'::jsonb),
      COALESCE((request->>'nameMismatch')::boolean, false),
      NULLIF(request->>'nameConfirmedBy', ''),
      NULLIF(request->>'nameConfirmedAt', '')::timestamptz,
      NULLIF(request->>'nameConfirmedReason', ''),
      COALESCE((request->>'customerConsent')::boolean, false),
      NULLIF(request->>'customerConsentAt', '')::timestamptz,
      NULLIF(request->>'customerConsentRecord', ''),
      requested_now,
      requested_now
    );

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (binding_id, 'BOUND', COALESCE(request->>'boundBy', ''),
      jsonb_build_object(
        'provider', requested_provider,
        'reportId', requested_report_id,
        'customerId', requested_customer_id,
        'nameMismatch', COALESCE((request->>'nameMismatch')::boolean, false)
      ), requested_now);

    RETURN jsonb_build_object(
      'idempotent', false,
      'alreadyBound', false,
      'binding', jsonb_build_object(
        'id', binding_id,
        'provider', requested_provider,
        'reportId', requested_report_id,
        'assessmentId', COALESCE(request->>'assessmentId', ''),
        'assessmentName', COALESCE(request->>'assessmentName', ''),
        'customerId', requested_customer_id,
        'customerName', COALESCE(request->>'customerName', ''),
        'reportNickname', COALESCE(request->>'reportNickname', ''),
        'completedAt', NULLIF(request->>'completedAt', '')::timestamptz,
        'boundAt', requested_now,
        'boundBy', COALESCE(request->>'boundBy', ''),
        'status', 'ACTIVE',
        'snapshotHash', COALESCE(request->>'snapshotHash', ''),
        'nameMismatch', COALESCE((request->>'nameMismatch')::boolean, false)
      ));

  -- ========== unbind ==========
  ELSIF action_name = 'unbind' THEN
    binding_id := NULLIF(request->>'bindingId', '');
    IF binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO binding_row
    FROM public.asva_assessment_bindings
    WHERE id = binding_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    IF binding_row.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '该绑定已不在活跃状态', 'status', 409));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET status = 'UNBOUND', updated_at = requested_now
    WHERE id = binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (binding_id, 'UNBOUND', COALESCE(request->>'actorId', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), requested_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', binding_id, 'status', 'UNBOUND');

  -- ========== transfer ==========
  ELSIF action_name = 'transfer' THEN
    binding_id := NULLIF(request->>'bindingId', '');
    requested_customer_id := NULLIF(request->>'targetCustomerId', '');
    IF binding_id IS NULL OR requested_customer_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'TRANSFER_INVALID', 'message', '转移参数无效', 'status', 400));
    END IF;

    SELECT * INTO binding_row
    FROM public.asva_assessment_bindings
    WHERE id = binding_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    IF binding_row.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '该绑定已不在活跃状态', 'status', 409));
    END IF;

    -- Check if target already has this report
    SELECT customer_id INTO existing_customer_id
    FROM public.asva_assessment_bindings
    WHERE provider = binding_row.provider AND report_id = binding_row.report_id
      AND customer_id = requested_customer_id AND status = 'ACTIVE';
    IF FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'TARGET_ALREADY_BOUND', 'message', '目标客户已绑定此报告', 'status', 409));
    END IF;

    -- Mark old binding as TRANSFERRED
    UPDATE public.asva_assessment_bindings
    SET status = 'TRANSFERRED', updated_at = requested_now
    WHERE id = binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (binding_id, 'TRANSFERRED_OUT', COALESCE(request->>'actorId', ''),
      jsonb_build_object(
        'fromCustomerId', binding_row.customer_id,
        'fromCustomerName', binding_row.customer_name,
        'toCustomerId', requested_customer_id,
        'toCustomerName', COALESCE(request->>'targetCustomerName', ''),
        'reason', COALESCE(request->>'reason', '')
      ), requested_now);

    -- Create new binding for target customer
    new_binding_id := NULLIF(request->>'newBindingId', '');
    IF new_binding_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ASSESSMENT_TRANSFER_ID_MISSING';
    END IF;

    INSERT INTO public.asva_assessment_bindings (
      id, provider, report_id, assessment_id, assessment_name, assessment_version, schema_version,
      customer_id, customer_name, report_nickname, completed_at, bound_at, bound_by, status,
      snapshot, snapshot_hash, preview,
      name_mismatch, customer_consent,
      created_at, updated_at
    ) VALUES (
      new_binding_id,
      binding_row.provider,
      binding_row.report_id,
      binding_row.assessment_id,
      binding_row.assessment_name,
      binding_row.assessment_version,
      binding_row.schema_version,
      requested_customer_id,
      COALESCE(request->>'targetCustomerName', ''),
      binding_row.report_nickname,
      binding_row.completed_at,
      requested_now,
      COALESCE(request->>'actorId', ''),
      'ACTIVE',
      binding_row.snapshot,
      binding_row.snapshot_hash,
      binding_row.preview,
      binding_row.name_mismatch,
      binding_row.customer_consent,
      requested_now,
      requested_now
    );

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (new_binding_id, 'TRANSFERRED_IN', COALESCE(request->>'actorId', ''),
      jsonb_build_object(
        'fromBindingId', binding_id,
        'fromCustomerId', binding_row.customer_id,
        'reason', COALESCE(request->>'reason', '')
      ), requested_now);

    RETURN jsonb_build_object(
      'ok', true,
      'oldBindingId', binding_id,
      'newBindingId', new_binding_id,
      'status', 'TRANSFERRED');

  -- ========== revoke_local ==========
  ELSIF action_name = 'revoke_local' THEN
    binding_id := NULLIF(request->>'bindingId', '');
    IF binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO binding_row FROM public.asva_assessment_bindings WHERE id = binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET local_revoked = true, local_revoked_at = requested_now,
        local_revoked_by = COALESCE(request->>'actorId', ''),
        local_revoke_reason = COALESCE(request->>'reason', ''),
        status = 'REVOKED',
        updated_at = requested_now
    WHERE id = binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (binding_id, 'REVOKED_LOCAL', COALESCE(request->>'actorId', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), requested_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', binding_id, 'status', 'REVOKED');

  -- ========== confirm_name ==========
  ELSIF action_name = 'confirm_name' THEN
    binding_id := NULLIF(request->>'bindingId', '');
    IF binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO binding_row FROM public.asva_assessment_bindings WHERE id = binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET name_mismatch = false,
        name_confirmed_by = COALESCE(request->>'confirmedBy', ''),
        name_confirmed_at = requested_now,
        name_confirmed_reason = COALESCE(request->>'reason', ''),
        updated_at = requested_now
    WHERE id = binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (binding_id, 'NAME_CONFIRMED', COALESCE(request->>'confirmedBy', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), requested_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', binding_id);

  -- ========== grant_consent ==========
  ELSIF action_name = 'grant_consent' THEN
    binding_id := NULLIF(request->>'bindingId', '');
    IF binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    SELECT * INTO binding_row FROM public.asva_assessment_bindings WHERE id = binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET customer_consent = true,
        customer_consent_at = requested_now,
        customer_consent_record = COALESCE(request->>'consentRecord', ''),
        updated_at = requested_now
    WHERE id = binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (binding_id, 'CONSENT_GRANTED', COALESCE(request->>'actorId', ''),
      jsonb_build_object('consentRecord', COALESCE(request->>'consentRecord', '')), requested_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', binding_id);

  -- ========== get ==========
  ELSIF action_name = 'get' THEN
    binding_id := NULLIF(request->>'bindingId', '');
    IF binding_id IS NOT NULL THEN
      SELECT * INTO binding_row FROM public.asva_assessment_bindings WHERE id = binding_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('binding', NULL::jsonb);
      END IF;
      RETURN jsonb_build_object('binding', jsonb_build_object(
        'id', binding_row.id,
        'provider', binding_row.provider,
        'reportId', binding_row.report_id,
        'assessmentId', binding_row.assessment_id,
        'assessmentName', binding_row.assessment_name,
        'assessmentVersion', binding_row.assessment_version,
        'schemaVersion', binding_row.schema_version,
        'customerId', binding_row.customer_id,
        'customerName', binding_row.customer_name,
        'reportNickname', binding_row.report_nickname,
        'completedAt', binding_row.completed_at,
        'boundAt', binding_row.bound_at,
        'boundBy', binding_row.bound_by,
        'status', binding_row.status,
        'snapshotHash', binding_row.snapshot_hash,
        'snapshot', binding_row.snapshot,
        'preview', binding_row.preview,
        'nameMismatch', binding_row.name_mismatch,
        'nameConfirmedBy', binding_row.name_confirmed_by,
        'nameConfirmedAt', binding_row.name_confirmed_at,
        'nameConfirmedReason', binding_row.name_confirmed_reason,
        'customerConsent', binding_row.customer_consent,
        'customerConsentAt', binding_row.customer_consent_at,
        'sourceRevoked', binding_row.source_revoked,
        'localRevoked', binding_row.local_revoked
      ));
    END IF;

    -- List by customer
    requested_customer_id := NULLIF(request->>'customerId', '');
    IF requested_customer_id IS NOT NULL THEN
      RETURN jsonb_build_object('bindings', COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
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
        ))
        FROM public.asva_assessment_bindings b
        WHERE b.customer_id = requested_customer_id AND b.status = 'ACTIVE'
        ORDER BY b.completed_at DESC NULLS LAST),
        '[]'::jsonb
      ));
    END IF;

    -- Find by provider + reportId
    requested_provider := NULLIF(request->>'provider', '');
    requested_report_id := NULLIF(request->>'reportId', '');
    IF requested_provider IS NOT NULL AND requested_report_id IS NOT NULL THEN
      SELECT * INTO binding_row
      FROM public.asva_assessment_bindings
      WHERE provider = requested_provider AND report_id = requested_report_id AND status = 'ACTIVE';
      IF NOT FOUND THEN
        RETURN jsonb_build_object('binding', NULL::jsonb);
      END IF;
      RETURN jsonb_build_object('binding', jsonb_build_object(
        'id', binding_row.id,
        'provider', binding_row.provider,
        'reportId', binding_row.report_id,
        'assessmentId', binding_row.assessment_id,
        'assessmentName', binding_row.assessment_name,
        'customerId', binding_row.customer_id,
        'customerName', binding_row.customer_name,
        'status', binding_row.status,
        'nameMismatch', binding_row.name_mismatch,
        'customerConsent', binding_row.customer_consent,
        'sourceRevoked', binding_row.source_revoked,
        'localRevoked', binding_row.local_revoked
      ));
    END IF;

    RETURN jsonb_build_object('error', jsonb_build_object(
      'code', 'ASSESSMENT_GET_INVALID', 'message', '查询参数无效', 'status', 400));

  -- ========== history ==========
  ELSIF action_name = 'history' THEN
    requested_customer_id := NULLIF(request->>'customerId', '');
    IF requested_customer_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'HISTORY_INVALID', 'message', '客户 ID 无效', 'status', 400));
    END IF;
    DECLARE
      requested_assessment_id text := NULLIF(request->>'assessmentId', '');
    BEGIN
      IF requested_assessment_id IS NOT NULL THEN
        RETURN jsonb_build_object('bindings', COALESCE(
          (SELECT jsonb_agg(jsonb_build_object(
            'id', b.id, 'provider', b.provider, 'reportId', b.report_id,
            'assessmentId', b.assessment_id, 'assessmentName', b.assessment_name,
            'reportNickname', b.report_nickname,
            'completedAt', b.completed_at, 'boundAt', b.bound_at,
            'status', b.status, 'preview', b.preview,
            'nameMismatch', b.name_mismatch, 'customerConsent', b.customer_consent
          ))
          FROM public.asva_assessment_bindings b
          WHERE b.customer_id = requested_customer_id
            AND b.assessment_id = requested_assessment_id
            AND b.status IN ('ACTIVE', 'TRANSFERRED', 'UNBOUND', 'REVOKED')
          ORDER BY b.completed_at DESC NULLS LAST),
          '[]'::jsonb
        ));
      ELSE
        RETURN jsonb_build_object('bindings', COALESCE(
          (SELECT jsonb_agg(jsonb_build_object(
            'id', b.id, 'provider', b.provider, 'reportId', b.report_id,
            'assessmentId', b.assessment_id, 'assessmentName', b.assessment_name,
            'reportNickname', b.report_nickname,
            'completedAt', b.completed_at, 'boundAt', b.bound_at,
            'status', b.status, 'preview', b.preview,
            'nameMismatch', b.name_mismatch, 'customerConsent', b.customer_consent
          ))
          FROM public.asva_assessment_bindings b
          WHERE b.customer_id = requested_customer_id
            AND b.status IN ('ACTIVE', 'TRANSFERRED', 'UNBOUND', 'REVOKED')
          ORDER BY b.completed_at DESC NULLS LAST),
          '[]'::jsonb
        ));
      END IF;
    END;

  -- ========== events ==========
  ELSIF action_name = 'events' THEN
    binding_id := NULLIF(request->>'bindingId', '');
    IF binding_id IS NULL THEN
      RETURN jsonb_build_object('events', '[]'::jsonb);
    END IF;
    RETURN jsonb_build_object('events', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'bindingId', e.binding_id, 'eventType', e.event_type,
        'actorId', e.actor_id, 'detail', e.detail, 'createdAt', e.created_at
      ))
      FROM public.asva_assessment_events e
      WHERE e.binding_id = binding_id
      ORDER BY e.created_at ASC),
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
-- Allow service_role to see sequences for events table
GRANT USAGE ON SEQUENCE asva_assessment_events_id_seq TO service_role;

COMMIT;
