import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  tableIds: {
    customers: 'tbl-p0-customers',
    staff: 'tbl-p0-staff',
    products: 'tbl-p0-products',
    enrollments: 'tbl-p0-enrollments',
    profileChanges: 'tbl-p0-profile-changes',
    sourceRecords: 'tbl-p0-sources',
    evidenceItems: 'tbl-p0-evidence',
    profileUpdateProposals: 'tbl-p0-proposals',
    evidenceConflicts: 'tbl-p0-conflicts',
  },
  tables: new Map(),
  nextRecordId: 1,
  createCalls: [],
  getRecordCalls: [],
  updateCalls: [],
  listCalls: [],
  createFailure: null,
  readbackFailures: 0,
  commitUpdateFailures: 0,
}))

const clone = (value) => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
const table = (tableId) => {
  if (!state.tables.has(tableId)) state.tables.set(tableId, new Map())
  return state.tables.get(tableId)
}
const rowFields = (row) => row?.fields || {}

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  const unavailable = (message) => new actual.FeishuUnavailableError(message, { code: 'FEISHU_NETWORK', retryable: true })
  return {
    ...actual,
    listRecords: async (tableId) => {
      state.listCalls.push(tableId)
      return [...table(tableId).values()].map(clone)
    },
    getRecord: async (tableId, recordId) => {
      state.getRecordCalls.push([tableId, recordId])
      if (state.readbackFailures > 0) {
        state.readbackFailures -= 1
        throw unavailable('模拟写入后回读超时')
      }
      const row = table(tableId).get(recordId)
      return row ? clone(row) : null
    },
    createRecord: async (tableId, fields, context = {}) => {
      state.createCalls.push({ tableId, fields: clone(fields), context })
      if (state.createFailure) throw state.createFailure
      const idempotency = context.idempotency
      if (idempotency?.field) {
        const existing = [...table(tableId).values()].find((row) => String(rowFields(row)[idempotency.field] ?? '') === String(idempotency.value))
        if (existing) return { record: clone(existing), idempotency_recovered: true }
      }
      const recordId = `rec-p0-${state.nextRecordId++}`
      const row = { record_id: recordId, fields: clone(fields) }
      table(tableId).set(recordId, row)
      return { record: clone(row) }
    },
    updateRecord: async (tableId, recordId, fields) => {
      state.updateCalls.push([tableId, recordId])
      if (state.commitUpdateFailures > 0) {
        state.commitUpdateFailures -= 1
        throw unavailable('模拟 COMMITTED 状态更新失败')
      }
      const row = table(tableId).get(recordId)
      if (!row) throw unavailable('模拟更新记录不存在')
      row.fields = { ...rowFields(row), ...clone(fields) }
      return { record: clone(row) }
    },
  }
})

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.ASVA_CONFIG_DIR = '/nonexistent/asva-p0-test-config'
process.env.FEISHU_CUSTOMERS_TABLE_ID = state.tableIds.customers
process.env.FEISHU_STAFF_TABLE_ID = state.tableIds.staff
process.env.FEISHU_PRODUCTS_TABLE_ID = state.tableIds.products
process.env.FEISHU_ENROLLMENTS_TABLE_ID = state.tableIds.enrollments
process.env.FEISHU_PROFILE_CHANGES_TABLE_ID = state.tableIds.profileChanges
process.env.FEISHU_SOURCE_RECORDS_TABLE_ID = state.tableIds.sourceRecords
process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID = state.tableIds.evidenceItems
process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID = state.tableIds.profileUpdateProposals
process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID = state.tableIds.evidenceConflicts

const { FeishuRepository, customerIdForOperation } = await import('./repository.mjs')
const { FeishuUnavailableError } = await import('./feishu.mjs')
const { fields } = await import('./field-mapping.mjs')

const seed = () => {
  state.tables.clear()
  state.createCalls = []
  state.getRecordCalls = []
  state.updateCalls = []
  state.listCalls = []
  state.createFailure = null
  state.readbackFailures = 0
  state.commitUpdateFailures = 0
  const put = (tableId, recordId, values) => table(tableId).set(recordId, { record_id: recordId, fields: fields(tableId === state.tableIds.customers ? 'customers' : tableId === state.tableIds.staff ? 'staff' : tableId === state.tableIds.products ? 'products' : tableId === state.tableIds.enrollments ? 'enrollments' : 'profileChanges', values) })
  put(state.tableIds.staff, 'rec-staff-1', { staff_id: 'MENTOR-1', nickname: 'P0 导师', permission_role: 'MENTOR', status: 'ACTIVE', login_enabled: true })
  put(state.tableIds.staff, 'rec-staff-2', { staff_id: 'MENTOR-2', nickname: 'P0 其他导师', permission_role: 'MENTOR', status: 'ACTIVE', login_enabled: true })
  put(state.tableIds.staff, 'rec-admin-1', { staff_id: 'ADMIN-1', nickname: 'P0 管理员', permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true })
  put(state.tableIds.products, 'rec-product-1', { product_id: 'PRODUCT-1', product_name: 'P0 合成课程', status: '在售' })
}

