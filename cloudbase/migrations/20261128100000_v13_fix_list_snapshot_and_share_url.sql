-- V1.3: Fix list RPC to include snapshot and hasEncryptedShareUrl
-- Previously the list-by-customer query omitted these fields, breaking:
-- - Server-side preview enrichment from stored snapshots
-- - Frontend button logic (查看原报告 vs 补充原报告链接)
--
-- The snapshot stays server-side only (stripped before sending to frontend).
-- hasEncryptedShareUrl is a boolean flag (never the encrypted URL itself).

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
  v_encryption_key text;
  v_share_url text;
BEGIN
  -- Role check (preserved from v41)
  BEGIN
    v_role_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_role_claims := NULL;
  END;
  v_role_name := COALESCE(v_role_claims->>'role', '');
  IF session_user NOT IN ('service_role', 'cloudbase_authenticator')
     AND v_role_name NOT IN ('service_role', 'asva_api')
     AND session_user <> current_user THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ASSESSMENT_RPC_ROLE_DENIED';
  END IF;

  IF p_action IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ASSESSMENT_ACTION_INVALID';
  END IF;

  -- Read encryption key from asva_config table
  SELECT value INTO v_encryption_key FROM public.asva_config WHERE key = 'encryption_key';

  -- ========== bind (extended with encrypted_share_url) ==========
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

    SELECT * INTO v_binding
    FROM public.asva_assessment_bindings
    WHERE provider = p_provider AND report_id = p_report_id AND status = 'ACTIVE'
    FOR UPDATE;

    IF FOUND THEN
      IF v_binding.customer_id = p_customer_id THEN
        IF p_snapshot_hash IS NOT NULL AND v_binding.snapshot_hash <> p_snapshot_hash THEN
          RETURN jsonb_build_object('error', jsonb_build_object(
            'code', 'REPORT_CONTENT_CHANGED',
            'message', '报告内容已发生变化，可能存在篡改或源数据更新',
            'status', 409));
        END IF;
        -- Idempotent: same customer, same content
        IF NULLIF(request->>'encryptedShareUrl', '') IS NOT NULL
           AND (v_binding.encrypted_share_url IS NULL OR length(v_binding.encrypted_share_url) = 0) THEN
          IF v_encryption_key IS NULL THEN
            RETURN jsonb_build_object('error', jsonb_build_object(
              'code', 'ENCRYPTION_KEY_MISSING',
              'message', '加密密钥未配置，无法保存分享链接',
              'status', 500));
          END IF;
          UPDATE public.asva_assessment_bindings
          SET encrypted_share_url = pgp_sym_encrypt(request->>'encryptedShareUrl', v_encryption_key),
              updated_at = p_now
          WHERE id = v_binding.id;
        END IF;
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
        RETURN jsonb_build_object('error', jsonb_build_object(
          'code', 'REPORT_ALREADY_BOUND',
          'message', '此报告已绑定到其他客户',
          'existingCustomerId', v_binding.customer_id,
          'existingCustomerName', v_binding.customer_name,
          'status', 409));
      END IF;
    END IF;

    -- Insert new binding with encrypted share URL
    IF NULLIF(request->>'encryptedShareUrl', '') IS NOT NULL AND v_encryption_key IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'ENCRYPTION_KEY_MISSING',
        'message', '加密密钥未配置，无法保存分享链接',
        'status', 500));
    END IF;

    INSERT INTO public.asva_assessment_bindings (
      id, provider, report_id, assessment_id, assessment_name, assessment_version, schema_version,
      customer_id, customer_name, report_nickname, completed_at, bound_at, bound_by, status,
      snapshot, snapshot_hash, preview,
      name_mismatch, name_confirmed_by, name_confirmed_at, name_confirmed_reason,
      archive_confirmed_by, archive_confirmed_at,
      customer_consent, customer_consent_at, customer_consent_record,
      encrypted_share_url,
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
      COALESCE(request->>'archiveConfirmedBy', COALESCE(request->>'boundBy', '')),
      p_now,
      COALESCE((request->>'customerConsent')::boolean, false),
      NULLIF(request->>'customerConsentAt', '')::timestamptz,
      NULLIF(request->>'customerConsentRecord', ''),
      CASE
        WHEN NULLIF(request->>'encryptedShareUrl', '') IS NOT NULL AND v_encryption_key IS NOT NULL
        THEN pgp_sym_encrypt(request->>'encryptedShareUrl', v_encryption_key)
        ELSE NULL
      END,
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
        'nameMismatch', COALESCE((request->>'nameMismatch')::boolean, false)
      ));
  END IF;

  -- ========== unbind ==========
  ELSIF p_action = 'unbind' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'UNBIND_INVALID', 'message', '绑定 ID 无效', 'status', 400));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;
    IF v_binding.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '绑定已不在活跃状态', 'status', 409));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET status = 'UNBOUND', updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'UNBOUND', COALESCE(request->>'actorId', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), p_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id, 'status', 'UNBOUND');
  END IF;

  -- ========== transfer ==========
  ELSIF p_action = 'transfer' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    p_customer_id := NULLIF(request->>'targetCustomerId', '');
    IF p_binding_id IS NULL OR p_customer_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'TRANSFER_INVALID', 'message', '转移参数无效', 'status', 400));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;
    IF v_binding.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '绑定已不在活跃状态', 'status', 409));
    END IF;

    v_existing_customer_id := v_binding.customer_id;
    v_existing_customer_name := v_binding.customer_name;

    UPDATE public.asva_assessment_bindings
    SET customer_id = p_customer_id,
        customer_name = COALESCE(request->>'targetCustomerName', v_binding.customer_name),
        updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'TRANSFERRED', COALESCE(request->>'actorId', ''),
      jsonb_build_object(
        'fromCustomerId', v_existing_customer_id,
        'fromCustomerName', v_existing_customer_name,
        'toCustomerId', p_customer_id,
        'reason', COALESCE(request->>'reason', '')
      ), p_now);

    RETURN jsonb_build_object(
      'ok', true,
      'bindingId', p_binding_id,
      'fromCustomerId', v_existing_customer_id,
      'toCustomerId', p_customer_id);
  END IF;

  -- ========== revoke_local ==========
  ELSIF p_action = 'revoke_local' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'REVOKE_INVALID', 'message', '绑定 ID 无效', 'status', 400));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;
    IF v_binding.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '绑定已不在活跃状态', 'status', 409));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET local_revoked = true, updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'LOCAL_REVOKED', COALESCE(request->>'actorId', ''),
      jsonb_build_object('reason', COALESCE(request->>'reason', '')), p_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id, 'localRevoked', true);
  END IF;

  -- ========== confirm_name ==========
  ELSIF p_action = 'confirm_name' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'CONFIRM_NAME_INVALID', 'message', '绑定 ID 无效', 'status', 400));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET name_confirmed_by = COALESCE(request->>'confirmedBy', ''),
        name_confirmed_at = p_now,
        name_confirmed_reason = COALESCE(request->>'reason', ''),
        updated_at = p_now
    WHERE id = p_binding_id;

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id);
  END IF;

  -- ========== grant_consent ==========
  ELSIF p_action = 'grant_consent' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'CONSENT_INVALID', 'message', '绑定 ID 无效', 'status', 400));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET customer_consent = true,
        customer_consent_at = p_now,
        customer_consent_record = COALESCE(request->>'consentRecord', ''),
        updated_at = p_now
    WHERE id = p_binding_id;

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id, 'consentGranted', true);
  END IF;

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
        'archiveConfirmedBy', v_binding.archive_confirmed_by,
        'archiveConfirmedAt', v_binding.archive_confirmed_at,
        'customerConsent', v_binding.customer_consent,
        'customerConsentAt', v_binding.customer_consent_at,
        'sourceRevoked', v_binding.source_revoked,
        'localRevoked', v_binding.local_revoked,
        'hasEncryptedShareUrl', v_binding.encrypted_share_url IS NOT NULL AND length(v_binding.encrypted_share_url) > 0
      ));
    END IF;

    -- V1.3 fix: List by customer now includes snapshot and hasEncryptedShareUrl.
    -- snapshot is used server-side for preview enrichment, then stripped before sending to frontend.
    -- hasEncryptedShareUrl is a boolean flag for frontend button logic.
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
             'snapshot', b.snapshot,
             'preview', b.preview,
             'nameMismatch', b.name_mismatch,
             'customerConsent', b.customer_consent,
             'sourceRevoked', b.source_revoked,
             'localRevoked', b.local_revoked,
             'hasEncryptedShareUrl', b.encrypted_share_url IS NOT NULL AND length(b.encrypted_share_url) > 0
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
               AND b.status IN ('ACTIVE', 'TRANSFERRED', 'UNBOUND', 'REVOKED', 'SUPERSEDED')
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
               AND b.status IN ('ACTIVE', 'TRANSFERRED', 'UNBOUND', 'REVOKED', 'SUPERSEDED')
           ) sub),
          '[]'::jsonb
        ));
      END IF;
    END;

  -- ========== events ==========
  ELSIF p_action = 'events' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'EVENTS_INVALID', 'message', '绑定 ID 无效', 'status', 400));
    END IF;
    RETURN jsonb_build_object('events', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'bindingId', e.binding_id, 'eventType', e.event_type,
        'actorId', e.actor_id, 'detail', e.detail, 'createdAt', e.created_at
      ) ORDER BY e.created_at DESC)
      FROM public.asva_assessment_events e
      WHERE e.binding_id = p_binding_id),
      '[]'::jsonb
    ));

  -- ========== get_share_url ==========
  ELSIF p_action = 'get_share_url' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    IF p_binding_id IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'GET_SHARE_URL_INVALID', 'message', '绑定 ID 无效', 'status', 400));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;
    IF v_binding.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '绑定已不在活跃状态', 'status', 403));
    END IF;

    IF v_binding.encrypted_share_url IS NULL OR length(v_binding.encrypted_share_url) = 0 THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'SHARE_URL_NOT_FOUND', 'message', '此报告未保存原始链接', 'status', 404));
    END IF;

    IF v_encryption_key IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'ENCRYPTION_KEY_MISSING', 'message', '加密密钥未配置', 'status', 500));
    END IF;

    BEGIN
      SELECT convert_from(
        pgp_sym_decrypt(v_binding.encrypted_share_url::bytea, v_encryption_key),
        'UTF8'
      ) INTO v_share_url;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'DECRYPTION_FAILED', 'message', '链接解密失败', 'status', 500));
    END;

    RETURN jsonb_build_object('shareUrl', v_share_url, 'bindingId', p_binding_id);

  -- ========== supplement_share_url ==========
  ELSIF p_action = 'supplement_share_url' THEN
    p_binding_id := NULLIF(request->>'bindingId', '');
    v_share_url := NULLIF(request->>'shareUrl', '');
    IF p_binding_id IS NULL OR v_share_url IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'SUPPLEMENT_SHARE_URL_INVALID', 'message', '参数无效', 'status', 400));
    END IF;

    IF v_encryption_key IS NULL THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'ENCRYPTION_KEY_MISSING', 'message', '加密密钥未配置，无法保存分享链接', 'status', 500));
    END IF;

    SELECT * INTO v_binding FROM public.asva_assessment_bindings WHERE id = p_binding_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_FOUND', 'message', '绑定记录不存在', 'status', 404));
    END IF;
    IF v_binding.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('error', jsonb_build_object(
        'code', 'BINDING_NOT_ACTIVE', 'message', '绑定已不在活跃状态', 'status', 403));
    END IF;

    UPDATE public.asva_assessment_bindings
    SET encrypted_share_url = pgp_sym_encrypt(v_share_url, v_encryption_key),
        updated_at = p_now
    WHERE id = p_binding_id;

    INSERT INTO public.asva_assessment_events (binding_id, event_type, actor_id, detail, created_at)
    VALUES (p_binding_id, 'SHARE_URL_SUPPLEMENTED', COALESCE(request->>'actorId', ''),
      jsonb_build_object('actorId', COALESCE(request->>'actorId', '')), p_now);

    RETURN jsonb_build_object('ok', true, 'bindingId', p_binding_id);

  ELSE
    RETURN jsonb_build_object('error', jsonb_build_object(
      'code', 'ASSESSMENT_ACTION_UNKNOWN', 'message', '未知操作: ' || p_action, 'status', 400));
  END IF;
END;
$$;
