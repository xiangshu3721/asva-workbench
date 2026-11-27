import { describe, expect, it } from 'vitest'
import { assessmentFingerprint, assessmentResultFingerprint, createAssessmentResult, extractAllAssessmentSummaries } from './assessment-understanding.mjs'

const makeBinding = (overrides = {}) => ({
  bindingId: 'ABD-TEST-001',
  provider: 'mindtest-web',
  reportId: 'rpt_test001',
  assessmentId: 'star',
  assessmentName: '职业六芒星',
  assessmentVersion: 'star-words-31-v1',
  customerId: 'CUS-001',
  customerName: '测试客户',
  reportNickname: '测试',
  completedAt: '2026-11-27T10:00:00+08:00',
  boundAt: '2026-11-27T10:30:00+08:00',
  boundBy: 'MENTOR-1',
  status: 'ACTIVE',
  snapshotHash: 'abc123',
  preview: {
    reportId: 'rpt_test001',
    assessmentId: 'star',
    assessmentName: '职业六芒星',
    assessmentVersion: 'star-words-31-v1',
    completedAt: '2026-11-27T10:00:00+08:00',
    nickname: '测试',
    headline: '底层动力: 创造性、自由',
    summary: '现实追求: 安全、新鲜感',
    caution: '',
    keyMetrics: [
      { name: '底层动力', labels: ['创造性', '自由', '挑战性'] },
      { name: '现实追求', labels: ['安全', '新鲜感'] },
    ],
  },
  customerConsent: true,
  sourceRevoked: false,
  localRevoked: false,
  ...overrides,
})

describe('V1.2 final — three-state assessment result', () => {
  it('creates a NONE result when no assessment store is configured', () => {
    const result = createAssessmentResult('NONE', [])
    expect(result.status).toBe('NONE')
    expect(result.summaries).toEqual([])
    expect(result.errorCode).toBe('')
  })

  it('creates an OK result with summaries', () => {
    const summaries = extractAllAssessmentSummaries([makeBinding()])
    const result = createAssessmentResult('OK', summaries)
    expect(result.status).toBe('OK')
    expect(result.summaries).toHaveLength(1)
    expect(result.errorCode).toBe('')
  })

  it('creates a FAILED result with error code', () => {
    const result = createAssessmentResult('FAILED', [], 'ASSESSMENT_READ_TIMEOUT')
    expect(result.status).toBe('FAILED')
    expect(result.summaries).toEqual([])
    expect(result.errorCode).toBe('ASSESSMENT_READ_TIMEOUT')
  })

  describe('assessmentResultFingerprint', () => {
    it('returns empty string for NONE status', () => {
      expect(assessmentResultFingerprint(createAssessmentResult('NONE', []))).toBe('')
    })

    it('returns empty string for FAILED status', () => {
      // Key behavior: FAILED does NOT change the fingerprint
      // This prevents transient errors from triggering unnecessary refreshes
      expect(assessmentResultFingerprint(createAssessmentResult('FAILED', [], 'TIMEOUT'))).toBe('')
    })

    it('returns a real hash for OK status with data', () => {
      const summaries = extractAllAssessmentSummaries([makeBinding()])
      const fp = assessmentResultFingerprint(createAssessmentResult('OK', summaries))
      expect(fp).toBeTruthy()
      expect(fp).toHaveLength(16)
    })

    it('returns empty string for OK status with no data', () => {
      const fp = assessmentResultFingerprint(createAssessmentResult('OK', []))
      expect(fp).toBe('')
    })

    it('returns empty string for null/undefined input', () => {
      expect(assessmentResultFingerprint(null)).toBe('')
      expect(assessmentResultFingerprint(undefined)).toBe('')
    })
  })

  describe('fingerprint stability across failures', () => {
    it('FAILED result does not change fingerprint compared to no assessments', () => {
      // Simulate: last successful read had assessments → stored fingerprint was X
      // Now: assessment read fails → current fingerprint should NOT include assessments
      // So the fingerprint matches the stored one → understanding stays FRESH
      const baseFp = assessmentFingerprint([]) // no assessments
      const failedFp = assessmentResultFingerprint(createAssessmentResult('FAILED', [], 'TIMEOUT'))
      expect(failedFp).toBe(baseFp)
    })

    it('OK result changes fingerprint compared to no assessments', () => {
      const baseFp = assessmentFingerprint([]) // no assessments
      const summaries = extractAllAssessmentSummaries([makeBinding()])
      const okFp = assessmentResultFingerprint(createAssessmentResult('OK', summaries))
      expect(okFp).not.toBe(baseFp)
    })

    it('assessment content change is detected by fingerprint', () => {
      const fp1 = assessmentResultFingerprint(createAssessmentResult('OK',
        extractAllAssessmentSummaries([makeBinding({ snapshotHash: 'aaa' })])))
      const fp2 = assessmentResultFingerprint(createAssessmentResult('OK',
        extractAllAssessmentSummaries([makeBinding({ snapshotHash: 'bbb' })])))
      expect(fp1).not.toBe(fp2)
    })

    it('assessment unbind changes fingerprint', () => {
      const fpWith = assessmentResultFingerprint(createAssessmentResult('OK',
        extractAllAssessmentSummaries([makeBinding()])))
      const fpWithout = assessmentResultFingerprint(createAssessmentResult('OK', []))
      expect(fpWith).not.toBe(fpWithout)
    })

    it('revoked assessment is excluded from fingerprint', () => {
      const fpActive = assessmentResultFingerprint(createAssessmentResult('OK',
        extractAllAssessmentSummaries([makeBinding({ sourceRevoked: false })])))
      const fpRevoked = assessmentResultFingerprint(createAssessmentResult('OK',
        extractAllAssessmentSummaries([makeBinding({ sourceRevoked: true })])))
      expect(fpActive).not.toBe(fpRevoked)
      expect(fpRevoked).toBe('') // revoked → no eligible summaries → empty fingerprint
    })
  })
})
