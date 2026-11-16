import { describe, expect, it } from 'vitest'
import { latencyReport, parseLogPage, STAGE_TAG, METRICS } from './collect-understanding-latency.mjs'

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
    expect(report.note).toContain('no matches does not mean zero business calls')
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

  it('rejects unknown JSON shapes rather than claiming no samples', () => {
    expect(() => parseLogPage(JSON.stringify({ message: 'anything including sensitive text' }))).toThrow('LOG_RESPONSE_UNKNOWN_SHAPE')
    expect(() => parseLogPage('unparseable secret payload')).toThrow('LOG_RESPONSE_NOT_JSON')
  })
})
