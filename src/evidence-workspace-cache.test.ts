import { describe, expect, it, vi } from 'vitest'
import { createEvidenceWorkspaceCache } from './evidence-workspace-cache'

type Workspace = { customerId: string; version: number }

describe('Evidence workspace loading state', () => {
  it('FIRST_EVIDENCE_LOAD loads once and SAME_CUSTOMER_RERENDER uses the cache', async () => {
    const load = vi.fn(async (customerId: string): Promise<Workspace> => ({ customerId, version: 1 }))
    const cache = createEvidenceWorkspaceCache(load)

    await expect(cache.load('CUS-A')).resolves.toEqual({ customerId: 'CUS-A', version: 1 })
    await expect(cache.load('CUS-A')).resolves.toEqual({ customerId: 'CUS-A', version: 1 })

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('SAME_CUSTOMER_CONCURRENT_REQUEST dedupes the in-flight request', async () => {
    let resolveRequest: ((value: Workspace) => void) | undefined
    const load = vi.fn(() => new Promise<Workspace>((resolve) => { resolveRequest = resolve }))
    const cache = createEvidenceWorkspaceCache(load)
    const first = cache.load('CUS-A')
    const second = cache.load('CUS-A')

    expect(load).toHaveBeenCalledTimes(1)
    resolveRequest?.({ customerId: 'CUS-A', version: 1 })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { customerId: 'CUS-A', version: 1 },
      { customerId: 'CUS-A', version: 1 },
    ])
  })

  it('CUSTOMER_A_TO_B and CUSTOMER_B_BACK_TO_A keep each customer data separate', async () => {
    const load = vi.fn(async (customerId: string): Promise<Workspace> => ({ customerId, version: 1 }))
    const cache = createEvidenceWorkspaceCache(load)

    await cache.load('CUS-A')
    await cache.load('CUS-B')
    await expect(cache.load('CUS-A')).resolves.toEqual({ customerId: 'CUS-A', version: 1 })

    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.getCached('CUS-B')).toEqual({ customerId: 'CUS-B', version: 1 })
  })

  it('BACKGROUND_REFRESH keeps old content until the refresh succeeds', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ customerId: 'CUS-A', version: 1 } satisfies Workspace)
      .mockResolvedValueOnce({ customerId: 'CUS-A', version: 2 } satisfies Workspace)
    const cache = createEvidenceWorkspaceCache(load)

    await cache.load('CUS-A')
    const refresh = cache.load('CUS-A', { refresh: true })
    expect(cache.getCached('CUS-A')).toEqual({ customerId: 'CUS-A', version: 1 })
    await refresh
    expect(cache.getCached('CUS-A')).toEqual({ customerId: 'CUS-A', version: 2 })
  })

  it('BACKGROUND_REFRESH_FAIL keeps the existing content cached', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ customerId: 'CUS-A', version: 1 } satisfies Workspace)
      .mockRejectedValueOnce(new Error('temporary failure'))
    const cache = createEvidenceWorkspaceCache(load)

    await cache.load('CUS-A')
    await expect(cache.load('CUS-A', { refresh: true })).rejects.toThrow('temporary failure')
    expect(cache.getCached('CUS-A')).toEqual({ customerId: 'CUS-A', version: 1 })
  })
})
