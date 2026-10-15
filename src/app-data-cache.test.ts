import { describe, expect, it, vi } from 'vitest'
import { createResourceCache } from './app-data-cache'

describe('resource cache', () => {
  it('deduplicates in-flight requests', async () => {
    const cache = createResourceCache()
    let resolve: ((value: string) => void) | undefined
    const loader = vi.fn(() => new Promise<string>((next) => { resolve = next }))

    const first = cache.load('dashboard:staff-1', loader)
    const second = cache.load('dashboard:staff-1', loader)
    await Promise.resolve()
    resolve?.('ready')

    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready'])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('returns fresh data without loading again', async () => {
    const cache = createResourceCache()
    const loader = vi.fn(async () => 'first')

    await cache.load('dashboard:staff-1', loader, { ttlMs: 90_000 })
    await expect(cache.load('dashboard:staff-1', loader, { ttlMs: 90_000 })).resolves.toBe('first')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('keeps stale content available while refreshes', async () => {
    const cache = createResourceCache()
    await cache.load('mentors:staff-1', async () => ['old'])
    let resolve: ((value: string[]) => void) | undefined
    const refresh = cache.refresh('mentors:staff-1', () => new Promise<string[]>((next) => { resolve = next }))

    expect(cache.get<string[]>('mentors:staff-1')).toEqual(['old'])
    await Promise.resolve()
    resolve?.(['new'])
    await refresh
    expect(cache.get<string[]>('mentors:staff-1')).toEqual(['new'])
  })

  it('preserves stale content when background refresh fails', async () => {
    const cache = createResourceCache()
    await cache.load('dashboard:staff-1', async () => ({ total: 3 }))

    await expect(cache.refresh('dashboard:staff-1', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(cache.get<{ total: number }>('dashboard:staff-1')).toEqual({ total: 3 })
    expect(cache.getEntry<{ total: number }>('dashboard:staff-1')?.status).toBe('ready')
  })
})
