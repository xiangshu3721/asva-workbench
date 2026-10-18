import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listRecordsMock } = vi.hoisted(() => ({ listRecordsMock: vi.fn() }))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return { ...actual, listRecords: listRecordsMock }
})

const { config } = await import('./config.mjs')
const { fields } = await import('./field-mapping.mjs')
const { FeishuRepository } = await import('./repository.mjs')

const originalTables = { ...config.feishu.tables }
const tableId = (name) => `r042-test-${name}`
const row = (table, recordId, values) => ({ record_id: recordId, fields: fields(table, values) })

const admin = { id: 'STAFF-ADMIN', name: '管理员', role: 'ADMIN', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }
const mentor = { id: 'STAFF-MENTOR', name: '导师', role: 'MENTOR', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }
const fixtureRows = () => ({
  [tableId('customers')]: [
    row('customers', 'rec-c1', { customer_id: 'CUS-1', nickname: '客户一', current_mentor_id: mentor.id, city: '杭州' }),
    row('customers', 'rec-c2', { customer_id: 'CUS-2', nickname: '客户二', current_mentor_id: 'STAFF-OTHER' }),
  ],
  [tableId('staff')]: [row('staff', 'rec-admin', { staff_id: admin.id, name: admin.name, permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true }), row('staff', 'rec-mentor', { staff_id: mentor.id, name: mentor.name, permission_role: 'MENTOR', status: 'ACTIVE', login_enabled: true })],
  [tableId('products')]: [],
  [tableId('enrollments')]: [],
  [tableId('evidenceItems')]: [row('evidenceItems', 'rec-e1', { evidence_id: 'E-1', customer_id: 'CUS-1', source_id: 'SRC-1', review_status: 'CONFIRMED', semantic_kind: 'CURRENT_STATE', field_key: 'city', standard_value: '杭州', display_text: '客户一证据', source_excerpt: '客户一资料', confidence: 0.95 }), row('evidenceItems', 'rec-e2', { evidence_id: 'E-2', customer_id: 'CUS-2', source_id: 'SRC-2', review_status: 'CONFIRMED', display_text: '客户二证据' })],
  [tableId('appointments')]: [],
  [tableId('serviceRecords')]: [],
  [tableId('profileChanges')]: [],
  [tableId('sourceRecords')]: [row('sourceRecords', 'rec-s1', { source_id: 'SRC-1', customer_id: 'CUS-1', raw_text: '客户一资料' }), row('sourceRecords', 'rec-s2', { source_id: 'SRC-2', customer_id: 'CUS-2', raw_text: '客户二资料' })],
  [tableId('profileUpdateProposals')]: [],
  [tableId('evidenceConflicts')]: [],
})

beforeEach(() => {
  for (const name of Object.keys(originalTables)) config.feishu.tables[name] = tableId(name)
  const rows = fixtureRows()
  listRecordsMock.mockReset().mockImplementation(async (id) => rows[id] || [])
})

afterEach(() => {
  Object.assign(config.feishu.tables, originalTables)
})

describe('R043 progressive read paths', () => {
  it('deduplicates concurrent directory reads and reuses the directory cache', async () => {
    const repository = new FeishuRepository()
    const [first, second] = await Promise.all([repository.customerDirectory(admin.id), repository.customerDirectory(admin.id)])

    expect(first.customers).toHaveLength(2)
    expect(second.customers).toHaveLength(2)
    expect(listRecordsMock).toHaveBeenCalledTimes(4)
    await repository.customerDirectory(admin.id)
    expect(listRecordsMock).toHaveBeenCalledTimes(4)
  })

  it('loads only customer-relevant detail tables and protects mentor scope', async () => {
    const repository = new FeishuRepository()
    const directory = await repository.loadDirectory()
    const detail = await repository.loadCustomerDetailFresh('CUS-1', directory)

    expect(detail.customers).toHaveLength(1)
    expect(detail.sourceRecords).toEqual([])
    expect(detail.evidenceItems).toEqual([])
    expect(listRecordsMock).toHaveBeenCalledTimes(7)

    const mentorDetail = await repository.customerDetail(mentor.id, 'CUS-1')
    expect(mentorDetail.customers.map((item) => item.id)).toEqual(['CUS-1'])
    expect(JSON.stringify(mentorDetail)).not.toContain('CUS-2')
    await expect(repository.customerDetail(mentor.id, 'CUS-2')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
  })

  it('keeps authentication staff-only instead of forcing the full business read', async () => {
    const repository = new FeishuRepository()
    const staff = await repository.staff(admin.id)
    expect(staff.id).toBe(admin.id)
    expect(listRecordsMock).toHaveBeenCalledTimes(1)
    expect(listRecordsMock).toHaveBeenCalledWith(tableId('staff'))
  })

  it('loads the customer profile materialization on demand without returning raw workspace tables', async () => {
    const repository = new FeishuRepository()
    const profile = await repository.customerProfile(mentor.id, 'CUS-1')

    expect(profile.customerId).toBe('CUS-1')
    expect(profile.profileMaterialization.sections.some((section) => section.items.length > 0)).toBe(true)
    expect(profile).not.toHaveProperty('sourceRecords')
    expect(profile).not.toHaveProperty('evidenceItems')
    await expect(repository.customerProfile(mentor.id, 'CUS-2')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
  })
})
