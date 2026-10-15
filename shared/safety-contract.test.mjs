import { describe, expect, it } from 'vitest'
import { assessSafetyRules, normalizeSafetyAssessment, qualityCheckSafetyAssessment, scanImmediateSafety } from './safety-contract.mjs'
import { buildCustomerSafetyContext, buildSafetyAssessment } from '../server/safety.mjs'
import { SAFETY_FIXTURES } from './safety-fixtures.mjs'

const signal = (overrides = {}) => ({ signal_type: 'SELF_HARM_IDEATION', subject_scope: 'SELF', polarity: 'PRESENT', explicitness: 'IMPLICIT', recency: 'CURRENT', severity: 'MEDIUM', confidence: 'MEDIUM', evidence_refs: ['EVD-1'], short_description: '客户表达近期状态需要确认', details: '', ...overrides })

describe('Safety V1 deterministic contract', () => {
  it('keeps the controlled fixture matrix explicit and non-production', () => {
    expect(SAFETY_FIXTURES.map((item) => item.id)).toEqual(expect.arrayContaining(['R0_CLEAR', 'R1_LOW', 'R2_PASSIVE_DEATH_WISH', 'R3_CURRENT_SELF_HARM', 'R4_IMMINENT', 'HARM_TO_OTHERS', 'NEGATED', 'THIRD_PARTY', 'HISTORICAL', 'CONFLICT', 'SPARSE_UNKNOWN']))
    expect(SAFETY_FIXTURES.length).toBe(11)
  })
  it('flags possible safety language without deciding a risk level', () => {
    expect(scanImmediateSafety('我最近不想活了')[0]).toMatchObject({ immediate_safety_flag: 'POSSIBLE', subject_scope: 'SELF', polarity: 'PRESENT' })
    expect(scanImmediateSafety('我朋友说想死')[0].subject_scope).toBe('OTHER')
    expect(scanImmediateSafety('客户提到朋友最近想死')[0]).toMatchObject({ subject_scope: 'OTHER', recency: 'RECENT' })
    expect(scanImmediateSafety('客户说今晚有自杀计划')[0].recency).toBe('CURRENT')
    expect(scanImmediateSafety('我以前想过自杀')[0].recency).toBe('HISTORICAL')
    expect(scanImmediateSafety('我没有想过自杀')[0]).toMatchObject({ polarity: 'NEGATED', immediate_safety_flag: 'POSSIBLE' })
    expect(assessSafetyRules({ signals: [signal({ polarity: 'UNCERTAIN', recency: 'HISTORICAL' })], safetyDataSufficiency: 'ADEQUATE' }).risk_level).toBe('R0')
  })

  it.each([
    ['R4', signal({ signal_type: 'SUICIDAL_INTENT_OR_PLAN', explicitness: 'EXPLICIT', details: '今晚有计划、意图和可用工具' })],
    ['R3', signal({ explicitness: 'EXPLICIT' })],
    ['R2', signal({ explicitness: 'IMPLICIT' })],
  ])('maps %s from server rules', (expected, item) => {
    expect(assessSafetyRules({ signals: [item], safetyDataSufficiency: 'ADEQUATE' }).risk_level).toBe(expected)
  })

  it('keeps insufficient data unknown and blocks commercial automation', () => {
    const rules = assessSafetyRules({ signals: [], safetyDataSufficiency: 'INSUFFICIENT' })
    expect(rules.risk_level).toBe('UNKNOWN')
    expect(rules.commercial_block).toBe('SOFT_BLOCK')
    expect(rules.requires_human_review).toBe(false)
  })

  it('grounds candidates and does not accept unreferenced safety claims', () => {
    const normalized = normalizeSafetyAssessment({ risk_level: 'R3', commercial_block: 'HARD_BLOCK', safety_signals: [signal(), signal({ evidence_refs: ['NOPE'] })] }, { evidenceRefs: ['EVD-1'] })
    expect(normalized.safety_signals).toHaveLength(1)
    expect(qualityCheckSafetyAssessment(normalized, { evidenceRefs: ['EVD-1'] }).ok).toBe(true)
  })

  it('builds a minimized context and deterministic assessment', () => {
    const customer = { id: 'CUS-1', profileVersion: 1, name: '不应发送', phone: '15000000000', wechat: 'hidden', profileFields: { current_core_issue: '最近睡眠很差', city: '杭州' } }
    const evidence = [{ id: 'EVD-1', customerId: 'CUS-1', sourceId: 'SRC-1', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', fieldKey: 'sleep', displayText: '最近睡眠很差', sourceExcerpt: '最近睡眠很差', confidence: 0.9, reviewStatus: 'CONFIRMED' }]
    const context = buildCustomerSafetyContext({ customer, evidenceItems: evidence, sourceRecords: [{ id: 'SRC-1', customerId: 'CUS-1', title: '近期记录' }], conflicts: [] })
    expect(context.current_snapshot.phone).toBeUndefined()
    expect(JSON.stringify(context)).not.toContain('不应发送')
    const result = buildSafetyAssessment({ context, candidates: { signals: [], critical_unknowns: ['当前是否存在自伤想法'] } })
    expect(result.assessment.risk_level).toBe('UNKNOWN')
    expect(result.assessment.critical_unknowns).toContain('当前是否存在自伤想法')
  })

  it('keeps the Qinghe synthetic safety fixture clear when the model points self-harm at income evidence', () => {
    const customer = { id: 'CUS-QINGHE', profileVersion: 1, profileFields: {} }
    const evidence = [
      { id: 'E-INCOME', customerId: customer.id, sourceId: 'S-QINGHE', evidenceType: 'FACT', semanticKind: 'RESOURCE', fieldKey: 'income_range', displayText: '月收入约4～5万元', sourceExcerpt: '月收入约4～5万元', confidence: 0.98, reviewStatus: 'CONFIRMED' },
      { id: 'E-SLEEP', customerId: customer.id, sourceId: 'S-QINGHE', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', fieldKey: 'sleep', displayText: '睡眠整体稳定', sourceExcerpt: '睡眠整体稳定', confidence: 0.98, reviewStatus: 'CONFIRMED' },
      { id: 'E-FUNCTION', customerId: customer.id, sourceId: 'S-QINGHE', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', fieldKey: 'routine', displayText: '基本生活/工作功能正常', sourceExcerpt: '基本生活/工作功能正常', confidence: 0.98, reviewStatus: 'CONFIRMED' },
      { id: 'E-NO-SELF', customerId: customer.id, sourceId: 'S-QINGHE', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', displayText: '无自伤念头', sourceExcerpt: '无自伤念头', confidence: 0.98, reviewStatus: 'CONFIRMED' },
      { id: 'E-NO-SUICIDAL', customerId: customer.id, sourceId: 'S-QINGHE', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', displayText: '无自杀念头', sourceExcerpt: '无自杀念头', confidence: 0.98, reviewStatus: 'CONFIRMED' },
      { id: 'E-NO-HARM', customerId: customer.id, sourceId: 'S-QINGHE', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', displayText: '无伤人念头', sourceExcerpt: '无伤人念头', confidence: 0.98, reviewStatus: 'CONFIRMED' },
      { id: 'E-NO-REALITY', customerId: customer.id, sourceId: 'S-QINGHE', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', fieldKey: 'current_barriers', displayText: '无明显现实安全风险', sourceExcerpt: '无明显现实安全风险', confidence: 0.98, reviewStatus: 'CONFIRMED' },
    ]
    const context = buildCustomerSafetyContext({ customer, evidenceItems: evidence, sourceRecords: [{ id: 'S-QINGHE', customerId: customer.id, title: '清和合成测试资料' }], conflicts: [] })
    const result = buildSafetyAssessment({ context, candidates: { signals: [signal({ evidence_refs: ['E-INCOME'] }), signal({ evidence_refs: ['E-NO-SELF'] })], critical_unknowns: [] } })
    expect(result.assessment.safety_signals.filter((item) => item.polarity === 'PRESENT' && item.signal_type === 'SELF_HARM_IDEATION')).toHaveLength(0)
    expect(result.assessment.risk_level).toBe('R0')
    expect(result.assessment.service_gate).not.toBe('STABILIZE_FIRST')
    expect(result.assessment.commercial_block).not.toBe('HARD_BLOCK')
  })

  it('requires direct safety semantics for a high-risk positive signal', () => {
    const customer = { id: 'CUS-TRUE', profileVersion: 1, profileFields: {} }
    const evidence = [{ id: 'E-TRUE', customerId: customer.id, sourceId: 'S-TRUE', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', displayText: '昨晚我有伤害自己的念头', sourceExcerpt: '昨晚我有伤害自己的念头', confidence: 0.98, reviewStatus: 'CONFIRMED' }]
    const context = buildCustomerSafetyContext({ customer, evidenceItems: evidence, sourceRecords: [{ id: 'S-TRUE', customerId: customer.id }], conflicts: [] })
    const result = buildSafetyAssessment({ context, candidates: { signals: [signal({ explicitness: 'EXPLICIT', evidence_refs: ['E-TRUE'] })], critical_unknowns: [] } })
    expect(result.assessment.safety_signals.some((item) => item.signal_type === 'SELF_HARM_IDEATION' && item.polarity === 'PRESENT')).toBe(true)
    expect(result.assessment.risk_level).toBe('R3')
    expect(result.assessment.commercial_block).toBe('HARD_BLOCK')
  })

  it('rejects cross-customer safety evidence before deterministic risk rules', () => {
    const customer = { id: 'CUS-CURRENT', profileVersion: 1, profileFields: {} }
    const evidence = [{ id: 'E-OTHER', customerId: 'CUS-OTHER', sourceId: 'S-OTHER', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', displayText: '昨晚我有伤害自己的念头', sourceExcerpt: '昨晚我有伤害自己的念头', confidence: 0.98, reviewStatus: 'CONFIRMED' }]
    const context = buildCustomerSafetyContext({ customer, evidenceItems: evidence, sourceRecords: [{ id: 'S-OTHER', customerId: 'CUS-OTHER' }], conflicts: [] })
    const result = buildSafetyAssessment({ context, candidates: { signals: [signal({ explicitness: 'EXPLICIT', evidence_refs: ['E-OTHER'] })], critical_unknowns: [] } })
    expect(result.assessment.safety_signals).toHaveLength(0)
    expect(result.assessment.risk_level).not.toBe('R3')
    expect(result.assessment.commercial_block).not.toBe('HARD_BLOCK')
  })

  it('keeps ambiguous distress as unknown without inventing self-harm', () => {
    const customer = { id: 'CUS-DISTRESS', profileVersion: 1, profileFields: {} }
    const evidence = [{ id: 'E-DISTRESS', customerId: customer.id, sourceId: 'S-DISTRESS', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', displayText: '最近很低落，很想躲起来，什么都不想处理', sourceExcerpt: '最近很低落，很想躲起来，什么都不想处理', confidence: 0.98, reviewStatus: 'CONFIRMED' }]
    const context = buildCustomerSafetyContext({ customer, evidenceItems: evidence, sourceRecords: [{ id: 'S-DISTRESS', customerId: customer.id }], conflicts: [] })
    const result = buildSafetyAssessment({ context, candidates: { signals: [], critical_unknowns: ['是否存在自伤或自杀想法'] } })
    expect(result.assessment.safety_signals.some((item) => item.signal_type === 'SELF_HARM_IDEATION')).toBe(false)
    expect(result.assessment.risk_level).toBe('UNKNOWN')
  })
})
