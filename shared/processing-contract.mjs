export const PROCESSING_STALE_AFTER_MS = 10 * 60 * 1000

/** Halt automatic recovery once processing_version reaches this value (starts at 1; each attempt increments). */
export const AUTO_PROCESSING_RETRY_CAP = 5

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
  const code = error?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code.slice(0, 80) : 'PROCESSING_FAILED'
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
  return true
}

/** Prefer keeping a non-retryable provider code; otherwise stamp AUTO_RETRY_CAP_REACHED when the version cap is hit. */
export function finalizeAutoProcessingFailureCode(error, processingVersion) {
  const code = processingErrorCode(error)
  if (isNonRetryableAutoProcessingError(code)) return code
  if (Number(processingVersion || 0) >= AUTO_PROCESSING_RETRY_CAP) return AUTO_RETRY_CAP_REACHED
  return code
}
