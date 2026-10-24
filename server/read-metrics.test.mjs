import { describe, expect, it } from 'vitest'
import { ReadMetrics } from './read-metrics.mjs'

describe('read metrics', () => {
  it('aggregates logical reads, provider requests, retries and latency without identifiers', () => {
    let clock = 0
    const metrics = new ReadMetrics({ now: () => clock })
    const first = metrics.start({ scene: 'A1', mode: 'FULL', table: 'customers' })
    first.providerRequest()
    clock = 12
    first.finish()
    const second = metrics.start({ scene: 'A1', mode: 'TARGETED', table: 'customers' })
    second.providerRequest()
    second.providerRequest({ retry: true })
    clock = 32
    second.finish({ status: 'FEISHU_TIMEOUT' })

    expect(metrics.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scene: 'A1', mode: 'FULL', table: 'customers', logicalReads: 1, providerRequests: 1, retries: 0, failures: 0, latency: { count: 1, p50Ms: 12, p95Ms: 12, maxMs: 12 } }),
      expect.objectContaining({ scene: 'A1', mode: 'TARGETED', table: 'customers', logicalReads: 1, providerRequests: 2, retries: 1, failures: 1, latency: { count: 1, p50Ms: 20, p95Ms: 20, maxMs: 20 } }),
    ]))
  })
})

