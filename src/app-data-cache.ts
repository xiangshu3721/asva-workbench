export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ResourceEntry<T> {
  key: string
  data?: T
  status: ResourceStatus
  updatedAt: number
  promise?: Promise<T>
  error?: unknown
}

export interface ResourceCache {
  get<T>(key: string): T | undefined
  getEntry<T>(key: string): ResourceEntry<T> | undefined
  set<T>(key: string, data: T): void
  invalidate(key: string): void
  invalidatePrefix(prefix: string): void
  load<T>(key: string, loader: () => Promise<T> | T, options?: { ttlMs?: number; force?: boolean }): Promise<T>
  refresh<T>(key: string, loader: () => Promise<T> | T): Promise<T>
}

const hasData = <T>(entry: ResourceEntry<T> | undefined): entry is ResourceEntry<T> & { data: T } => entry?.data !== undefined

export function createResourceCache(): ResourceCache {
  const entries = new Map<string, ResourceEntry<unknown>>()

  const getEntry = <T>(key: string) => entries.get(key) as ResourceEntry<T> | undefined

  const set = <T>(key: string, data: T) => {
    const entry = getEntry<T>(key) || { key, status: 'idle' as ResourceStatus, updatedAt: 0 }
    entry.data = data
    entry.status = 'ready'
    entry.updatedAt = Date.now()
    entry.error = undefined
    entries.set(key, entry)
  }

  const load = <T>(key: string, loader: () => Promise<T> | T, options: { ttlMs?: number; force?: boolean } = {}) => {
    const current = getEntry<T>(key)
    if (current?.promise) return current.promise
    const fresh = hasData(current) && (options.ttlMs === undefined || Date.now() - current.updatedAt < options.ttlMs)
    if (!options.force && fresh) return Promise.resolve(current.data)

    const entry: ResourceEntry<T> = current || { key, status: 'idle', updatedAt: 0 }
    entry.status = 'loading'
    entry.error = undefined
    const request = Promise.resolve().then(loader).then((data) => {
      set(key, data)
      return data
    }).catch((error: unknown) => {
      entry.status = hasData(entry) ? 'ready' : 'error'
      entry.error = error
      throw error
    })
    entry.promise = request
    entries.set(key, entry)
    request.finally(() => {
      if (getEntry<T>(key)?.promise === request) {
        const latest = getEntry<T>(key)
        if (latest) latest.promise = undefined
      }
    }).catch(() => undefined)
    return request
  }

  return {
    get: <T>(key: string) => {
      const entry = getEntry<T>(key)
      return hasData(entry) ? entry.data : undefined
    },
    getEntry,
    set,
    invalidate: (key) => { entries.delete(key) },
    invalidatePrefix: (prefix) => { for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key) },
    load,
    refresh: (key, loader) => load(key, loader, { force: true }),
  }
}
