import { describe, expect, it } from 'vitest'
import type { MentorAccountResult } from './domain'
import { buildMentorCopyText, insertMentorSnapshot, publicMentorSummary, reconcileMentorSnapshot } from './mentor-account-ux'

const created: MentorAccountResult = {
  id: 'mentor-new', name: '测试导师', role: 'MENTOR', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true,
  displayRole: '导师', title: '导师', phone: '13900000001', specialty: '', avatar: '测',
  initialPassword: 'temporary-only', accountCreateCommitted: true, createOutcome: 'CREATED',
}

describe('mentor account UX safety', () => {
  it('keeps only the public mentor summary in list/cache state', () => {
    const summary = publicMentorSummary(created)
    expect(summary).toMatchObject({ id: 'mentor-new', name: '测试导师' })
    expect(summary).not.toHaveProperty('initialPassword')
    expect(summary).not.toHaveProperty('accountCreateCommitted')
    expect(summary).not.toHaveProperty('createOutcome')
  })

  it('inserts a successful create response immediately and deduplicates it', () => {
    const next = insertMentorSnapshot([{ mentor: publicMentorSummary(created), customerCount: 4 }], created)
    expect(next).toHaveLength(1)
    expect(next[0].mentor.id).toBe('mentor-new')
    expect(next[0].customerCount).toBe(0)
  })

  it('preserves the new mentor when a later list refresh fails', () => {
    const optimistic = insertMentorSnapshot([], created)
    const staleRefresh = reconcileMentorSnapshot([], optimistic[0])
    expect(staleRefresh[0].mentor.name).toBe('测试导师')
    expect(reconcileMentorSnapshot(optimistic, optimistic[0])).toHaveLength(1)
  })

  it('copies full credentials only for a temporary in-memory password', () => {
    const full = buildMentorCopyText(created, 'https://example.test/asva-workbench/', 'temporary-only')
    expect(full).toContain('临时密码：temporary-only')
    expect(full).toContain('登录地址：https://example.test/asva-workbench/')
    const basic = buildMentorCopyText(publicMentorSummary(created), 'https://example.test/asva-workbench/')
    expect(basic).not.toContain('临时密码')
    expect(basic).toContain('手机号：13900000001')
  })
})