const customerRows = () => [...table(state.tableIds.customers).values()]
const rowFor = (customerId) => customerRows().find((row) => String(rowFields(row)['客户ID'] ?? '') === customerId)
const mutationOf = (row, operationId) => {
  try { return JSON.parse(String(rowFields(row)['档案字段元数据'] || '{}'))._mutation_states?.[operationId] || null } catch { return null }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
const waitForMutationStatus = async (operationId, status = 'COMMITTED') => {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const row = customerRows().find((item) => mutationOf(item, operationId)?.status === status)
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`mutation ${operationId} did not reach ${status}`)
}
const input = (operationId, overrides = {}) => ({
  operationId,
  nickname: 'P0 合成客户',
  phone: '13900000001',
  wechat: '',
  introducer: '',
  situation: '',
  needsFollowup: false,
  mentorId: null,
  source: 'P0',
  caseSource: 'SYNTHETIC',
  enrollments: [],
  ...overrides,
})

beforeEach(seed)
afterEach(settle)

describe('customer save P0 recovery path', () => {
  it('fails fast when Feishu fails before the Customers write and keeps the retry idempotent', async () => {
    const repository = new FeishuRepository()
    const payload = input('p0-pre-write-failure')
    state.createFailure = new FeishuUnavailableError('模拟创建前飞书不可用', { code: 'FEISHU_NETWORK', retryable: true })

    await expect(repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })).rejects.toMatchObject({
      code: 'CUSTOMER_SAVE_NOT_STARTED',
      writeStatus: 'NOT_STARTED',
      status: 502,
    })
    expect(customerRows()).toHaveLength(0)
    expect(state.getRecordCalls).toHaveLength(0)

    state.createFailure = null
    const retried = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })
    expect(retried.createdCustomerId).toBe(customerIdForOperation(payload.operationId))
    expect(customerRows()).toHaveLength(1)
  })

  it('keeps a successful create successful when the post-write readback times out', async () => {
    const repository = new FeishuRepository()
    const payload = input('p0-readback-timeout')
    state.readbackFailures = 2

    const created = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })
    expect(created.customer).toMatchObject({ name: payload.nickname, phone: payload.phone })
    expect(created.persistenceStatus).toBe('PERSISTED')
    expect(customerRows()).toHaveLength(1)
    expect(repository.saveTraces[0]).toMatchObject({ result: 'SUCCESS', phase: 'DONE', commit_mode: 'ASYNC' })

    const status = await repository.customerSaveStatus('MENTOR-1', created.createdCustomerId, payload.operationId)
    expect(['PERSISTED', 'COMMITTED']).toContain(status.status)
    expect(status.customer).toMatchObject({ id: created.createdCustomerId, name: payload.nickname })

    const retried = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })
    expect(retried.createdCustomerId).toBe(created.createdCustomerId)
    expect(customerRows()).toHaveLength(1)
  })

  it('keeps the customer durable when the COMMITTED marker update fails and heals on the next retry', async () => {
    const repository = new FeishuRepository()
    const payload = input('p0-commit-update-failure')
    state.commitUpdateFailures = 1

    const created = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })
    expect(created.customer).toMatchObject({ name: payload.nickname })
    expect(created.persistenceStatus).toBe('PERSISTED')
    expect(customerRows()).toHaveLength(1)
    await settle()

    const afterFailure = await repository.customerSaveStatus('MENTOR-1', created.createdCustomerId, payload.operationId)
    expect(afterFailure).toMatchObject({ status: 'PERSISTED', customer: { id: created.createdCustomerId } })
    expect(mutationOf(rowFor(created.createdCustomerId), payload.operationId)?.status).toBe('PERSISTED')

    const retried = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })
    expect(retried.createdCustomerId).toBe(created.createdCustomerId)
    expect(customerRows()).toHaveLength(1)

    await waitForMutationStatus(payload.operationId)
    const healed = await repository.customerSaveStatus('MENTOR-1', created.createdCustomerId, payload.operationId)
    expect(healed).toMatchObject({ status: 'COMMITTED', resultSnapshotAvailable: true, customer: { id: created.createdCustomerId } })
  })

  it('reads status from the Customers table even when another instance has a stale directory cache', async () => {
    const staleInstance = new FeishuRepository()
    await staleInstance.loadDirectory()
    expect(staleInstance.directoryCache.data.customers).toHaveLength(0)

    const writer = new FeishuRepository()
    const payload = input('p0-cross-instance-cache')
    const created = await writer.createCustomer('MENTOR-1', payload, '', { compactResponse: true })

    const status = await staleInstance.customerSaveStatus('MENTOR-1', created.createdCustomerId, payload.operationId)
    expect(['PERSISTED', 'COMMITTED']).toContain(status.status)
    expect(status.customer).toMatchObject({ id: created.createdCustomerId, name: payload.nickname })
    expect(staleInstance.directoryCache.data.customers).toHaveLength(0)

    // Force the 2s save-context cache budget to expire: the retry must see the
    // written row instead of re-creating the customer from the stale snapshot.
    staleInstance.directoryCache.savedAt = Date.now() - 3_000
    const retried = await staleInstance.createCustomer('MENTOR-1', payload, '', { compactResponse: true })
    expect(retried.createdCustomerId).toBe(created.createdCustomerId)
    expect(customerRows()).toHaveLength(1)
  })

  it('returns the same customer for repeated requests with the same operationId', async () => {
    const repository = new FeishuRepository()
    const payload = input('p0-same-operation')

    const first = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })
    const second = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })

    expect(second.createdCustomerId).toBe(first.createdCustomerId)
    expect(second.customerCreated).toBe(false)
    expect(customerRows()).toHaveLength(1)
    expect(state.createCalls).toHaveLength(1)
    expect(rowFor(first.createdCustomerId)).toBeTruthy()
  })

  it('saves an ordinary customer with no course and no attachment through the fast path', async () => {
    const repository = new FeishuRepository()
    const payload = input('p0-ordinary-customer', { nickname: '普通客户', phone: '13900000006', situation: '仅基础资料。' })

    const created = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })

    expect(created).toMatchObject({
      createdCustomerId: customerIdForOperation(payload.operationId),
      customerCreated: true,
      customer: { name: payload.nickname, phone: payload.phone, notes: payload.situation },
      enrollments: [],
      profileChanges: [],
      enrollmentStatus: 'COMPLETED',
    })
    expect(customerRows()).toHaveLength(1)
    expect(state.listCalls.filter((tableId) => tableId === state.tableIds.profileChanges)).toHaveLength(0)
    expect(state.listCalls.filter((tableId) => tableId === state.tableIds.enrollments)).toHaveLength(1)
    expect(repository.saveTraces[0]).toMatchObject({ result: 'SUCCESS', phase: 'DONE', commit_mode: 'ASYNC' })
    expect(repository.saveTraces[0].write_ack_ms).toBeGreaterThanOrEqual(0)
    expect(repository.saveTraces[0].readback_ms).toBeGreaterThanOrEqual(0)
    await waitForMutationStatus(payload.operationId)
    expect(mutationOf(rowFor(created.createdCustomerId), payload.operationId)).toMatchObject({ status: 'COMMITTED', enrollmentStatus: 'COMPLETED' })
  })

  it('enforces staff identity and operation/result fingerprints on status lookups', async () => {
    const repository = new FeishuRepository()
    const payload = input('p0-status-guard', { nickname: '指纹校验客户', phone: '13900000007' })
    const created = await repository.createCustomer('MENTOR-1', payload, '', { compactResponse: true })

    await expect(repository.customerSaveStatus('MENTOR-2', created.createdCustomerId, payload.operationId)).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const unknownOperation = await repository.customerSaveStatus('MENTOR-1', created.createdCustomerId, 'p0-other-operation')
    expect(unknownOperation).toMatchObject({ status: 'UNKNOWN', customer: null })

    await waitForMutationStatus(payload.operationId)
    const row = rowFor(created.createdCustomerId)
    row.fields['档案字段元数据'] = JSON.stringify({
      ...JSON.parse(String(row.fields['档案字段元数据'] || '{}')),
      _mutation_states: {
        ...JSON.parse(String(row.fields['档案字段元数据'] || '{}'))._mutation_states,
        'p0-status-guard': { ...mutationOf(row, payload.operationId), customerId: 'CUS-SOMEONE-ELSE' },
      },
    })
    const mismatchedOperation = await repository.customerSaveStatus('MENTOR-1', created.createdCustomerId, payload.operationId)
    expect(mismatchedOperation).toMatchObject({ status: 'UNKNOWN', customer: null })

    row.fields['档案字段元数据'] = JSON.stringify({
      ...JSON.parse(String(row.fields['档案字段元数据'] || '{}')),
      _mutation_states: {
        ...JSON.parse(String(row.fields['档案字段元数据'] || '{}'))._mutation_states,
        'p0-status-guard': { ...mutationOf(row, payload.operationId), customerId: created.createdCustomerId },
      },
    })
    row.fields['客户昵称'] = '保存后再次修改'
    const changedSinceOperation = await repository.customerSaveStatus('MENTOR-1', created.createdCustomerId, payload.operationId)
    expect(changedSinceOperation).toMatchObject({ status: 'COMMITTED', resultSnapshotAvailable: false, resultChangedSinceOperation: true, customer: null })
  })
})
