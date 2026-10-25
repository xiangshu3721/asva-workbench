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
const tableId = (name) => `p0-visibility-${name}`
const row = (table, recordId, values) => ({ record_id: recordId, fields: fields(table, values) })
const admin = { id: 'STAFF-ADMIN', name: '管理员', permissionRole: 'ADMIN', role: 'ADMIN', status: 'ACTIVE' }
const mentor = { id: 'STAFF-MENTOR', name: '导师', permissionRole: 'MENTOR', role: 'MENTOR', status: 'ACTIVE' }

function fixtureRows() {
  return {
    [tableId('customers')]: [
      row('customers', 'rec-c1', { customer_id: 'CUS-1', nickname: '合成客户一', current_mentor_id: mentor.id, current_issue: '最近工作压力很大', help_expectation: '先梳理优先级', current_goal: '找到下一步方向', city: '杭州', age: 35, occupation: '设计师', marital_status: '已婚', family_summary: '与家人同住', notes: '客户情况来自基础资料录入' }),
      row('customers', 'rec-c2', { customer_id: 'CUS-2', nickname: '合成客户二', current_mentor_id: 'STAFF-OTHER', current_issue: '其他客户资料不应可见' }),
    ],
    [tableId('staff')]: [
      row('staff', 'rec-admin', { staff_id: admin.id, name: admin.name, permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true }),
      row('staff', 'rec-mentor', { staff_id: mentor.id, name: mentor.name, permission_role: 'MENTOR', status: 'ACTIVE', login_enabled: true }),
    ],
    [tableId('products')]: [],
    [tableId('enrollments')]: [],
    [tableId('evidenceItems')]: [],
    [tableId('appointments')]: [],
    [tableId('serviceRecords')]: [],
    [tableId('profileChanges')]: [],
    [tableId('sourceRecords')]: [],
    [tableId('profileUpdateProposals')]: [],
    [tableId('evidenceConflicts')]: [],
  }
}

beforeEach(() => {
  for (const name of Object.keys(originalTables)) config.feishu.tables[name] = tableId(name)
  const rows = fixtureRows()
  listRecordsMock.mockReset().mockImplementation(async (id) => rows[id] || [])
})

afterEach(() => {
  Object.assign(config.feishu.tables, originalTables)
})

describe('P0 customer visibility fallbacks', () => {
  it('materializes recorded basics in the customer profile without evidence', async () => {
    const repository = new FeishuRepository()
    const profile = await repository.customerProfile(mentor.id, 'CUS-1')
    const section = profile.profileMaterialization.sections.find((item) => item.title === '当前状态与目标')
    expect(section.items.map((item) => item.text)).toEqual(expect.arrayContaining(['最近工作压力很大', '先梳理优先级', '找到下一步方向']))
    const rendered = profile.profileMaterialization.sections.flatMap((item) => item.items).map((item) => item.text)
    expect(rendered).toEqual(expect.arrayContaining(['35', '杭州', '设计师', '已婚', '与家人同住', '客户情况来自基础资料录入']))
    expect(profile.profileMaterialization.coverage.percentage).toBeGreaterThan(0)
  })

  it('returns a grounded understanding fallback instead of an empty result', async () => {
    const repository = new FeishuRepository()
    const response = await repository.getCustomerUnderstanding(mentor.id, 'CUS-1')
    expect(response.understanding.one_line_understanding).toMatchObject({ text: '最近工作压力很大', confidence: 'LOW', evidence_ids: [] })
    expect(response.meta.source).toBe('STRUCTURED_FALLBACK')
  })

  it('returns conservative sales guidance without inferring commercial readiness', async () => {
    const repository = new FeishuRepository()
    const response = await repository.getCustomerSalesUnderstanding(mentor.id, 'CUS-1')
    expect(response.salesUnderstanding.pain_points[0]).toMatchObject({ title: '最近工作压力很大', confidence: 'LOW', evidence_ids: [] })
    expect(response.salesUnderstanding.aspirations[0]).toMatchObject({ title: '找到下一步方向', confidence: 'LOW', evidence_ids: [] })
    expect(response.salesUnderstanding.willingness_to_pay.level).toBe('UNKNOWN')
    expect(response.salesUnderstanding.ability_to_pay.level).toBe('UNKNOWN')
    expect(response.meta.source).toBe('STRUCTURED_FALLBACK')
  })

  it('keeps mentor scope unchanged while providing the fallback', async () => {
    const repository = new FeishuRepository()
    await expect(repository.getCustomerUnderstanding(mentor.id, 'CUS-2')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
    await expect(repository.customerProfile(mentor.id, 'CUS-2')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
  })
})
