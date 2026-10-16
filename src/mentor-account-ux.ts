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

export function insertMentorSnapshot(current: TeamSnapshot[], result: MentorAccountResult): TeamSnapshot[] {
  const mentor = publicMentorSummary(result)
  return [{ mentor, customerCount: 0 }, ...current.filter((item) => item.mentor.id !== mentor.id)]
}

export function reconcileMentorSnapshot(refreshed: TeamSnapshot[], optimistic?: TeamSnapshot): TeamSnapshot[] {
  return optimistic && !refreshed.some((item) => item.mentor.id === optimistic.mentor.id) ? [optimistic, ...refreshed] : refreshed
}

export function buildMentorCopyText(mentor: Staff, baseUrl: string, password?: string) {
  const lines = [`导师昵称：${mentor.name}`, `手机号：${mentor.phone}`]
  if (password) lines.push(`临时密码：${password}`)
  lines.push(`登录地址：${baseUrl}`)
  return lines.join('\n')
}

