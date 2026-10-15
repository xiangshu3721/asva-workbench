import { describe, expect, it } from 'vitest'
import { FeishuRepository, customerIdForOperation, partialEnrollmentFailureMessage } from './repository.mjs'

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
})
