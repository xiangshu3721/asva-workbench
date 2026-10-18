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
const tableId = (name) => `r043-security-${name}`
const row = (table, recordId, values) => ({ record_id: recordId, fields: fields(table, values) })
const admin = { id: 'STAFF-ADMIN', name: '管理员', role: 'ADMIN', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }
const mentor = { id: 'STAFF-MENTOR', name: '导师', role: 'MENTOR', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }

beforeEach(() => {
  for (const name of Object.keys(originalTables)) config.feishu.tables[name] = tableId(name)
  const rows = {
    [tableId('customers')]: [
      row('customers', 'rec-c1', { customer_id: 'CUS-1', nickname: '客户一', current_mentor_id: mentor.id, city: '杭州' }),
      row('customers', 'rec-c2', { customer_id: 'CUS-2', nickname: '客户二', current_mentor_id: 'STAFF-OTHER', city: '深圳' }),
    ],
    [tableId('staff')]: [
      row('staff', 'rec-admin', { staff_id: admin.id, name: admin.name, permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true }),
      row('staff', 'rec-mentor', { staff_id: mentor.id, name: mentor.name, permission_role: 'MENTOR', status: 'ACTIVE', login_enabled: true }),
    ],
    [tableId('products')]: [],
    [tableId('enrollments')]: [],
    [tableId('appointments')]: [],
    [tableId('serviceRecords')]: [],
    [tableId('profileChanges')]: [],
    [tableId('sourceRecords')]: [row('sourceRecords', 'rec-s2', { source_id: 'SRC-2', customer_id: 'CUS-2', raw_text: '客户二原始资料' })],
    [tableId('evidenceItems')]: [row('evidenceItems', 'rec-e2', { evidence_id: 'E-2', customer_id: 'CUS-2', source_id: 'SRC-2', display_text: '客户二安全资料', privacy_level: 'HIGH_SENSITIVE' })],
    [tableId('profileUpdateProposals')]: [],
    [tableId('evidenceConflicts')]: [],
  }
  listRecordsMock.mockReset().mockImplementation(async (id) => rows[id] || [])
})

afterEach(() => Object.assign(config.feishu.tables, originalTables))

describe('R043 explicit directory/detail DTOs', () => {
  it('does not expose raw rows, evidence, or another customer to a mentor', async () => {
    const repository = new FeishuRepository()
    const directory = await repository.customerDirectory(mentor.id)
    const detail = await repository.customerDetail(mentor.id, 'CUS-1')
    const payload = JSON.stringify({ directory, detail })

    expect(directory.customers.map((item) => item.id)).toEqual(['CUS-1'])
    expect(directory.evidenceItems).toEqual([])
    expect(directory.customers[0].profileMaterialization).toEqual(expect.objectContaining({ coverage: expect.any(Object) }))
    expect(directory.customers[0].profileMaterialization).not.toHaveProperty('sections')
    expect(detail.evidenceItems).toEqual([])
    expect(payload).not.toContain('CUS-2')
    expect(payload).not.toContain('客户二安全资料')
    expect(payload).not.toContain('HIGH_SENSITIVE')
    expect(payload).not.toContain('_rows')
    expect(payload).not.toContain('_allEvidenceItems')
    expect(payload).not.toContain('客户二原始资料')
  })

  it('keeps the admin directory bounded to the whitelisted shape', async () => {
    const repository = new FeishuRepository()
    const directory = await repository.customerDirectory(admin.id)
    expect(directory).toEqual(expect.objectContaining({ sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [] }))
    expect(directory).not.toHaveProperty('_rows')
    expect(directory).not.toHaveProperty('_dataScope')
    expect(directory.customers[0]).not.toHaveProperty('profileFields')
    expect(directory.customers[0]).not.toHaveProperty('understanding')
  })
})
