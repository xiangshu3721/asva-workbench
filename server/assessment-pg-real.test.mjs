// Real PostgreSQL integration tests for assessment bindings.
// Connects to local PostgreSQL and executes actual SQL via the RPC function.
// NO Map mocks — this tests real transactional behavior.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

const { Pool } = pg

const DB_NAME = 'asva_assessment_test'
const DB_USER = process.env.USER || 'postgres'

// Synthetic full report (with credentials that must be stripped)
const SYNTHETIC_FULL_REPORT = {
  reportId: 'rpt_pg_test_01',
  assessmentId: 'star',
  assessmentName: '职业六芒星',
  assessmentVersion: 'star-words-31-v1',
  schemaVersion: '1.0.0',
  nickname: '测试用户',
  completedAt: '2026-11-20T10:00:00+08:00',
  linkSecret: 'SECRET_MUST_BE_STRIPPED',
  ownerToken: 'TOKEN_MUST_BE_STRIPPED',
  dimensions: [
    { id: 'drive', name: '底层动力', kind: 'category', score: null, labels: ['创造性', '自由'] },
    { id: 'pursue', name: '现实追求', kind: 'category', score: null, labels: ['安全', '新鲜感'] },
  ],
}

let pool

async function rpc(action, payload = {}) {
  const result = await pool.query('SELECT public.asva_assessment_guard($1::jsonb)', [
    JSON.stringify({ action, table: 'asva_assessment_bindings', ...payload })
  ])
  return result.rows[0].asva_assessment_guard
}

beforeAll(async () => {
  pool = new Pool({ database: DB_NAME, user: DB_USER })
  // Verify connection
  await pool.query('SELECT 1')
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  // Clean tables between tests
  await pool.query('DELETE FROM public.asva_assessment_events')
  await pool.query('DELETE FROM public.asva_assessment_bindings')
})

