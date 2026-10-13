import { describe, expect, it } from 'vitest'
import { accountAvatar, accountPanelFor, accountRoleLabel } from './account-identity.mjs'

describe('account identity presentation', () => {
  it('derives a Chinese avatar from the current nickname', () => {
    expect(accountAvatar('林硕')).toBe('林')
    expect(accountAvatar('翔叔')).toBe('翔')
  })

  it('derives an uppercase avatar from an English or numeric nickname', () => {
    expect(accountAvatar('R017测试导师')).toBe('R')
    expect(accountAvatar('  mentor')).toBe('M')
  })

  it('keeps role labels tied to the role value', () => {
    expect(accountRoleLabel('ADMIN')).toBe('管理员 · 经营与服务设计')
    expect(accountRoleLabel('MENTOR')).toBe('导师')
  })

  it('only allows the team panel for admins', () => {
    expect(accountPanelFor('ADMIN', 'team')).toBe('team')
    expect(accountPanelFor('MENTOR', 'team')).toBe('account')
    expect(accountPanelFor('MENTOR', 'account')).toBe('account')
  })
})
