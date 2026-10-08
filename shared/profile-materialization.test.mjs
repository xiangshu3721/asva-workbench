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
})
