import { PROCESSING_STALE_AFTER_MS } from './processing-contract'

export type AutoOrganizeStatus = 'PENDING' | 'FAILED' | 'PROCESSING' | 'COMPLETED' | 'REVIEW_REQUIRED' | 'NOT_STARTED' | 'NO_USABLE_OUTPUT' | string

/** CREATE save order: customer persisted → upload Source confirmed → then phase-2 kickoff. */
export function shouldKickoffAfterCreateSave(input: {
  uploadFailed?: boolean
  automaticProfileStatus?: string | null
  hasSituation?: boolean
  hasUpload?: boolean
}) {
  if (input.uploadFailed) return false
  return input.automaticProfileStatus === 'PENDING' || Boolean(input.hasSituation) || Boolean(input.hasUpload)
}

/** Shared resume policy for profile open + save kickoff. PROCESSING only when stale. */
export function shouldResumeAutoArchive(input: {
  status?: AutoOrganizeStatus | null
  kickoffAt?: number | null
  now?: number
  staleAfterMs?: number
}) {
  const status = input.status || ''
  if (status === 'PENDING' || status === 'FAILED') return true
  if (status === 'PROCESSING') {
    const kickoffAt = input.kickoffAt
    const now = input.now ?? Date.now()
    const staleAfterMs = input.staleAfterMs ?? PROCESSING_STALE_AFTER_MS
    if (!kickoffAt) return true
    return now - kickoffAt >= staleAfterMs
  }
  return false
}

export function attachmentFailureToast() {
  return '客户已保存，但附件未保存'
}
