import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ failAtWrite: 0, writes: [], history: [] }))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return {
    ...actual,
    createRecord: vi.fn(async (_tableId, fields) => {
      fake.writes.push(fields)
      if (fake.failAtWrite && fake.writes.length === fake.failAtWrite) throw Object.assign(new Error('synthetic history write failure'), { code: 'FEISHU_NETWORK', retryable: false })
      const id = fields.change_id || fields['变更ID'] || `rec-history-${fake.writes.length}`
      fake.history.push({ id, customerId: fields.customer_id || fields['客户ID'], field: fields.field_key || fields['字段键'], fieldName: fields.field_name || fields['字段名称'] || fields.field_key || fields['字段键'], oldValue: JSON.parse(fields.old_value || fields['旧值'] || 'null'), newValue: JSON.parse(fields.new_value || fields['新值'] || 'null'), source: fields.source || fields['来源'] || 'MANUAL', operatorId: fields.operator_id || fields['操作人ID'] || '', serviceRecordId: fields.service_record_id || '', sourceRecordId: fields.source_record_id || '', evidenceId: fields.evidence_id || '', updateBatchId: fields.update_batch_id || '' })
      return { record: { record_id: id } }
    }),
  }
})

const { FeishuRepository } = await import('./repository.mjs')

function makeDatabase(plan, enrollmentStatus = 'COMPLETE') {
  const operationId = 'op-history-compensation'
  const customer = {
    id: 'CUS-HISTORY-1', name: 'Synthetic Customer', mentorId: null, profileFields: {}, profileFieldMeta: {},
    mutationStates: { [operationId]: { operationId, customerId: 'CUS-HISTORY-1', kind: 'UPDATE', status: 'PERSISTED', payloadHash: 'hash', historyStatus: 'PENDING', historyPlan: plan, enrollmentStatus, updatedAt: '2026-01-01T00:00:00.000Z' } },
  }
  return { staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }], customers: [customer], enrollments: [], profileChanges: [...fake.history], appointments: [], sessions: [], followups: [], products: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _readCoverage: { profileChanges: 'CUSTOMER_FILTERED' }, _rows: { customers: [{ record_id: 'rec-customer-1', fields: {} }] } }
}

const plan = (changeId, field, oldValue, newValue) => ({ changeId, customerId: 'CUS-HISTORY-1', field, fieldName: field, oldValue, newValue, source: 'MANUAL', confidence: 1, confirmed: true, operatorId: 'ADMIN-1', changedAt: '2026-01-01T00:00:00.000Z' })

