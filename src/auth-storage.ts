export const ACCESS_TOKEN_STORAGE_KEY = 'asva_access_token'
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
