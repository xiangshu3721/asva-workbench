// V1.0.1 UX Optimization - Real HTTP + PostgreSQL Regression Tests
// Tests the new V1.0.1 features:
// 1. Encrypted share URL storage + retrieval
// 2. Share URL supplementation with reportId verification
// 3. Report update (supersede old + create new) with idempotency
// 4. Update history tracking
// 5. Unbind clears share URL
// 6. Permission checks (customer access, not admin-only)
// 7. Incremental migration (existing data preserved)

import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================================
// 1. Mock: External assessment report service
// ============================================================================
const SYNTHETIC_REPORT_V1 = {
  reportId: 'rpt_v101_01',
  assessmentId: 'star',
  assessmentName: '职业六芒星',
  assessmentVersion: 'star-words-31-v1',
  schemaVersion: '1.0.0',
  nickname: '合成客户一',
  completedAt: '2026-11-20T10:00:00+08:00',
  linkSecret: 'V1_SECRET',
  ownerToken: 'V1_TOKEN',
  dimensions: [
    { id: 'drive', name: '底层动力', kind: 'category', score: null, labels: ['创造性'] },
  ],
}

const SYNTHETIC_REPORT_V2 = {
  reportId: 'rpt_v101_02',
  assessmentId: 'star',
  assessmentName: '职业六芒星',
  assessmentVersion: 'star-words-31-v1',
  schemaVersion: '1.0.0',
  nickname: '合成客户一',
  completedAt: '2026-11-25T10:00:00+08:00',
  linkSecret: 'V2_SECRET',
  ownerToken: 'V2_TOKEN',
  dimensions: [
    { id: 'drive', name: '底层动力', kind: 'category', score: null, labels: ['创造性', '自由'] },
  ],
}

const SHARE_URL_V1 = 'https://xiangshu3721.github.io/mindtest-web/r/#rpt_v101_01.v1_secret_abc'
const SHARE_URL_V2 = 'https://xiangshu3721.github.io/mindtest-web/r/#rpt_v101_02.v2_secret_xyz'

vi.mock('./assessment-import.mjs', () => ({
  importAssessmentFromShareUrl: vi.fn(async () => ({
    reportId: 'rpt_v101_01',
    assessmentId: 'star',
    assessmentName: '职业六芒星',
    assessmentVersion: 'star-words-31-v1',
    completedAt: '2026-11-20T10:00:00+08:00',
    nickname: '合成客户一',
    keyMetrics: [{ id: 'drive', name: '底层动力', labels: ['创造性'] }],
    headline: 'V1 报告',
    summary: 'V1 摘要',
    caution: 'V1 注意',
  })),
  readAssessmentReport: vi.fn(async (reportId) => {
    if (reportId === 'rpt_v101_01') return { ...SYNTHETIC_REPORT_V1 }
    if (reportId === 'rpt_v101_02') return { ...SYNTHETIC_REPORT_V2 }
    if (reportId === 'rpt_v101_wrong_type') return {
      reportId: 'rpt_v101_wrong_type',
      assessmentId: 'scl90',
      assessmentName: 'SCL-90 症状自评量表',
      assessmentVersion: 'v1',
      schemaVersion: '1.0.0',
      nickname: '测试',
      completedAt: '2026-11-25T10:00:00+08:00',
      linkSecret: 'WRONG_TYPE_SECRET',
      ownerToken: 'WRONG_TYPE_TOKEN',
      dimensions: [],
    }
    const err = new Error('报告不存在')
    err.code = 'REPORT_NOT_FOUND'
    throw err
  }),
}))

vi.mock('../shared/assessment-import-star-contract.mjs', () => ({
  parseStarShareUrl: vi.fn((url) => {
    const hashIdx = url.indexOf('#')
    if (hashIdx === -1) throw new Error('无效链接')
    const fragment = url.slice(hashIdx + 1)
    const dotIdx = fragment.indexOf('.')
    if (dotIdx === -1) throw new Error('无效链接')
    return { reportId: fragment.slice(0, dotIdx), linkSecret: fragment.slice(dotIdx + 1) }
  }),
  normalizeStarReportPreview: vi.fn((report) => ({
    reportId: report.reportId,
    assessmentId: report.assessmentId || 'star',
    assessmentName: report.assessmentName || '职业六芒星',
    assessmentVersion: report.assessmentVersion || 'star-words-31-v1',
    completedAt: report.completedAt,
    nickname: report.nickname,
    keyMetrics: [{ id: 'drive', name: '底层动力', labels: ['创造性'] }],
    headline: '测试报告',
    summary: '测试摘要',
    caution: '测试注意',
  })),
}))