describe('Real PostgreSQL: basic bind', () => {
  it('creates a binding and returns it', async () => {
    const result = await rpc('bind', {
      bindingId: 'ABD-PG-TEST-001',
      provider: 'mindtest-web',
      reportId: 'rpt_pg_001',
      assessmentId: 'star',
      assessmentName: '职业六芒星',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: SYNTHETIC_FULL_REPORT,
      snapshotHash: 'abc123',
      preview: { reportId: 'rpt_pg_001', headline: 'test' },
      now: '2026-11-24T12:00:00Z',
    })

    expect(result.idempotent).toBe(false)
    expect(result.alreadyBound).toBe(false)
    expect(result.binding.id).toBe('ABD-PG-TEST-001')
    expect(result.binding.status).toBe('ACTIVE')
    expect(result.binding.customerId).toBe('CUS-001')

    // Verify in database
    const dbRow = await pool.query('SELECT * FROM public.asva_assessment_bindings WHERE id = $1', ['ABD-PG-TEST-001'])
    expect(dbRow.rows).toHaveLength(1)
    expect(dbRow.rows[0].status).toBe('ACTIVE')
    expect(dbRow.rows[0].customer_id).toBe('CUS-001')
    // Snapshot stored with credentials (sanitization happens in Node.js layer)
    expect(dbRow.rows[0].snapshot.reportId).toBe('rpt_pg_test_01')
  })

  it('enforces UNIQUE(provider, report_id) for ACTIVE bindings', async () => {
    await rpc('bind', {
      bindingId: 'ABD-PG-001',
      provider: 'mindtest-web',
      reportId: 'rpt_unique_test',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h1',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    // Try to bind same report to different customer
    const result = await rpc('bind', {
      bindingId: 'ABD-PG-002',
      provider: 'mindtest-web',
      reportId: 'rpt_unique_test',
      assessmentId: 'star',
      customerId: 'CUS-002',
      customerName: '李四',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-002',
      snapshot: {},
      snapshotHash: 'h1',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    expect(result.error).toBeDefined()
    expect(result.error.code).toBe('REPORT_ALREADY_BOUND')
    expect(result.error.existingCustomerId).toBe('CUS-001')
  })
})

describe('Real PostgreSQL: idempotent re-import', () => {
  it('returns existing binding for same report + same customer', async () => {
    const first = await rpc('bind', {
      bindingId: 'ABD-PG-IDE-001',
      provider: 'mindtest-web',
      reportId: 'rpt_idempotent',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'same_hash',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    const second = await rpc('bind', {
      bindingId: 'ABD-PG-IDE-002', // Different ID but same report+customer
      provider: 'mindtest-web',
      reportId: 'rpt_idempotent',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'same_hash', // Same hash — no content change
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    expect(second.idempotent).toBe(true)
    expect(second.alreadyBound).toBe(true)
    expect(second.binding.id).toBe('ABD-PG-IDE-001') // Returns original

    // Only 1 row in DB
    const count = await pool.query('SELECT COUNT(*) FROM public.asva_assessment_bindings WHERE report_id = $1', ['rpt_idempotent'])
    expect(Number(count.rows[0].count)).toBe(1)
  })

  it('rejects when snapshot hash changes (content integrity)', async () => {
    await rpc('bind', {
      bindingId: 'ABD-PG-HASH-001',
      provider: 'mindtest-web',
      reportId: 'rpt_hash_test',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'original_hash',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    // Re-import with different hash
    const result = await rpc('bind', {
      bindingId: 'ABD-PG-HASH-002',
      provider: 'mindtest-web',
      reportId: 'rpt_hash_test',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'CHANGED_HASH', // Different!
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    expect(result.error).toBeDefined()
    expect(result.error.code).toBe('REPORT_CONTENT_CHANGED')
  })
})

describe('Real PostgreSQL: unbind + rebind', () => {
  it('unbind releases unique constraint, allows rebind', async () => {
    const bound = await rpc('bind', {
      bindingId: 'ABD-PG-UB-001',
      provider: 'mindtest-web',
      reportId: 'rpt_unbind_test',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h1',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    // Unbind
    const unbound = await rpc('unbind', {
      bindingId: 'ABD-PG-UB-001',
      actorId: 'admin-001',
      reason: '测试解绑',
      now: '2026-11-24T12:01:00Z',
    })
    expect(unbound.ok).toBe(true)
    expect(unbound.status).toBe('UNBOUND')

    // Now bind to different customer — should succeed (old is UNBOUND, not ACTIVE)
    const rebound = await rpc('bind', {
      bindingId: 'ABD-PG-UB-002',
      provider: 'mindtest-web',
      reportId: 'rpt_unbind_test',
      assessmentId: 'star',
      customerId: 'CUS-002',
      customerName: '李四',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h1',
      preview: {},
      now: '2026-11-24T12:02:00Z',
    })

    expect(rebound.idempotent).toBe(false)
    expect(rebound.binding.customerId).toBe('CUS-002')
    expect(rebound.binding.status).toBe('ACTIVE')

    // Two rows total: one UNBOUND, one ACTIVE
    const count = await pool.query('SELECT COUNT(*) FROM public.asva_assessment_bindings WHERE report_id = $1', ['rpt_unbind_test'])
    expect(Number(count.rows[0].count)).toBe(2)

    const active = await pool.query("SELECT * FROM public.asva_assessment_bindings WHERE report_id = $1 AND status = 'ACTIVE'", ['rpt_unbind_test'])
    expect(active.rows).toHaveLength(1)
    expect(active.rows[0].customer_id).toBe('CUS-002')
  })
})

describe('Real PostgreSQL: transfer', () => {
  it('transfers atomically — old becomes TRANSFERRED, new becomes ACTIVE', async () => {
    await rpc('bind', {
      bindingId: 'ABD-PG-TR-001',
      provider: 'mindtest-web',
      reportId: 'rpt_transfer_test',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: { data: 'important' },
      snapshotHash: 'hash_tr',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    const transferred = await rpc('transfer', {
      bindingId: 'ABD-PG-TR-001',
      targetCustomerId: 'CUS-002',
      targetCustomerName: '李四',
      newBindingId: 'ABD-PG-TR-002',
      actorId: 'admin-001',
      reason: '纠错转移',
      now: '2026-11-24T12:01:00Z',
    })

    expect(transferred.ok).toBe(true)
    expect(transferred.oldBindingId).toBe('ABD-PG-TR-001')
    expect(transferred.newBindingId).toBe('ABD-PG-TR-002')

    // Verify DB state
    const old = await pool.query('SELECT * FROM public.asva_assessment_bindings WHERE id = $1', ['ABD-PG-TR-001'])
    expect(old.rows[0].status).toBe('TRANSFERRED')

    const newBinding = await pool.query('SELECT * FROM public.asva_assessment_bindings WHERE id = $1', ['ABD-PG-TR-002'])
    expect(newBinding.rows[0].status).toBe('ACTIVE')
    expect(newBinding.rows[0].customer_id).toBe('CUS-002')
    // Snapshot preserved
    expect(newBinding.rows[0].snapshot.data).toBe('important')
    // Consent NOT inherited
    expect(newBinding.rows[0].customer_consent).toBe(false)

    // Only 1 ACTIVE binding for this report
    const active = await pool.query("SELECT * FROM public.asva_assessment_bindings WHERE report_id = $1 AND status = 'ACTIVE'", ['rpt_transfer_test'])
    expect(active.rows).toHaveLength(1)
    expect(active.rows[0].customer_id).toBe('CUS-002')
  })
})

describe('Real PostgreSQL: history and get', () => {
  it('get by customer returns only ACTIVE bindings', async () => {
    await rpc('bind', {
      bindingId: 'ABD-PG-H1',
      provider: 'mindtest-web',
      reportId: 'rpt_h1',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '报告1',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h1',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    await rpc('bind', {
      bindingId: 'ABD-PG-H2',
      provider: 'mindtest-web',
      reportId: 'rpt_h2',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '报告2',
      completedAt: '2026-06-15T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h2',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    // Unbind one
    await rpc('unbind', { bindingId: 'ABD-PG-H2', actorId: 'admin-001', reason: 'test', now: '2026-11-24T12:01:00Z' })

    const result = await rpc('get', { customerId: 'CUS-001' })
    // Only ACTIVE returned
    expect(result.bindings).toHaveLength(1)
    expect(result.bindings[0].reportId).toBe('rpt_h1')
  })

  it('history includes all statuses', async () => {
    await rpc('bind', {
      bindingId: 'ABD-PG-HIST-1',
      provider: 'mindtest-web',
      reportId: 'rpt_hist_1',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '报告1',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h1',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    await rpc('unbind', { bindingId: 'ABD-PG-HIST-1', actorId: 'admin-001', reason: 'test', now: '2026-11-24T12:01:00Z' })

    const result = await rpc('history', { customerId: 'CUS-001' })
    expect(result.bindings).toHaveLength(1)
    expect(result.bindings[0].status).toBe('UNBOUND')
  })

  it('history sorted by completedAt DESC', async () => {
    const reports = [
      { id: 'ABD-PG-SORT-1', reportId: 'rpt_old', completedAt: '2026-01-01T10:00:00+08:00' },
      { id: 'ABD-PG-SORT-2', reportId: 'rpt_mid', completedAt: '2026-06-15T10:00:00+08:00' },
      { id: 'ABD-PG-SORT-3', reportId: 'rpt_new', completedAt: '2026-11-20T10:00:00+08:00' },
    ]
    for (const r of reports) {
      await rpc('bind', {
        bindingId: r.id,
        provider: 'mindtest-web',
        reportId: r.reportId,
        assessmentId: 'star',
        customerId: 'CUS-001',
        customerName: '张三',
        reportNickname: '测试',
        completedAt: r.completedAt,
        boundBy: 'mentor-001',
        snapshot: {},
        snapshotHash: 'h',
        preview: {},
        now: '2026-11-24T12:00:00Z',
      })
    }

    const result = await rpc('get', { customerId: 'CUS-001' })
    expect(result.bindings).toHaveLength(3)
    expect(result.bindings[0].reportId).toBe('rpt_new') // Newest first
    expect(result.bindings[2].reportId).toBe('rpt_old')
  })
})

describe('Real PostgreSQL: consent', () => {
  it('grant and revoke consent', async () => {
    await rpc('bind', {
      bindingId: 'ABD-PG-CON-1',
      provider: 'mindtest-web',
      reportId: 'rpt_consent',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h',
      preview: {},
      customerConsent: false,
      now: '2026-11-24T12:00:00Z',
    })

    // Grant consent
    const granted = await rpc('grant_consent', {
      bindingId: 'ABD-PG-CON-1',
      actorId: 'mentor-001',
      consentRecord: '客户口头同意',
      now: '2026-11-24T12:01:00Z',
    })
    expect(granted.ok).toBe(true)

    let binding = await pool.query('SELECT * FROM public.asva_assessment_bindings WHERE id = $1', ['ABD-PG-CON-1'])
    expect(binding.rows[0].customer_consent).toBe(true)

    // Revoke consent
    const revoked = await rpc('revoke_consent', {
      bindingId: 'ABD-PG-CON-1',
      actorId: 'mentor-001',
      reason: '客户撤回同意',
      now: '2026-11-24T12:02:00Z',
    })
    expect(revoked.ok).toBe(true)

    binding = await pool.query('SELECT * FROM public.asva_assessment_bindings WHERE id = $1', ['ABD-PG-CON-1'])
    expect(binding.rows[0].customer_consent).toBe(false)
  })
})

describe('Real PostgreSQL: audit events', () => {
  it('records full audit trail', async () => {
    await rpc('bind', {
      bindingId: 'ABD-PG-AUDIT-1',
      provider: 'mindtest-web',
      reportId: 'rpt_audit',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '小明',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h',
      preview: {},
      nameMismatch: true,
      now: '2026-11-24T12:00:00Z',
    })

    await rpc('confirm_name', {
      bindingId: 'ABD-PG-AUDIT-1',
      confirmedBy: 'admin-001',
      reason: '已确认身份',
      now: '2026-11-24T12:01:00Z',
    })

    await rpc('grant_consent', {
      bindingId: 'ABD-PG-AUDIT-1',
      actorId: 'mentor-001',
      consentRecord: '口头同意',
      now: '2026-11-24T12:02:00Z',
    })

    await rpc('unbind', {
      bindingId: 'ABD-PG-AUDIT-1',
      actorId: 'admin-001',
      reason: '测试解绑',
      now: '2026-11-24T12:03:00Z',
    })

    const events = await rpc('events', { bindingId: 'ABD-PG-AUDIT-1' })
    expect(events.events).toHaveLength(4)
    expect(events.events.map(e => e.eventType)).toEqual([
      'BOUND', 'NAME_CONFIRMED', 'CONSENT_GRANTED', 'UNBOUND'
    ])
  })
})

describe('Real PostgreSQL: concurrent bind protection', () => {
  it('partial unique index prevents concurrent active bindings', async () => {
    // Bind first
    await rpc('bind', {
      bindingId: 'ABD-PG-CONC-1',
      provider: 'mindtest-web',
      reportId: 'rpt_concurrent',
      assessmentId: 'star',
      customerId: 'CUS-001',
      customerName: '张三',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-001',
      snapshot: {},
      snapshotHash: 'h',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    // Try concurrent bind from different customer
    const result = await rpc('bind', {
      bindingId: 'ABD-PG-CONC-2',
      provider: 'mindtest-web',
      reportId: 'rpt_concurrent',
      assessmentId: 'star',
      customerId: 'CUS-002',
      customerName: '李四',
      reportNickname: '测试',
      completedAt: '2026-11-20T10:00:00+08:00',
      boundBy: 'mentor-002',
      snapshot: {},
      snapshotHash: 'h',
      preview: {},
      now: '2026-11-24T12:00:00Z',
    })

    expect(result.error).toBeDefined()
    expect(result.error.code).toBe('REPORT_ALREADY_BOUND')

    // Verify only 1 ACTIVE binding exists
    const active = await pool.query("SELECT COUNT(*) FROM public.asva_assessment_bindings WHERE report_id = 'rpt_concurrent' AND status = 'ACTIVE'")
    expect(Number(active.rows[0].count)).toBe(1)
  })
})
