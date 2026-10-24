import { describe, expect, it } from 'vitest'
import { FeishuRepository, customerIdForOperation, partialEnrollmentFailureMessage, publicCustomerMutationDto } from './repository.mjs'

describe('customer save contracts', () => {
  it('keeps the same operation idempotent across retries', () => {
    expect(customerIdForOperation('save-operation-1')).toBe(customerIdForOperation('save-operation-1'))
    expect(customerIdForOperation('save-operation-1')).not.toBe(customerIdForOperation('save-operation-2'))
  })

  it('explains an enrollment partial failure without pretending the customer was lost', () => {
    expect(partialEnrollmentFailureMessage()).toContain('客户已保存')
    expect(partialEnrollmentFailureMessage()).toContain('请重试')
  })

  it('keeps a successful write successful when the immediate readback is delayed', async () => {
    const database = { customers: [{ id: 'CUS-1' }], staff: [], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {} }
    const repository = new FeishuRepository({ authRepository: {} })
    repository.lastKnownGood = database
    repository.lastKnownGoodByCustomer.set('CUS-1', database)
    repository.load = async () => ({ ...database, _dataFreshness: 'DELAYED' })

    const result = await repository.loadAfterWrite({ record: { record_id: 'rec-1' } }, 'CUS-1')

    expect(result).toMatchObject({ _dataFreshness: 'DELAYED', _persistenceStatus: 'COMMITTED' })
  })

  it('supports a compact customer mutation response without returning the whole database', () => {
    const database = {
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-1', name: 'Synthetic Customer', profileFields: {}, profileFieldMeta: {} }],
      enrollments: [{ id: 'ENR-1', customerId: 'CUS-1', productId: 'P-001', status: '学习中' }],
      appointments: [{ id: 'APT-1', customerId: 'CUS-1' }],
      profileChanges: [{ id: 'PC-1', customerId: 'CUS-1', field: 'notes', fieldName: '客户情况', oldValue: null, newValue: 'Synthetic change', source: 'MANUAL', confidence: 1, confirmed: true, updatedAt: '2026-01-01T00:00:00.000Z', operatorId: 'ADMIN-1' }],
      sessions: [], followups: [], products: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {},
    }
    const result = publicCustomerMutationDto(database, 'ADMIN-1', 'CUS-1', true)

    expect(result).toMatchObject({ createdCustomerId: 'CUS-1', customerCreated: true, customer: { id: 'CUS-1' } })
    expect(result.enrollments).toHaveLength(1)
    expect(result.profileChanges).toHaveLength(1)
    expect(result).not.toHaveProperty('appointments')
    expect(result).not.toHaveProperty('sourceRecords')
  })

  it('returns a durable mutation result only for the exact operation identity', async () => {
    const database = {
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-1', name: 'Synthetic Customer', mutationStates: { 'op-1': { operationId: 'op-1', customerId: 'CUS-1', kind: 'UPDATE', status: 'COMMITTED', updatedAt: '2026-01-01T00:00:00.000Z' } } }],
      enrollments: [], profileChanges: [], appointments: [], sessions: [], followups: [], products: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {},
    }
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = async () => database

    await expect(repository.customerSaveStatus('ADMIN-1', 'CUS-1', 'op-1')).resolves.toMatchObject({
      operationId: 'op-1', customerId: 'CUS-1', status: 'COMMITTED', mutation: { operationId: 'op-1', kind: 'UPDATE' },
    })
    await expect(repository.customerSaveStatus('ADMIN-1', 'CUS-1', 'op-unknown')).resolves.toMatchObject({
      operationId: 'op-unknown', customerId: 'CUS-1', status: 'UNKNOWN', customer: null,
    })
    await expect(repository.customerSaveStatus('ADMIN-1', '', 'op-1')).resolves.toMatchObject({
      operationId: 'op-1', customerId: 'CUS-1', status: 'COMMITTED', mutation: { operationId: 'op-1', kind: 'UPDATE' },
    })
  })

  it('does not expose a save result outside the actor customer scope', async () => {
    const database = {
      staff: [{ id: 'MENTOR-1', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-ADMIN', name: 'Admin Customer', mentorId: 'MENTOR-OTHER', mutationStates: { 'op-admin': { operationId: 'op-admin', customerId: 'CUS-ADMIN', kind: 'CREATE', status: 'COMMITTED', updatedAt: '2026-01-01T00:00:00.000Z' } } }],
      enrollments: [], profileChanges: [], appointments: [], sessions: [], followups: [], products: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {},
    }
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = async () => database

    await expect(repository.customerSaveStatus('MENTOR-1', 'CUS-ADMIN', 'op-admin')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
  })
})
