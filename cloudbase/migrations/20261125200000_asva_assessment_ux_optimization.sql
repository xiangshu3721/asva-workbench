-- ASVA Assessment UX Optimization V1.0.1
-- Add encrypted_share_url field to store full share URL with linkSecret
-- This allows mentors to view original report in new tab

BEGIN;

-- Add encrypted_share_url column to store full share URL (with linkSecret)
-- This is separate from the sanitized share_url in snapshot
ALTER TABLE public.asva_assessment_bindings
ADD COLUMN IF NOT EXISTS encrypted_share_url TEXT;

-- Add comment explaining the purpose
COMMENT ON COLUMN public.asva_assessment_bindings.encrypted_share_url IS 
  'Full share URL with linkSecret for viewing original report. Access controlled by mentor permissions.';

-- Create index for efficient lookup when updating reports
CREATE INDEX IF NOT EXISTS idx_assessment_bindings_report_id 
ON public.asva_assessment_bindings ((snapshot->>'reportId'));

-- Update the RPC function to handle new actions
CREATE OR REPLACE FUNCTION public.asva_assessment_guard(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_action text := payload->>'action';
  v_binding_id text := payload->>'bindingId';
  v_provider text := payload->>'provider';
  v_report_id text := payload->>'reportId';
  v_customer_id text := payload->>'customerId';
  v_binding jsonb;
  v_result jsonb;
BEGIN
  -- Validate action
  IF v_action NOT IN ('bind', 'unbind', 'transfer', 'revoke', 'get', 'list', 'events', 'confirm_name', 'consent', 'get_share_url', 'supplement_share_url', 'update_report') THEN
    RAISE EXCEPTION 'Invalid action: %', v_action;
  END IF;

  -- Handle new V1.0.1 actions
  IF v_action = 'get_share_url' THEN
    SELECT to_jsonb(b.*) INTO v_binding
    FROM public.asva_assessment_bindings b
    WHERE b.id = v_binding_id AND b.status = 'ACTIVE';
    
    IF v_binding IS NULL THEN
      RAISE EXCEPTION 'Binding not found or not active';
    END IF;
    
    RETURN jsonb_build_object(
      'bindingId', v_binding_id,
      'encryptedShareUrl', v_binding->>'encrypted_share_url'
    );
  END IF;

  IF v_action = 'supplement_share_url' THEN
    UPDATE public.asva_assessment_bindings
    SET encrypted_share_url = payload->>'shareUrl',
        updated_at = now()
    WHERE id = v_binding_id AND status = 'ACTIVE'
    RETURNING to_jsonb(asva_assessment_bindings.*) INTO v_binding;
    
    IF v_binding IS NULL THEN
      RAISE EXCEPTION 'Binding not found or not active';
    END IF;
    
    -- Log event
    INSERT INTO public.asva_assessment_events (id, binding_id, event_type, event_data, created_at)
    VALUES (
      gen_random_uuid()::text,
      v_binding_id,
      'SUPPLEMENT_SHARE_URL',
      jsonb_build_object(
        'supplementedBy', payload->>'supplementedBy',
        'supplementedAt', payload->>'supplementedAt'
      ),
      now()
    );
    
    RETURN jsonb_build_object('binding', v_binding);
  END IF;

  IF v_action = 'update_report' THEN
    -- Mark old binding as SUPERSEDED
    UPDATE public.asva_assessment_bindings
    SET status = 'SUPERSEDED',
        updated_at = now()
    WHERE id = v_binding_id AND status = 'ACTIVE';
    
    -- Create new binding with updated report
    INSERT INTO public.asva_assessment_bindings (
      id, provider, report_id, assessment_id, assessment_name, 
      assessment_version, schema_version, customer_id, customer_name,
      report_nickname, completed_at, bound_at, bound_by, status,
      snapshot, snapshot_hash, preview, encrypted_share_url,
      archive_confirmed_by, archive_confirmed_at,
      customer_consent, customer_consent_at,
      created_at, updated_at
    )
    SELECT 
      gen_random_uuid()::text,
      provider,
      payload->>'newReportId',
      assessment_id,
      assessment_name,
      assessment_version,
      schema_version,
      customer_id,
      customer_name,
      report_nickname,
      payload->'newSnapshot'->>'completedAt',
      now(),
      payload->>'updatedBy',
      'ACTIVE',
      payload->'newSnapshot',
      payload->>'newSnapshotHash',
      payload->'newPreview',
      payload->>'newShareUrl',
      payload->>'updatedBy',
      now(),
      false,
      NULL,
      now(),
      now()
    FROM public.asva_assessment_bindings
    WHERE id = v_binding_id
    RETURNING to_jsonb(asva_assessment_bindings.*) INTO v_binding;
    
    -- Log update event
    INSERT INTO public.asva_assessment_events (id, binding_id, event_type, event_data, created_at)
    VALUES (
      gen_random_uuid()::text,
      v_binding->>'id',
      'REPORT_UPDATED',
      jsonb_build_object(
        'previousBindingId', v_binding_id,
        'updatedBy', payload->>'updatedBy',
        'updatedAt', payload->>'updatedAt',
        'updateReason', payload->>'updateReason'
      ),
      now()
    );
    
    RETURN jsonb_build_object('binding', v_binding);
  END IF;

  -- Original bind action - now includes encrypted_share_url
  IF v_action = 'bind' THEN
    INSERT INTO public.asva_assessment_bindings (
      id, provider, report_id, assessment_id, assessment_name,
      assessment_version, schema_version, customer_id, customer_name,
      report_nickname, completed_at, bound_at, bound_by, status,
      snapshot, snapshot_hash, preview,
      name_mismatch, name_confirmed_by, name_confirmed_at, name_confirmed_reason,
      archive_confirmed_by, archive_confirmed_at,
      customer_consent, customer_consent_at,
      encrypted_share_url,
      created_at, updated_at
    )
    VALUES (
      v_binding_id,
      v_provider,
      v_report_id,
      payload->>'assessmentId',
      payload->>'assessmentName',
      payload->>'assessmentVersion',
      payload->>'schemaVersion',
      v_customer_id,
      payload->>'customerName',
      payload->>'reportNickname',
      payload->>'completedAt',
      now(),
      payload->>'boundBy',
      'ACTIVE',
      payload->'snapshot',
      payload->>'snapshotHash',
      payload->'preview',
      COALESCE((payload->>'nameMismatch')::boolean, false),
      payload->>'nameConfirmedBy',
      payload->>'nameConfirmedAt',
      payload->>'nameConfirmedReason',
      payload->>'archiveConfirmedBy',
      payload->>'archiveConfirmedAt',
      COALESCE((payload->>'customerConsent')::boolean, false),
      payload->>'customerConsentAt',
      payload->>'encryptedShareUrl',
      now(),
      now()
    )
    RETURNING to_jsonb(asva_assessment_bindings.*) INTO v_binding;
    
    -- Log bind event
    INSERT INTO public.asva_assessment_events (id, binding_id, event_type, event_data, created_at)
    VALUES (
      gen_random_uuid()::text,
      v_binding_id,
      'BOUND',
      jsonb_build_object(
        'boundBy', payload->>'boundBy',
        'provider', v_provider,
        'reportId', v_report_id,
        'customerId', v_customer_id
      ),
      now()
    );
    
    RETURN jsonb_build_object('binding', v_binding);
  END IF;

  -- Other existing actions (unbind, transfer, revoke, get, list, events, confirm_name, consent)
  -- remain unchanged for backward compatibility
  
  IF v_action = 'unbind' THEN
    UPDATE public.asva_assessment_bindings
    SET status = 'UNBOUND', updated_at = now()
    WHERE id = v_binding_id AND status = 'ACTIVE'
    RETURNING to_jsonb(asva_assessment_bindings.*) INTO v_binding;
    
    IF v_binding IS NULL THEN
      RAISE EXCEPTION 'Binding not found or not active';
    END IF;
    
    INSERT INTO public.asva_assessment_events (id, binding_id, event_type, event_data, created_at)
    VALUES (
      gen_random_uuid()::text,
      v_binding_id,
      'UNBOUND',
      jsonb_build_object('reason', payload->>'reason'),
      now()
    );
    
    RETURN jsonb_build_object('binding', v_binding);
  END IF;

  IF v_action = 'transfer' THEN
    INSERT INTO public.asva_assessment_bindings (
      id, provider, report_id, assessment_id, assessment_name,
      assessment_version, schema_version, customer_id, customer_name,
      report_nickname, completed_at, bound_at, bound_by, status,
      snapshot, snapshot_hash, preview, encrypted_share_url,
      archive_confirmed_by, archive_confirmed_at,
      customer_consent, customer_consent_at,
      created_at, updated_at
    )
    SELECT 
      gen_random_uuid()::text,
      provider, report_id, assessment_id, assessment_name,
      assessment_version, schema_version,
      payload->>'targetCustomerId',
      payload->>'targetCustomerName',
      report_nickname, completed_at, now(), payload->>'transferredBy',
      'ACTIVE',
      snapshot, snapshot_hash, preview, encrypted_share_url,
      payload->>'transferredBy', now(),
      false, NULL,
      now(), now()
    FROM public.asva_assessment_bindings
    WHERE id = v_binding_id AND status = 'ACTIVE'
    RETURNING to_jsonb(asva_assessment_bindings.*) INTO v_binding;
    
    IF v_binding IS NULL THEN
      RAISE EXCEPTION 'Binding not found or not active';
    END IF;
    
    UPDATE public.asva_assessment_bindings
    SET status = 'TRANSFERRED', updated_at = now()
    WHERE id = v_binding_id;
    
    INSERT INTO public.asva_assessment_events (id, binding_id, event_type, event_data, created_at)
    VALUES (
      gen_random_uuid()::text,
      v_binding_id,
      'TRANSFERRED',
      jsonb_build_object(
        'targetCustomerId', payload->>'targetCustomerId',
        'transferredBy', payload->>'transferredBy',
        'reason', payload->>'reason'
      ),
      now()
    );
    
    RETURN jsonb_build_object('binding', v_binding);
  END IF;

  IF v_action = 'revoke' THEN
    UPDATE public.asva_assessment_bindings
    SET status = 'REVOKED', updated_at = now()
    WHERE id = v_binding_id AND status = 'ACTIVE'
    RETURNING to_jsonb(asva_assessment_bindings.*) INTO v_binding;
    
    IF v_binding IS NULL THEN
      RAISE EXCEPTION 'Binding not found or not active';
    END IF;
    
    INSERT INTO public.asva_assessment_events (id, binding_id, event_type, event_data, created_at)
    VALUES (
      gen_random_uuid()::text,
      v_binding_id,
      'REVOKED',
      jsonb_build_object('reason', payload->>'reason'),
      now()
    );
    
    RETURN jsonb_build_object('binding', v_binding);
  END IF;

  IF v_action = 'get' THEN
    -- Handle both bindingId and customerId cases
    IF v_binding_id IS NOT NULL AND v_binding_id != '' THEN
      SELECT to_jsonb(b.*) INTO v_binding
      FROM public.asva_assessment_bindings b
      WHERE b.id = v_binding_id;
      
      IF v_binding IS NULL THEN
        RETURN jsonb_build_object('binding', NULL);
      END IF;
      
      RETURN jsonb_build_object('binding', v_binding);
    ELSIF v_customer_id IS NOT NULL AND v_customer_id != '' THEN
      -- List all ACTIVE bindings for this customer
      SELECT jsonb_agg(to_jsonb(b.*))
      INTO v_result
      FROM public.asva_assessment_bindings b
      WHERE b.customer_id = v_customer_id AND b.status = 'ACTIVE'
      ORDER BY b.completed_at DESC NULLS LAST;
      
      RETURN jsonb_build_object('bindings', COALESCE(v_result, '[]'::jsonb));
    ELSE
      RAISE EXCEPTION 'get action requires bindingId or customerId';
    END IF;
  END IF;

  IF v_action = 'list' THEN
    SELECT jsonb_agg(to_jsonb(b.*))
    INTO v_result
    FROM public.asva_assessment_bindings b
    WHERE b.customer_id = v_customer_id AND b.status = 'ACTIVE'
    ORDER BY b.completed_at DESC NULLS LAST;
    
    RETURN jsonb_build_object('bindings', COALESCE(v_result, '[]'::jsonb));
  END IF;

  IF v_action = 'events' THEN
    SELECT jsonb_agg(to_jsonb(e.*))
    INTO v_result
    FROM public.asva_assessment_events e
    WHERE e.binding_id = v_binding_id
    ORDER BY e.created_at DESC;
    
    RETURN jsonb_build_object('events', COALESCE(v_result, '[]'::jsonb));
  END IF;

  IF v_action = 'confirm_name' THEN
    UPDATE public.asva_assessment_bindings
    SET name_confirmed_by = payload->>'confirmedBy',
        name_confirmed_at = now(),
        name_confirmed_reason = payload->>'reason',
        name_mismatch = false,
        updated_at = now()
    WHERE id = v_binding_id AND status = 'ACTIVE'
    RETURNING to_jsonb(asva_assessment_bindings.*) INTO v_binding;
    
    IF v_binding IS NULL THEN
      RAISE EXCEPTION 'Binding not found or not active';
    END IF;
    
    RETURN jsonb_build_object('binding', v_binding);
  END IF;

  IF v_action = 'consent' THEN
    UPDATE public.asva_assessment_bindings
    SET customer_consent = true,
        customer_consent_at = now(),
        updated_at = now()
    WHERE id = v_binding_id AND status = 'ACTIVE'
    RETURNING to_jsonb(asva_assessment_bindings.*) INTO v_binding;
    
    IF v_binding IS NULL THEN
      RAISE EXCEPTION 'Binding not found or not active';
    END IF;
    
    RETURN jsonb_build_object('binding', v_binding);
  END IF;

  RAISE EXCEPTION 'Unhandled action: %', v_action;
END;
$$;

COMMIT;