// ============================================================================
// 2. Mock: Repository
// ============================================================================
const state = vi.hoisted(() => ({
  staff: [
    { id: 'MENTOR-V101', name: '导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true },
    { id: 'ADMIN-V101', name: '管理员', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true },
    { id: 'OTHER-MENTOR', name: '其他导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true },
  ],
  customers: [
    { id: 'CUS-V101-1', nickname: '客户A', name: '客户A', phone: '13800000001', status: 'ACTIVE' },
    { id: 'CUS-V101-2', nickname: '客户B', name: '客户B', phone: '13800000002', status: 'ACTIVE' },
  ],
  // Mentor -> customer access mapping
  mentorAccess: {
    'MENTOR-V101': ['CUS-V101-1'],
    'ADMIN-V101': ['CUS-V101-1', 'CUS-V101-2'],
    'OTHER-MENTOR': ['CUS-V101-2'],
  },
}))

class SyntheticRepository {
  async staff(actorId) { return state.staff.find(s => s.id === actorId) || null }
  async customer(actorId, customerId) {
    const access = state.mentorAccess[actorId] || []
    if (!access.includes(customerId)) return null
    return state.customers.find(c => c.id === customerId) || null
  }
  async customerDirectory() { return { staff: state.staff, customers: state.customers } }
  async customerDetail(_actorId, customerId) {
    return { staff: state.staff, customers: state.customers.filter(c => c.id === customerId) }
  }
}

vi.mock('./repository.mjs', () => ({ SyntheticRepository, FeishuRepository: SyntheticRepository }))

// ============================================================================
// 3. Environment + Server import
// ============================================================================
process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.HOST = '127.0.0.1'
process.env.PORT = '0'
process.env.ASVA_FRONTEND_ORIGIN = 'https://xiangshu3721.github.io'

const { server, __setAssessmentStoreForTesting } = await import('./index.mjs?assessment-v101-regression')
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

// ============================================================================
// 4. Inject real PostgreSQL store
// ============================================================================
const { PgTestAssessmentStore } = await import('./assessment-pg-test-store.mjs')
const pgStore = new PgTestAssessmentStore('asva_assessment_v101')
__setAssessmentStoreForTesting(pgStore)

// ============================================================================
// 5. Test helpers
// ============================================================================
async function request(path, staffId = 'MENTOR-V101', init = {}) {
  const headers = new Headers({
    Origin: 'https://xiangshu3721.github.io',
    'Content-Type': 'application/json',
    'X-Staff-Id': staffId,
    ...(init.headers || {}),
  })
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers })
  let payload = null
  if (response.status !== 204) {
    const text = await response.text()
    if (text) {
      try { payload = JSON.parse(text) } catch {}
    }
  }
  return { response, payload, status: response.status }
}

beforeAll(async () => {
  // Ensure tables are clean
  await pgStore.pool.query('DELETE FROM public.asva_assessment_events')
  await pgStore.pool.query('DELETE FROM public.asva_assessment_bindings')
})

