import { describe, expect, it, beforeEach } from 'vitest'
import { CloudBaseAssessmentStore, generateBindingId, snapshotHash, sanitizeReportForStorage, sanitizeShareUrl } from './assessment-pg-store.mjs'

/**
 * Mock PG RPC that simulates the asva_assessment_guard function.
 * This mock enforces the same constraints as the real SQL:
 * - UNIQUE (provider, report_id) for active bindings
 * - Idempotent same-customer re-bind
 * - Cross-customer conflict rejection
 * - Status transitions
 * - Audit events
 */
function createMockPgRpc() {
  const bindings = new Map() // bindingId → binding row
  const events = []
  let eventCounter = 0

  // Indexes for fast lookup
  function findActiveByProviderReport(provider, reportId) {
    for (const b of bindings.values()) {
      if (b.provider === provider && b.report_id === reportId && b.status === 'ACTIVE') return b
    }
    return null
  }

  return {
    async rpc(action, payload) {
      const now = payload.now || new Date().toISOString()

      if (action === 'bind') {
        const { provider, reportId, customerId, bindingId } = payload

        // Check existing
        const existing = findActiveByProviderReport(provider, reportId)
        if (existing) {
          if (existing.customer_id === customerId) {
            // Idempotent
            events.push({ id: ++eventCounter, binding_id: existing.id, event_type: 'BOUND', actor_id: payload.boundBy || '', detail: { idempotent: true }, created_at: now })
            return {
              idempotent: true,
              alreadyBound: true,
              binding: { ...existing, completed_at: existing.completed_at },
            }
          }
          return {
            error: {
              code: 'REPORT_ALREADY_BOUND',
              message: '此报告已绑定到其他客户',
              existingCustomerId: existing.customer_id,
              existingCustomerName: existing.customer_name,
              status: 409,
            },
          }
        }

        // New binding
        const row = {
          id: bindingId,
          provider,
          report_id: reportId,
          assessment_id: payload.assessmentId || '',
          assessment_name: payload.assessmentName || '',
          assessment_version: payload.assessmentVersion || '',
          schema_version: payload.schemaVersion || '',
          customer_id: customerId,
          customer_name: payload.customerName || '',
          report_nickname: payload.reportNickname || '',
          completed_at: payload.completedAt || null,
          bound_at: now,
          bound_by: payload.boundBy || '',
          status: 'ACTIVE',
          snapshot: payload.snapshot || {},
          snapshot_hash: payload.snapshotHash || '',
          preview: payload.preview || {},
          name_mismatch: payload.nameMismatch || false,
          name_confirmed_by: payload.nameConfirmedBy || null,
          name_confirmed_at: payload.nameConfirmedAt || null,
          name_confirmed_reason: payload.nameConfirmedReason || null,
          customer_consent: payload.customerConsent || false,
          customer_consent_at: payload.customerConsentAt || null,
          customer_consent_record: payload.customerConsentRecord || null,
          source_revoked: false,
          local_revoked: false,
          created_at: now,
          updated_at: now,
        }
        bindings.set(bindingId, row)
        events.push({ id: ++eventCounter, binding_id: bindingId, event_type: 'BOUND', actor_id: payload.boundBy || '', detail: { provider, reportId, customerId, nameMismatch: payload.nameMismatch }, created_at: now })
        return {
          idempotent: false,
          alreadyBound: false,
          binding: { ...row },
        }
      }

      if (action === 'unbind') {
        const row = bindings.get(payload.bindingId)
        if (!row) return { error: { code: 'BINDING_NOT_FOUND', message: '绑定记录不存在', status: 404 } }
        if (row.status !== 'ACTIVE') return { error: { code: 'BINDING_NOT_ACTIVE', message: '该绑定已不在活跃状态', status: 409 } }
        row.status = 'UNBOUND'
        row.updated_at = now
        events.push({ id: ++eventCounter, binding_id: row.id, event_type: 'UNBOUND', actor_id: payload.actorId || '', detail: { reason: payload.reason || '' }, created_at: now })
        return { ok: true, bindingId: row.id, status: 'UNBOUND' }
      }

      if (action === 'transfer') {
        const row = bindings.get(payload.bindingId)
        if (!row) return { error: { code: 'BINDING_NOT_FOUND', message: '绑定记录不存在', status: 404 } }
        if (row.status !== 'ACTIVE') return { error: { code: 'BINDING_NOT_ACTIVE', message: '该绑定已不在活跃状态', status: 409 } }

        // Check target
        const targetExisting = findActiveByProviderReport(row.provider, row.report_id)
        if (targetExisting && targetExisting.customer_id === payload.targetCustomerId) {
          return { error: { code: 'TARGET_ALREADY_BOUND', message: '目标客户已绑定此报告', status: 409 } }
        }

        // Mark old as transferred
        row.status = 'TRANSFERRED'
        row.updated_at = now
        events.push({ id: ++eventCounter, binding_id: row.id, event_type: 'TRANSFERRED_OUT', actor_id: payload.actorId || '', detail: { fromCustomerId: row.customer_id, toCustomerId: payload.targetCustomerId, reason: payload.reason || '' }, created_at: now })

        // Create new
        const newRow = {
          ...row,
          id: payload.newBindingId,
          customer_id: payload.targetCustomerId,
          customer_name: payload.targetCustomerName || '',
          status: 'ACTIVE',
          bound_at: now,
          bound_by: payload.actorId || '',
          created_at: now,
          updated_at: now,
        }
        bindings.set(payload.newBindingId, newRow)
        events.push({ id: ++eventCounter, binding_id: newRow.id, event_type: 'TRANSFERRED_IN', actor_id: payload.actorId || '', detail: { fromBindingId: row.id, fromCustomerId: row.customer_id, reason: payload.reason || '' }, created_at: now })

        return { ok: true, oldBindingId: row.id, newBindingId: newRow.id, status: 'TRANSFERRED' }
      }

      if (action === 'revoke_local') {
        const row = bindings.get(payload.bindingId)
        if (!row) return { error: { code: 'BINDING_NOT_FOUND', message: '绑定记录不存在', status: 404 } }
        row.status = 'REVOKED'
        row.local_revoked = true
        row.local_revoked_at = now
        row.local_revoked_by = payload.actorId || ''
        row.local_revoke_reason = payload.reason || ''
        row.updated_at = now
        events.push({ id: ++eventCounter, binding_id: row.id, event_type: 'REVOKED_LOCAL', actor_id: payload.actorId || '', detail: { reason: payload.reason || '' }, created_at: now })
        return { ok: true, bindingId: row.id, status: 'REVOKED' }
      }

      if (action === 'confirm_name') {
        const row = bindings.get(payload.bindingId)
        if (!row) return { error: { code: 'BINDING_NOT_FOUND', message: '绑定记录不存在', status: 404 } }
        row.name_mismatch = false
        row.name_confirmed_by = payload.confirmedBy || ''
        row.name_confirmed_at = now
        row.name_confirmed_reason = payload.reason || ''
        row.updated_at = now
        events.push({ id: ++eventCounter, binding_id: row.id, event_type: 'NAME_CONFIRMED', actor_id: payload.confirmedBy || '', detail: { reason: payload.reason || '' }, created_at: now })
        return { ok: true, bindingId: row.id }
      }

      if (action === 'grant_consent') {
        const row = bindings.get(payload.bindingId)
        if (!row) return { error: { code: 'BINDING_NOT_FOUND', message: '绑定记录不存在', status: 404 } }
        row.customer_consent = true
        row.customer_consent_at = now
        row.customer_consent_record = payload.consentRecord || ''
        row.updated_at = now
        events.push({ id: ++eventCounter, binding_id: row.id, event_type: 'CONSENT_GRANTED', actor_id: payload.actorId || '', detail: { consentRecord: payload.consentRecord || '' }, created_at: now })
        return { ok: true, bindingId: row.id }
      }

      if (action === 'get') {
        if (payload.bindingId) {
          const row = bindings.get(payload.bindingId)
          return { binding: row || null }
        }
        if (payload.customerId) {
          const results = []
          for (const b of bindings.values()) {
            if (b.customer_id === payload.customerId && b.status === 'ACTIVE') results.push({ ...b })
          }
          results.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
          return { bindings: results }
        }
        if (payload.provider && payload.reportId) {
          const row = findActiveByProviderReport(payload.provider, payload.reportId)
          return { binding: row || null }
        }
        return { error: { code: 'ASSESSMENT_GET_INVALID', message: '查询参数无效', status: 400 } }
      }

      if (action === 'history') {
        const results = []
        for (const b of bindings.values()) {
          if (b.customer_id !== payload.customerId) continue
          if (payload.assessmentId && b.assessment_id !== payload.assessmentId) continue
          if (!['ACTIVE', 'TRANSFERRED', 'UNBOUND', 'REVOKED'].includes(b.status)) continue
          results.push({ ...b })
        }
        results.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
        return { bindings: results }
      }

      if (action === 'events') {
        return { events: events.filter(e => e.binding_id === payload.bindingId).sort((a, b) => a.created_at.localeCompare(b.created_at)) }
      }

      throw new Error(`Unknown action: ${action}`)
    },
    _bindings: bindings,
    _events: events,
  }
}

