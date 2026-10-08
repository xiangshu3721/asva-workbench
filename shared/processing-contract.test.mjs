import { describe, expect, it } from 'vitest'
import { PROCESSING_STALE_AFTER_MS, isStaleProcessing, processingErrorCode, shouldResumeSource } from './processing-contract.mjs'

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
})
