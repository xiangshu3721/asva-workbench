import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ rows: [], loadCount: 0, releaseLoad: null, loadBarrier: null }))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return {
    ...actual,
    createRecord: vi.fn(async (_tableId, fields) => {
      const recordId = `rec-customer-${fake.rows.length + 1}`
      fake.rows.push({ record_id: recordId, fields })
      return { record: { record_id: recordId } }
    }),
  }
})

const { FeishuRepository } = await import('./repository.mjs')

function customerFromRow(row) {
  return {
    id: row.fields['客户ID'], name: row.fields['客户昵称'], phone: row.fields['手机号'] || '', wechat: row.fields['微信号'] || '',
    referrerName: row.fields['介绍人'] || '', notes: row.fields['备注'] || '', profileFields: {}, profileFieldMeta: {}, mutationStates: {}, _recordId: row.record_id,
  }
}

function emptyDatabase() {
  return {
    staff: [{ id: 'ADMIN-1', name: 'Synthetic Admin', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
    customers: fake.rows.map(customerFromRow), appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
    _rows: { customers: fake.rows },
  }
}

function repositoryWithSharedReadBarrier() {
  const repository = new FeishuRepository({ authRepository: {} })
  repository.loadCustomerMutationContext = async () => {
    fake.loadCount += 1
    if (fake.loadCount === 2) fake.releaseLoad?.()
    await fake.loadBarrier
    return emptyDatabase()
  }
  repository.loadCustomerAfterWrite = async () => emptyDatabase()
  repository.persistCustomerMutationState = async () => null
  return repository
}

function input(operationId, overrides = {}) {
  return { operationId, nickname: '并发合成客户', phone: '13800000001', wechat: '', introducer: '', situation: '', ...overrides }
}

describe('01D customer creation interleaving audit', () => {
  beforeEach(() => {
    fake.rows.length = 0
    fake.loadCount = 0
    fake.loadBarrier = new Promise((resolve) => { fake.releaseLoad = resolve })
  })

  it('reproduces the different-operation contact race across repository instances', async () => {
    const first = repositoryWithSharedReadBarrier()
    const second = repositoryWithSharedReadBarrier()
    await Promise.all([
      first.createCustomer('ADMIN-1', input('op-create-a'), '', { compactResponse: true }),
      second.createCustomer('ADMIN-1', input('op-create-b'), '', { compactResponse: true }),
    ])

    expect(fake.loadCount).toBe(2)
    expect(fake.rows).toHaveLength(2)
    expect(new Set(fake.rows.map((row) => row.fields['客户ID'])).size).toBe(2)
  })

  it('reproduces the same-operation race before a provider-level idempotency decision', async () => {
    const first = repositoryWithSharedReadBarrier()
    const second = repositoryWithSharedReadBarrier()
    await Promise.all([
      first.createCustomer('ADMIN-1', input('op-create-same'), '', { compactResponse: true }),
      second.createCustomer('ADMIN-1', input('op-create-same'), '', { compactResponse: true }),
    ])

    expect(fake.rows).toHaveLength(2)
    expect(new Set(fake.rows.map((row) => row.fields['客户ID'])).size).toBe(1)
  })
})
