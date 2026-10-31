/**
 * asva-ai-archive — lightweight Event cloud function worker.
 * Reuses FeishuRepository.recoverAutomaticCustomerProfile / processSource.
 * Invoked asynchronously from asva-api; also usable as local test double.
 */
import { FeishuRepository } from './repository.mjs'
import { config } from './config.mjs'

const repository = new FeishuRepository()

function text(value) {
  return String(value ?? '').trim()
}

function parseEvent(event) {
  if (event == null) return {}
  if (typeof event === 'string') {
    try { return JSON.parse(event) } catch { return { raw: event } }
  }
  if (typeof event === 'object') {
    if (event.customerId || event.sourceId || event.mode) return event
    if (typeof event.Payload === 'string') {
      try { return JSON.parse(event.Payload) } catch { /* fall through */ }
    }
    if (event.Payload && typeof event.Payload === 'object') return event.Payload
    if (typeof event.body === 'string') {
      try { return JSON.parse(event.body) } catch { return {} }
    }
    if (event.body && typeof event.body === 'object') return event.body
  }
  return {}
}

function assertInvokeSecret(payload, event) {
  const expected = text(process.env.ASVA_AI_ARCHIVE_INVOKE_SECRET)
  if (!expected) return
  const provided = text(payload.invokeSecret)
    || text(event?.ClientContext && (() => {
      try {
        const ctx = typeof event.ClientContext === 'string' ? JSON.parse(event.ClientContext) : event.ClientContext
        return ctx?.asvaInvokeSecret
      } catch { return '' }
    })())
  if (provided !== expected) {
    throw Object.assign(new Error('AI archive invoke secret mismatch'), { code: 'AI_ARCHIVE_INVOKE_FORBIDDEN', status: 403 })
  }
}

/**
 * Core worker handler — shared by SCF main and local invoke.
 */
export async function handleAiArchiveEvent(rawEvent = {}) {
  const startedAt = Date.now()
  const payload = parseEvent(rawEvent)
  assertInvokeSecret(payload, rawEvent)

  const customerId = text(payload.customerId)
  const sourceId = text(payload.sourceId)
  const actorId = text(payload.actorId)
  const mode = text(payload.mode).toLowerCase() === 'process' ? 'process' : 'recover'
  const force = payload.force === true
  const reason = text(payload.reason) || 'WORKER'

  if (!config.features.automaticProfileArchiving) {
    return { ok: true, status: 'DISABLED', customerId, sourceId, durationMs: Date.now() - startedAt }
  }
  if (!customerId && !sourceId) {
    return { ok: false, status: 'FAILED', errorCode: 'AI_ARCHIVE_JOB_TARGET_REQUIRED', durationMs: Date.now() - startedAt }
  }

  repository.audit?.('AI_ARCHIVE_WORKER_START', customerId || sourceId, actorId, 'QUEUED')

  try {
    let result
    if (mode === 'process' && sourceId) {
      const processed = await repository.processSource(actorId || 'SYSTEM', sourceId, { force })
      result = {
        ok: true,
        status: processed?.source?.processingStatus || 'PROCESSING',
        customerId: processed?.source?.customerId || customerId,
        sourceId,
        processed: true,
        mode,
      }
    } else {
      if (!customerId) {
        return { ok: false, status: 'FAILED', errorCode: 'CUSTOMER_ID_REQUIRED', durationMs: Date.now() - startedAt }
      }
      // recover: locate customer → ensure Source → processSource (idempotent)
      result = await repository.recoverAutomaticCustomerProfile(actorId, customerId)
      result = {
        ok: !['FAILED', 'DISABLED'].includes(result?.status),
        ...result,
        mode: 'recover',
      }
    }
    repository.audit?.('AI_ARCHIVE_WORKER_DONE', customerId || sourceId, actorId, result.ok ? 'SUCCESS' : 'FAIL', result.ok ? '' : (result.errorCode || result.status || 'FAILED'))
    return { ...result, durationMs: Date.now() - startedAt }
  } catch (error) {
    repository.audit?.('AI_ARCHIVE_WORKER_DONE', customerId || sourceId, actorId, 'FAIL', error?.code || 'AI_ARCHIVE_WORKER_FAILED')
    return {
      ok: false,
      status: 'FAILED',
      customerId,
      sourceId,
      mode,
      errorCode: error?.code || 'AI_ARCHIVE_WORKER_FAILED',
      message: error?.message || 'worker failed',
      durationMs: Date.now() - startedAt,
    }
  }
}

/** CloudBase / SCF Event entry. */
export async function main(event, context) {
  const result = await handleAiArchiveEvent(event)
  // Event invoke ignores return value; keep structured logs for ops.
  console.info('[ASVA_AI_ARCHIVE_WORKER]', JSON.stringify({
    request_id: context?.requestId || context?.request_id,
    ...result,
  }))
  return result
}

// CJS interop for bundled SCF handler
export default { main, handleAiArchiveEvent }