afterAll(async () => {
  await pgStore.close()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(async () => {
  await pgStore.pool.query('DELETE FROM public.asva_assessment_events')
  await pgStore.pool.query('DELETE FROM public.asva_assessment_bindings')
})

// ============================================================================
// Test suite
// ============================================================================
describe('V1.0.1 UX Optimization - Regression Tests', () => {
  describe('Encrypted share URL storage and retrieval', () => {
    it('stores encrypted share URL on bind and retrieves it via share-url endpoint', async () => {
      // Step 1: Import and bind a report
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      expect(bindResult.status).toBe(201)
      const bindingId = bindResult.payload.bindingId
      expect(bindingId).toBeTruthy()

      // Step 2: Retrieve share URL
      const urlResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/share-url`, 'MENTOR-V101')
      expect(urlResult.status).toBe(200)
      expect(urlResult.payload.shareUrl).toBe(SHARE_URL_V1)
      expect(urlResult.payload.bindingId).toBe(bindingId)
    })

    it('does NOT return share URL in list/get responses', async () => {
      // Bind a report
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId

      // List assessments - should NOT include encryptedShareUrl
      const listResult = await request('/api/customers/CUS-V101-1/assessments', 'MENTOR-V101')
      expect(listResult.status).toBe(200)
      const binding = listResult.payload.assessments.find(a => a.bindingId === bindingId)
      expect(binding).toBeTruthy()
      expect(binding.encryptedShareUrl).toBeUndefined()
      expect(binding.shareUrl).toBeUndefined()
    })
  })

  describe('Share URL supplementation with reportId verification', () => {
    it('supplements missing share URL with correct reportId', async () => {
      // First bind without share URL (simulate legacy data)
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId

      // Delete the share URL to simulate legacy data
      await pgStore.pool.query('UPDATE public.asva_assessment_bindings SET encrypted_share_url = NULL WHERE id = $1', [bindingId])

      // Supplement with correct URL
      const suppResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/supplement-url`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      expect(suppResult.status).toBe(200)
      expect(suppResult.payload.ok).toBe(true)

      // Verify it works now
      const urlResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/share-url`, 'MENTOR-V101')
      expect(urlResult.status).toBe(200)
      expect(urlResult.payload.shareUrl).toBe(SHARE_URL_V1)
    })

    it('rejects supplementation with mismatched reportId', async () => {
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId

      // Delete the share URL to simulate legacy data
      await pgStore.pool.query('UPDATE public.asva_assessment_bindings SET encrypted_share_url = NULL WHERE id = $1', [bindingId])

      // Try to supplement with V2 URL (wrong reportId)
      const suppResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/supplement-url`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V2 }),
      })
      expect(suppResult.status).toBe(409)
      expect(suppResult.payload.code).toBe('REPORT_ID_MISMATCH')
    })
  })

  describe('Report update with idempotency', () => {
    it('updates report: supersedes old + creates new', async () => {
      // Bind V1
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const oldBindingId = bindResult.payload.bindingId

      // Update to V2
      const updateResult = await request(`/api/assessments/bindings/${encodeURIComponent(oldBindingId)}/update`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V2, reason: '客户重新测评' }),
      })
      expect(updateResult.status).toBe(200)
      expect(updateResult.payload.success).toBe(true)
      expect(updateResult.payload.idempotent).toBe(false)
      expect(updateResult.payload.oldBindingId).toBe(oldBindingId)
      const newBindingId = updateResult.payload.newBindingId
      expect(newBindingId).toBeTruthy()
      expect(newBindingId).not.toBe(oldBindingId)

      // Verify: Old binding is SUPERSEDED
      const oldBinding = await pgStore.pool.query('SELECT status FROM public.asva_assessment_bindings WHERE id = $1', [oldBindingId])
      expect(oldBinding.rows[0].status).toBe('SUPERSEDED')

      // Verify: New binding is ACTIVE
      const newBinding = await pgStore.pool.query('SELECT status, report_id FROM public.asva_assessment_bindings WHERE id = $1', [newBindingId])
      expect(newBinding.rows[0].status).toBe('ACTIVE')
      expect(newBinding.rows[0].report_id).toBe('rpt_v101_02')

      // Verify: List only shows new binding (ACTIVE)
      const listResult = await request('/api/customers/CUS-V101-1/assessments', 'MENTOR-V101')
      expect(listResult.payload.assessments.length).toBe(1)
      expect(listResult.payload.assessments[0].bindingId).toBe(newBindingId)
    })

    it('is idempotent for same reportId', async () => {
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId

      // Update with same URL = idempotent
      const updateResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/update`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      expect(updateResult.status).toBe(200)
      expect(updateResult.payload.idempotent).toBe(true)
    })

    it('rejects update with different assessment type', async () => {
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId

      // Try to update with a different assessment type
      const wrongTypeUrl = 'https://xiangshu3721.github.io/mindtest-web/r/#rpt_v101_wrong_type.wrong_type_secret'

      const updateResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/update`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: wrongTypeUrl }),
      })
      expect(updateResult.status).toBe(400)
      expect(updateResult.payload.code).toBe('ASSESSMENT_TYPE_MISMATCH')
    })
  })

  describe('Update history tracking', () => {
    it('records update events and returns them via update-history', async () => {
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const oldBindingId = bindResult.payload.bindingId

      // Update
      const updateResult = await request(`/api/assessments/bindings/${encodeURIComponent(oldBindingId)}/update`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V2, reason: '测试更新原因' }),
      })
      const newBindingId = updateResult.payload.newBindingId

      // Get update history for new binding
      const historyResult = await request(`/api/assessments/bindings/${encodeURIComponent(newBindingId)}/update-history`, 'MENTOR-V101')
      expect(historyResult.status).toBe(200)
      expect(historyResult.payload.history.length).toBeGreaterThanOrEqual(1)
      const reportUpdatedEvent = historyResult.payload.history.find(e => e.eventType === 'REPORT_UPDATED')
      expect(reportUpdatedEvent).toBeTruthy()
      expect(reportUpdatedEvent.detail.reason).toBe('测试更新原因')
    })
  })

  describe('Unbind clears share URL', () => {
    it('clears encrypted share URL when unbinding', async () => {
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId

      // Unbind
      const unbindResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/unbind`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ reason: '测试解绑' }),
      })
      expect(unbindResult.status).toBe(200)

      // Verify share URL is gone
      const urlResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/share-url`, 'MENTOR-V101')
      expect(urlResult.status).toBe(403) // BINDING_NOT_ACTIVE
    })

    it('removes report from customer list after unbind', async () => {
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId

      // Verify it's in the list
      const listBefore = await request('/api/customers/CUS-V101-1/assessments', 'MENTOR-V101')
      expect(listBefore.payload.assessments.length).toBe(1)

      // Unbind
      await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/unbind`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ reason: '测试' }),
      })

      // Verify it's gone from the list
      const listAfter = await request('/api/customers/CUS-V101-1/assessments', 'MENTOR-V101')
      expect(listAfter.payload.assessments.length).toBe(0)
    })
  })

  describe('Permission checks', () => {
    it('allows mentor with customer access to view/share/update/unbind', async () => {
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId
      expect(bindingId).toBeTruthy()

      // Mentor with access can get share URL
      const urlResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/share-url`, 'MENTOR-V101')
      expect(urlResult.status).toBe(200)

      // Mentor with access can unbind
      const unbindResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/unbind`, 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ reason: '导师解绑' }),
      })
      expect(unbindResult.status).toBe(200)
    })

    it('denies mentor without customer access', async () => {
      const bindResult = await request('/api/customers/CUS-V101-1/assessments/confirm', 'MENTOR-V101', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SHARE_URL_V1 }),
      })
      const bindingId = bindResult.payload.bindingId

      // OTHER-MENTOR has no access to CUS-V101-1
      const urlResult = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/share-url`, 'OTHER-MENTOR')
      expect(urlResult.status).toBe(403)
    })
  })

  describe('Incremental migration compatibility', () => {
    it('preserves existing bindings when V1.0.1 columns are added', async () => {
      // Simulate a v41 binding (no encrypted_share_url)
      await pgStore.pool.query(`
        INSERT INTO public.asva_assessment_bindings (
          id, provider, report_id, assessment_id, assessment_name,
          customer_id, customer_name, status, snapshot, snapshot_hash, preview,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        'LEGACY-BINDING-001', 'mindtest-web', 'rpt_legacy_01', 'star', '职业六芒星',
        'CUS-V101-1', '客户A', 'ACTIVE', '{}', 'hash_legacy', '{}',
        new Date().toISOString(), new Date().toISOString(),
      ])

      // Verify it's still accessible
      const listResult = await request('/api/customers/CUS-V101-1/assessments', 'MENTOR-V101')
      const legacy = listResult.payload.assessments.find(a => a.bindingId === 'LEGACY-BINDING-001')
      expect(legacy).toBeTruthy()
      expect(legacy.status).toBe('ACTIVE')

      // Share URL should not be available (returns 404, not error)
      const urlResult = await request('/api/assessments/bindings/LEGACY-BINDING-001/share-url', 'MENTOR-V101')
      expect(urlResult.status).toBe(404)
      expect(urlResult.payload.code).toBe('SHARE_URL_NOT_FOUND')
    })
  })
})
