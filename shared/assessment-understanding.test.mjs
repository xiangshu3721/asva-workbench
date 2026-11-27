import { describe, expect, it } from 'vitest'
import { assessmentFingerprint, buildAssessmentContextSection, extractAllAssessmentSummaries, extractAssessmentSummary } from './assessment-understanding.mjs'

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

describe('assessment-understanding', () => {
  describe('extractAssessmentSummary', () => {
    it('extracts a structured summary from an eligible binding', () => {
      const binding = makeBinding()
      const summary = extractAssessmentSummary(binding)
      expect(summary).not.toBeNull()
      expect(summary.binding_id).toBe('ABD-TEST-001')
      expect(summary.assessment_id).toBe('star')
      expect(summary.assessment_name).toBe('职业六芒星')
      expect(summary.headline).toBe('底层动力: 创造性、自由')
      expect(summary.summary).toBe('现实追求: 安全、新鲜感')
      expect(summary.key_metrics).toHaveLength(2)
      expect(summary.key_metrics[0].name).toBe('底层动力')
      expect(summary.key_metrics[0].labels).toEqual(['创造性', '自由', '挑战性'])
      expect(summary.content_hash).toBe('abc123')
    })

    it('returns null for non-ACTIVE bindings', () => {
      const binding = makeBinding({ status: 'UNBOUND' })
      expect(extractAssessmentSummary(binding)).toBeNull()
    })

    it('returns null for revoked bindings', () => {
      expect(extractAssessmentSummary(makeBinding({ sourceRevoked: true }))).toBeNull()
      expect(extractAssessmentSummary(makeBinding({ localRevoked: true }))).toBeNull()
    })

    it('returns null for unsupported assessment types', () => {
      const binding = makeBinding({ assessmentId: 'unknown-test', preview: { ...makeBinding().preview, assessmentId: 'unknown-test' } })
      expect(extractAssessmentSummary(binding)).toBeNull()
    })

    it('returns null when preview is missing', () => {
      const binding = makeBinding({ preview: null })
      expect(extractAssessmentSummary(binding)).toBeNull()
    })

    it('returns null for null/undefined input', () => {
      expect(extractAssessmentSummary(null)).toBeNull()
      expect(extractAssessmentSummary(undefined)).toBeNull()
    })

    it('truncates long text fields to safe bounds', () => {
      const longText = 'x'.repeat(1000)
      const binding = makeBinding({
        preview: {
          ...makeBinding().preview,
          headline: longText,
          summary: longText,
          caution: longText,
        },
      })
      const summary = extractAssessmentSummary(binding)
      expect(summary.headline.length).toBeLessThanOrEqual(200)
      expect(summary.summary.length).toBeLessThanOrEqual(400)
      expect(summary.caution.length).toBeLessThanOrEqual(200)
    })

    it('filters out empty labels and limits key metrics', () => {
      const binding = makeBinding({
        preview: {
          ...makeBinding().preview,
          keyMetrics: [
            { name: '有效指标', labels: ['值1', '', '值2'] },
            { name: '空指标', labels: ['', ''] },
            { name: '指标3', labels: ['值3'] },
            { name: '指标4', labels: ['值4'] },
            { name: '指标5', labels: ['值5'] },
            { name: '指标6', labels: ['值6'] },
          ],
        },
      })
      const summary = extractAssessmentSummary(binding)
      // 空指标 should be filtered (no non-empty labels)
      // max 4 key metrics
      expect(summary.key_metrics.length).toBeLessThanOrEqual(4)
      // labels should be trimmed
      expect(summary.key_metrics[0].labels).toEqual(['值1', '值2'])
    })
  })

  describe('extractAllAssessmentSummaries', () => {
    it('extracts summaries from all eligible bindings', () => {
      const bindings = [
        makeBinding({ bindingId: 'ABD-001' }),
        makeBinding({ bindingId: 'ABD-002', assessmentId: 'beattie-anger', preview: { ...makeBinding().preview, assessmentId: 'beattie-anger', assessmentName: '愤怒测试' } }),
        makeBinding({ bindingId: 'ABD-003', status: 'UNBOUND' }),
      ]
      const summaries = extractAllAssessmentSummaries(bindings)
      expect(summaries).toHaveLength(2)
      expect(summaries[0].assessment_id).toBe('star')
      expect(summaries[1].assessment_id).toBe('beattie-anger')
    })

    it('returns empty array for non-array input', () => {
      expect(extractAllAssessmentSummaries(null)).toEqual([])
      expect(extractAllAssessmentSummaries(undefined)).toEqual([])
    })

    it('returns empty array when no bindings are eligible', () => {
      const bindings = [makeBinding({ status: 'UNBOUND' })]
      expect(extractAllAssessmentSummaries(bindings)).toEqual([])
    })
  })

  describe('buildAssessmentContextSection', () => {
    it('returns available=false when no summaries', () => {
      const section = buildAssessmentContextSection([])
      expect(section.available).toBe(false)
      expect(section.count).toBe(0)
      expect(section.summaries).toEqual([])
    })

    it('returns structured section with summaries and note', () => {
      const summaries = extractAllAssessmentSummaries([makeBinding()])
      const section = buildAssessmentContextSection(summaries)
      expect(section.available).toBe(true)
      expect(section.count).toBe(1)
      expect(section.summaries).toHaveLength(1)
      expect(section.summaries[0].assessment_id).toBe('star')
      expect(section.summaries[0].headline).toBe('底层动力: 创造性、自由')
      expect(section.summaries[0].assessment_evidence_ref).toMatch(/^ASM-/)
      expect(section.note).toContain('自评')
      expect(section.note).toContain('不是临床诊断')
    })
  })

  describe('assessmentFingerprint', () => {
    it('returns empty string when no bindings', () => {
      expect(assessmentFingerprint([])).toBe('')
      expect(assessmentFingerprint(null)).toBe('')
    })

    it('returns a stable hash for the same bindings', () => {
      const bindings = [makeBinding()]
      const fp1 = assessmentFingerprint(bindings)
      const fp2 = assessmentFingerprint(bindings)
      expect(fp1).toBe(fp2)
      expect(fp1).toHaveLength(16)
    })

    it('changes when content hash changes', () => {
      const fp1 = assessmentFingerprint([makeBinding({ snapshotHash: 'abc' })])
      const fp2 = assessmentFingerprint([makeBinding({ snapshotHash: 'def' })])
      expect(fp1).not.toBe(fp2)
    })

    it('changes when a binding is added or removed', () => {
      const fp1 = assessmentFingerprint([makeBinding({ bindingId: 'ABD-001' })])
      const fp2 = assessmentFingerprint([
        makeBinding({ bindingId: 'ABD-001' }),
        makeBinding({ bindingId: 'ABD-002', assessmentId: 'beattie-anger' }),
      ])
      expect(fp1).not.toBe(fp2)
    })

    it('ignores ineligible bindings', () => {
      const fp1 = assessmentFingerprint([makeBinding()])
      const fp2 = assessmentFingerprint([makeBinding(), makeBinding({ status: 'UNBOUND' })])
      expect(fp1).toBe(fp2)
    })
  })
})
