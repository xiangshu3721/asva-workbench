export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1
export const SESSION_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000

type StoredSnapshot<T> = {
  data: T
  savedAt: number
  schemaVersion: number
}

function sessionStorageSafe(): Storage | null {
  if (typeof window === 'undefined') return null
  try { return window.sessionStorage } catch { return null }
}

export function readSessionSnapshot<T>(key: string, maxAgeMs = SESSION_SNAPSHOT_MAX_AGE_MS): T | undefined {
  const storage = sessionStorageSafe()
  if (!storage) return undefined
  try {
    const raw = storage.getItem(key)
    if (!raw) return undefined
    const snapshot = JSON.parse(raw) as Partial<StoredSnapshot<T>>
    if (snapshot.schemaVersion !== SESSION_SNAPSHOT_SCHEMA_VERSION || !snapshot.savedAt || Date.now() - snapshot.savedAt > maxAgeMs) {
      storage.removeItem(key)
      return undefined
    }
    return snapshot.data
  } catch {
    return undefined
  }
}

export function writeSessionSnapshot<T>(key: string, data: T): void {
  const storage = sessionStorageSafe()
  if (!storage) return
  try { storage.setItem(key, JSON.stringify({ data, savedAt: Date.now(), schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION } satisfies StoredSnapshot<T>)) } catch {
    // Session snapshots are optional performance hints, never a data source of truth.
  }
}

export function clearSessionSnapshots(): void {
  const storage = sessionStorageSafe()
  if (!storage) return
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (key?.startsWith('asva:session:')) storage.removeItem(key)
    }
  } catch {
    // Storage may be unavailable or restricted; the in-memory cache is still cleared by the caller.
  }
}
