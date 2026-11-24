import { describe, expect, it, beforeEach } from 'vitest'
import { createAssessmentStore } from './assessment-store.mjs'

/**
 * Mock Feishu gateway for testing.
 * Simulates bitable operations with an in-memory store.
 * IMPORTANT: This is for testing the STORE LOGIC only.
 * The store uses Feishu for persistence, but we verify the store's
 * business rules (uniqueness, idempotency, transfer, etc.) are correct.
 */
function createMockFeishu() {
  const tables = new Map() // tableId → { fields: [], records: Map<recordId, fields> }
  let recordCounter = 0

  function getOrCreateTable(tableId) {
    if (!tables.has(tableId)) {
      tables.set(tableId, { fields: [], records: new Map() })
    }
    return tables.get(tableId)
  }

  return {
    createTable: async (name, fields) => {
      const tableId = `tbl_test_${name.replace(/\s/g, '_')}_${Date.now()}`
      tables.set(tableId, { fields, records: new Map() })
      return { table_id: tableId }
    },
    createRecord: async (tableId, fields) => {
      const table = getOrCreateTable(tableId)
      const recordId = `rec_test_${++recordCounter}`
      table.records.set(recordId, { ...fields })
      return { record: { record_id: recordId, fields: { ...fields } } }
    },
    updateRecord: async (tableId, recordId, update) => {
      const table = getOrCreateTable(tableId)
      const existing = table.records.get(recordId)
      if (!existing) throw new Error('Record not found')
      const updatedFields = { ...existing, ...update.fields }
      table.records.set(recordId, updatedFields)
      return { record: { record_id: recordId, fields: updatedFields } }
    },
    searchRecords: async (tableId, { filter }) => {
      const table = getOrCreateTable(tableId)
      const allRecords = Array.from(table.records.entries()).map(([recordId, fields]) => ({ record_id: recordId, fields }))

      // Simple filter evaluation
      const filtered = allRecords.filter(record => {
        if (!filter?.conditions) return true
        return filter.conditions.every(cond => {
          const value = record.fields[cond.field_name]
          if (cond.operator === 'is') {
            return cond.value.includes(String(value || ''))
          }
          return true
        })
      })

      return { items: filtered }
    },
    // Expose internal state for test assertions
    _tables: tables,
    _allRecords: (tableId) => {
      const table = tables.get(tableId)
      return table ? Array.from(table.records.entries()).map(([id, f]) => ({ record_id: id, fields: f })) : []
    },
  }
}

const mockConfig = {
  feishu: {
    tables: { assessmentBindings: null }, // Will be created on first use
  },
}

// Synthetic test data
const syntheticReport = {
  reportId: 'rpt_test_001',
  assessmentId: 'star',
  assessmentName: '职业六芒星',
  assessmentVersion: 'star-words-31-v1',
  schemaVersion: '1.0.0',
  nickname: '测试用户',
  completedAt: '2026-11-20T10:00:00+08:00',
  dimensions: [
    { id: 'drive', name: '底层动力', kind: 'category', score: null, labels: ['创造性', '自由', '挑战性'] },
    { id: 'pursue', name: '现实追求', kind: 'category', score: null, labels: ['安全', '新鲜感', '有学习/成长的机会'] },
  ],
}

const syntheticPreview = {
  reportId: 'rpt_test_001',
  assessmentId: 'star',
  assessmentName: '职业六芒星',
  assessmentVersion: 'star-words-31-v1',
  schemaVersion: '1.0.0',
  nickname: '测试用户',
  completedAt: '2026-11-20T10:00:00+08:00',
  keyMetrics: [
    { id: 'drive', name: '底层动力', labels: ['创造性', '自由', '挑战性'] },
    { id: 'pursue', name: '现实追求', labels: ['安全', '新鲜感', '有学习/成长的机会'] },
  ],
  headline: '底层动力：创造性、自由、挑战性',
  summary: '现实追求：安全、新鲜感、有学习/成长的机会',
  caution: '自我整理结果，不是职业或心理诊断。',
}

const customer1 = { id: 'CUS-001', name: '张三' }
const customer2 = { id: 'CUS-002', name: '李四' }
const mentor1 = 'staff-mentor-001'
const mentor2 = 'staff-mentor-002'

