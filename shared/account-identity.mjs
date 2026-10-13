export function accountAvatar(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  const first = Array.from(value).find((character) => /[\p{L}\p{N}]/u.test(character))
  return first ? first.toUpperCase() : '客'
}

export function accountRoleLabel(role) {
  return role === 'MENTOR' ? '导师' : '管理员 · 经营与服务设计'
}

export function accountPanelFor(role, panel) {
  return role === 'ADMIN' && panel === 'team' ? 'team' : 'account'
}
