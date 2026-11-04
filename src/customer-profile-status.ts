import type { ProfileMaterialization } from './domain'
import type { AutomaticProfileStatus } from './clientApi'

export const AUTO_PROFILE_REFRESH_INTERVAL_MS = 20_000
export const AUTO_PROFILE_REFRESH_MAX_ATTEMPTS = 9

const ACTIVE_AUTO_PROFILE_STATUSES = new Set<AutomaticProfileStatus>(['PENDING', 'PROCESSING', 'EXTRACT_READY'])
const VERIFICATION_STATUS_PATTERN = /待核实|待验证|待确认|存在冲突/

export function isAutomaticProfileInProgress(
  status: AutomaticProfileStatus | undefined,
  hasPendingMarker = false,
  shouldResumeFailed = false,
): boolean {
  if (!status) return hasPendingMarker
  if (ACTIVE_AUTO_PROFILE_STATUSES.has(status)) return true
  if (status === 'NOT_STARTED') return hasPendingMarker
  if (status === 'FAILED') return shouldResumeFailed
  return false
}

export function countProfileVerificationItems(
  materialization?: Pick<ProfileMaterialization, 'sections' | 'provisionalItems'>,
): number {
  if (!materialization) return 0
  const items = [
    ...materialization.sections.flatMap((section) => section.items),
    ...materialization.provisionalItems,
  ]
  const seen = new Set<string>()
  let count = 0
  for (const item of items) {
    if (!VERIFICATION_STATUS_PATTERN.test(item.statusLabel || '')) continue
    const evidenceIds = [...(item.evidenceIds || [])].filter(Boolean).sort()
    const key = evidenceIds.length
      ? `evidence:${evidenceIds.join('|')}`
      : `item:${item.label}:${item.text}`
    if (seen.has(key)) continue
    seen.add(key)
    count += 1
  }
  return count
}

export function automaticProfileStatusMessage(
  status: AutomaticProfileStatus | undefined,
  pendingVerificationCount = 0,
  hasPendingMarker = false,
  shouldResumeFailed = false,
): string {
  const pendingCopy = pendingVerificationCount > 0
    ? `另有 ${pendingVerificationCount} 条信息待核实。`
    : ''
  switch (status) {
    case 'NOT_STARTED':
      return hasPendingMarker ? '资料已保存，等待后台开始整理；页面会自动检查进度。' : ''
    case 'PENDING':
      return '资料已保存，等待后台继续整理；页面会自动检查进度。'
    case 'PROCESSING':
      return 'AI正在整理资料，原始资料已保存；页面会自动检查进度。'
    case 'EXTRACT_READY':
      return 'AI已完成信息提取，正在更新正式档案；页面会自动检查进度。'
    case 'FAILED':
      return shouldResumeFailed
        ? '本次整理暂未成功，原始资料已保留；系统会按恢复策略重试。'
        : '本次整理未能完成，原始资料已保留；可在“原始资料与查看依据”中查看详情。'
    case 'REVIEW_REQUIRED':
      return pendingVerificationCount > 0
        ? `AI整理已完成，档案已更新；${pendingCopy}`
        : 'AI整理已完成，部分信息需要人工确认。'
    case 'COMPLETED':
      return pendingVerificationCount > 0
        ? `AI整理完成，档案已更新；${pendingCopy}`
        : 'AI整理完成，档案已更新。'
    case 'NO_USABLE_OUTPUT':
      return '本次未提取到可归档信息，原始资料已完整保留。'
    default:
      return ''
  }
}
