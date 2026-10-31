import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contentHash } from '../shared/evidence-contract.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const EVIDENCE_DIR = process.env.ASVA_SCOPED_P0_EVIDENCE_DIR
  || (process.env.HOME ? `${process.env.HOME}/Troublehut/_verify/asva-scoped-load-p0-20261031` : path.resolve('_verify/asva-scoped-load-p0-20261031'))
const UPLOADED_RESUME_EVIDENCE_DIR = process.env.ASVA_UPLOADED_RESUME_P0_EVIDENCE_DIR
  || (process.env.HOME ? `${process.env.HOME}/Troublehut/_verify/asva-uploaded-resume-p0-20261031` : path.resolve('_verify/asva-uploaded-resume-p0-20261031'))

const state = vi.hoisted(() => ({
  tableIds: {
    customers: 'tbl-scoped-customers',
    staff: 'tbl-scoped-staff',
    products: 'tbl-scoped-products',
    enrollments: 'tbl-scoped-enrollments',
    profileChanges: 'tbl-scoped-profile-changes',
    appointments: 'tbl-scoped-appointments',
    serviceRecords: 'tbl-scoped-services',
    sourceRecords: 'tbl-scoped-sources',
    evidenceItems: 'tbl-scoped-evidence',
    profileUpdateProposals: 'tbl-scoped-proposals',
    evidenceConflicts: 'tbl-scoped-conflicts',
  },
  tables: new Map(),
  nextRecordId: 1,
  listCalls: [],
  searchCalls: [],
  createCalls: [],
}))

const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)))
const table = (tableId) => {
  if (!state.tables.has(tableId)) state.tables.set(tableId, new Map())
  return state.tables.get(tableId)
}
const rowFields = (row) => row?.fields || {}

function matchSearchFilter(fields, filter) {
  const conditions = filter?.conditions || []
  if (!conditions.length) return true
  const conjunction = String(filter?.conjunction || 'and').toLowerCase()
  const results = conditions.map((condition) => {
    const actual = fields?.[condition.field_name]
    const expected = Array.isArray(condition.value) ? condition.value[0] : condition.value
    if (condition.operator === 'is') return String(actual ?? '') === String(expected ?? '')
    return false
  })
  return conjunction === 'or' ? results.some(Boolean) : results.every(Boolean)
}

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return {
    ...actual,
    listRecords: async (tableId) => {
      state.listCalls.push(tableId)
      return [...table(tableId).values()].map(clone)
    },
    searchRecords: async (tableId, filter) => {
      state.searchCalls.push({ tableId, filter })
      return [...table(tableId).values()].filter((row) => matchSearchFilter(rowFields(row), filter)).map(clone)
    },
    getRecord: async (tableId, recordId) => {
      const row = table(tableId).get(recordId)
      return row ? clone(row) : null
    },
    createRecord: async (tableId, fields, context = {}) => {
      state.createCalls.push({ tableId, fields })
      const idempotency = context.idempotency
      if (idempotency?.field) {
        const existing = [...table(tableId).values()].find((row) => String(rowFields(row)[idempotency.field] ?? '') === String(idempotency.value))
        if (existing) return { record: clone(existing), idempotency_recovered: true }
      }
      const recordId = `rec-scoped-${state.nextRecordId++}`
      const row = { record_id: recordId, fields: clone(fields) }
      table(tableId).set(recordId, row)
      return { record: clone(row) }
    },
    updateRecord: async (tableId, recordId, fields) => {
      const row = table(tableId).get(recordId)
      if (!row) throw new actual.FeishuUnavailableError('模拟更新记录不存在', { code: 'FEISHU_NOT_FOUND', retryable: false })
      row.fields = { ...rowFields(row), ...clone(fields) }
      return { record: clone(row) }
    },
  }
})

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.ASVA_CONFIG_DIR = '/nonexistent/asva-scoped-load-test-config'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'off'
process.env.FEISHU_CUSTOMERS_TABLE_ID = state.tableIds.customers
process.env.FEISHU_STAFF_TABLE_ID = state.tableIds.staff
process.env.FEISHU_PRODUCTS_TABLE_ID = state.tableIds.products
process.env.FEISHU_ENROLLMENTS_TABLE_ID = state.tableIds.enrollments
process.env.FEISHU_PROFILE_CHANGES_TABLE_ID = state.tableIds.profileChanges
process.env.FEISHU_APPOINTMENTS_TABLE_ID = state.tableIds.appointments
process.env.FEISHU_SERVICE_RECORDS_TABLE_ID = state.tableIds.serviceRecords
process.env.FEISHU_SOURCE_RECORDS_TABLE_ID = state.tableIds.sourceRecords
process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID = state.tableIds.evidenceItems
process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID = state.tableIds.profileUpdateProposals
process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID = state.tableIds.evidenceConflicts

