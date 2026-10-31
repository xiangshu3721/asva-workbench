import { describe, expect, it } from 'vitest'
import { PROCESSING_STALE_AFTER_MS } from './processing-contract'
import { attachmentFailureToast, shouldKickoffAfterCreateSave, shouldResumeAutoArchive } from './customer-auto-archive-flow'

describe('customer auto-archive create/upload flow', () => {
  it('no notes + upload only still kicks after upload success', () => {
    expect(shouldKickoffAfterCreateSave({ hasUpload: true, hasSituation: false, automaticProfileStatus: 'NOT_REQUIRED' })).toBe(true)
  })

  it('notes + upload kicks only when upload did not fail', () => {
    expect(shouldKickoffAfterCreateSave({ hasUpload: true, hasSituation: true, automaticProfileStatus: 'PENDING', uploadFailed: false })).toBe(true)
    expect(shouldKickoffAfterCreateSave({ hasUpload: true, hasSituation: true, automaticProfileStatus: 'PENDING', uploadFailed: true })).toBe(false)
  })

  it('attachment failure copy is explicit', () => {
    expect(attachmentFailureToast()).toBe('客户已保存，但附件未保存')
  })

  it('resume PENDING/FAILED; PROCESSING only when stale', () => {
    expect(shouldResumeAutoArchive({ status: 'PENDING' })).toBe(true)
    expect(shouldResumeAutoArchive({ status: 'FAILED' })).toBe(true)
    expect(shouldResumeAutoArchive({ status: 'PROCESSING', kickoffAt: Date.now() - 1000, now: Date.now() })).toBe(false)
    expect(shouldResumeAutoArchive({
      status: 'PROCESSING',
      kickoffAt: Date.now() - PROCESSING_STALE_AFTER_MS - 1,
      now: Date.now(),
    })).toBe(true)
    expect(shouldResumeAutoArchive({ status: 'PROCESSING', kickoffAt: null })).toBe(true)
    expect(shouldResumeAutoArchive({ status: 'COMPLETED' })).toBe(false)
  })
})
