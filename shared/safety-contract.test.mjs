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
})
