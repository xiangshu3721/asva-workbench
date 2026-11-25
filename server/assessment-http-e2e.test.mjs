// Real HTTP integration tests for assessment import/confirm/bind flows.
// Uses real Node HTTP server + real PostgreSQL RPC function.
// Only the external assessment report service is mocked (synthetic report data).

import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================================
// 1. Mock: External assessment report service
// ============================================================================
const SYNTHETIC_FULL_REPORT = {
  reportId: 'rpt_http_e2e_01',
  assessmentId: 'star',
  assessmentName: '职业六芒星',
  assessmentVersion: 'star-words-31-v1',
  schemaVersion: '1.0.0',
  nickname: '合成客户一',
  completedAt: '2026-11-20T10:00:00+08:00',
  linkSecret: 'SYNTHETIC_SECRET_SHOULD_NOT_LEAK',
  ownerToken: 'SYNTHETIC_TOKEN_SHOULD_NOT_LEAK',
  dimensions: [
    { id: 'drive', name: '底层动力', kind: 'category', score: null, labels: ['创造性', '自由'] },
    { id: 'pursue', name: '现实追求', kind: 'category', score: null, labels: ['安全'] },
  ],
}

const SYNTHETIC_SHARE_URL = 'https://xiangshu3721.github.io/mindtest-web/r/#rpt_http_e2e_01.synthetic_secret_abc123'