function createStore(mockRpc) {
  return new CloudBaseAssessmentStore({
    rpcBaseUrl: 'https://test.api.tcloudbasegateway.com/v1/rdb/rest/rpc',
    rpcFunction: 'asva_assessment_guard',
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      const action = body.request.action
      const result = await mockRpc.rpc(action, body.request)
      return {
        ok: !result.error,
        status: result.error?.status || 200,
        json: async () => result,
      }
    },
  })
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
  linkSecret: 'SECRET_SHOULD_BE_STRIPPED',
  ownerToken: 'TOKEN_SHOULD_BE_STRIPPED',
  dimensions: [
    { id: 'drive', name: '底层动力', kind: 'category', score: null, labels: ['创造性', '自由'] },
  ],
}

const syntheticPreview = {
  reportId: 'rpt_test_001',
  assessmentId: 'star',
  nickname: '测试用户',
  headline: '底层动力：创造性、自由',
}

const customer1 = { id: 'CUS-001', name: '张三' }
const customer2 = { id: 'CUS-002', name: '李四' }
const mentor1 = 'staff-mentor-001'

describe('assessment-pg-store', () => {
  let mockRpc
  let store

  beforeEach(() => {
    mockRpc = createMockPgRpc()
    store = createStore(mockRpc)
  })

  describe('sanitizeReportForStorage', () => {
    it('strips linkSecret and ownerToken', () => {
      const sanitized = sanitizeReportForStorage(syntheticReport)
      expect(sanitized.linkSecret).toBeUndefined()
      expect(sanitized.ownerToken).toBeUndefined()
      expect(sanitized.reportId).toBe('rpt_test_001')
      expect(sanitized.dimensions).toHaveLength(1)
    })

    it('strips fields containing "secret" or "token"', () => {
      const report = { data: 'ok', mySecretKey: 'abc', authToken: 'xyz', shareSecret: '123' }
      const sanitized = sanitizeReportForStorage(report)
      expect(sanitized.data).toBe('ok')
      expect(sanitized.mySecretKey).toBeUndefined()
      expect(sanitized.authToken).toBeUndefined()
      expect(sanitized.shareSecret).toBeUndefined()
    })
  })

  describe('sanitizeShareUrl', () => {
    it('strips linkSecret from share URL fragment', () => {
      const url = 'https://example.com/r/#rpt_001.superSecretKey123456'
      expect(sanitizeShareUrl(url)).toBe('https://example.com/r/#rpt_001')
    })

    it('handles URL without fragment', () => {
      expect(sanitizeShareUrl('https://example.com/r/')).toBe('https://example.com/r/')
    })

    it('handles empty URL', () => {
      expect(sanitizeShareUrl('')).toBe('')
      expect(sanitizeShareUrl(null)).toBe('')
    })
  })

  describe('bindReport', () => {
    it('creates a new binding with sanitized snapshot', async () => {
      const result = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        assessmentVersion: 'star-words-31-v1',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试用户',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        shareUrl: 'https://example.com/r/#rpt_001.SECRET123',
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      expect(result.bindingId).toMatch(/^ABD-/)
      expect(result.idempotent).toBe(false)
      expect(result.status).toBe('ACTIVE')

      // Verify snapshot was sanitized (no credentials)
      const storedBinding = mockRpc._bindings.get(result.bindingId)
      expect(storedBinding.snapshot.linkSecret).toBeUndefined()
      expect(storedBinding.snapshot.ownerToken).toBeUndefined()
      expect(storedBinding.snapshot.reportId).toBe('rpt_test_001')

      // Verify share URL was sanitized
      expect(storedBinding.snapshot.shareUrl).toBeUndefined() // not in snapshot
    })

    it('returns idempotent result for same report + same customer', async () => {
      const params = {
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      }

      const first = await store.bindReport(params)
      const second = await store.bindReport(params)

      expect(second.idempotent).toBe(true)
      expect(second.alreadyBound).toBe(true)
      expect(second.bindingId).toBe(first.bindingId)

      // Only 1 binding in DB (not 2)
      expect(mockRpc._bindings.size).toBe(1)
    })

    it('rejects cross-customer binding', async () => {
      await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      await expect(
        store.bindReport({
          provider: 'mindtest-web',
          reportId: 'rpt_test_001',
          assessmentId: 'star',
          assessmentName: '职业六芒星',
          customerId: customer2.id,
          customerName: customer2.name,
          reportNickname: '测试',
          completedAt: '2026-11-20T10:00:00+08:00',
          boundBy: 'staff-mentor-002',
          fullReport: syntheticReport,
          safePreview: syntheticPreview,
        })
      ).rejects.toThrow('此报告已绑定到其他客户')
    })

    it('records name mismatch flag', async () => {
      const result = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: '张三',
        reportNickname: '小明', // Different from customer name
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
        nameMismatch: true,
      })

      expect(result.nameMismatch).toBe(true)
      const stored = mockRpc._bindings.get(result.bindingId)
      expect(stored.name_mismatch).toBe(true)

      // Verify audit event
      const bindEvents = mockRpc._events.filter(e => e.event_type === 'BOUND')
      expect(bindEvents).toHaveLength(1)
      expect(bindEvents[0].detail.nameMismatch).toBe(true)
    })
  })

  describe('unbindReport', () => {
    it('unbinds and records audit event', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const result = await store.unbindReport(bound.bindingId, mentor1, '不再需要')
      expect(result.status).toBe('UNBOUND')

      const stored = mockRpc._bindings.get(bound.bindingId)
      expect(stored.status).toBe('UNBOUND')

      // Verify audit
      const unbindEvents = mockRpc._events.filter(e => e.event_type === 'UNBOUND')
      expect(unbindEvents).toHaveLength(1)
      expect(unbindEvents[0].detail.reason).toBe('不再需要')
    })

    it('rejects unbinding non-existent binding', async () => {
      await expect(store.unbindReport('ABD-NONEXISTENT', mentor1)).rejects.toThrow()
    })

    it('allows re-binding after unbind', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      await store.unbindReport(bound.bindingId, mentor1)

      // Now bind to different customer
      const rebound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer2.id,
        customerName: customer2.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      expect(rebound.customerId).toBe(customer2.id)
      expect(rebound.status).toBe('ACTIVE')
    })
  })

  describe('transferBinding', () => {
    it('transfers binding atomically', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const result = await store.transferBinding(bound.bindingId, customer2.id, customer2.name, mentor1, '纠错')
      expect(result.status).toBe('TRANSFERRED')
      expect(result.newBindingId).toBeTruthy()

      // Old binding is TRANSFERRED
      const oldBinding = mockRpc._bindings.get(bound.bindingId)
      expect(oldBinding.status).toBe('TRANSFERRED')

      // New binding is ACTIVE for customer2
      const newBinding = mockRpc._bindings.get(result.newBindingId)
      expect(newBinding.status).toBe('ACTIVE')
      expect(newBinding.customer_id).toBe(customer2.id)

      // Snapshot preserved
      expect(newBinding.snapshot).toEqual(oldBinding.snapshot)
      expect(newBinding.snapshot_hash).toBe(oldBinding.snapshot_hash)

      // Audit events
      const outEvents = mockRpc._events.filter(e => e.event_type === 'TRANSFERRED_OUT')
      const inEvents = mockRpc._events.filter(e => e.event_type === 'TRANSFERRED_IN')
      expect(outEvents).toHaveLength(1)
      expect(inEvents).toHaveLength(1)
      expect(outEvents[0].detail.fromCustomerId).toBe(customer1.id)
      expect(inEvents[0].detail.fromBindingId).toBe(bound.bindingId)
    })
  })

  describe('revokeLocal', () => {
    it('revokes access locally while preserving snapshot', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const result = await store.revokeLocal(bound.bindingId, mentor1, '安全撤销')
      expect(result.status).toBe('REVOKED')

      const stored = mockRpc._bindings.get(bound.bindingId)
      expect(stored.status).toBe('REVOKED')
      expect(stored.local_revoked).toBe(true)
      expect(stored.snapshot.reportId).toBe('rpt_test_001') // Snapshot preserved
    })
  })

  describe('getCustomerAssessments', () => {
    it('returns active assessments sorted by completedAt desc', async () => {
      // Bind two reports with different completedAt
      await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_old',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '旧',
        completedAt: '2026-01-01T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: { reportId: 'rpt_old', nickname: '旧' },
        safePreview: { reportId: 'rpt_old' },
      })

      await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_new',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '新',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: { reportId: 'rpt_new', nickname: '新' },
        safePreview: { reportId: 'rpt_new' },
      })

      const assessments = await store.getCustomerAssessments(customer1.id)
      expect(assessments).toHaveLength(2)
      // Newest first (sorted by PG)
      expect(assessments[0].reportId).toBe('rpt_new')
      expect(assessments[1].reportId).toBe('rpt_old')
    })

    it('excludes unbound assessments', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      await store.unbindReport(bound.bindingId, mentor1)

      const assessments = await store.getCustomerAssessments(customer1.id)
      expect(assessments).toHaveLength(0)
    })
  })

  describe('consent tracking', () => {
    it('tracks customer consent for AI usage', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
        customerConsent: false,
      })

      expect(bound.customerConsent).toBe(false)

      await store.grantConsent(bound.bindingId, mentor1, '客户口头同意')
      const updated = await store.findBindingById(bound.bindingId)
      expect(updated.customerConsent).toBe(true)

      const consentEvents = mockRpc._events.filter(e => e.event_type === 'CONSENT_GRANTED')
      expect(consentEvents).toHaveLength(1)
    })
  })

  describe('name confirmation', () => {
    it('clears name mismatch after admin confirmation', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: '张三',
        reportNickname: '小明',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
        nameMismatch: true,
      })

      expect(bound.nameMismatch).toBe(true)

      await store.confirmName(bound.bindingId, mentor1, '已确认是客户本人')
      const updated = await store.findBindingById(bound.bindingId)
      expect(updated.nameMismatch).toBe(false)
      expect(updated.nameConfirmedBy).toBe(mentor1)
    })
  })

  describe('audit trail', () => {
    it('returns full event history for a binding', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const events = await store.getBindingEvents(bound.bindingId)
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events[0].event_type || events[0].eventType).toBe('BOUND')
    })
  })

  describe('cross-customer isolation', () => {
    it('does not return other customers assessments', async () => {
      await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const customer2Assessments = await store.getCustomerAssessments(customer2.id)
      expect(customer2Assessments).toHaveLength(0)
    })
  })

  describe('persistence across operations', () => {
    it('snapshot survives unbind + rebind to different customer', async () => {
      const bound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer1.id,
        customerName: customer1.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const originalSnapshot = mockRpc._bindings.get(bound.bindingId).snapshot

      await store.unbindReport(bound.bindingId, mentor1)

      const rebound = await store.bindReport({
        provider: 'mindtest-web',
        reportId: 'rpt_test_001',
        assessmentId: 'star',
        assessmentName: '职业六芒星',
        customerId: customer2.id,
        customerName: customer2.name,
        reportNickname: '测试',
        completedAt: '2026-11-20T10:00:00+08:00',
        boundBy: mentor1,
        fullReport: syntheticReport,
        safePreview: syntheticPreview,
      })

      const newSnapshot = mockRpc._bindings.get(rebound.bindingId).snapshot
      expect(newSnapshot).toEqual(originalSnapshot)
    })
  })
})
