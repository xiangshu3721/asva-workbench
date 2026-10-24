import { describe, expect, it } from 'vitest'
import { FeishuRepository, customerIdForOperation, customerResultFingerprint, mutationPayloadHash, partialEnrollmentFailureMessage, publicCustomerMutationDto, sanitizeMutationStates, serializeCustomerDerivedMeta } from './repository.mjs'

const emptyCollections = { enrollments: [], profileChanges: [], appointments: [], sessions: [], followups: [], products: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [] }
const customerDatabase = (customer) => ({ staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }], customers: [customer], ...emptyCollections, _rows: { customers: [{ record_id: 'rec-customer-1', fields: { 客户ID: customer.id } }] } })

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

  it('keeps PERSISTED distinct from COMMITTED in the public contract', () => {
    const database = customerDatabase({ id: 'CUS-1', name: 'Synthetic Customer', mutationStates: { 'op-1': { operationId: 'op-1', customerId: 'CUS-1', kind: 'UPDATE', status: 'PERSISTED', updatedAt: '2026-01-01T00:00:00.000Z' } } })
    expect(publicCustomerMutationDto(database, 'ADMIN-1', 'CUS-1', false, 'op-1')).toMatchObject({ persistenceStatus: 'PERSISTED', mutation: { status: 'PERSISTED' } })
  })

  it('does not replay an incomplete PATCH and rejects a changed payload', async () => {
    const operationId = 'patch-persisted-1'
    const originalInput = { operationId, nickname: 'Synthetic Customer', phone: '13800000001', wechat: '', situation: 'same', enrollments: [] }
    const customer = { id: 'CUS-1', name: 'Synthetic Customer', phone: '13800000001', wechat: '', notes: '', mutationStates: { [operationId]: { operationId, customerId: 'CUS-1', kind: 'UPDATE', status: 'PERSISTED', payloadHash: mutationPayloadHash(originalInput), updatedAt: '2026-01-01T00:00:00.000Z' } } }
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = async () => customerDatabase(customer)
    await expect(repository.updateCustomerUnsafe('ADMIN-1', 'CUS-1', originalInput, { compactResponse: true })).rejects.toMatchObject({ code: 'CUSTOMER_SAVE_INCOMPLETE', mutationStatus: 'PERSISTED' })
    await expect(repository.updateCustomerUnsafe('ADMIN-1', 'CUS-1', { operationId, nickname: 'Changed payload', phone: '13800000001', wechat: '', situation: 'same', enrollments: [] }, { compactResponse: true })).rejects.toMatchObject({ code: 'CUSTOMER_SAVE_OPERATION_CONFLICT', status: 409 })
  })

  it('does not replay an incomplete CREATE with the same operation id', async () => {
    const operationId = 'create-persisted-1'
    const customerId = customerIdForOperation(operationId)
    const database = customerDatabase({ id: customerId, name: 'Synthetic Customer', phone: '13800000002', wechat: '', mutationStates: { [operationId]: { operationId, customerId, kind: 'CREATE', status: 'PERSISTED', payloadHash: '', updatedAt: '2026-01-01T00:00:00.000Z' } } })
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = async () => database
    await expect(repository.createCustomer('ADMIN-1', { operationId, nickname: 'Synthetic Customer', phone: '13800000002', wechat: '', introducer: '', situation: '', enrollments: [] }, '', { compactResponse: true })).rejects.toMatchObject({ code: 'CUSTOMER_SAVE_INCOMPLETE', mutationStatus: 'PERSISTED' })
  })

  it('retains incomplete mutation states when committed history exceeds the limit', () => {
    const states = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`committed-${index}`, { customerId: 'CUS-1', kind: 'UPDATE', status: 'COMMITTED', updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z` }]))
    states.pending = { customerId: 'CUS-1', kind: 'UPDATE', status: 'PERSISTED', updatedAt: '2026-01-01T00:01:00.000Z' }
    const result = sanitizeMutationStates(states)
    expect(Object.keys(result)).toHaveLength(21)
    expect(result.pending.status).toBe('PERSISTED')
    expect(result['committed-0']).toBeUndefined()
    expect(result['committed-24'].status).toBe('COMMITTED')
  })

  it('merges a derived metadata update without dropping sibling namespaces', () => {
    const customer = { id: 'CUS-1', profileVersion: 3, profileFieldMeta: { occupation: { source: 'MANUAL' } }, aiSummaryMeta: { status: 'FRESH' }, understandingMeta: { status: 'FRESH' }, salesUnderstandingMeta: { status: 'FRESH' }, safetyMeta: { status: 'FRESH' }, mutationStates: { op: { customerId: 'CUS-1', kind: 'UPDATE', status: 'PERSISTED' } } }
    const parsed = JSON.parse(serializeCustomerDerivedMeta(customer, { understanding: { status: 'PROCESSING' } }))
    expect(parsed._fields).toEqual(customer.profileFieldMeta)
    expect(parsed._ai_summary).toEqual(customer.aiSummaryMeta)
    expect(parsed._sales_understanding).toEqual(customer.salesUnderstandingMeta)
    expect(parsed._safety).toEqual(customer.safetyMeta)
    expect(parsed._mutation_states.op.status).toBe('PERSISTED')
    expect(parsed._understanding.status).toBe('PROCESSING')
  })

  it('does not return the latest customer fields as the historical result of an older operation', async () => {
    const original = { id: 'CUS-1', name: 'Original name', notes: 'Original notes', profileFields: { occupation: 'Designer' }, profileFieldMeta: {}, profileVersion: 1, profileUpdatedAt: '2026-01-01T00:00:00.000Z' }
    const database = customerDatabase({ ...original, name: 'Latest name', notes: 'Later notes', profileFields: { occupation: 'Teacher' }, profileVersion: 2, profileUpdatedAt: '2026-01-02T00:00:00.000Z', mutationStates: { 'old-op': { operationId: 'old-op', customerId: 'CUS-1', kind: 'UPDATE', status: 'COMMITTED', resultFingerprint: customerResultFingerprint(original), updatedAt: '2026-01-01T00:00:00.000Z' } } })
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = async () => database
    await expect(repository.customerSaveStatus('ADMIN-1', 'CUS-1', 'old-op')).resolves.toMatchObject({ status: 'COMMITTED', customer: null, resultSnapshotAvailable: false, resultChangedSinceOperation: true })
  })
})
