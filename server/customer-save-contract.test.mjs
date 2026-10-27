import { describe, expect, it } from 'vitest'
import { FeishuRepository, customerIdForOperation, partialEnrollmentFailureMessage, publicCustomerMutationDto, withOptimisticEnrollments } from './repository.mjs'

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
})


describe('customer save fast-path after write', () => {
  it('builds enrollment DTOs without waiting for a full-table readback', () => {
    const database = {
      customers: [{ id: 'CUS-1' }],
      enrollments: [{ id: 'ENR-OTHER', customerId: 'CUS-OTHER', productId: 'P-9', status: '学习中' }],
      staff: [], appointments: [], sessions: [], followups: [], products: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {},
    }
    const next = withOptimisticEnrollments(database, 'CUS-1', [{ productId: 'P-001' }, { productId: 'P-002', paymentStatus: 'PAID' }], 'op-save-1')
    expect(next.enrollments.filter((item) => item.customerId === 'CUS-1')).toEqual([
      expect.objectContaining({ productId: 'P-001', status: 'ACTIVE', paymentStatus: 'UNRECORDED' }),
      expect.objectContaining({ productId: 'P-002', status: 'ACTIVE', paymentStatus: 'PAID' }),
    ])
    expect(next.enrollments.some((item) => item.customerId === 'CUS-OTHER')).toBe(true)
  })

  it('returns COMMITTED for the same operationId when the customer already exists (lost-response recovery)', async () => {
    const operationId = 'op-recover-committed-1'
    const customerId = customerIdForOperation(operationId)
    const database = {
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: customerId, name: 'Recovered', phone: '13800000099', wechat: '', notes: '', profileFields: {}, profileFieldMeta: {} }],
      products: [{ id: 'P-001', name: '觉塑', active: true, status: '在售' }],
      enrollments: [],
      appointments: [], sessions: [], followups: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
      _rows: {},
    }
    const repository = new FeishuRepository({ authRepository: {} })
    let loadAfterWriteCalls = 0
    repository.loadDirectory = async () => database
    repository.loadAfterWrite = async () => { loadAfterWriteCalls += 1; return database }
    repository.loadCustomerAfterWrite = async () => { throw new Error('should not create again') }
    repository.scheduleAutomaticCustomerProfile = () => ({ status: 'NOT_REQUIRED' })

    const result = await repository.createCustomer('ADMIN-1', {
      operationId,
      nickname: 'Recovered',
      phone: '13800000099',
      wechat: '',
      situation: '',
      needsFollowup: false,
      confirmedNotSame: true,
    }, 'req-1', { compactResponse: true })

    expect(result).toMatchObject({ createdCustomerId: customerId, customerCreated: false, persistenceStatus: 'COMMITTED' })
    expect(loadAfterWriteCalls).toBe(0)
  })
})
