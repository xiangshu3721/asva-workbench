import { describe, expect, it, vi } from 'vitest'
import { buildCustomerUnderstandingContext, understandingInputFingerprint } from './customer-understanding.mjs'

const customer = { id: 'CUS-V12', profileVersion: 1, need: '理清方向', profileFields: { city: '杭州' } }

const makeAssessmentSummary = (overrides = {}) => ({
  binding_id: 'ABD-TEST-001',
  assessment_id: 'star',
  assessment_name: '职业六芒星',
  assessment_version: 'star-words-31-v1',
  completed_at: '2026-11-27T10:00:00+08:00',
  headline: '底层动力: 创造性、自由',
  summary: '现实追求: 安全、新鲜感',
  caution: '',
  key_metrics: [
    { name: '底层动力', labels: ['创造性', '自由'] },
    { name: '现实追求', labels: ['安全', '新鲜感'] },
  ],
  content_hash: 'abc123',
  ...overrides,
})

describe('V1.2 assessment integration', () => {
  it('includes assessment_summaries in the context when provided', () => {
    const summaries = [makeAssessmentSummary()]
    const context = buildCustomerUnderstandingContext({ customer, evidenceItems: [], assessmentSummaries: summaries })
    expect(context.assessment_summaries).toBeDefined()
    expect(context.assessment_summaries.available).toBe(true)
    expect(context.assessment_summaries.count).toBe(1)
    expect(context.assessment_summaries.summaries[0].assessment_id).toBe('star')
    expect(context.assessment_summaries.summaries[0].headline).toBe('底层动力: 创造性、自由')
  })

  it('returns available=false when no assessments', () => {
    const context = buildCustomerUnderstandingContext({ customer, evidenceItems: [] })
    expect(context.assessment_summaries.available).toBe(false)
    expect(context.assessment_summaries.count).toBe(0)
  })

  it('changes the fingerprint when assessments change', () => {
    const fp1 = understandingInputFingerprint({ customer, evidenceItems: [] })
    const fp2 = understandingInputFingerprint({ customer, evidenceItems: [], assessmentSummaries: [makeAssessmentSummary()] })
    expect(fp1).not.toBe(fp2)
  })

  it('changes the fingerprint when assessment content changes', () => {
    const fp1 = understandingInputFingerprint({ customer, evidenceItems: [], assessmentSummaries: [makeAssessmentSummary({ content_hash: 'abc' })] })
    const fp2 = understandingInputFingerprint({ customer, evidenceItems: [], assessmentSummaries: [makeAssessmentSummary({ content_hash: 'def' })] })
    expect(fp1).not.toBe(fp2)
  })

  it('has the same fingerprint when assessments are unchanged', () => {
    const summaries = [makeAssessmentSummary()]
    const fp1 = understandingInputFingerprint({ customer, evidenceItems: [], assessmentSummaries: summaries })
    const fp2 = understandingInputFingerprint({ customer, evidenceItems: [], assessmentSummaries: summaries })
    expect(fp1).toBe(fp2)
  })

  it('context input_fingerprint matches the standalone fingerprint with assessments', () => {
    const summaries = [makeAssessmentSummary()]
    const context = buildCustomerUnderstandingContext({ customer, evidenceItems: [], assessmentSummaries: summaries })
    const standalone = understandingInputFingerprint({ customer, evidenceItems: [], assessmentSummaries: summaries })
    expect(context.input_fingerprint).toBe(standalone)
  })

  it('does not include raw assessment data in context', () => {
    const summaries = [makeAssessmentSummary()]
    const context = buildCustomerUnderstandingContext({ customer, evidenceItems: [], assessmentSummaries: summaries })
    const contextJson = JSON.stringify(context)
    // Should not contain raw answer data
    expect(contextJson).not.toContain('answers')
    expect(contextJson).not.toContain('linkSecret')
    expect(contextJson).not.toContain('ownerToken')
    expect(contextJson).not.toContain('encryptedShareUrl')
  })

  it('truncates long assessment text to safe bounds', () => {
    const longText = 'x'.repeat(1000)
    const summaries = [makeAssessmentSummary({ headline: longText, summary: longText })]
    const context = buildCustomerUnderstandingContext({ customer, evidenceItems: [], assessmentSummaries: summaries })
    expect(context.assessment_summaries.summaries[0].headline.length).toBeLessThanOrEqual(200)
    expect(context.assessment_summaries.summaries[0].summary.length).toBeLessThanOrEqual(400)
  })
})
