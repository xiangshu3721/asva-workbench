import type { MentorAccountResult, Staff } from './domain'
import type { TeamSnapshot } from './clientApi'

export type TemporaryMentorCredential = {
  mentor: Staff
  password?: string
  copied: boolean
}

export function publicMentorSummary(result: MentorAccountResult): Staff {
  const { initialPassword: _initialPassword, accountCreateCommitted: _committed, createOutcome: _outcome, ...mentor } = result
  return mentor
}

function mentorIdentityKey(mentor: Staff) {
  return mentor.phone.replace(/[\s-]/g, '') || mentor.id
}

function dedupeMentorSnapshot(items: TeamSnapshot[]) {
  const selected = new Map<string, TeamSnapshot>()
  for (const item of items) {
    const key = mentorIdentityKey(item.mentor)
    const current = selected.get(key)
    if (!current || (item.mentor.status === 'ACTIVE' && current.mentor.status !== 'ACTIVE')) selected.set(key, item)
  }
  return [...selected.values()]
}

export function insertMentorSnapshot(current: TeamSnapshot[], result: MentorAccountResult): TeamSnapshot[] {
  const mentor = publicMentorSummary(result)
  return dedupeMentorSnapshot([{ mentor, customerCount: 0 }, ...current.filter((item) => mentorIdentityKey(item.mentor) !== mentorIdentityKey(mentor))])
}

export function reconcileMentorSnapshot(refreshed: TeamSnapshot[], optimistic?: TeamSnapshot): TeamSnapshot[] {
  return dedupeMentorSnapshot(optimistic && !refreshed.some((item) => mentorIdentityKey(item.mentor) === mentorIdentityKey(optimistic.mentor)) ? [optimistic, ...refreshed] : refreshed)
}

export function mentorAccountRecoveryMessage(status: 'COMPLETED' | 'PARTIAL' | 'NOT_FOUND' | 'DUPLICATE') {
  if (status === 'COMPLETED') return '导师账号已创建，但初始密码无法安全恢复，请使用重置密码。'
  if (status === 'PARTIAL') return '导师人员记录已存在，但登录凭据尚未完整，请稍后重试或使用密码重置。'
  if (status === 'DUPLICATE') return '检测到重复导师记录，系统未自动合并，请联系管理员核查。'
  return '正在确认创建结果，请勿重复提交；稍后刷新导师列表。'
}

export function buildMentorCopyText(mentor: Staff, baseUrl: string, password?: string) {
  const lines = [`导师昵称：${mentor.name}`, `手机号：${mentor.phone}`]
  if (password) lines.push(`临时密码：${password}`)
  lines.push(`登录地址：${baseUrl}`)
  return lines.join('\n')
}

