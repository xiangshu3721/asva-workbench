import { describe, expect, it } from 'vitest'
import { buildCustomerUnderstandingContext, createLocalCustomerUnderstanding, normalizeCustomerUnderstanding, qualityCheckCustomerUnderstanding, understandingInputFingerprint } from './customer-understanding.mjs'

const customer = { id: 'CUS-1', profileVersion: 2, need: '最近工作节奏很乱', helpExpectation: '先找到能执行的一步', profileFields: { city: '杭州', occupation: '自由职业', current_goal: '稳定作息', phone: '15000000000' } }
const fact = (overrides = {}) => ({ id: 'EVD-1', sourceId: 'SRC-1', customerId: 'CUS-1', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', fieldKey: 'current_goal', standardValue: '稳定作息', displayText: '目前希望稳定作息', sourceExcerpt: '我希望先稳定作息', confidence: 0.9, reviewStatus: 'CONFIRMED', ...overrides })

describe('CustomerUnderstandingV1 contract', () => {
  it('builds a structured, redacted context with current and historical separation', () => {
    const context = buildCustomerUnderstandingContext({ customer, evidenceItems: [fact(), fact({ id: 'EVD-2', semanticKind: 'EVENT', fieldKey: 'occupation', displayText: '后来转为自由职业', occurredAt: '2025' }), fact({ id: 'EVD-3', evidenceType: 'HYPOTHESIS', displayText: '可能存在某种人格类型', reviewStatus: 'CONFIRMED' })] })
    expect(context.current_snapshot.phone).toBeUndefined()
    expect(context.current_goals[0].evidence_ids).toContain('EVD-1')
    expect(context.top_life_events[0].evidence_ids).toContain('EVD-2')
    expect(context.working_hypotheses[0].evidence_ids).toContain('EVD-3')
    expect(context.evidence_refs.map((item) => item.evidence_id)).toEqual(expect.arrayContaining(['EVD-1', 'EVD-2', 'EVD-3']))
  })

  it('changes fingerprint when confirmed evidence changes', () => {
    expect(understandingInputFingerprint({ customer, evidenceItems: [fact()] })).not.toBe(understandingInputFingerprint({ customer, evidenceItems: [fact({ id: 'EVD-2' })] }))
  })

  it('rejects unsupported diagnosis and unknown evidence references', () => {
    const normalized = normalizeCustomerUnderstanding({ one_line_understanding: { text: '这是抑郁症', evidence_ids: ['NOPE'], confidence: 'HIGH', type: 'SYNTHESIS' }, knowledge_gaps: [{ text: '待确认' }] }, { evidenceIds: ['EVD-1'] })
    const result = qualityCheckCustomerUnderstanding(normalized, { evidenceIds: ['EVD-1'] })
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining(['UNSUPPORTED_DIAGNOSIS', 'UNKNOWN_EVIDENCE_REF']))
  })

  it('keeps an explicit unknown path in the deterministic fallback', () => {
    const local = createLocalCustomerUnderstanding({ generated_at: '2026-01-01T00:00:00.000Z', current_needs: [], resources: [], top_life_events: [], coverage_gaps: ['当前状态'], evidence_refs: [] })
    expect(local.knowledge_gaps.length).toBeGreaterThan(0)
    expect(local.one_line_understanding.confidence).toBe('LOW')
  })
})