const { FeishuRepository, serializeCustomerDerivedMeta } = await import('./repository.mjs')
const { config } = await import('./config.mjs')
const { fields } = await import('./field-mapping.mjs')
const { buildSearchExactFilter } = await import('./feishu.mjs')

function resetStore() {
  state.tables = new Map()
  state.nextRecordId = 1
  state.listCalls = []
  state.searchCalls = []
  state.createCalls = []
}

function put(tableId, recordId, mappedFields) {
  table(tableId).set(recordId, { record_id: recordId, fields: clone(mappedFields) })
}

function seedProductionScale({ targetCustomerId, targetNotes, customerCount = 1200 } = {}) {
  put(state.tableIds.staff, 'rec-admin', fields('staff', {
    staff_id: 'ADMIN-1', nickname: '管理员', permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true, phone: '13800000000',
  }))
  for (let i = 0; i < customerCount; i += 1) {
    const id = i === 0 ? targetCustomerId : `CUS-SCALE-${String(i).padStart(4, '0')}`
    const notes = i === 0 ? targetNotes : `脱敏客户资料 ${i}。`.repeat(20)
    const meta = i === 0 ? {} : {}
    put(state.tableIds.customers, `rec-cus-${i}`, fields('customers', {
      customer_id: id,
      nickname: i === 0 ? '目标客户' : `客户${i}`,
      notes,
      profile_field_meta_json: JSON.stringify(meta),
      sabc: 'C',
      is_paid: false,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    }))
    // Noise rows across stage-2 tables to force full-load cost if someone regresses.
    if (i % 3 === 0) {
      put(state.tableIds.sourceRecords, `rec-src-noise-${i}`, fields('sourceRecords', {
        source_id: `SRC-NOISE-${i}`, customer_id: id, source_type: 'TEXT_INPUT', title: 'noise', raw_text: notes.slice(0, 80),
        content_hash: contentHash(notes.slice(0, 80)), processing_status: 'COMPLETED', uploaded_by: 'ADMIN-1', notes: 'noise',
        created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', uploaded_at: '2026-10-01T00:00:00.000Z',
      }))
      put(state.tableIds.evidenceItems, `rec-evd-noise-${i}`, fields('evidenceItems', {
        evidence_id: `EVD-NOISE-${i}`, customer_id: id, source_id: `SRC-NOISE-${i}`, evidence_type: 'FACT', display_text: 'noise',
        source_excerpt: 'noise', review_status: 'CONFIRMED', extraction_batch_id: `EXT-NOISE-${i}`, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
      }))
    }
  }
}

function tableNameById(tableId) {
  return Object.entries(state.tableIds).find(([, id]) => id === tableId)?.[0] || tableId
}

function summarizeCalls() {
  const listTables = [...new Set(state.listCalls.map(tableNameById))]
  const searchTables = [...new Set(state.searchCalls.map((item) => tableNameById(item.tableId)))]
  return {
    listCallCount: state.listCalls.length,
    searchCallCount: state.searchCalls.length,
    listTables,
    searchTables,
    totalDistinctTables: [...new Set([...listTables, ...searchTables])],
    createCount: state.createCalls.length,
  }
}

