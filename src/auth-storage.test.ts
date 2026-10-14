import { afterEach, describe, expect, it } from 'vitest'
import { ACCESS_TOKEN_STORAGE_KEY, clearAccessToken, readAccessToken, writeAccessToken } from './auth-storage'

function installStorage() {
  const local = new Map<string, string>()
  const session = new Map<string, string>()
  const make = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: make(local), sessionStorage: make(session) } })
  return { local, session }
}

afterEach(() => { delete (globalThis as { window?: unknown }).window })

describe('persistent access token storage', () => {
  it('migrates the legacy session token once and keeps one canonical key', () => {
    const { local, session } = installStorage()
    session.set('asva_session_token', 'legacy-token')
    expect(readAccessToken()).toBe('legacy-token')
    expect(local.get(ACCESS_TOKEN_STORAGE_KEY)).toBe('legacy-token')
    expect(session.has('asva_session_token')).toBe(false)
  })

  it('writes and clears the formal token in localStorage only', () => {
    const { local, session } = installStorage()
    session.set('asva_session_token', 'old-token')
    writeAccessToken('new-token')
    expect(local.get(ACCESS_TOKEN_STORAGE_KEY)).toBe('new-token')
    expect(session.has('asva_session_token')).toBe(false)
    clearAccessToken()
    expect(local.has(ACCESS_TOKEN_STORAGE_KEY)).toBe(false)
    expect(session.has('asva_session_token')).toBe(false)
  })
})
