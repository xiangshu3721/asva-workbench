import { describe, expect, it } from 'vitest'
import { parseDateFromFeishu } from './date-contract.mjs'

describe('parseDateFromFeishu', () => {
  it('accepts Feishu search date text segments', () => {
    expect(parseDateFromFeishu([{ text: '2026-10-31T15:38:18.513Z', type: 'text' }])).toBe('2026-10-31T15:38:18.513Z')
  })

  it('accepts Feishu value/timestamp wrappers', () => {
    expect(parseDateFromFeishu({ value: '2026-10-31T15:38:18.513Z' })).toBe('2026-10-31T15:38:18.513Z')
    expect(parseDateFromFeishu({ timestamp: 1793461098513 })).toBe('2026-10-31T15:38:18.513Z')
  })
})
