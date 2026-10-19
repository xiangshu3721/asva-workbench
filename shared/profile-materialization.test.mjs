import { describe, expect, it } from 'vitest'
import { isSnapshotEvidence, materializeCustomerProfile, shouldAutoConfirmEvidence, summaryInputFingerprint } from './profile-materialization.mjs'

const customer = { profileFields: { city: '杭州', birth_date: '1992-03-22', hometown: '安徽阜阳' } }

function evidence(overrides) {
  return { id: 'EVD-1', sourceId: 'SRC-1', customerId: 'CUS-1', evidenceType: 'FACT', semanticKind: 'PROFILE_FIELD', fieldKey: 'birth_date', standardValue: '1992-03-22', displayText: '出生日期：1992年3月22日', sourceExcerpt: '1992年3月22日出生', confidence: 0.95, reviewStatus: 'CONFIRMED', occurredAt: null, ...overrides }
}

describe('CustomerProfileRenderer materialization', () => {
  it('keeps high-confidence empty-field facts eligible for snapshot materialization', () => {
    expect(isSnapshotEvidence(evidence({ fieldKey: 'birth_date' }))).toBe(true)
    expect(isSnapshotEvidence(evidence({ fieldKey: 'occupation', semanticKind: 'EVENT' }))).toBe(false)
  })

  it('renders confirmed events and grounded evidence without hypotheses', () => {
    const result = materializeCustomerProfile({ customer, evidenceItems: [
      evidence({ id: 'EVD-BIRTH', fieldKey: 'birth_date' }),
      evidence({ id: 'EVD-EVENT', semanticKind: 'EVENT', fieldKey: null, displayText: '18岁离乡读大学', sourceExcerpt: '18岁离乡读大学', occurredAt: '18岁' }),
      evidence({ id: 'EVD-CAREER', semanticKind: 'EVENT', fieldKey: 'occupation', displayText: '房地产销售并成为销冠', sourceExcerpt: '约20岁进入房地产销售并成为销冠' }),
      evidence({ id: 'EVD-HYP', evidenceType: 'HYPOTHESIS', semanticKind: 'OTHER', fieldKey: null, displayText: '可能缺乏安全感', sourceExcerpt: '推测', reviewStatus: 'CONFIRMED' }),
    ] })
    expect(result.sections.find((section) => section.title === 'TA是谁').items.some((item) => item.text === '1992-03-22')).toBe(true)
    expect(result.sections.find((section) => section.title === '职业与事业').items.some((item) => item.text.includes('房地产销售'))).toBe(true)
    expect(result.lifeEvents.map((item) => item.title)).toEqual(expect.arrayContaining(['18岁离乡读大学', '房地产销售并成为销冠']))
    expect(result.sections.flatMap((section) => section.items).some((item) => item.text.includes('缺乏安全感'))).toBe(false)
    expect(result.coverage.percentage).toBeGreaterThan(0)
  })

  it('only auto-confirms factual event evidence, never hypothesis', () => {
    expect(shouldAutoConfirmEvidence(evidence({ semanticKind: 'EVENT' }))).toBe(true)
    expect(shouldAutoConfirmEvidence(evidence({ semanticKind: 'EVENT', evidenceType: 'HYPOTHESIS' }))).toBe(false)
  })

  it('moves summary state from stale to fresh only for the matching materialization input', () => {
    const evidenceItems = [evidence({ id: 'EVD-FRESH' })]
    const fingerprint = summaryInputFingerprint({ customer, evidenceItems })
    expect(materializeCustomerProfile({ customer, evidenceItems }).aiSummaryStatus).toBe('STALE')
    expect(materializeCustomerProfile({ customer, evidenceItems, summaryMeta: { status: 'FRESH', inputFingerprint: fingerprint } }).aiSummaryStatus).toBe('FRESH')
    expect(materializeCustomerProfile({ customer, evidenceItems, summaryMeta: { status: 'FRESH', inputFingerprint: 'old' } }).aiSummaryStatus).toBe('STALE')
  })

  it('projects ordinary unconfirmed evidence without turning it into a confirmed fact', () => {
    const result = materializeCustomerProfile({ customer, evidenceItems: [
      evidence({ id: 'EVD-PENDING', reviewStatus: 'PENDING_REVIEW', fieldKey: 'occupation', semanticKind: 'EVENT', displayText: '最近开始探索心理学方向', sourceExcerpt: '她说最近开始探索心理学方向', contentSource: 'STAFF_TRANSCRIBED_CUSTOMER', informationNature: 'PERSONAL_STATEMENT', verificationStatus: 'SOURCE_SUPPORTED' }),
      evidence({ id: 'EVD-AI', reviewStatus: 'PENDING_REVIEW', evidenceType: 'HYPOTHESIS', fieldKey: 'personality_traits', semanticKind: 'OTHER', displayText: '可能比较回避冲突', sourceExcerpt: '模型推测', informationNature: 'AI_INFERENCE', verificationStatus: 'UNKNOWN' }),
      evidence({ id: 'EVD-CONFIRMED', reviewStatus: 'CONFIRMED', fieldKey: 'city', standardValue: '杭州', displayText: '现居杭州' }),
    ] })
    expect(result.provisionalItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: 'EVD-PENDING', fieldKey: 'occupation', verificationStatus: 'SOURCE_SUPPORTED', sectionTitle: '职业与事业' }),
      expect.objectContaining({ evidenceId: 'EVD-AI', label: '待验证洞察' }),
    ]))
    expect(result.provisionalItems).not.toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: 'EVD-CONFIRMED' })]))
    expect(result.sections.find((section) => section.title === 'TA是谁').items.some((item) => item.text === '杭州')).toBe(true)
  })

  it('does not project superseded or rejected evidence and deduplicates repeated display text', () => {
    const result = materializeCustomerProfile({ customer, evidenceItems: [
      evidence({ id: 'EVD-OLD', reviewStatus: 'SUPERSEDED', displayText: '旧资料' }),
      evidence({ id: 'EVD-REJECTED', reviewStatus: 'REJECTED', displayText: '被拒资料' }),
      evidence({ id: 'EVD-1', reviewStatus: 'PENDING_REVIEW', displayText: '近期睡眠有所改善', sourceExcerpt: '近期睡眠有所改善', fieldKey: 'energy_state', semanticKind: 'CURRENT_STATE' }),
      evidence({ id: 'EVD-2', reviewStatus: 'PENDING_REVIEW', displayText: '近期睡眠有所改善', sourceExcerpt: '近期睡眠有所改善', fieldKey: 'energy_state', semanticKind: 'CURRENT_STATE' }),
    ] })
    expect(result.provisionalItems.map((item) => item.evidenceId)).not.toEqual(expect.arrayContaining(['EVD-OLD', 'EVD-REJECTED']))
    expect(result.provisionalItems.filter((item) => item.text === '近期睡眠有所改善')).toHaveLength(1)
    expect(result.provisionalItems.find((item) => item.text === '近期睡眠有所改善').evidenceIds).toEqual(['EVD-1', 'EVD-2'])
  })
})
