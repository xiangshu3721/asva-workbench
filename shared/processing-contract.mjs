export const PROCESSING_STALE_AFTER_MS = 10 * 60 * 1000

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
