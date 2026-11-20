export const PROCESSING_STALE_AFTER_MS = 10 * 60 * 1000

/** Halt automatic recovery once processing_version reaches this value (starts at 1; each attempt increments). */
export const AUTO_PROCESSING_RETRY_CAP = 5

// Keep the retry schedule within the one-minute worker cadence while giving
// an overloaded upstream time to recover. The delay is persisted in the
// existing processing_error field, so a new CloudBase instance observes it.
export const AUTOMATIC_RETRY_DELAYS_MS = [60_000, 180_000, 600_000]

/** Pause recoverAutomaticProcessing after this many auto process schedules in one UTC day (or until process restart). */
export const AUTO_RECOVERY_CIRCUIT_MAX_PER_DAY = 80

export const AUTO_RETRY_CAP_REACHED = 'AUTO_RETRY_CAP_REACHED'

/** Non-transient failures that must never re-enter automatic recovery. Manual force reprocess may still run. */
export const NON_RETRYABLE_AUTO_PROCESSING_ERROR_CODES = new Set([
  'DEEPSEEK_OUTPUT_TRUNCATED',
  AUTO_RETRY_CAP_REACHED,
  'SOURCE_TEXT_REQUIRED',
  'INVALID_SOURCE_TYPE',
  'UNSUPPORTED_DOCUMENT_FORMAT',
  'INVALID_DOCUMENT_MIME',
  'DOCX_CORRUPT',
  'DOCUMENT_TEXT_EMPTY',
])

export function processingTimestamp(source) {
  return source?.lastProcessingAt || source?.processingStartedAt || source?.updatedAt || source?.createdAt || null
}

export function isStaleProcessing(source, now = Date.now()) {
  if (!source || source.processingStatus !== 'PROCESSING') return false
  const timestamp = Date.parse(processingTimestamp(source) || '')
  return !Number.isFinite(timestamp) || now - timestamp >= PROCESSING_STALE_AFTER_MS
}

export function shouldResumeSource(source, now = Date.now()) {
  return source?.processingStatus === 'UPLOADED' || isStaleProcessing(source, now)
}

export function processingErrorCode(error) {
  const code = typeof error === 'string' ? error.split('|', 1)[0].trim() : error?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code.slice(0, 80) : 'PROCESSING_FAILED'
}

export function parseProcessingError(errorOrCode) {
  const raw = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode?.processingError || errorOrCode?.code || ''
  const [codePart, ...parts] = String(raw).split('|')
  const metadata = Object.fromEntries(parts.map((part) => {
    const index = part.indexOf('=')
    return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, '']
  }))
  const retryAt = Date.parse(metadata.retry_at || '')
  return { code: processingErrorCode(codePart), retryAt: Number.isFinite(retryAt) ? retryAt : null, retryCount: Number(metadata.retry_count || 0) || 0 }
}

export function formatAutomaticProcessingFailure(error, processingVersion, now = Date.now()) {
  const code = finalizeAutoProcessingFailureCode(error, processingVersion)
  if (code === AUTO_RETRY_CAP_REACHED || isNonRetryableAutoProcessingError(code)) return code
  if (!String(code).startsWith('DEEPSEEK_')) return code
  const delayIndex = Math.max(0, Math.min(AUTOMATIC_RETRY_DELAYS_MS.length - 1, Number(processingVersion || 1) - 2))
  const retryAt = new Date(now + AUTOMATIC_RETRY_DELAYS_MS[delayIndex]).toISOString()
  return `${code}|retry_at=${retryAt}|retry_count=${Number(processingVersion || 1)}`
}

export function normalizeProcessingErrorCode(errorOrCode) {
  if (typeof errorOrCode === 'string') {
    return /^[A-Z0-9_]+$/.test(errorOrCode) ? errorOrCode.slice(0, 80) : 'PROCESSING_FAILED'
  }
  return processingErrorCode(errorOrCode)
}

export function isNonRetryableAutoProcessingError(errorOrCode) {
  return NON_RETRYABLE_AUTO_PROCESSING_ERROR_CODES.has(normalizeProcessingErrorCode(errorOrCode))
}

export function hasReachedAutoRetryCap(source) {
  return Number(source?.processingVersion || 1) >= AUTO_PROCESSING_RETRY_CAP
}

/**
 * Whether recoverAutomaticProcessing may schedule another processSource for this source.
 * FAILED is eligible only while under the version cap and without a non-retryable error.
 */
export function shouldAutoRecoverSource(source, now = Date.now()) {
  if (!source) return false
  const status = source.processingStatus
  const eligibleStatus = status === 'UPLOADED' || status === 'FAILED' || (status === 'PROCESSING' && isStaleProcessing(source, now))
  if (!eligibleStatus) return false
  if (isNonRetryableAutoProcessingError(source.processingError)) return false
  if (hasReachedAutoRetryCap(source)) return false
  const retryAt = parseProcessingError(source.processingError).retryAt
  if (retryAt && retryAt > now) return false
  return true
}

/** Prefer keeping a non-retryable provider code; otherwise stamp AUTO_RETRY_CAP_REACHED when the version cap is hit. */
export function finalizeAutoProcessingFailureCode(error, processingVersion) {
  const code = processingErrorCode(error)
  if (isNonRetryableAutoProcessingError(code)) return code
  if (Number(processingVersion || 0) >= AUTO_PROCESSING_RETRY_CAP) return AUTO_RETRY_CAP_REACHED
  return code
}