describe('profile history compensation', () => {
  beforeEach(() => { fake.failAtWrite = 0; fake.writes.length = 0; fake.history.length = 0 })

  it('recovers a partial history write without rewriting the customer', async () => {
    const database = makeDatabase([plan('PCH-1', 'occupation', null, '设计师'), plan('PCH-2', 'city', null, '杭州')])
    const repository = new FeishuRepository({ authRepository: {} })
    repository.loadCustomerMutationContext = async () => ({ ...database, profileChanges: [...fake.history] })
    repository.persistCustomerMutationState = async (_database, _customerId, operationId, nextState) => {
      database.customers[0].mutationStates[operationId] = { ...nextState, operationId, customerId: 'CUS-HISTORY-1' }
      return null
    }
    fake.failAtWrite = 2
    await expect(repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')).rejects.toMatchObject({ code: 'FEISHU_NETWORK' })
    expect(fake.history).toHaveLength(1)
    database.customers[0].name = 'Updated after partial write'
    const recovered = await repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')
    expect(recovered).toMatchObject({ status: 'COMMITTED', historyStatus: 'COMPLETE', repaired: true })
    expect(fake.history).toHaveLength(2)
    const retried = await repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')
    expect(retried).toMatchObject({ status: 'COMMITTED', historyStatus: 'COMPLETE', repaired: true })
    expect(fake.history).toHaveLength(2)
    expect(database.customers[0].name).toBe('Updated after partial write')
  })

  it('does not commit when only two of three history writes succeed', async () => {
    const database = makeDatabase([plan('PCH-5', 'occupation', null, '设计师'), plan('PCH-6', 'city', null, '杭州'), plan('PCH-7', 'goal', null, '转型')])
    const repository = new FeishuRepository({ authRepository: {} })
    repository.loadCustomerMutationContext = async () => ({ ...database, profileChanges: [...fake.history] })
    repository.persistCustomerMutationState = async (_database, _customerId, operationId, nextState) => { database.customers[0].mutationStates[operationId] = { ...nextState, operationId, customerId: 'CUS-HISTORY-1' }; return null }
    fake.failAtWrite = 3
    await expect(repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')).rejects.toMatchObject({ code: 'FEISHU_NETWORK' })
    expect(fake.history).toHaveLength(2)
    expect(database.customers[0].mutationStates['op-history-compensation'].status).toBe('PERSISTED')
    expect(database.customers[0].mutationStates['op-history-compensation'].historyStatus).toBe('PENDING')
  })

  it('rejects an existing change id whose content or relationship differs', async () => {
    const expected = plan('PCH-8', 'occupation', null, '设计师')
    fake.history.push({ id: expected.changeId, customerId: expected.customerId, field: expected.field, fieldName: expected.fieldName, oldValue: null, newValue: '错误值', source: expected.source, operatorId: expected.operatorId, serviceRecordId: '', sourceRecordId: 'OTHER-SOURCE', evidenceId: '', updateBatchId: '' })
    const database = makeDatabase([expected])
    const repository = new FeishuRepository({ authRepository: {} })
    repository.loadCustomerMutationContext = async () => ({ ...database, profileChanges: [...fake.history] })
    repository.persistCustomerMutationState = async () => null
    await expect(repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')).rejects.toMatchObject({ code: 'PROFILE_HISTORY_CONFLICT', status: 409 })
    expect(fake.history).toHaveLength(1)
  })

  it('does not mark history compensation committed when another required step is pending', async () => {
    const database = makeDatabase([plan('PCH-3', 'occupation', null, '设计师')], 'PENDING')
    const repository = new FeishuRepository({ authRepository: {} })
    repository.loadCustomerMutationContext = async () => ({ ...database, profileChanges: [...fake.history] })
    repository.persistCustomerMutationState = async (_database, _customerId, operationId, nextState) => { database.customers[0].mutationStates[operationId] = { ...nextState, operationId, customerId: 'CUS-HISTORY-1' }; return null }
    await expect(repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')).resolves.toMatchObject({ status: 'PERSISTED', persistenceStatus: 'PERSISTED', historyStatus: 'COMPLETE', repaired: true })
    expect(database.customers[0].mutationStates['op-history-compensation'].historyPlan).toHaveLength(1)
  })

  it('keeps history unknown when the verification read is incomplete', async () => {
    const database = makeDatabase([plan('PCH-9', 'occupation', null, '设计师')])
    const repository = new FeishuRepository({ authRepository: {} })
    repository.loadCustomerMutationContext = async () => ({ ...database, _readCoverage: { profileChanges: 'PARTIAL' }, profileChanges: [] })
    repository.persistCustomerMutationState = async (_database, _customerId, operationId, nextState) => { database.customers[0].mutationStates[operationId] = { ...nextState, operationId, customerId: 'CUS-HISTORY-1' }; return null }
    await expect(repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')).resolves.toMatchObject({ status: 'UNKNOWN', persistenceStatus: 'UNKNOWN', historyStatus: 'UNKNOWN', repaired: false })
    expect(database.customers[0].mutationStates['op-history-compensation'].historyPlan).toHaveLength(1)
  })

  it('fails closed when the actor cannot access the customer history', async () => {
    const database = makeDatabase([plan('PCH-4', 'occupation', null, '设计师')])
    database.staff = [{ id: 'MENTOR-1', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }]
    database.customers[0].mentorId = 'MENTOR-OTHER'
    const repository = new FeishuRepository({ authRepository: {} })
    repository.loadCustomerMutationContext = async () => ({ ...database, profileChanges: [...fake.history] })
    await expect(repository.repairCustomerMutationHistory('MENTOR-1', 'CUS-HISTORY-1', 'op-history-compensation')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
  })
})
