import { describe, expect, it } from 'vitest'
import { applyAbilityEvidenceGate, applyWillingnessEvidenceGate, buildCustomerSalesContext, commercialSignalsForEvidence, createLocalCustomerSalesUnderstanding, historicalSalesRecords, normalizeCustomerSalesUnderstanding, qualityCheckCustomerSalesUnderstanding } from './customer-sales-understanding.mjs'

const evidence = (overrides = {}) => ({ id: 'EVD-1', sourceId: 'SRC-1', customerId: 'CUS-1', evidenceType: 'SELF_MEANING', semanticKind: 'NEED', fieldKey: 'current_core_issue', standardValue: '最近工作和关系都很累', displayText: '客户明确说最近工作和关系都很累', sourceExcerpt: '我最近工作和关系都很累', confidence: 0.9, reviewStatus: 'CONFIRMED', ...overrides })

describe('CustomerSalesUnderstandingV1 contract', () => {
  it('keeps high pain separate from commercial readiness', () => {
    const value = normalizeCustomerSalesUnderstanding({ pain_points: [{ title: '当前压力很大', severity: 'HIGH', confidence: 'HIGH', evidence_ids: ['EVD-1'] }], willingness_to_pay: { level: 'LOW', evidence_ids: ['EVD-1'] }, ability_to_pay: { level: 'UNKNOWN' } }, { evidenceIds: ['EVD-1'] })
    const quality = qualityCheckCustomerSalesUnderstanding(value, { evidenceIds: ['EVD-1'], hasStrongPaymentSignal: false })
    expect(value.pain_points[0].severity).toBe('HIGH')
    expect(value.willingness_to_pay.level).toBe('LOW')
    expect(quality.ok).toBe(true)
  })

  it('forces Stage5 stabilize rules to pause sales', () => {
    const value = normalizeCustomerSalesUnderstanding({ strategy: 'COGNITIVE_GROWTH_READY', sales_timing: 'HIGH_READINESS' }, { safetyAssessment: { service_gate: 'STABILIZE_FIRST', commercial_block: 'HARD_BLOCK', next_action: '先确认当前状态' } })
    expect(value.strategy).toBe('STABILIZE_BEFORE_SALE')
    expect(value.sales_timing).toBe('PAUSE')
    expect(value.do_not_do.join('')).toContain('高压力销售')
  })

  it('accepts a strong payment signal for willingness only when grounded', () => {
    const value = normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'HIGH', explanation: '客户询问价格并明确准备付款', evidence_ids: ['EVD-1'] } }, { evidenceIds: ['EVD-1'] })
    expect(qualityCheckCustomerSalesUnderstanding(value, { evidenceIds: ['EVD-1'], hasStrongPaymentSignal: true }).ok).toBe(true)
    expect(value.willingness_to_pay.level).toBe('HIGH')
  })

  it('keeps willingness and ability unknown without financial evidence', () => {
    const value = normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'HIGH' }, ability_to_pay: { level: 'MEDIUM' } }, { evidenceIds: [] })
    expect(value.willingness_to_pay.level).toBe('UNKNOWN')
    expect(value.ability_to_pay.level).toBe('UNKNOWN')
  })

  it('does not treat enrollment alone as paid amount', () => {
    const context = buildCustomerSalesContext({ customer: { id: 'CUS-1', profileVersion: 1, profileFields: {} }, evidenceItems: [evidence()], enrollments: [{ id: 'ENR-1', customerId: 'CUS-1', productId: 'P-1', paid: false, amount: Number.NaN, paymentStatus: 'UNRECORDED', status: '学习中', enrolledAt: '2026-01-01' }], products: [{ id: 'P-1', name: '课程 A' }], sourceRecords: [], conflicts: [] })
    expect(context.paid_history_count).toBe(0)
    expect(context.historical_enrollments[0].payment_status).toBe('UNRECORDED')
  })

  it('normalizes financial evidence into stable categories with provenance', () => {
    const financial = [
      evidence({ id: 'E-INCOME', displayText: '过去3个月平均月收入约7000～9000元', sourceExcerpt: '过去3个月平均月收入约7000～9000元' }),
      evidence({ id: 'E-EXPENSE', displayText: '固定支出约6000元', sourceExcerpt: '固定支出约6000元' }),
      evidence({ id: 'E-SAVINGS', displayText: '可动用储蓄约1万元', sourceExcerpt: '可动用储蓄约1万元' }),
      evidence({ id: 'E-SUPPORT', displayText: '没有持续家庭经济支持', sourceExcerpt: '没有持续家庭经济支持' }),
      evidence({ id: 'E-BUDGET', displayText: '几千块的支出都要认真考虑', sourceExcerpt: '现在几千块的支出我都要认真考虑' }),
    ]
    const signals = commercialSignalsForEvidence(financial)
    expect(signals.financialEvidenceByCategory.income).toHaveLength(1)
    expect(signals.financialEvidenceByCategory.expense).toHaveLength(2)
    expect(signals.financialEvidenceByCategory.savings).toHaveLength(1)
    expect(signals.financialEvidenceByCategory.financialSupport).toHaveLength(1)
    expect(signals.financialEvidenceByCategory.budget).toHaveLength(1)
    expect(signals.financialEvidenceByCategory.cashflowPressure).toHaveLength(1)
    expect(signals.financialEvidence[0]).toMatchObject({ evidence_id: 'E-INCOME', source_record_id: 'SRC-1', quote: expect.any(String) })
    const context = buildCustomerSalesContext({ customer: { id: 'CUS-1', profileVersion: 1, profileFields: {} }, evidenceItems: financial, sourceRecords: [], conflicts: [] })
    expect(context.financial_evidence.length).toBeGreaterThan(0)
    expect(context.financial_evidence_by_category.income[0].evidence_id).toBe('E-INCOME')
  })

  it('does not infer financial ability from occupation or city alone', () => {
    const nonFinancial = [
      evidence({ id: 'E-OCCUPATION', fieldKey: 'occupation', displayText: '职业：合伙人', sourceExcerpt: '她是一名合伙人' }),
      evidence({ id: 'E-CITY', fieldKey: 'city', displayText: '城市：杭州', sourceExcerpt: '目前住在杭州' }),
    ]
    const signals = commercialSignalsForEvidence(nonFinancial)
    expect(signals.financialEvidence).toEqual([])
    expect(buildCustomerSalesContext({ customer: { id: 'CUS-1', profileVersion: 1, profileFields: {} }, evidenceItems: nonFinancial }).financial_evidence).toEqual([])
  })

  it('keeps sparse customers conservative and discovery-oriented', () => {
    const value = createLocalCustomerSalesUnderstanding({ customer_snapshot: { context_density: { classification: 'SPARSE' } }, current_needs: [], current_goals: [], evidence_refs: [], paid_history_count: 0 })
    expect(value.strategy).toBe('DISCOVER_BEFORE_SALE')
    expect(value.sales_timing).toBe('NURTURE')
    expect(value.willingness_to_pay.level).toBe('UNKNOWN')
    expect(value.ability_to_pay.level).toBe('UNKNOWN')
  })

  it('caps sparse commercial insights without filling empty context', () => {
    const value = normalizeCustomerSalesUnderstanding({
      pain_points: [{ title: '一' }, { title: '二' }, { title: '三' }],
      aspirations: [{ title: '一' }, { title: '二' }, { title: '三' }],
    }, { contextDensity: 'SPARSE' })
    expect(value.pain_points).toHaveLength(2)
    expect(value.aspirations).toHaveLength(2)
  })

  it('rejects diagnosis and exploitative sales language', () => {
    const value = normalizeCustomerSalesUnderstanding({ summary: '利用客户焦虑逼单，这是抑郁症', evidence_ids: ['EVD-1'] }, { evidenceIds: ['EVD-1'] })
    const quality = qualityCheckCustomerSalesUnderstanding(value, { evidenceIds: ['EVD-1'] })
    expect(quality.ok).toBe(false)
    expect(quality.errors).toEqual(expect.arrayContaining(['UNSUPPORTED_DIAGNOSIS', 'EXPLOITATIVE_LANGUAGE']))
  })

  it('allows safety guidance that explicitly prohibits exploitative sales language', () => {
    const value = normalizeCustomerSalesUnderstanding({ do_not_do: ['不要逼单，不制造焦虑，不用高客单话术', '不要在安全门禁下推进任何销售、报价或逼单'] })
    const quality = qualityCheckCustomerSalesUnderstanding(value, { evidenceIds: [] })
    expect(quality.ok).toBe(true)
  })

  it('does not invent unsupported deep fear', () => {
    const value = normalizeCustomerSalesUnderstanding({ pain_points: [{ title: '被抛弃恐惧', confidence: 'HIGH' }] })
    expect(qualityCheckCustomerSalesUnderstanding(value, { evidenceIds: [] }).errors).toContain('UNGROUNDED_COMMERCIAL_INSIGHT')
  })

  it('builds history deterministically from enrollments and services only', () => {
    const history = historicalSalesRecords({ enrollments: [{ productId: 'P-1', status: '学习中', paymentStatus: 'PAID', paid: true, enrolledAt: '2026-01-01' }], products: [{ id: 'P-1', name: '课程 A' }], sessions: [{ topic: '首次服务', type: '跟进反馈', date: '2026-01-05', note: '已完成' }] })
    expect(history.enrollmentHistory[0].name).toBe('课程 A')
    expect(history.enrollmentHistory[0].payment_status).toBe('PAID')
    expect(history.serviceHistory[0].name).toBe('首次服务')
  })

  it('does not use intended course as historical enrollment', () => {
    const history = historicalSalesRecords({ enrollments: [], products: [{ id: 'P-1', name: '意向课程' }] })
    expect(history.enrollmentHistory).toEqual([])
  })

  it('downgrades model MEDIUM to UNKNOWN without payment evidence', () => {
    const value = normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'MEDIUM', explanation: '付费意愿较强' } })
    const finalValue = applyWillingnessEvidenceGate(value, { evidenceItems: [] })
    expect(finalValue.willingness_to_pay.level).toBe('UNKNOWN')
    expect(finalValue.willingness_to_pay.explanation).toContain('没有足够可靠')
    expect(finalValue.willingness_to_pay.positive_signals).toEqual([])
  })

  it('keeps distress-only evidence at UNKNOWN', () => {
    const finalValue = applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'MEDIUM' } }), { evidenceItems: [evidence({ displayText: '客户最近非常焦虑、失眠，迫切想改变' })] })
    expect(finalValue.willingness_to_pay.level).toBe('UNKNOWN')
  })

  it('requires willingness plus a real service behavior for MEDIUM', () => {
    const willing = evidence({ id: 'EVD-W', displayText: '客户愿意为解决问题投入费用' })
    const helpSeeking = evidence({ id: 'EVD-H', displayText: '客户希望进一步了解如何获得帮助' })
    expect(applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'UNKNOWN' } }), { evidenceItems: [willing] }).willingness_to_pay.level).toBe('UNKNOWN')
    expect(applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'UNKNOWN' } }), { evidenceItems: [willing, helpSeeking] }).willingness_to_pay.level).toBe('MEDIUM')
  })

  it('recognizes learning how the service works as auxiliary service behavior', () => {
    const willing = evidence({ id: 'EVD-W', displayText: '如果能帮到我，我愿意花一些钱' })
    const service = evidence({ id: 'EVD-S', displayText: '我想了解服务方式' })
    const result = applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'UNKNOWN' } }), { evidenceItems: [willing, service] })
    expect(result.willingness_to_pay.level).toBe('MEDIUM')
    expect(result.willingness_to_pay.evidence_ids).toEqual(expect.arrayContaining(['EVD-W', 'EVD-S']))
  })

  it('grounds Qinghe financial context and recognizes strong willingness signals', () => {
    const qinghe = [
      evidence({ id: 'Q-INCOME', displayText: '月收入约4—5万元', sourceExcerpt: '我的月收入约4—5万元' }),
      evidence({ id: 'Q-SAVINGS', displayText: '流动储蓄约30万元', sourceExcerpt: '目前有流动储蓄约30万元' }),
      evidence({ id: 'Q-BUDGET', displayText: '每年成长预算3—5万元', sourceExcerpt: '每年有3—5万元成长预算' }),
      evidence({ id: 'Q-INVEST', displayText: '我明确愿意投入', sourceExcerpt: '如果合适，我明确愿意投入' }),
      evidence({ id: 'Q-PRICE', displayText: '主动询问价格和付款方式', sourceExcerpt: '请问价格和付款方式是什么' }),
      evidence({ id: 'Q-START', displayText: '询问开始时间', sourceExcerpt: '什么时候可以开始' }),
    ]
    const signals = commercialSignalsForEvidence(qinghe)
    expect(signals.financialEvidenceByCategory.income).toHaveLength(1)
    expect(signals.financialEvidenceByCategory.savings).toHaveLength(1)
    expect(signals.financialEvidenceByCategory.budget).toHaveLength(1)
    expect(signals.financialEvidence.every((item) => item.evidence_id && item.source_record_id && item.quote && item.fact)).toBe(true)
    const result = applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'UNKNOWN' } }), { evidenceItems: qinghe })
    expect(result.willingness_to_pay.level).toBe('HIGH')
    expect(result.willingness_to_pay.evidence_ids).toEqual(expect.arrayContaining(['Q-INVEST', 'Q-PRICE', 'Q-START']))
  })

  it('allows HIGH only for a clear price or payment inquiry', () => {
    const price = evidence({ displayText: '客户主动询问价格和付款方式' })
    const finalValue = applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'UNKNOWN' } }), { evidenceItems: [price] })
    expect(finalValue.willingness_to_pay.level).toBe('HIGH')
    expect(finalValue.willingness_to_pay.evidence_ids).toContain('EVD-1')
  })

  it('does not treat an explicit absence of price inquiry as HIGH', () => {
    const absent = evidence({ displayText: '没有主动询问价格、报名或付款' })
    const finalValue = applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'HIGH' } }), { evidenceItems: [absent] })
    expect(finalValue.willingness_to_pay.level).toBe('UNKNOWN')
  })

  it('allows LOW only for explicit refusal', () => {
    const refusal = evidence({ displayText: '客户明确表示当前不会投入费用，只接受免费方式' })
    expect(applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'MEDIUM' } }), { evidenceItems: [refusal] }).willingness_to_pay.level).toBe('LOW')
  })

  it('keeps no evidence at UNKNOWN', () => {
    expect(applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding({ willingness_to_pay: { level: 'HIGH' } }), { evidenceItems: [] }).willingness_to_pay.level).toBe('UNKNOWN')
  })

  it('does not let high pain increase willingness', () => {
    const pain = evidence({ displayText: '客户失眠、焦虑，当前压力非常大' })
    const value = normalizeCustomerSalesUnderstanding({ pain_points: [{ title: '压力很大', severity: 'HIGH', evidence_ids: ['EVD-1'] }], willingness_to_pay: { level: 'MEDIUM' } }, { evidenceIds: ['EVD-1'] })
    expect(applyWillingnessEvidenceGate(value, { evidenceItems: [pain] }).willingness_to_pay.level).toBe('UNKNOWN')
  })

  it('does not let ability HIGH increase willingness', () => {
    const income = evidence({ displayText: '客户收入较高，但没有表达购买或投入意愿' })
    const value = normalizeCustomerSalesUnderstanding({ ability_to_pay: { level: 'HIGH' }, willingness_to_pay: { level: 'MEDIUM' } })
    expect(applyWillingnessEvidenceGate(value, { evidenceItems: [income] }).willingness_to_pay.level).toBe('UNKNOWN')
  })

  it('makes Ruolan ability LOW regardless of the model candidate', () => {
    const ruolan = [
      evidence({ id: 'R-INCOME', displayText: '月收入约7000～9000元', sourceExcerpt: '过去3个月平均月收入约7000～9000元' }),
      evidence({ id: 'R-EXPENSE', displayText: '固定支出约6000元', sourceExcerpt: '每月固定支出约6000元' }),
      evidence({ id: 'R-SAVINGS', displayText: '可动用储蓄约10000元', sourceExcerpt: '可动用储蓄约10000元' }),
      evidence({ id: 'R-SUPPORT', displayText: '没有持续家庭经济支持', sourceExcerpt: '目前没有持续的家庭经济支持' }),
      evidence({ id: 'R-BUDGET', displayText: '几千块的支出都要认真考虑', sourceExcerpt: '现在几千块的支出我都要认真考虑' }),
    ]
    const results = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN', 'HIGH'].map((level) => applyAbilityEvidenceGate({ ability_to_pay: { level } }, { evidenceItems: ruolan }).ability_to_pay)
    expect(results.map((item) => item.level)).toEqual(['LOW', 'LOW', 'LOW', 'LOW', 'LOW'])
    expect(results[0].evidence_ids).toEqual(expect.arrayContaining(['R-INCOME', 'R-EXPENSE', 'R-SAVINGS', 'R-BUDGET']))
    expect(results[0].explanation).toContain('支付空间比较有限')
  })

  it('makes Qinghe ability HIGH only from direct financial space evidence', () => {
    const qinghe = [
      evidence({ id: 'Q-INCOME', displayText: '月收入约4—5万元', sourceExcerpt: '我的月收入约4—5万元' }),
      evidence({ id: 'Q-SAVINGS', displayText: '流动储蓄约30万元', sourceExcerpt: '目前有流动储蓄约30万元' }),
      evidence({ id: 'Q-BUDGET', displayText: '每年成长预算3—5万元', sourceExcerpt: '每年有3—5万元成长预算' }),
      evidence({ id: 'Q-INVEST', fieldKey: 'occupation', displayText: '企业主', sourceExcerpt: '职业是企业主' }),
    ]
    const results = ['HIGH', 'LOW', 'UNKNOWN'].map((level) => applyAbilityEvidenceGate({ ability_to_pay: { level } }, { evidenceItems: qinghe }).ability_to_pay)
    expect(results.map((item) => item.level)).toEqual(['HIGH', 'HIGH', 'HIGH'])
    expect(results[0].evidence_ids).toEqual(expect.arrayContaining(['Q-INCOME', 'Q-SAVINGS', 'Q-BUDGET']))
    expect(results[0].evidence_ids).not.toContain('Q-INVEST')
  })

  it('keeps ability UNKNOWN when only identity or enrollment context exists', () => {
    const identityOnly = [
      evidence({ id: 'E-OCCUPATION', fieldKey: 'occupation', displayText: '职业：企业高管', sourceExcerpt: '她是一名企业高管' }),
      evidence({ id: 'E-CITY', fieldKey: 'city', displayText: '城市：上海', sourceExcerpt: '目前住在上海' }),
    ]
    const result = applyAbilityEvidenceGate({ ability_to_pay: { level: 'HIGH' } }, { evidenceItems: identityOnly, enrollments: [{ id: 'ENR-1', paymentStatus: 'UNRECORDED', paid: false }] })
    expect(result.ability_to_pay.level).toBe('UNKNOWN')
    expect(result.ability_to_pay.evidence_ids).toEqual([])
    expect(result.ability_to_pay.explanation).toContain('缺少足够的经济与预算信息')
  })
})
