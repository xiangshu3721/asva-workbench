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
  needsFinalize?: boolean
}) {
  const status = input.status || ''
  if (input.needsFinalize) return true
  if (status === 'PENDING' || status === 'FAILED') return true
  if (status === 'PROCESSING') {
    const kickoffAt = input.kickoffAt
    const now = input.now ?? Date.now()
    const staleAfterMs = input.staleAfterMs ?? PROCESSING_STALE_AFTER_MS
    if (!kickoffAt) return true
    return now - kickoffAt >= staleAfterMs
  }
  // REVIEW_REQUIRED may still need finalize (proposals or unconfirmed physical fields).
  // Server decides idempotently; client only kicks same customerId.
  return false
}

export function autoArchiveStatusToast(result: {
  status?: string
  phase?: string
  proposalCount?: number
  pendingUnconfirmedFieldCount?: number
  needsFinalize?: boolean
  physicalFields?: Record<string, unknown> | null
}) {
  if (result?.needsFinalize || result?.phase === 'EXTRACT_READY') return { message: 'AI整理中（证据已保存，正在收尾）', tone: 'success' as const }
  if (result?.status === 'COMPLETED') {
    const n = Number(result.pendingUnconfirmedFieldCount || 0)
    if (n > 0) return { message: `字段已落盘，${n}项待核实`, tone: 'success' as const }
    return { message: 'AI整理完成，档案已更新', tone: 'success' as const }
  }
  if (result?.status === 'REVIEW_REQUIRED') {
    const n = Number(result.proposalCount || result.pendingUnconfirmedFieldCount || 0)
    if (n > 0) return { message: `AI已整理，${n}项待确认`, tone: 'success' as const }
    return { message: 'AI整理完成，部分信息待核实', tone: 'success' as const }
  }
  if (result?.status === 'FAILED') return { message: `AI处理失败待恢复（${result.phase || 'PROCESS'}）`, tone: 'warning' as const }
  if (result?.status === 'PROCESSING') return { message: 'AI整理中，原始资料已保存', tone: 'success' as const }
  return { message: '原始资料已保存', tone: 'success' as const }
}

export function attachmentFailureToast() {
  return '客户已保存，但附件未保存'
}