describe('assessment-store', () => {
  let mockFeishu
  let store

  beforeEach(async () => {
    mockFeishu = createMockFeishu()
    store = createAssessmentStore({ feishu: mockFeishu, config: mockConfig })
  })

  describe('bindReport', () => {
    it('creates a new binding successfully', async () => {
      const result = await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        shareUrl: 'https://xiangshu3721.github.io/mindtest-web/r/#test_001.secret12345678901',
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      expect(result.bindingId).toMatch(/^ABD-/)
      expect(result.idempotent).toBe(false)
      expect(result.alreadyBound).toBe(false)
      expect(result.status).toBe('ACTIVE')
      expect(result.customerId).toBe(customer1.id)
    })

    it('returns idempotent result for same report + same customer', async () => {
      const params = {
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      }

      const first = await store.bindReport(params)
      const second = await store.bindReport(params)

      expect(second.idempotent).toBe(true)
      expect(second.alreadyBound).toBe(true)
      expect(second.bindingId).toBe(first.bindingId)
    })

    it('rejects binding same report to different customer', async () => {
      await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      await expect(
        store.bindReport({
          provider: 'mindtest-web',
          reportId: syntheticReport.reportId,
          assessmentId: 'star',
          assessmentName: '职业六芒星',
          customerId: customer2.id,
          customerName: customer2.name,
          reportNickname: syntheticReport.nickname,
          completedAt: syntheticReport.completedAt,
          boundBy: mentor2,
          fullReport: syntheticReport,
          safePreview: syntheticPreview,
        })
      ).rejects.toThrow('此报告已绑定到其他客户')

      await expect(
        store.bindReport({
          provider: 'mindtest-web',
          reportId: syntheticReport.reportId,
          assessmentId: 'star',
          assessmentName: '职业六芒星',
          customerId: customer2.id,
          customerName: customer2.name,
          reportNickname: syntheticReport.nickname,
          completedAt: syntheticReport.completedAt,
          boundBy: mentor2,
          fullReport: syntheticReport,
          safePreview: syntheticPreview,
        })
      ).rejects.toMatchObject({ code: 'REPORT_ALREADY_BOUND' })
    })

    it('stores full report snapshot for safety', async () => {
      await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      // Verify snapshot was stored
      const binding = await store.findBindingByReport('mindtest-web', syntheticReport.reportId)
      expect(binding.snapshot).toEqual(syntheticReport)
      expect(binding.snapshotHash).toBeTruthy()
      expect(binding.preview).toBeTruthy()
    })

    it('does not store linkSecret in binding record', async () => {
      await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        shareUrl: 'https://xiangshu3721.github.io/mindtest-web/r/#test_001.super_secret_key_123',
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const binding = await store.findBindingByReport('mindtest-web', syntheticReport.reportId)
      // shareUrl is stored for reference but the linkSecret is embedded in it
      // The snapshot should NOT contain linkSecret or ownerToken
      expect(binding.snapshot.linkSecret).toBeUndefined()
      expect(binding.snapshot.ownerToken).toBeUndefined()
      expect(binding.preview.linkSecret).toBeUndefined()
      expect(binding.preview.ownerToken).toBeUndefined()
    })
  })

  describe('unbindReport', () => {
    it('successfully unbinds an active binding', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const result = await store.unbindReport(bound.bindingId, mentor1, '客户不再需要此测评')
      expect(result.status).toBe('UNBOUND')

      // Verify binding is no longer active
      const binding = await store.findBindingByReport('mindtest-web', syntheticReport.reportId)
      expect(binding).toBeNull()
    })

    it('rejects unbinding non-existent binding', async () => {
      await expect(store.unbindReport('ABD-NONEXISTENT', mentor1))
        .rejects.toThrow('绑定记录不存在')
    })

    it('allows re-binding after unbind', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      await store.unbindReport(bound.bindingId, mentor1)

      // Now bind to a different customer
      const rebound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer2.id,
        customerName: customer2.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor2,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      expect(rebound.customerId).toBe(customer2.id)
      expect(rebound.status).toBe('ACTIVE')
    })
  })

  describe('transferBinding', () => {
    it('transfers binding from one customer to another', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const result = await store.transferBinding(
        bound.bindingId,
        customer2.id,
        customer2.name,
        mentor1,
        '客户归属纠正'
      )

      expect(result.status).toBe('TRANSFERRED')
      expect(result.newBindingId).toBeTruthy()

      // Verify new binding is active for customer2
      const binding = await store.findBindingByReport('mindtest-web', syntheticReport.reportId)
      expect(binding.customerId).toBe(customer2.id)
      expect(binding.status).toBe('ACTIVE')
    })

    it('preserves snapshot during transfer', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      await store.transferBinding(bound.bindingId, customer2.id, customer2.name, mentor1)

      const binding = await store.findBindingByReport('mindtest-web', syntheticReport.reportId)
      expect(binding.snapshot).toEqual(syntheticReport)
      expect(binding.snapshotHash).toBeTruthy()
    })
  })

  describe('getCustomerAssessments', () => {
    it('returns all active assessments for a customer', async () => {
      // Bind two different reports to customer1
      await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试1',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: { ...syntheticReport, reportId: 'rpt_test_001' },
        safePreview: syntheticPreview,
      })

      await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_002',
        assessmentId: 'sefs',
        assessmentName: 'SEFS',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试2',
        completedAt: '2026-11-21T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: { reportId: 'rpt_test_002', assessmentId: 'sefs' },
        safePreview: { reportId: 'rpt_test_002', assessmentId: 'sefs' },
      })

      const assessments = await store.getCustomerAssessments(customer1.id)
      expect(assessments).toHaveLength(2)
      expect(assessments.map(a => a.assessmentId).sort()).toEqual(['sefs', 'star'])
    })

    it('excludes unbound assessments', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: syntheticReport.nickname,
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      await store.unbindReport(bound.bindingId, mentor1)

      const assessments = await store.getCustomerAssessments(customer1.id)
      expect(assessments).toHaveLength(0)
    })

    it('returns empty array for customer with no assessments', async () => {
      const assessments = await store.getCustomerAssessments('CUS-nonexistent')
      expect(assessments).toEqual([])
    })
  })

  describe('getCustomerAssessmentHistory', () => {
    it('returns version history for same assessment type, sorted by completedAt desc', async () => {
      // Bind 3 star reports to customer1 with different completedAt
      const reports = [
        { reportId: 'rpt_old', completedAt: '2026-01-01T10:00:00+08:00', nickname: '旧报告' },
        { reportId: 'rpt_mid', completedAt: '2026-06-15T10:00:00+08:00', nickname: '中期报告' },
        { reportId: 'rpt_new', completedAt: '2026-11-20T10:00:00+08:00', nickname: '最新报告' },
      ]

      for (const r of reports) {
        await store.bindReport({
          provider: 'mindtest-web',
          reportId: r.reportId,
          assessmentId: 'star',
          assessmentName: '职业六芒星',
          customerId: customer1.id,
          customerName: customer1.name,
          reportNickname: r.nickname,
          completedAt: r.completedAt,
          boundBy: mentor1,
          fullReport: { reportId: r.reportId, assessmentId: 'star', nickname: r.nickname },
          safePreview: { reportId: r.reportId, assessmentId: 'star', nickname: r.nickname },
        })
      }

      const history = await store.getCustomerAssessmentHistory(customer1.id, 'star')
      expect(history).toHaveLength(3)
      // Most recent first
      expect(history[0].reportId).toBe('rpt_new')
      expect(history[1].reportId).toBe('rpt_mid')
      expect(history[2].reportId).toBe('rpt_old')
    })
  })

  describe('nickname mismatch', () => {
    it('stores both customer name and report nickname for admin review', async () => {
      await store.bindReport({
        provider: 'mindtest-web',
        reportId: syntheticReport.reportId,
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: '张三', // Customer name
        reportNickname: '小明', // Different report nickname
        completedAt: syntheticReport.completedAt,
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
        notes: '姓名不一致，已人工确认',
      })

      const binding = await store.findBindingByReport('mindtest-web', syntheticReport.reportId)
      expect(binding.customerName).toBe('张三')
      expect(binding.reportNickname).toBe('小明')
      expect(binding.notes).toContain('姓名不一致')
    })
  })
})
