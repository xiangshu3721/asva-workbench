export const PROCESSING_STALE_AFTER_MS = 10 * 60 * 1000

export interface ProcessingSourceLike {
  processingStatus: string
  processingStartedAt?: string | null
  lastProcessingAt?: string | null
  updatedAt?: string | null
  createdAt?: string | null
}

function processingTimestamp(source: ProcessingSourceLike) {
  return source.lastProcessingAt || source.processingStartedAt || source.updatedAt || source.createdAt || null
}

export function isStaleProcessing(source: ProcessingSourceLike, now = Date.now()) {
  if (source.processingStatus !== 'PROCESSING') return false
  const timestamp = Date.parse(processingTimestamp(source) || '')
  return !Number.isFinite(timestamp) || now - timestamp >= PROCESSING_STALE_AFTER_MS
}

export function shouldResumeSource(source: ProcessingSourceLike, now = Date.now()) {
  return source.processingStatus === 'UPLOADED' || isStaleProcessing(source, now)
}
