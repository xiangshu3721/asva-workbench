import { describe, expect, it } from 'vitest'
import { collectLogPages, latencyReport, parseLogPage, STAGE_TAG, METRICS } from './collect-understanding-latency.mjs'

const valid = (overrides = {}) => Object.fromEntries([
  ['result', 'FRESH'],
  ...METRICS.map((key, i) => [key, i * 10]),
  ...Object.entries(overrides),
])

describe('production read-only consultation timing parser', () => {
  it('extracts only allowed scalar fields from grouped CloudBase logs', () => {
    const clientSecret = 'private-client-secret'
    const result = parseLogPage(JSON.stringify({
      data: [{ request_id: 'private-req-100', logs: [
        { log: `unrelated customer ${clientSecret}` },
        { log: `${STAGE_TAG} ${JSON.stringify({ ...valid(), customerId: 'private-customer', prompt: clientSecret })}` },
      ] }],
      Context: 'fake-cursor',
    }))
    expect(result.cursor).toBe('fake-cursor')
    expect(result.items).toEqual([valid()])
    expect(JSON.stringify(result)).not.toMatch(/private-req|private-client|private-customer/)
  })

  it('marks unexecuted phases null and discards invalid or fabricated records', () => {
    const item = valid({ deepseek_ms: null, terminal_write_ms: null, result: 'STATUS_WRITE_UNKNOWN' })
    const result = parseLogPage(JSON.stringify([{ message: `${STAGE_TAG} ${JSON.stringify(item)}` },
      { message: `${STAGE_TAG} ${JSON.stringify(valid({ queue_wait_ms: -1 }))}` },
      { message: `${STAGE_TAG} ${JSON.stringify(valid({ result: 'CUSTOMER_PRIVATE' }))}` },
    ]))
    expect(result.items).toEqual([item])
  })

  it('keeps absent matches distinct from absent business requests', () => {
    const { items } = parseLogPage(JSON.stringify({ data: [{ log: 'other diagnostic message' }] }))
    expect(items).toHaveLength(0)
    const report = latencyReport(items)
    expect(report.status).toBe('INSUFFICIENT_DATA')
    expect(report.note).toContain('No matches does not mean zero business calls')
  })

  it('uses nearest-rank percentiles only when sufficient non-null samples exist', () => {
    const samples = Array.from({ length: 10 }, (_, i) => valid({ deepseek_ms: (i + 1) * 10 }))
    samples[0].terminal_write_ms = null
    const report = latencyReport(samples)
    expect(report.status).toBe('MEASURED')
    expect(report.metrics.deepseek_ms).toEqual({ n: 10, p50_ms: 50, p90_ms: 90 })
    expect(report.metrics.terminal_write_ms.n).toBe(9)
    expect(report.metrics.terminal_write_ms.p90_ms).toBeNull()
    expect(latencyReport(samples, { truncated: true }).status).toBe('INSUFFICIENT_DATA')
  })

  it('does not combine cache reuse samples with actual generation latency', () => {
    const reused = Array.from({ length: 10 }, () => valid({ result: 'REUSED_FRESH', processing_write_ms: null, deepseek_ms: null, terminal_write_ms: null }))
    const report = latencyReport([...reused, valid()])
    expect(report.observed_metric_entries).toBe(11)
    expect(report.generation_sample_count).toBe(1)
    expect(report.status).toBe('INSUFFICIENT_DATA')
    expect(report.metrics.deepseek_ms.n).toBe(1)
    expect(report.metrics_by_result.REUSED_FRESH.deepseek_ms.n).toBe(0)
    expect(report.result_counts.REUSED_FRESH).toBe(10)
  })

  it('keeps fresh and fallback percentiles separate', () => {
    const fresh = Array.from({ length: 10 }, (_, i) => valid({ deepseek_ms: (i + 1) * 10 }))
    const fallback = Array.from({ length: 10 }, (_, i) => valid({ result: 'STRUCTURED_FALLBACK', deepseek_ms: 1_000 + (i + 1) * 10 }))
    const report = latencyReport([...fresh, ...fallback])
    expect(report.generation_sample_count).toBe(20)
    expect(report.metrics.deepseek_ms).toEqual({ n: 10, p50_ms: 50, p90_ms: 90 })
    expect(report.fallback_metrics.deepseek_ms).toEqual({ n: 10, p50_ms: 1050, p90_ms: 1090 })
  })

  it('paginates without cursor loops and reports an incomplete collection at the cap', () => {
    const pages = [
      JSON.stringify({ data: [{ log: `${STAGE_TAG} ${JSON.stringify(valid())}` }], Context: 'next-1' }),
      JSON.stringify({ data: [{ log: `${STAGE_TAG} ${JSON.stringify(valid({ execution_ms: 99 }))}` }], Context: 'next-2' }),
      JSON.stringify({ data: [{ log: `${STAGE_TAG} ${JSON.stringify(valid({ execution_ms: 199 }))}` }], Context: 'next-3' }),
    ]
    const contexts = []
    const collected = collectLogPages((context) => { contexts.push(context); return pages[contexts.length - 1] })
    expect(contexts).toEqual([null, 'next-1', 'next-2'])
    expect(collected).toMatchObject({ pages: 3, truncated: true })
    expect(collected.items).toHaveLength(3)

    const loop = collectLogPages((context) => JSON.stringify({ data: [{ log: `${STAGE_TAG} ${JSON.stringify(valid())}` }], Context: context || 'loop' }))
    expect(loop).toMatchObject({ pages: 2, truncated: true })
  })

  it('rejects unknown JSON shapes rather than claiming no samples', () => {
    expect(() => parseLogPage(JSON.stringify({ message: 'anything including sensitive text' }))).toThrow('LOG_RESPONSE_UNKNOWN_SHAPE')
    expect(() => parseLogPage('unparseable secret payload')).toThrow('LOG_RESPONSE_NOT_JSON')
  })
})
