import { describe, expect, it } from 'vitest'
import {
  AUTO_PROCESSING_RETRY_CAP,
  AUTO_RETRY_CAP_REACHED,
  PROCESSING_STALE_AFTER_MS,
  finalizeAutoProcessingFailureCode,
  hasReachedAutoRetryCap,
  isNonRetryableAutoProcessingError,
  isStaleProcessing,
  processingErrorCode,
  shouldAutoRecoverSource,
  shouldResumeSource,
} from './processing-contract.mjs'

describe('source processing recovery contract', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z')

  it('resumes uploaded and stale processing sources only', () => {
    expect(shouldResumeSource({ processingStatus: 'UPLOADED' }, now)).toBe(true)
    expect(isStaleProcessing({ processingStatus: 'PROCESSING', lastProcessingAt: '2026-10-08T11:40:00.000Z' }, now)).toBe(true)
    expect(isStaleProcessing({ processingStatus: 'PROCESSING', lastProcessingAt: '2026-10-08T11:59:59.000Z' }, now)).toBe(false)
    expect(isStaleProcessing({ processingStatus: 'COMPLETED', lastProcessingAt: '2026-10-08T11:00:00.000Z' }, now)).toBe(false)
    expect(PROCESSING_STALE_AFTER_MS).toBe(600000)
  })

  it('uses a safe code instead of persisting error text', () => {
    expect(processingErrorCode({ code: 'DEEPSEEK_TIMEOUT', message: 'raw customer text' })).toBe('DEEPSEEK_TIMEOUT')
    expect(processingErrorCode(new Error('raw customer text'))).toBe('PROCESSING_FAILED')
  })

  it('treats truncation and retry-cap codes as non-retryable for auto recovery', () => {
    expect(isNonRetryableAutoProcessingError('DEEPSEEK_OUTPUT_TRUNCATED')).toBe(true)
    expect(isNonRetryableAutoProcessingError(AUTO_RETRY_CAP_REACHED)).toBe(true)
    expect(isNonRetryableAutoProcessingError('DEEPSEEK_TIMEOUT')).toBe(false)
  })

  it('halts auto recovery after the processing_version cap or a non-retryable error', () => {
    expect(AUTO_PROCESSING_RETRY_CAP).toBe(5)
    expect(shouldAutoRecoverSource({ processingStatus: 'UPLOADED', processingVersion: 1 }, now)).toBe(true)
    expect(shouldAutoRecoverSource({ processingStatus: 'FAILED', processingVersion: 4, processingError: 'DEEPSEEK_TIMEOUT' }, now)).toBe(true)
    expect(shouldAutoRecoverSource({ processingStatus: 'FAILED', processingVersion: 5, processingError: 'DEEPSEEK_TIMEOUT' }, now)).toBe(false)
    expect(hasReachedAutoRetryCap({ processingVersion: 5 })).toBe(true)
    expect(shouldAutoRecoverSource({ processingStatus: 'FAILED', processingVersion: 2, processingError: 'DEEPSEEK_OUTPUT_TRUNCATED' }, now)).toBe(false)
    expect(shouldAutoRecoverSource({ processingStatus: 'FAILED', processingVersion: 191, processingError: 'DEEPSEEK_OUTPUT_TRUNCATED' }, now)).toBe(false)
    expect(shouldAutoRecoverSource({
      processingStatus: 'PROCESSING',
      processingVersion: 3,
      lastProcessingAt: '2026-10-08T11:40:00.000Z',
    }, now)).toBe(true)
  })

  it('finalizes failure codes with retry-cap preference after transient errors', () => {
    expect(finalizeAutoProcessingFailureCode({ code: 'DEEPSEEK_OUTPUT_TRUNCATED' }, 5)).toBe('DEEPSEEK_OUTPUT_TRUNCATED')
    expect(finalizeAutoProcessingFailureCode({ code: 'DEEPSEEK_TIMEOUT' }, 5)).toBe(AUTO_RETRY_CAP_REACHED)
    expect(finalizeAutoProcessingFailureCode({ code: 'DEEPSEEK_TIMEOUT' }, 3)).toBe('DEEPSEEK_TIMEOUT')
  })
})
