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
      fake.history.push({ id, customerId: fields.customer_id || fields['客户ID'], field: fields.field_key || fields['字段键'], oldValue: JSON.parse(fields.old_value || fields['旧值'] || 'null'), newValue: JSON.parse(fields.new_value || fields['新值'] || 'null'), operatorId: fields.operator_id || fields['操作人ID'] || '' })
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
  return { staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }], customers: [customer], enrollments: [], profileChanges: [...fake.history], appointments: [], sessions: [], followups: [], products: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: { customers: [{ record_id: 'rec-customer-1', fields: {} }] } }
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
    const recovered = await repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')
    expect(recovered).toMatchObject({ status: 'COMMITTED', historyStatus: 'COMPLETE', repaired: true })
    expect(fake.history).toHaveLength(2)
    expect(database.customers[0].name).toBe('Synthetic Customer')
  })

  it('does not mark history compensation committed when another required step is pending', async () => {
    const database = makeDatabase([plan('PCH-3', 'occupation', null, '设计师')], 'PENDING')
    const repository = new FeishuRepository({ authRepository: {} })
    repository.loadCustomerMutationContext = async () => ({ ...database, profileChanges: [...fake.history] })
    repository.persistCustomerMutationState = async (_database, _customerId, operationId, nextState) => { database.customers[0].mutationStates[operationId] = { ...nextState, operationId, customerId: 'CUS-HISTORY-1' }; return null }
    await expect(repository.repairCustomerMutationHistory('ADMIN-1', 'CUS-HISTORY-1', 'op-history-compensation')).resolves.toMatchObject({ status: 'PERSISTED', historyStatus: 'COMPLETE', repaired: true })
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
