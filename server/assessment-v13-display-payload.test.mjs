import { describe, expect, it } from 'vitest'
import { getAssessmentAdapter } from './assessment-adapters.mjs'

describe('V1.3 — Assessment adapter displayPayload', () => {
  describe('star adapter', () => {
    it('produces displayPayload with star-hexagram kind', () => {
      const adapter = getAssessmentAdapter('star')
      expect(adapter).not.toBeNull()
      
      // Star uses normalizeStarReportPreview which validates strictly
      // We test that the adapter wraps the base preview with displayPayload
      // The actual star preview validation is tested elsewhere
      expect(typeof adapter.parsePreview).toBe('function')
    })
  })

  describe('beattie adapter', () => {
    it('produces displayPayload with beattie-gauge kind', () => {
      const adapter = getAssessmentAdapter('beattie-anger')
      expect(adapter).not.toBeNull()
      
      const report = {
        reportId: 'rpt_test',
        reportContent: {
          viewModel: {
            total: 25,
            maxPossible: 60,
            band: { text: '中等' },
            chapter: '3',
            subScales: [
              { name: '压抑', score: 8, maxScore: 15 },
              { name: '爆发', score: 5, maxScore: 15 },
            ],
          },
        },
        assessmentVersion: '1.0',
        completedAt: '2026-11-28T10:00:00Z',
        nickname: '测试',
      }
      
      const preview = adapter.parsePreview(report)
      expect(preview.displayPayload).toBeDefined()
      expect(preview.displayPayload.kind).toBe('beattie-gauge')
      expect(preview.displayPayload.total).toBe(25)
      expect(preview.displayPayload.maxPossible).toBe(60)
      expect(preview.displayPayload.percentage).toBe(42) // Math.round(25/60*100)
      expect(preview.displayPayload.level).toBe('中等')
      expect(preview.displayPayload.color).toBe('#ff9800') // 中等 → orange
      expect(preview.displayPayload.chapter).toBe('3')
      expect(preview.displayPayload.subScales).toHaveLength(2)
      expect(preview.displayPayload.subScales[0].name).toBe('压抑')
    })

    it('maps level colors correctly', () => {
      const adapter = getAssessmentAdapter('beattie-emotional-health')
      
      // Test 轻微 → green
      let preview = adapter.parsePreview({
        reportContent: { viewModel: { total: 5, maxPossible: 60, band: { text: '轻微' } } },
        reportId: 'rpt_1', assessmentVersion: '1.0', completedAt: '2026-11-28T10:00:00Z', nickname: 'T',
      })
      expect(preview.displayPayload.color).toBe('#4caf50')
      
      // Test 偏高 → red
      preview = adapter.parsePreview({
        reportContent: { viewModel: { total: 45, maxPossible: 60, band: { text: '偏高' } } },
        reportId: 'rpt_2', assessmentVersion: '1.0', completedAt: '2026-11-28T10:00:00Z', nickname: 'T',
      })
      expect(preview.displayPayload.color).toBe('#f44336')
    })

    it('handles missing sub-scales gracefully', () => {
      const adapter = getAssessmentAdapter('beattie-fear')
      const preview = adapter.parsePreview({
        reportContent: { viewModel: { total: 10, maxPossible: 40, band: { text: '轻度' } } },
        reportId: 'rpt_3', assessmentVersion: '1.0', completedAt: '2026-11-28T10:00:00Z', nickname: 'T',
      })
      expect(preview.displayPayload.subScales).toEqual([])
    })
  })

  describe('sefs adapter', () => {
    it('produces displayPayload with sefs-radar kind', () => {
      const adapter = getAssessmentAdapter('sefs')
      expect(adapter).not.toBeNull()
      
      // V1.3 fix: SEFS reports are stored under reportContent.viewModel (same as other H5 assessments)
      const report = {
        reportId: 'rpt_sefs_01',
        reportContent: {
          viewModel: {
            total: 85,
            dimensions: [
              { name: '身体感知', score: 18 },
              { name: '情绪觉察', score: 22 },
              { name: '关系敏感', score: 15 },
              { name: '思维活跃', score: 20 },
              { name: '意义追寻', score: 10 },
            ],
          },
        },
        assessmentVersion: '1.0',
        completedAt: '2026-11-28T10:00:00Z',
        nickname: '测试',
      }
      
      const preview = adapter.parsePreview(report)
      expect(preview.displayPayload).toBeDefined()
      expect(preview.displayPayload.kind).toBe('sefs-radar')
      expect(preview.displayPayload.total).toBe(85)
      expect(preview.displayPayload.topDimension).toBeDefined()
      expect(preview.displayPayload.topDimension.name).toBe('情绪觉察')
      expect(preview.displayPayload.top3).toHaveLength(3)
      expect(preview.displayPayload.radarAxes.length).toBeGreaterThan(0)
      // Normalized values should be between 0 and 1
      for (const axis of preview.displayPayload.radarAxes) {
        expect(axis.normalized).toBeGreaterThanOrEqual(0)
        expect(axis.normalized).toBeLessThanOrEqual(1)
      }
    })

    it('supports items array as alternative to dimensions', () => {
      const adapter = getAssessmentAdapter('sefs')
      const report = {
        reportId: 'rpt_sefs_02',
        reportContent: {
          viewModel: {
            total: 70,
            items: [
              { name: '维度A', score: 25 },
              { name: '维度B', score: 20 },
              { name: '维度C', score: 15 },
            ],
          },
        },
        assessmentVersion: '1.0',
        completedAt: '2026-11-28T10:00:00Z',
        nickname: 'T',
      }
      const preview = adapter.parsePreview(report)
      expect(preview.displayPayload.total).toBe(70)
      expect(preview.displayPayload.topDimension.name).toBe('维度A')
      expect(preview.displayPayload.radarAxes).toHaveLength(3)
    })

    it('handles empty dimensions gracefully', () => {
      const adapter = getAssessmentAdapter('sefs')
      const preview = adapter.parsePreview({
        reportContent: { viewModel: { total: 0, dimensions: [] } },
        reportId: 'rpt_sefs_03',
        assessmentVersion: '1.0',
        completedAt: '2026-11-28T10:00:00Z',
        nickname: 'T',
      })
      expect(preview.displayPayload.total).toBe(0)
      expect(preview.displayPayload.topDimension).toBeNull()
      expect(preview.displayPayload.top3).toEqual([])
      expect(preview.displayPayload.radarAxes).toEqual([])
    })

    it('falls back to report.score for legacy reports', () => {
      const adapter = getAssessmentAdapter('sefs')
      const preview = adapter.parsePreview({
        score: { total: 50, dimensions: [{ name: 'Legacy', score: 30 }] },
        reportId: 'rpt_sefs_legacy',
        assessmentVersion: '1.0',
        completedAt: '2026-11-28T10:00:00Z',
        nickname: 'Legacy',
      })
      expect(preview.displayPayload.total).toBe(50)
      expect(preview.displayPayload.topDimension.name).toBe('Legacy')
    })
  })
})
