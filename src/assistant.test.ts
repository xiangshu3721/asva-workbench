import { describe, expect, it } from 'vitest'
import { queryLocalAssistant } from './assistant'
import { seedDatabase } from './data'

describe('V0.6 read-only AI assistant queries', () => {
  it('answers customer queries from current records', () => {
    const result = queryLocalAssistant(seedDatabase, '查一下林知微')
    expect(result.kind).toBe('CUSTOMER_QUERY')
    expect(result.customerId).toBe('C00001298')
    expect(result.answer).toContain('林知微')
  })

  it('returns structured enrollment records and supports follow-up context', () => {
    const first = queryLocalAssistant(seedDatabase, '上个月觉塑报名了哪些客户？')
    expect(first.kind).toBe('ENROLLMENT_QUERY')
    expect(first.records?.[0]?.name).toBe('林知微')
    const followup = queryLocalAssistant(seedDatabase, '把他们列出来', { lastQuery: first.continuation })
    expect(followup.records?.[0]?.customerId).toBe('C00001298')
  })

  it('calculates recorded revenue without asking the model to invent numbers', () => {
    const result = queryLocalAssistant(seedDatabase, '上个月整体营收多少？')
    expect(result.answer).toContain('¥6,660')
    expect(result.answer).toContain('2 位付费客户')
  })

  it('reports workflow status counts', () => {
    const result = queryLocalAssistant(seedDatabase, '现在有多少待分配预约？')
    expect(result.kind).toBe('STATUS_SUMMARY')
    expect(result.answer).toContain('待分配')
  })
})