describe('scoped customer AI load (isolation)', () => {
  const originalArchiving = config.features.automaticProfileArchiving
  const originalMode = config.features.automaticProfileArchivingMode

  beforeEach(() => {
    resetStore()
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
  })
  afterEach(() => {
    config.features.automaticProfileArchiving = originalArchiving
    config.features.automaticProfileArchivingMode = originalMode
  })

  it('buildSearchExactFilter uses records/search condition shape', () => {
    expect(buildSearchExactFilter('客户ID', 'CUS-1')).toEqual({
      conjunction: 'and',
      conditions: [{ field_name: '客户ID', operator: 'is', value: ['CUS-1'] }],
    })
  })

  it('loadCustomerScoped searches by customerId and does not list 11 full tables', async () => {
    const customerId = 'CUS-TARGET-1'
    const notes = '客户希望提升职业决策能力，当前在考虑转行。'
    seedProductionScale({ targetCustomerId: customerId, targetNotes: notes, customerCount: 800 })
    const repository = new FeishuRepository({
      authRepository: {},
      evidenceExtractor: async () => [],
    })
    const before = process.memoryUsage().heapUsed
    const startedAt = Date.now()
    const database = await repository.loadCustomerScoped(customerId, { scene: 'TEST_SCOPED' })
    const durationMs = Date.now() - startedAt
    const after = process.memoryUsage().heapUsed
    const summary = summarizeCalls()

    expect(database._scoped).toBe(true)
    expect(database.customers).toHaveLength(1)
    expect(database.customers[0].id).toBe(customerId)
    expect(database.sourceRecords.every((item) => item.customerId === customerId)).toBe(true)
    expect(summary.listTables).toEqual(['staff'])
    expect(summary.searchTables.sort()).toEqual(['customers', 'evidenceConflicts', 'evidenceItems', 'profileUpdateProposals', 'sourceRecords'].sort())
    expect(summary.totalDistinctTables.length).toBeLessThan(11)
    expect(summary.listCallCount).toBe(1)
    // Prove LKG stores a slice, not a full production clone.
    repository.rememberCustomerLastKnownGood(customerId, database)
    const lkg = repository.lastKnownGoodByCustomer.get(customerId)
    expect(lkg.customers).toHaveLength(1)
    expect(lkg.sourceRecords.every((item) => item.customerId === customerId)).toBe(true)
    // Full DB would include hundreds of customers if wrongly cloned from a wide object.
    const fakeFull = {
      ...database,
      customers: [{ id: customerId, profileFields: {} }, ...Array.from({ length: 799 }, (_, i) => ({ id: `CUS-OTHER-${i}`, profileFields: {} }))],
      sourceRecords: [
        { id: 'SRC-TARGET', customerId },
        ...Array.from({ length: 799 }, (_, i) => ({ id: `SRC-OTHER-${i}`, customerId: `CUS-OTHER-${i}` })),
      ],
    }
    repository.rememberCustomerLastKnownGood(customerId, fakeFull)
    const projected = repository.lastKnownGoodByCustomer.get(customerId)
    expect(projected.customers).toHaveLength(1)
    expect(projected.customers[0].id).toBe(customerId)
    expect(projected.sourceRecords).toHaveLength(1)

    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(path.join(EVIDENCE_DIR, 'scoped-load-metrics.json'), JSON.stringify({
      scene: 'loadCustomerScoped',
      durationMs,
      heapDeltaBytes: Math.max(0, after - before),
      peakHeapUsed: after,
      tableCount: summary.totalDistinctTables.length,
      ...summary,
      customerCountInResult: database.customers.length,
      sourceCountInResult: database.sourceRecords.length,
    }, null, 2))
  })

  it('recoverAutomaticCustomerProfile for pending=null Source=0 rebuilds via scoped reads', async () => {
    const customerId = 'CUS-OLD-RECOVER'
    const notes = '旧客户无 Source，需要安全恢复。当前目标是改善亲子沟通。'
    seedProductionScale({ targetCustomerId: customerId, targetNotes: notes, customerCount: 500 })
    // Ensure target has zero sources: remove noise for target only (i===0 noise may exist when 0%3==0)
    for (const [recordId, row] of [...table(state.tableIds.sourceRecords).entries()]) {
      if (String(rowFields(row)['客户ID'] || '') === customerId) table(state.tableIds.sourceRecords).delete(recordId)
    }
    for (const [recordId, row] of [...table(state.tableIds.evidenceItems).entries()]) {
      if (String(rowFields(row)['客户ID'] || '') === customerId) table(state.tableIds.evidenceItems).delete(recordId)
    }

    const repository = new FeishuRepository({
      authRepository: {},
      evidenceExtractor: async () => [{
        evidence_type: 'FACT',
        field_key: 'current_goal',
        value: '改善亲子沟通',
        display_text: '改善亲子沟通',
        source_excerpt: '当前目标是改善亲子沟通',
        locator: { char_start: notes.indexOf('当前目标是改善亲子沟通'), char_end: notes.indexOf('当前目标是改善亲子沟通') + '当前目标是改善亲子沟通'.length },
        confidence: 0.9,
        semantic_kind: 'GOAL',
        content_source: 'STAFF_REPORTED',
        information_nature: 'OBSERVED_FACT',
        verification_status: 'UNVERIFIED',
        review_status: 'PENDING_REVIEW',
      }],
    })
    // Disable background setImmediate racing; recover now awaits processSource itself.
    repository.scheduleAutomaticProcessing = vi.fn()

    state.listCalls = []
    state.searchCalls = []
    const startedAt = Date.now()
    const recovered = await repository.recoverAutomaticCustomerProfile('ADMIN-1', customerId)
    const recoverMs = Date.now() - startedAt
    const recoverSummary = summarizeCalls()

    // Must not stop at SOURCE_CREATED — recover awaits processSource to a terminal archive state.
    expect(['COMPLETED', 'REVIEW_REQUIRED']).toContain(recovered.status)
    expect(recovered.sourceId).toBeTruthy()
    expect(recovered.processed).toBe(true)
    expect(recovered.scheduledProcessing).toBe(false)
    expect(recoverSummary.totalDistinctTables.length).toBeLessThan(11)
    expect(recoverSummary.listTables.every((name) => name === 'staff')).toBe(true)
    expect(recoverSummary.searchTables).toContain('customers')
    expect(recoverSummary.searchTables).toContain('sourceRecords')

    const sources = [...table(state.tableIds.sourceRecords).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    const evidence = [...table(state.tableIds.evidenceItems).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    expect(sources.length).toBeGreaterThanOrEqual(1)
    expect(evidence.length).toBeGreaterThanOrEqual(1)

    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(path.join(EVIDENCE_DIR, 'recover-old-customer.json'), JSON.stringify({
      recover: recovered,
      recoverMs,
      recoverSummary,
      processStatus: recovered.status,
      sourceCount: sources.length,
      evidenceCount: evidence.length,
    }, null, 2))
  })

  it('new customer auto archive creates Source/Evidence and is idempotent', async () => {
    const customerId = 'CUS-NEW-AUTO'
    const notes = '新客户首次录入：希望提升表达能力，近期工作压力较大。'
    seedProductionScale({ targetCustomerId: customerId, targetNotes: notes, customerCount: 600 })
    for (const [recordId, row] of [...table(state.tableIds.sourceRecords).entries()]) {
      if (String(rowFields(row)['客户ID'] || '') === customerId) table(state.tableIds.sourceRecords).delete(recordId)
    }

    const repository = new FeishuRepository({
      authRepository: {},
      evidenceExtractor: async () => [{
        evidence_type: 'FACT',
        field_key: 'current_core_issue',
        value: '工作压力较大',
        display_text: '工作压力较大',
        source_excerpt: '近期工作压力较大',
        locator: { char_start: notes.indexOf('近期工作压力较大'), char_end: notes.indexOf('近期工作压力较大') + '近期工作压力较大'.length },
        confidence: 0.91,
        semantic_kind: 'ISSUE',
        content_source: 'STAFF_REPORTED',
        information_nature: 'OBSERVED_FACT',
        verification_status: 'UNVERIFIED',
        review_status: 'PENDING_REVIEW',
      }],
    })
    repository.scheduleAutomaticProcessing = vi.fn()

    const first = await repository.queueAutomaticCustomerProfile('ADMIN-1', customerId, notes, 'CUSTOMER_SAVE')
    expect(first.status).toBe('QUEUED')
    const second = await repository.queueAutomaticCustomerProfile('ADMIN-1', customerId, notes, 'CUSTOMER_SAVE')
    expect(second.status).toBe('QUEUED')
    expect(second.sourceId).toBe(first.sourceId)

    const sourcesAfterQueue = [...table(state.tableIds.sourceRecords).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    expect(sourcesAfterQueue).toHaveLength(1)

    state.listCalls = []
    state.searchCalls = []
    const memBefore = process.memoryUsage().heapUsed
    const startedAt = Date.now()
    const processed = await repository.processSource('ADMIN-1', first.sourceId)
    const durationMs = Date.now() - startedAt
    const memAfter = process.memoryUsage().heapUsed
    const processSummary = summarizeCalls()

    expect(['COMPLETED', 'REVIEW_REQUIRED']).toContain(processed.source.processingStatus)
    expect(processed.source.processingStatus).not.toBe('UPLOADED')
    expect(['QUEUED', 'SOURCE_CREATED']).not.toContain(processed.source.processingStatus)

    // Repeat process must not duplicate evidence logical rows for same batch path.
    const evidenceBefore = [...table(state.tableIds.evidenceItems).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    await repository.processSource('ADMIN-1', first.sourceId)
    const evidenceAfter = [...table(state.tableIds.evidenceItems).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    expect(evidenceAfter.length).toBe(evidenceBefore.length)

    const lkgSizes = [...repository.lastKnownGoodByCustomer.entries()].map(([id, db]) => ({ id, customers: db.customers.length, sources: db.sourceRecords.length }))
    expect(lkgSizes.every((item) => item.customers <= 1)).toBe(true)

    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(path.join(EVIDENCE_DIR, 'new-customer-auto-archive.json'), JSON.stringify({
      first,
      second,
      processStatus: processed.source.processingStatus,
      durationMs,
      heapDeltaBytes: Math.max(0, memAfter - memBefore),
      processSummary,
      sourceCount: sourcesAfterQueue.length,
      evidenceCount: evidenceAfter.length,
      lkgSizes,
    }, null, 2))
  })

  it('full load remembers projected customer slices instead of N full clones', async () => {
    // Bypass scoped ALS; exercise rememberCustomerLastKnownGood projection directly with a wide DB.
    const repository = new FeishuRepository({ authRepository: {} })
    const wide = {
      staff: [{ id: 'ADMIN-1' }],
      customers: Array.from({ length: 200 }, (_, i) => ({ id: `CUS-${i}`, profileFields: {} })),
      appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [],
      sourceRecords: Array.from({ length: 200 }, (_, i) => ({ id: `SRC-${i}`, customerId: `CUS-${i}` })),
      evidenceItems: Array.from({ length: 200 }, (_, i) => ({ id: `EVD-${i}`, customerId: `CUS-${i}`, sourceId: `SRC-${i}` })),
      profileUpdateProposals: [], evidenceConflicts: [],
      _rows: {},
    }
    for (const customer of wide.customers) repository.rememberCustomerLastKnownGood(customer.id, wide)
    for (const [id, db] of repository.lastKnownGoodByCustomer.entries()) {
      expect(db.customers).toHaveLength(1)
      expect(db.customers[0].id).toBe(id)
      expect(db.sourceRecords).toHaveLength(1)
      expect(db.evidenceItems).toHaveLength(1)
    }
  })

  it('createCustomer defers AI to HTTP phase-2; auto-archive creates Source without save-path schedule', async () => {
    // Seed only staff + empty related tables; createCustomer writes the customer itself.
    put(state.tableIds.staff, 'rec-admin', fields('staff', {
      staff_id: 'ADMIN-1', nickname: '管理员', permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true, phone: '13800000000',
    }))
    for (const key of ['customers', 'products', 'enrollments', 'profileChanges', 'appointments', 'serviceRecords', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']) {
      state.tables.set(state.tableIds[key], new Map())
    }
    const repository = new FeishuRepository()
    repository.scheduleAutomaticProcessing = vi.fn()
    const situation = '入口测试客户：希望提升表达能力，近期工作压力较大。'
    const startedAt = Date.now()
    const created = await repository.createCustomer('ADMIN-1', {
      operationId: `op-entry-${Date.now()}`,
      nickname: '入口测试客户',
      phone: '13900001111',
      wechat: '',
      introducer: '',
      situation,
      enrollments: [],
    }, '', { compactResponse: true })
    const createMs = Date.now() - startedAt
    const customerId = created.createdCustomerId || created.id
    expect(customerId).toBeTruthy()
    expect(created.automaticProfile?.status).toBe('PENDING')
    expect(created.automaticProfile?.mode).toBe('HTTP_PHASE2')
    expect(createMs).toBeLessThan(8000)
    // Save path must not have created Source yet.
    const sourcesBefore = [...table(state.tableIds.sourceRecords).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    expect(sourcesBefore.length).toBe(0)

    repository.processSource = vi.fn(async (_actor, sourceId) => ({
      source: { id: sourceId, customerId, processingStatus: 'COMPLETED' },
      evidenceItems: [],
      proposals: [],
      conflicts: [],
    }))
    const archived = await repository.runCustomerAutoArchive('ADMIN-1', customerId)
    expect(['COMPLETED', 'REVIEW_REQUIRED', 'PROCESSING', 'SOURCE_CREATED']).toContain(archived.status)
    expect(archived.sourceId).toBeTruthy()
    const sourcesAfter = [...table(state.tableIds.sourceRecords).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    expect(sourcesAfter.length).toBeGreaterThanOrEqual(1)

    const before = sourcesAfter.length
    await repository.runCustomerAutoArchive('ADMIN-1', customerId)
    const after = [...table(state.tableIds.sourceRecords).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId).length
    expect(after).toBe(before)
  })

  it('UPLOADED Source with pending cleared still resumes to Evidence (CloudBase freeze dead corner)', async () => {
    // Simulate: Source persisted, clearAutomaticProfilePending done, process setImmediate lost / instance restarted.
    const customerId = 'CUS-UPLOADED-STUCK'
    const notes = '死角恢复客户：希望提升表达能力，近期工作压力较大，需要结构化整理。'
    seedProductionScale({ targetCustomerId: customerId, targetNotes: notes, customerCount: 80 })
    for (const [recordId, row] of [...table(state.tableIds.sourceRecords).entries()]) {
      if (String(rowFields(row)['客户ID'] || '') === customerId) table(state.tableIds.sourceRecords).delete(recordId)
    }
    for (const [recordId, row] of [...table(state.tableIds.evidenceItems).entries()]) {
      if (String(rowFields(row)['客户ID'] || '') === customerId) table(state.tableIds.evidenceItems).delete(recordId)
    }

    const repository = new FeishuRepository({
      authRepository: {},
      evidenceExtractor: async () => [{
        evidence_type: 'FACT',
        field_key: 'current_goal',
        value: '提升表达能力',
        display_text: '提升表达能力',
        source_excerpt: '希望提升表达能力',
        locator: { char_start: notes.indexOf('希望提升表达能力'), char_end: notes.indexOf('希望提升表达能力') + '希望提升表达能力'.length },
        confidence: 0.91,
        semantic_kind: 'GOAL',
        content_source: 'STAFF_REPORTED',
        information_nature: 'OBSERVED_FACT',
        verification_status: 'UNVERIFIED',
        review_status: 'PENDING_REVIEW',
      }],
    })

    // 1) Create Source only — swallow process scheduling (freeze before processSource).
    repository.scheduleAutomaticProcessing = vi.fn()
    const queued = await repository.queueAutomaticCustomerProfile('ADMIN-1', customerId, notes, 'CUSTOMER_SAVE')
    expect(queued.status).toBe('QUEUED')
    expect(queued.sourceId).toBeTruthy()

    // 2) Force the dead corner: pending cleared, instance pending gone, Source stays UPLOADED, Evidence=0.
    const customerRow = [...table(state.tableIds.customers).values()].find((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    const meta = JSON.parse(String(rowFields(customerRow)['档案字段元数据'] || '{}'))
    meta._automatic_profile_pending = null
    customerRow.fields = { ...rowFields(customerRow), '档案字段元数据': JSON.stringify(meta) }
    repository.instancePendingAutoProfiles.clear()
    repository.localAutoProfileJobs.clear()
    repository.automaticProfilePendingKeys.clear()

    const sourceRow = [...table(state.tableIds.sourceRecords).values()].find((row) => String(rowFields(row)['资料ID'] || '') === queued.sourceId)
    expect(sourceRow).toBeTruthy()
    expect(String(rowFields(sourceRow)['处理状态'] || '')).toBe('UPLOADED')
    expect([...table(state.tableIds.evidenceItems).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)).toHaveLength(0)

    // 3) Old gate (pending-only) would no-op. New path: recover/maybeResume awaits processSource → Evidence.
    const resumed = await repository.maybeResumeAutomaticCustomerProfile('ADMIN-1', customerId)
    expect(resumed.processed).toBe(true)
    expect(['COMPLETED', 'REVIEW_REQUIRED']).toContain(resumed.status)
    expect(resumed.status).not.toBe('SOURCE_CREATED')
    expect(resumed.sourceId).toBe(queued.sourceId)

    const evidence = [...table(state.tableIds.evidenceItems).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
    expect(evidence.length).toBeGreaterThanOrEqual(1)

    const profileDb = await repository.load({ force: true })
    const customer = profileDb.customers.find((item) => item.id === customerId)
    expect(customer.automaticProfilePending?.contentHash).toBeFalsy()

    await mkdir(UPLOADED_RESUME_EVIDENCE_DIR, { recursive: true })
    await writeFile(path.join(UPLOADED_RESUME_EVIDENCE_DIR, 'uploaded-pending-cleared-resume.json'), JSON.stringify({
      customerId,
      sourceId: queued.sourceId,
      resumed,
      evidenceCount: evidence.length,
      pendingAfterClear: customer.automaticProfilePending || null,
      finalStatus: resumed.status,
      note: 'SOURCE_CREATED is not treated as success; Evidence + terminal archive required',
    }, null, 2))
  })

  it('processSource query budget stays far below per-stage x6 explosion', async () => {
    const customerId = 'CUS-BUDGET-1'
    const notes = '查询预算客户：希望改善睡眠质量，最近压力偏大。'
    seedProductionScale({ targetCustomerId: customerId, targetNotes: notes, customerCount: 400 })
    for (const [recordId, row] of [...table(state.tableIds.sourceRecords).entries()]) {
      if (String(rowFields(row)['客户ID'] || '') === customerId) table(state.tableIds.sourceRecords).delete(recordId)
    }
    for (const [recordId, row] of [...table(state.tableIds.evidenceItems).entries()]) {
      if (String(rowFields(row)['客户ID'] || '') === customerId) table(state.tableIds.evidenceItems).delete(recordId)
    }

    const repository = new FeishuRepository({
      authRepository: {},
      evidenceExtractor: async () => [{
        evidence_type: 'FACT',
        field_key: 'current_core_issue',
        value: '压力偏大',
        display_text: '压力偏大',
        source_excerpt: '最近压力偏大',
        locator: { char_start: notes.indexOf('最近压力偏大'), char_end: notes.indexOf('最近压力偏大') + '最近压力偏大'.length },
        confidence: 0.92,
        semantic_kind: 'ISSUE',
        content_source: 'STAFF_REPORTED',
        information_nature: 'OBSERVED_FACT',
        verification_status: 'UNVERIFIED',
        review_status: 'PENDING_REVIEW',
      }],
    })
    repository.scheduleAutomaticProcessing = vi.fn()

    const queued = await repository.queueAutomaticCustomerProfile('ADMIN-1', customerId, notes, 'CUSTOMER_SAVE')
    expect(queued.status).toBe('QUEUED')

    state.listCalls = []
    state.searchCalls = []
    const startedAt = Date.now()
    const processed = await repository.processSource('ADMIN-1', queued.sourceId)
    const durationMs = Date.now() - startedAt
    const summary = summarizeCalls()
    const totalQueries = summary.listCallCount + summary.searchCallCount

    expect(['COMPLETED', 'REVIEW_REQUIRED']).toContain(processed.source.processingStatus)
    // Without scoped cache, force load x ~5 stages x ~6 tables ≈ 30+. Budget must stay well below that.
    // Current measured steady state is ~22 with partial dirty refresh + staff cache.
    expect(totalQueries).toBeLessThanOrEqual(24)
    expect(totalQueries).toBeLessThan(30)
    expect(summary.totalDistinctTables.length).toBeLessThan(11)
    expect(durationMs).toBeLessThan(60_000)

    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(path.join(EVIDENCE_DIR, 'process-source-query-budget.json'), JSON.stringify({
      sourceId: queued.sourceId,
      processStatus: processed.source.processingStatus,
      durationMs,
      totalQueries,
      listCallCount: summary.listCallCount,
      searchCallCount: summary.searchCallCount,
      listTables: summary.listTables,
      searchTables: summary.searchTables,
      totalDistinctTables: summary.totalDistinctTables,
      budgetLimit: 24,
      uncachedExplosionEstimate: 30,
    }, null, 2))
  })
})