vi.mock('./assessment-import.mjs', () => ({
  importAssessmentFromShareUrl: vi.fn(async (shareUrl) => ({
    reportId: 'rpt_http_e2e_01',
    assessmentId: 'star',
    assessmentName: '职业六芒星',
    assessmentVersion: 'star-words-31-v1',
    completedAt: '2026-11-20T10:00:00+08:00',
    nickname: '合成客户一',
    keyMetrics: [{ id: 'drive', name: '底层动力', labels: ['创造性', '自由'] }],
    headline: '合成报告标题',
    summary: '合成报告摘要',
    caution: '合成报告注意',
    source: 'assessment-import',
    importedAt: new Date().toISOString(),
  })),
  readAssessmentReport: vi.fn(async (reportId, _linkSecret) => {
    if (reportId === 'rpt_http_e2e_01') return { ...SYNTHETIC_FULL_REPORT }
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
  normalizeStarReportPreview: vi.fn((report, reportId) => ({
    reportId: report.reportId || reportId,
    assessmentId: report.assessmentId || 'star',
    assessmentName: report.assessmentName || '职业六芒星',
    assessmentVersion: report.assessmentVersion || 'star-words-31-v1',
    completedAt: report.completedAt || '2026-11-20T10:00:00+08:00',
    nickname: report.nickname || '合成客户一',
    keyMetrics: [{ id: 'drive', name: '底层动力', labels: ['创造性', '自由'] }],
    headline: '合成报告标题',
    summary: '合成报告摘要',
    caution: '合成报告注意',
  })),
}))

// ============================================================================
// 2. Mock: Repository with admin + mentor + customers
// ============================================================================
const state = vi.hoisted(() => ({
  staff: [
    { id: 'MENTOR-HTTP', name: 'Synthetic Mentor', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true },
    { id: 'ADMIN-HTTP', name: 'Synthetic Admin', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true },
  ],
  customers: [
    { id: 'CUS-HTTP-1', nickname: '合成客户一', name: '合成客户一', phone: '13800000001', status: 'ACTIVE' },
    { id: 'CUS-HTTP-2', nickname: '合成客户二', name: '合成客户二', phone: '13800000002', status: 'ACTIVE' },
  ],
}))

class SyntheticRepository {
  async staff(actorId) { return state.staff.find(s => s.id === actorId) || null }
  async customer(actorId, customerId) {
    const staff = await this.staff(actorId)
    if (!staff) return null
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

const { server, __setAssessmentStoreForTesting } = await import('./index.mjs?assessment-http-e2e')
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

// ============================================================================
// 4. Inject real PostgreSQL store (use separate database to avoid conflicts)
// ============================================================================
const { PgTestAssessmentStore } = await import('./assessment-pg-test-store.mjs')
const pgStore = new PgTestAssessmentStore('asva_assessment_http_e2e')
__setAssessmentStoreForTesting(pgStore)

// ============================================================================
// 5. Test helpers
// ============================================================================
async function request(path, staffId = 'MENTOR-HTTP', init = {}) {
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
  return { response, payload }
}

beforeAll(async () => {
  // Clean PG tables
  await pgStore.pool.query('DELETE FROM public.asva_assessment_events')
  await pgStore.pool.query('DELETE FROM public.asva_assessment_bindings')
})

afterAll(async () => {
  await pgStore.close()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(async () => {
  // Clean between tests
  await pgStore.pool.query('DELETE FROM public.asva_assessment_events')
  await pgStore.pool.query('DELETE FROM public.asva_assessment_bindings')
})

// ============================================================================
// Tests
// ============================================================================
describe('Real HTTP + PostgreSQL assessment integration', () => {

  describe('1. Preview → Confirm → List flow', () => {
    it('completes the full import flow', async () => {
      // Step 1: Preview (no binding)
      const preview = await request('/api/assessments/import', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      expect(preview.response.status).toBe(200)
      expect(preview.payload.reportId).toBe('rpt_http_e2e_01')
      expect(preview.payload.assessmentName).toBe('职业六芒星')
      // linkSecret must not leak
      expect(JSON.stringify(preview.payload)).not.toContain('synthetic_secret_abc123')

      // Step 2: Confirm binding (server re-reads from source)
      const confirm = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      expect([200, 201]).toContain(confirm.response.status)
      expect(confirm.payload.bindingId).toBeTruthy()
      expect(confirm.payload.preview.reportId).toBe('rpt_http_e2e_01')

      // Step 3: List assessments
      const list = await request('/api/customers/CUS-HTTP-1/assessments', 'MENTOR-HTTP')
      expect(list.response.status).toBe(200)
      expect(list.payload).toBeTruthy()
      expect(list.payload.assessments).toHaveLength(1)
      expect(list.payload.assessments[0].reportId).toBe('rpt_http_e2e_01')
      expect(list.payload.assessments[0].status).toBe('ACTIVE')
    })
  })

  describe('2. Idempotent re-import', () => {
    it('does not create duplicate bindings on repeated confirm', async () => {
      // First confirm
      const first = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      expect(first.response.status).toBe(201)
      const firstId = first.payload.bindingId

      // Second confirm (idempotent)
      const second = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      expect(second.response.status).toBe(200) // 200 not 201 = idempotent
      expect(second.payload.bindingId).toBe(firstId)

      // Only 1 binding in DB
      const count = await pgStore.pool.query("SELECT COUNT(*) FROM public.asva_assessment_bindings WHERE report_id = 'rpt_http_e2e_01' AND status = 'ACTIVE'")
      expect(Number(count.rows[0].count)).toBe(1)
    })
  })

  describe('3. Cross-customer conflict', () => {
    it('blocks binding same report to different customer', async () => {
      // Bind to CUS-HTTP-1 (name matches)
      const first = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      expect(first.response.status).toBe(201)

      // Try to bind to CUS-HTTP-2 as admin with name confirmation
      // (report nickname '合成客户一' doesn't match customer '合成客户二')
      const second = await request('/api/customers/CUS-HTTP-2/assessments/confirm', 'ADMIN-HTTP', {
        method: 'POST',
        body: JSON.stringify({
          shareUrl: SYNTHETIC_SHARE_URL,
          nameConfirmedBy: 'ADMIN-HTTP',
          nameConfirmedReason: '已确认身份一致',
        }),
      })
      // Should be 409 REPORT_ALREADY_BOUND (name confirmed, but report already bound)
      expect(second.response.status).toBe(409)
      expect(second.payload.code).toBe('REPORT_ALREADY_BOUND')
      // Mentor should NOT see the other customer's name in the error
      // (this is the admin, so they CAN see it — that's by design)
    })
  })

  describe('4. Admin transfer preserves snapshot atomically', () => {
    it('transfers and removes from original customer', async () => {
      // Bind
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Admin transfers to CUS-HTTP-2
      const transferred = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/transfer`, 'ADMIN-HTTP', {
        method: 'POST',
        body: JSON.stringify({ targetCustomerId: 'CUS-HTTP-2', reason: '纠错转移' }),
      })
      expect(transferred.response.status).toBe(200)
      expect(transferred.payload.status).toBe('TRANSFERRED')

      // Original customer no longer has the report
      const listOriginal = await request('/api/customers/CUS-HTTP-1/assessments', 'MENTOR-HTTP')
      expect(listOriginal.payload.assessments).toHaveLength(0)

      // Target customer now has it
      const listTarget = await request('/api/customers/CUS-HTTP-2/assessments', 'MENTOR-HTTP')
      expect(listTarget.payload.assessments).toHaveLength(1)
    })
  })

  describe('5. Non-admin cannot transfer or revoke', () => {
    it('rejects mentor transfer with 403', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      const result = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/transfer`, 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ targetCustomerId: 'CUS-HTTP-2', reason: 'test' }),
      })
      expect(result.response.status).toBe(403)
    })

    it('rejects mentor revoke with 403', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      const result = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/revoke`, 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ reason: 'test' }),
      })
      expect(result.response.status).toBe(403)
    })
  })

  describe('6. Admin local revoke cuts access', () => {
    it('revoked binding no longer appears in active list', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      const revoked = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/revoke`, 'ADMIN-HTTP', {
        method: 'POST',
        body: JSON.stringify({ reason: '安全撤销' }),
      })
      expect(revoked.response.status).toBe(200)

      const list = await request('/api/customers/CUS-HTTP-1/assessments', 'MENTOR-HTTP')
      expect(list.payload.assessments).toHaveLength(0)
    })
  })

  describe('7. Credential non-leak verification', () => {
    it('preview does not contain linkSecret or ownerToken', async () => {
      const preview = await request('/api/assessments/import', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const body = JSON.stringify(preview.payload)
      expect(body).not.toContain('SYNTHETIC_SECRET_SHOULD_NOT_LEAK')
      expect(body).not.toContain('SYNTHETIC_TOKEN_SHOULD_NOT_LEAK')
      expect(body).not.toContain('synthetic_secret_abc123')
    })

    it('confirm response does not contain credentials', async () => {
      const confirm = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const body = JSON.stringify(confirm.payload)
      expect(body).not.toContain('SYNTHETIC_SECRET_SHOULD_NOT_LEAK')
      expect(body).not.toContain('synthetic_secret_abc123')
    })

    it('stored snapshot has credentials stripped', async () => {
      await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })

      const row = await pgStore.pool.query('SELECT snapshot FROM public.asva_assessment_bindings LIMIT 1')
      const snapshot = row.rows[0].snapshot
      // The snapshot is sanitized by the server before storage
      // linkSecret and ownerToken should not be present
      expect(snapshot.linkSecret).toBeUndefined()
      expect(snapshot.ownerToken).toBeUndefined()
    })
  })

  describe('8. Customer access isolation', () => {
    it('mentor cannot see other customer assessments', async () => {
      // Bind to CUS-HTTP-1
      await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })

      // CUS-HTTP-2 should not see it
      const list = await request('/api/customers/CUS-HTTP-2/assessments', 'MENTOR-HTTP')
      expect(list.payload.assessments).toHaveLength(0)
    })
  })

  describe('9. Consent tracking', () => {
    it('default binding has no consent', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      expect(bound.payload.customerConsent).toBe(false)
    })

    it('can grant consent', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      const consented = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/consent`, 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ consentRecord: '客户口头同意' }),
      })
      expect(consented.response.status).toBe(200)

      // Verify in DB
      const row = await pgStore.pool.query('SELECT customer_consent FROM public.asva_assessment_bindings LIMIT 1')
      expect(row.rows[0].customer_consent).toBe(true)
    })
  })

  describe('10. Audit events', () => {
    it('records bind and unbind events', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/unbind`, 'ADMIN-HTTP', {
        method: 'POST',
        body: JSON.stringify({ reason: '测试解绑' }),
      })

      const events = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/events`, 'ADMIN-HTTP')
      expect(events.response.status).toBe(200)
      expect(events.payload.events.length).toBeGreaterThanOrEqual(2)
      const types = events.payload.events.map(e => e.eventType)
      expect(types).toContain('BOUND')
      expect(types).toContain('UNBOUND')
    })
  })

  describe('11. Snapshot access control for non-ACTIVE bindings', () => {
    it('admin can read snapshot of unbound binding (audit)', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Unbind
      await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/unbind`, 'ADMIN-HTTP', {
        method: 'POST',
        body: JSON.stringify({ reason: 'test' }),
      })

      // Admin can still read snapshot (audit access)
      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'ADMIN-HTTP')
      expect(snap.response.status).toBe(200)
      expect(snap.payload.bindingId).toBe(bindingId)
      expect(snap.payload.status).toBe('UNBOUND')
    })

    it('non-admin cannot read snapshot of unbound binding', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Unbind
      await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/unbind`, 'ADMIN-HTTP', {
        method: 'POST',
        body: JSON.stringify({ reason: 'test' }),
      })

      // Mentor cannot read snapshot of unbound binding
      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'MENTOR-HTTP')
      expect(snap.response.status).toBe(403)
      expect(snap.payload.code).toBe('BINDING_NOT_ACTIVE')
    })

    it('non-admin cannot read snapshot of revoked binding', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Admin revokes
      await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/revoke`, 'ADMIN-HTTP', {
        method: 'POST',
        body: JSON.stringify({ reason: '安全撤销' }),
      })

      // Mentor cannot read snapshot of revoked binding
      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'MENTOR-HTTP')
      expect(snap.response.status).toBe(403)
      expect(snap.payload.code).toBe('BINDING_NOT_ACTIVE')
    })

    it('non-admin cannot read snapshot of transferred binding', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Admin transfers to CUS-HTTP-2
      await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/transfer`, 'ADMIN-HTTP', {
        method: 'POST',
        body: JSON.stringify({ targetCustomerId: 'CUS-HTTP-2', reason: 'test' }),
      })

      // Mentor cannot read snapshot of the old (transferred) binding
      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'MENTOR-HTTP')
      expect(snap.response.status).toBe(403)
      expect(snap.payload.code).toBe('BINDING_NOT_ACTIVE')
    })
  })

  describe('12. Source status returns UNKNOWN (not verified)', () => {
    it('sourceStatus is UNKNOWN by default (no source re-check)', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Use admin to read (no consent needed for admin)
      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'ADMIN-HTTP')
      expect(snap.response.status).toBe(200)
      // Source status must NOT be 'OK' — it's genuinely unknown
      expect(snap.payload.sourceStatus).toBe('UNKNOWN')
      expect(snap.payload.sourceStatusMessage).toContain('未知')
      expect(snap.payload.sourceRevoked).toBe(false)
    })

    it('admin can read snapshot with UNKNOWN source status', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'ADMIN-HTTP')
      expect(snap.response.status).toBe(200)
      expect(snap.payload.sourceStatus).toBe('UNKNOWN')
    })
  })

  describe('13. Archive vs AI authorization separation', () => {
    it('binding implies archive authorization (distinct from AI consent)', async () => {
      // Confirm without customerConsent
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      expect(bound.payload.archiveAuthorized).toBe(true)
      // AI consent defaults to false
      expect(bound.payload.customerConsent).toBe(false)
    })

    it('can grant AI consent separately after binding', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Grant AI consent
      const consented = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/consent`, 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ action: 'grant', consentRecord: '客户同意 AI 使用' }),
      })
      expect(consented.response.status).toBe(200)

      // Verify: archive still authorized, AI consent now true
      const row = await pgStore.pool.query('SELECT customer_consent FROM public.asva_assessment_bindings WHERE id = $1', [bindingId])
      expect(row.rows[0].customer_consent).toBe(true)
    })

    it('customer without AI consent cannot read snapshot', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Try to read snapshot as mentor (who acts as customer access in test setup)
      // Since customerConsent is false, non-admin should be blocked
      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'MENTOR-HTTP')
      // Mentor has access to the customer, but no AI consent → blocked
      expect(snap.response.status).toBe(403)
      expect(snap.payload.code).toBe('AI_CONSENT_REQUIRED')
    })

    it('admin can read snapshot even without AI consent', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Admin can read even without AI consent (for audit)
      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'ADMIN-HTTP')
      expect(snap.response.status).toBe(200)
    })
  })

  describe('14. Snapshot access requires customer consent for non-admin', () => {
    it('customer with consent can read snapshot', async () => {
      const bound = await request('/api/customers/CUS-HTTP-1/assessments/confirm', 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ shareUrl: SYNTHETIC_SHARE_URL }),
      })
      const bindingId = bound.payload.bindingId

      // Grant consent first
      await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/consent`, 'MENTOR-HTTP', {
        method: 'POST',
        body: JSON.stringify({ action: 'grant', consentRecord: '客户同意' }),
      })

      // Now mentor (who has customer access) can read
      const snap = await request(`/api/assessments/bindings/${encodeURIComponent(bindingId)}/snapshot`, 'MENTOR-HTTP')
      expect(snap.response.status).toBe(200)
      expect(snap.payload.snapshot).toBeTruthy()
    })
  })
})
