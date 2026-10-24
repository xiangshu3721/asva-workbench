import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getRecordMock } = vi.hoisted(() => ({ getRecordMock: vi.fn() }))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return { ...actual, getRecord: getRecordMock }
})

const { FeishuRepository } = await import('./repository.mjs')
const { fields } = await import('./field-mapping.mjs')
const { config } = await import('./config.mjs')

describe('customer targeted write readback', () => {
  beforeEach(() => getRecordMock.mockReset())

  it('confirms the written customer by record id without a full database reload', async () => {
    const row = { record_id: 'rec-customer-1', fields: fields('customers', { customer_id: 'CUS-1', nickname: 'Updated Customer' }) }
    getRecordMock.mockResolvedValue(row)
    const database = {
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-1', name: 'Old Customer', profileFields: {}, profileFieldMeta: {}, _recordId: 'rec-customer-1' }],
      enrollments: [], appointments: [], sessions: [], followups: [], products: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
      _rows: { customers: [{ record_id: 'rec-customer-1', fields: fields('customers', { customer_id: 'CUS-1', nickname: 'Old Customer' }) }] },
    }
    const repository = new FeishuRepository()

    const result = await repository.loadCustomerAfterWrite({ record: { record_id: 'rec-customer-1' } }, 'CUS-1', database)

    expect(getRecordMock).toHaveBeenCalledWith(config.feishu.tables.customers, 'rec-customer-1', expect.objectContaining({ readContext: expect.any(Object) }))
    expect(result.customers[0].name).toBe('Updated Customer')
    expect(result._persistenceStatus).toBe('COMMITTED')
  })
})
