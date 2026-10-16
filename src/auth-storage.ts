export const ACCESS_TOKEN_STORAGE_KEY = 'asva_access_token'
export const LAST_LOGIN_PHONE_STORAGE_KEY = 'asva:last-login-phone'
const LEGACY_ACCESS_TOKEN_STORAGE_KEY = 'asva_session_token'

function storage(name: 'localStorage' | 'sessionStorage'): Storage | null {
  if (typeof window === 'undefined') return null
  try { return window[name] } catch { return null }
}

export function readAccessToken(): string | null {
  const local = storage('localStorage')
  const session = storage('sessionStorage')
  const current = local?.getItem(ACCESS_TOKEN_STORAGE_KEY)
  if (current) {
    session?.removeItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY)
    return current
  }
  const legacy = session?.getItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY)
  if (!legacy) return null
  try {
    local?.setItem(ACCESS_TOKEN_STORAGE_KEY, legacy)
    session?.removeItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY)
  } catch {
    // Keep the current session token usable if browser storage is temporarily unavailable.
  }
  return legacy
}

export function writeAccessToken(token: string) {
  storage('localStorage')?.setItem(ACCESS_TOKEN_STORAGE_KEY, token)
  storage('sessionStorage')?.removeItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY)
}

export function clearAccessToken() {
  storage('localStorage')?.removeItem(ACCESS_TOKEN_STORAGE_KEY)
  storage('sessionStorage')?.removeItem(LEGACY_ACCESS_TOKEN_STORAGE_KEY)
}

export function readLastLoginPhone(): string {
  return storage('localStorage')?.getItem(LAST_LOGIN_PHONE_STORAGE_KEY) || ''
}

export function writeLastLoginPhone(phone: string) {
  const normalized = phone.trim()
  if (normalized) storage('localStorage')?.setItem(LAST_LOGIN_PHONE_STORAGE_KEY, normalized)
}

export type AccessTokenIdentity = { staffId: string; authVersion: number; expiresAt: number }

export function readAccessTokenIdentity(token = readAccessToken()): AccessTokenIdentity | undefined {
  if (!token) return undefined
  try {
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4))) as { sub?: string; auth_version?: number; exp?: number }
    if (!claims.sub) return undefined
    return { staffId: String(claims.sub), authVersion: Number(claims.auth_version || 0), expiresAt: Number(claims.exp || 0) }
  } catch {
    return undefined
  }
}
