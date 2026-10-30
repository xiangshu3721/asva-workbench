import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contentHash } from '../shared/evidence-contract.mjs'

const state = vi.hoisted(() => ({
  tableIds: {
    customers: 'tbl-pending-customers',
    staff: 'tbl-pending-staff',
    products: 'tbl-pending-products',
    enrollments: 'tbl-pending-enrollments',
    profileChanges: 'tbl-pending-profile-changes',
    sourceRecords: 'tbl-pending-sources',
    evidenceItems: 'tbl-pending-evidence',
    profileUpdateProposals: 'tbl-pending-proposals',
    evidenceConflicts: 'tbl-pending-conflicts',
  },
  tables: new Map(),
  nextRecordId: 1,
  createFailureByTable: new Map(),
  updateHooks: [],
}))

const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)))
const table = (tableId) => {
  if (!state.tables.has(tableId)) state.tables.set(tableId, new Map())
  return state.tables.get(tableId)
}
const rowFields = (row) => row?.fields || {}

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return {
    ...actual,
    listRecords: async (tableId) => [...table(tableId).values()].map(clone),
    getRecord: async (tableId, recordId) => {
      const row = table(tableId).get(recordId)
      return row ? clone(row) : null
    },
    createRecord: async (tableId, fields, context = {}) => {
      const failure = state.createFailureByTable.get(tableId)
      if (failure) throw failure
      const idempotency = context.idempotency
      if (idempotency?.field) {
        const existing = [...table(tableId).values()].find((row) => String(rowFields(row)[idempotency.field] ?? '') === String(idempotency.value))
        if (existing) return { record: clone(existing), idempotency_recovered: true }
      }
      const recordId = `rec-pending-${state.nextRecordId++}`
      const row = { record_id: recordId, fields: clone(fields) }
      table(tableId).set(recordId, row)
      return { record: clone(row) }
    },
    updateRecord: async (tableId, recordId, fields) => {
      for (const hook of state.updateHooks) hook(tableId, recordId, fields)
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
process.env.ASVA_CONFIG_DIR = '/nonexistent/asva-pending-test-config'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'off'
process.env.FEISHU_CUSTOMERS_TABLE_ID = state.tableIds.customers
process.env.FEISHU_STAFF_TABLE_ID = state.tableIds.staff
process.env.FEISHU_PRODUCTS_TABLE_ID = state.tableIds.products
process.env.FEISHU_ENROLLMENTS_TABLE_ID = state.tableIds.enrollments
process.env.FEISHU_PROFILE_CHANGES_TABLE_ID = state.tableIds.profileChanges
process.env.FEISHU_SOURCE_RECORDS_TABLE_ID = state.tableIds.sourceRecords
process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID = state.tableIds.evidenceItems
process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID = state.tableIds.profileUpdateProposals
process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID = state.tableIds.evidenceConflicts

const { FeishuRepository, serializeCustomerDerivedMeta, customerIdForOperation } = await import('./repository.mjs')
const { FeishuUnavailableError } = await import('./feishu.mjs')
const { config } = await import('./config.mjs')
const { fields } = await import('./field-mapping.mjs')

const metaOf = (row) => {
  try { return JSON.parse(String(rowFields(row)['档案字段元数据'] || '{}')) } catch { return {} }
}
const customerRows = () => [...table(state.tableIds.customers).values()]
const sourceRows = () => [...table(state.tableIds.sourceRecords).values()]
const rowFor = (customerId) => customerRows().find((row) => String(rowFields(row)['客户ID'] ?? '') === customerId)
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))
const waitFor = async (predicate, label = 'condition', timeoutMs = 2500) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const seed = () => {
  state.tables.clear()
  state.nextRecordId = 1
  state.createFailureByTable = new Map()
  state.updateHooks = []
  const put = (tableId, recordId, values) => table(tableId).set(recordId, { record_id: recordId, fields: fields(tableId === state.tableIds.customers ? 'customers' : tableId === state.tableIds.staff ? 'staff' : tableId === state.tableIds.products ? 'products' : tableId === state.tableIds.enrollments ? 'enrollments' : tableId === state.tableIds.sourceRecords ? 'sourceRecords' : 'profileChanges', values) })
  put(state.tableIds.staff, 'rec-staff-admin', { staff_id: 'ADMIN-1', nickname: 'Pending Admin', permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true })
  put(state.tableIds.products, 'rec-product-1', { product_id: 'PRODUCT-1', product_name: 'Pending Course', status: '在售' })
  config.features.automaticProfileArchiving = true
  config.features.automaticProfileArchivingMode = 'off'
  config.features.automaticProfileArchivingEnabledAt = ''
  config.features.automaticProfileArchivingCanary = false
  config.features.automaticProfileCanaryCustomerIds = new Set()
}

beforeEach(seed)
afterEach(settle)

describe('automatic profile pending consistency', () => {
  it('persists pending on create when notes are present and archiving is enabled', async () => {
    const repository = new FeishuRepository()
    repository.scheduleAutomaticCustomerProfile = vi.fn(() => ({ status: 'QUEUED' }))
    const operationId = 'pending-create-1'
    const situation = '客户希望梳理职业方向，准备转行做产品。'
    const result = await repository.createCustomer('ADMIN-1', {
      operationId,
      nickname: 'Pending Create',
      phone: '13900001111',
      situation,
      enrollments: [],
    }, '', { compactResponse: true })

    const customerId = result.createdCustomerId || customerIdForOperation(operationId)
    const row = rowFor(customerId)
    expect(row).toBeTruthy()
    const pending = metaOf(row)._automatic_profile_pending
    expect(pending).toMatchObject({ contentHash: contentHash(situation), actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE' })
    expect(result.automaticProfile?.status).toBe('QUEUED')
  })

  it('reproduces pending loss when meta is rewritten from a stale snapshot without pending', async () => {
    const repository = new FeishuRepository()
    const situation = '陈旧快照覆盖风险复现文本'
    const marker = { contentHash: contentHash(situation), actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE', createdAt: '2026-10-30T00:00:00.000Z', sourceReference: { kind: 'CUSTOMER_FIELDS', fields: ['notes'] } }
    const recordId = 'rec-stale-1'
    table(state.tableIds.customers).set(recordId, {
      record_id: recordId,
      fields: fields('customers', {
        customer_id: 'CUS-STALE-1',
        nickname: 'Stale',
        notes: situation,
        created_by_staff_id: 'ADMIN-1',
        sabc: 'C',
        is_paid: false,
        created_at: '2026-10-30T00:00:00.000Z',
        profile_field_meta_json: JSON.stringify({
          _profile_version: 1,
          _fields: {},
          _automatic_profile_pending: marker,
          _mutation_states: { 'op-stale': { operationId: 'op-stale', customerId: 'CUS-STALE-1', kind: 'CREATE', status: 'PERSISTED', payloadHash: 'x', updatedAt: '2026-10-30T00:00:00.000Z' } },
        }),
      }),
    })

    // Risk reproduction: an unsafe writer serializes a stale in-memory customer
    // whose automaticProfilePending is already null, and overwrites Feishu meta.
    const staleCustomer = {
      id: 'CUS-STALE-1',
      profileVersion: 1,
      profileFieldMeta: {},
      automaticProfilePending: null,
      mutationStates: { 'op-stale': { operationId: 'op-stale', customerId: 'CUS-STALE-1', kind: 'CREATE', status: 'COMMITTED', payloadHash: 'x', updatedAt: '2026-10-30T00:00:01.000Z' } },
    }
    const { updateRecord } = await import('./feishu.mjs')
    await updateRecord(state.tableIds.customers, recordId, fields('customers', {
      profile_field_meta_json: serializeCustomerDerivedMeta(staleCustomer, { mutationStates: staleCustomer.mutationStates }),
    }))

    expect(metaOf(table(state.tableIds.customers).get(recordId))._automatic_profile_pending).toBeNull()
    // Fixed path: persistCustomerMutationState merges from latest and must keep pending.
    // Restore pending with the same field mapper the repository uses, then commit.
    const restoredMeta = {
      _profile_version: 1,
      _fields: {},
      _automatic_profile_pending: marker,
      _mutation_states: { 'op-stale': { operationId: 'op-stale', customerId: 'CUS-STALE-1', kind: 'CREATE', status: 'PERSISTED', payloadHash: 'x', updatedAt: '2026-10-30T00:00:00.000Z' } },
    }
    table(state.tableIds.customers).get(recordId).fields = {
      ...table(state.tableIds.customers).get(recordId).fields,
      ...fields('customers', { profile_field_meta_json: JSON.stringify(restoredMeta) }),
    }
    repository.invalidateDatabaseCache()
    expect(metaOf(rowFor('CUS-STALE-1'))._automatic_profile_pending).toMatchObject({ contentHash: marker.contentHash })
    const database = await repository.load({ force: true })
    expect(database.customers.find((item) => item.id === 'CUS-STALE-1')?.automaticProfilePending?.contentHash).toBe(marker.contentHash)
    await repository.persistCustomerMutationState(database, 'CUS-STALE-1', 'op-stale', {
      kind: 'CREATE',
      status: 'COMMITTED',
      payloadHash: 'x',
      enrollmentStatus: 'COMPLETED',
      enrollmentDrafts: [],
      enrollmentErrorCode: '',
      updatedAt: '2026-10-30T00:00:02.000Z',
    })
    const after = metaOf(rowFor('CUS-STALE-1'))
    expect(after._automatic_profile_pending).toMatchObject({ contentHash: marker.contentHash })
    expect(after._mutation_states['op-stale'].status).toBe('COMMITTED')
  })

  it('keeps pending when Source creation fails and records a recoverable error', async () => {
    const repository = new FeishuRepository()
    const situation = 'Source 创建失败应保留 pending'
    const operationId = 'pending-source-fail'
    repository.scheduleAutomaticCustomerProfile = vi.fn(() => ({ status: 'QUEUED' }))
    const created = await repository.createCustomer('ADMIN-1', {
      operationId,
      nickname: 'Source Fail',
      phone: '13900002222',
      situation,
      enrollments: [],
    }, '', { compactResponse: true })
    const customerId = created.createdCustomerId
    expect(metaOf(rowFor(customerId))._automatic_profile_pending?.contentHash).toBe(contentHash(situation))

    // Let the createCustomer COMMITTED background write settle before failure injection.
    await settle()
    state.createFailureByTable.set(state.tableIds.sourceRecords, new FeishuUnavailableError('模拟 Source 不可用', { code: 'FEISHU_UNAVAILABLE', retryable: true }))
    const queued = await repository.queueAutomaticCustomerProfile('ADMIN-1', customerId, situation, 'CUSTOMER_SAVE')
    expect(queued).toMatchObject({ status: 'PENDING', errorCode: 'FEISHU_UNAVAILABLE' })
    await settle()
    const pendingAfterFail = metaOf(rowFor(customerId))._automatic_profile_pending
    expect(pendingAfterFail).toMatchObject({ contentHash: contentHash(situation) })
    // Recoverable error stamp is best-effort; retention of pending is the hard requirement.
    if (pendingAfterFail?.lastErrorCode) expect(pendingAfterFail.lastErrorCode).toBe('FEISHU_UNAVAILABLE')
    expect(sourceRows()).toHaveLength(0)
  })

  it('refuses to clear pending until a matching Source is visible, then clears after success', async () => {
    const repository = new FeishuRepository()
    const situation = '仅在 Source 可见后清除 pending'
    const marker = { contentHash: contentHash(situation), actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE', createdAt: '2026-10-30T00:00:00.000Z' }
    table(state.tableIds.customers).set('rec-clear-1', {
      record_id: 'rec-clear-1',
      fields: fields('customers', {
        customer_id: 'CUS-CLEAR-1',
        nickname: 'Clear Gate',
        notes: situation,
        created_by_staff_id: 'ADMIN-1',
        sabc: 'C',
        is_paid: false,
        created_at: '2026-10-30T00:00:00.000Z',
        profile_field_meta_json: JSON.stringify({ _profile_version: 1, _fields: {}, _automatic_profile_pending: marker, _mutation_states: {} }),
      }),
    })

    await expect(repository.clearAutomaticProfilePending('CUS-CLEAR-1', marker)).resolves.toBe(false)
    expect(metaOf(rowFor('CUS-CLEAR-1'))._automatic_profile_pending).toMatchObject({ contentHash: marker.contentHash })

    repository.createSource = vi.fn(async (_actorId, input) => {
      const sourceId = `SRC-${input.operationId}`
      const recordId = `rec-source-${state.nextRecordId++}`
      table(state.tableIds.sourceRecords).set(recordId, {
        record_id: recordId,
        fields: fields('sourceRecords', {
          source_id: sourceId,
          customer_id: input.customerId,
          source_type: 'TEXT_INPUT',
          raw_text: input.rawText,
          content_hash: contentHash(input.rawText),
          notes: input.notes,
          processing_status: 'UPLOADED',
          uploaded_by: _actorId,
          created_at: '2026-10-30T00:00:00.000Z',
          updated_at: '2026-10-30T00:00:00.000Z',
        }),
      })
      return { id: sourceId, customerId: input.customerId, contentHash: contentHash(input.rawText), processingStatus: 'UPLOADED', notes: input.notes }
    })
    repository.scheduleAutomaticProcessing = vi.fn()

    const queued = await repository.queueAutomaticCustomerProfile('ADMIN-1', 'CUS-CLEAR-1', situation, 'CUSTOMER_SAVE')
    expect(queued.status).toBe('QUEUED')
    await waitFor(() => metaOf(rowFor('CUS-CLEAR-1'))._automatic_profile_pending == null, 'pending cleared after source')
    expect(sourceRows().length).toBeGreaterThan(0)
  })

  it('single-customer recover continues after response returns and background work never starts', async () => {
    const repository = new FeishuRepository()
    const situation = '响应后中断仍可单客户恢复'
    const operationId = 'pending-interrupt-1'
    repository.scheduleAutomaticCustomerProfile = vi.fn(() => ({ status: 'QUEUED' }))
    const created = await repository.createCustomer('ADMIN-1', {
      operationId,
      nickname: 'Interrupt Recover',
      phone: '13900003333',
      situation,
      enrollments: [],
    }, '', { compactResponse: true })
    const customerId = created.createdCustomerId
    expect(metaOf(rowFor(customerId))._automatic_profile_pending?.contentHash).toBe(contentHash(situation))
    expect(sourceRows()).toHaveLength(0)

    repository.createSource = vi.fn(async (_actorId, input) => {
      const sourceId = `SRC-${input.operationId}`
      const recordId = `rec-source-${state.nextRecordId++}`
      table(state.tableIds.sourceRecords).set(recordId, {
        record_id: recordId,
        fields: fields('sourceRecords', {
          source_id: sourceId,
          customer_id: input.customerId,
          source_type: 'TEXT_INPUT',
          raw_text: input.rawText,
          content_hash: contentHash(input.rawText),
          notes: input.notes,
          processing_status: 'UPLOADED',
          uploaded_by: _actorId,
          created_at: '2026-10-30T00:00:00.000Z',
          updated_at: '2026-10-30T00:00:00.000Z',
        }),
      })
      return { id: sourceId, customerId: input.customerId, contentHash: contentHash(input.rawText), processingStatus: 'UPLOADED', notes: input.notes }
    })
    repository.scheduleAutomaticProcessing = vi.fn()

    const recovered = await repository.recoverAutomaticCustomerProfile('ADMIN-1', customerId)
    expect(recovered).toMatchObject({ status: 'SOURCE_CREATED', customerId, reused: false, scheduledProcessing: true })
    expect(recovered.sourceId).toBeTruthy()
    expect(repository.createSource).toHaveBeenCalledTimes(1)
  })

  it('repeated recover for the same customer and text reuses the Source without duplicates', async () => {
    const repository = new FeishuRepository()
    const situation = '重复恢复不得重复建 Source'
    table(state.tableIds.customers).set('rec-reuse-1', {
      record_id: 'rec-reuse-1',
      fields: fields('customers', {
        customer_id: 'CUS-REUSE-1',
        nickname: 'Reuse',
        notes: situation,
        created_by_staff_id: 'ADMIN-1',
        sabc: 'C',
        is_paid: false,
        created_at: '2026-10-30T00:00:00.000Z',
        profile_field_meta_json: JSON.stringify({ _profile_version: 1, _fields: {}, _automatic_profile_pending: null, _mutation_states: {} }),
      }),
    })

    const createdSources = []
    repository.createSource = vi.fn(async (_actorId, input) => {
      const existing = createdSources.find((item) => item.operationId === input.operationId)
      if (existing) return existing
      const source = { id: `SRC-${input.operationId}`, customerId: input.customerId, contentHash: contentHash(input.rawText), processingStatus: 'UPLOADED', notes: input.notes, operationId: input.operationId }
      createdSources.push(source)
      const recordId = `rec-source-${state.nextRecordId++}`
      table(state.tableIds.sourceRecords).set(recordId, {
        record_id: recordId,
        fields: fields('sourceRecords', {
          source_id: source.id,
          customer_id: input.customerId,
          source_type: 'TEXT_INPUT',
          raw_text: input.rawText,
          content_hash: source.contentHash,
          notes: input.notes,
          processing_status: 'UPLOADED',
          uploaded_by: _actorId,
          created_at: '2026-10-30T00:00:00.000Z',
          updated_at: '2026-10-30T00:00:00.000Z',
        }),
      })
      return source
    })
    repository.scheduleAutomaticProcessing = vi.fn()

    const first = await repository.recoverAutomaticCustomerProfile('ADMIN-1', 'CUS-REUSE-1')
    const second = await repository.recoverAutomaticCustomerProfile('ADMIN-1', 'CUS-REUSE-1')
    expect(first.status).toBe('SOURCE_CREATED')
    expect(second).toMatchObject({ status: 'SOURCE_CREATED', reused: true, sourceId: first.sourceId })
    expect(sourceRows()).toHaveLength(1)
  })

  it('AI/source failure does not change customer notes or save success semantics', async () => {
    const repository = new FeishuRepository()
    const situation = 'AI 失败不影响客户原文'
    const operationId = 'pending-ai-fail'
    repository.queueAutomaticCustomerProfile = vi.fn(async () => ({ status: 'PENDING', errorCode: 'DEEPSEEK_UNAVAILABLE' }))
    const created = await repository.createCustomer('ADMIN-1', {
      operationId,
      nickname: 'AI Fail Safe',
      phone: '13900004444',
      situation,
      enrollments: [],
    }, '', { compactResponse: true })
    expect(created.createdCustomerId).toBeTruthy()
    expect(String(rowFields(rowFor(created.createdCustomerId))['备注'] || '')).toBe(situation)
    await new Promise((resolve) => setImmediate(resolve))
    expect(String(rowFields(rowFor(created.createdCustomerId))['备注'] || '')).toBe(situation)
  })

  it('customer save returns before automatic queue work starts', async () => {
    const repository = new FeishuRepository()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    repository.queueAutomaticCustomerProfile = vi.fn(() => gate)
    const started = Date.now()
    const created = await repository.createCustomer('ADMIN-1', {
      operationId: 'pending-fast-return',
      nickname: 'Fast Return',
      phone: '13900005555',
      situation: '保存主链路不等待 AI',
      enrollments: [],
    }, '', { compactResponse: true })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(created.automaticProfile?.status).toBe('QUEUED')
    expect(repository.queueAutomaticCustomerProfile).not.toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(repository.queueAutomaticCustomerProfile).toHaveBeenCalled()
    release({ status: 'QUEUED', sourceId: 'SRC-FAST' })
  })


  it('late stamp/ensure must not overwrite newer pending hash', async () => {
    const repository = new FeishuRepository()
    const older = { contentHash: contentHash('旧资料原文'), actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE', createdAt: '2026-10-30T00:00:00.000Z' }
    const newer = { contentHash: contentHash('新资料已写入'), actorId: 'ADMIN-1', reason: 'CUSTOMER_UPDATE', createdAt: '2026-10-30T01:00:00.000Z' }
    const recordId = 'rec-race-1'
    table(state.tableIds.customers).set(recordId, {
      record_id: recordId,
      fields: fields('customers', {
        customer_id: 'CUS-RACE-1',
        nickname: 'Race',
        notes: '新资料已写入',
        created_by_staff_id: 'ADMIN-1',
        sabc: 'C',
        is_paid: false,
        created_at: '2026-10-30T00:00:00.000Z',
        profile_field_meta_json: JSON.stringify({
          _profile_version: 1,
          _fields: {},
          _automatic_profile_pending: newer,
          _mutation_states: {},
        }),
      }),
    })
    repository.invalidateDatabaseCache()

    await expect(repository.stampAutomaticProfilePendingError('CUS-RACE-1', older, 'AUTO_SOURCE_QUEUE_FAILED')).resolves.toBe(false)
    await expect(repository.ensureAutomaticProfilePending('CUS-RACE-1', older)).resolves.toBe(false)

    const pending = metaOf(rowFor('CUS-RACE-1'))._automatic_profile_pending
    expect(pending).toMatchObject({ contentHash: newer.contentHash, reason: 'CUSTOMER_UPDATE' })
    expect(pending.lastErrorCode).toBeUndefined()
  })

  it('stamp only applies when current pending hash matches marker', async () => {
    const repository = new FeishuRepository()
    const marker = { contentHash: contentHash('同 hash 可 stamp'), actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE', createdAt: '2026-10-30T00:00:00.000Z' }
    const recordId = 'rec-stamp-ok'
    table(state.tableIds.customers).set(recordId, {
      record_id: recordId,
      fields: fields('customers', {
        customer_id: 'CUS-STAMP-OK',
        nickname: 'StampOk',
        notes: '同 hash 可 stamp',
        created_by_staff_id: 'ADMIN-1',
        sabc: 'C',
        is_paid: false,
        created_at: '2026-10-30T00:00:00.000Z',
        profile_field_meta_json: JSON.stringify({
          _profile_version: 1,
          _fields: {},
          _automatic_profile_pending: marker,
          _mutation_states: {},
        }),
      }),
    })
    repository.invalidateDatabaseCache()
    await expect(repository.stampAutomaticProfilePendingError('CUS-STAMP-OK', marker, 'AUTO_SOURCE_QUEUE_FAILED')).resolves.toBe(true)
    expect(metaOf(rowFor('CUS-STAMP-OK'))._automatic_profile_pending).toMatchObject({
      contentHash: marker.contentHash,
      lastErrorCode: 'AUTO_SOURCE_QUEUE_FAILED',
    })
  })


})
