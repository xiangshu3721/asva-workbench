import { describe, expect, it } from 'vitest'
import { queryLocalAssistant } from './assistant'
import { seedDatabase } from './data'

const context = { now: '2026-10-04T12:00:00.000Z' }

describe('V0.7 Query Planner and read-only assistant', () => {
  it('TEST01 resolves a real customer from a natural sentence', () => {
    const result = queryLocalAssistant(seedDatabase, '帮我查一个客户信息叫林志微', context)
    expect(result.plan?.query_type).toBe('CUSTOMER_DETAIL')
    expect(result.customerId).toBe('C00001298')
    expect(result.answer).toContain('林知微')
    expect(result.records?.[0]?.fields?.some((field) => field.label === '当前导师')).toBe(true)
  })

  it('TEST02 matches names after spaces and full-width normalization', () => {
    const result = queryLocalAssistant(seedDatabase, '查一下 林 志微', context)
    expect(result.customerId).toBe('C00001298')
    expect(result.debug?.status).toBe('SUCCESS')
  })

  it('TEST03 returns candidates instead of choosing between duplicates', () => {
    const database = structuredClone(seedDatabase)
    database.customers.push({ ...seedDatabase.customers[0], id: 'C-DUPLICATE', phone: '133****0000' })
    const result = queryLocalAssistant(database, '查一下林知微', context)
    expect(result.debug?.status).toBe('AMBIGUOUS')
    expect(result.candidates).toHaveLength(2)
    expect(result.answer).toContain('2 个可能匹配')
  })

  it('TEST04 turns “上个月客户数据” into a customer summary', () => {
    const result = queryLocalAssistant(seedDatabase, '查一下上个月的客户数据', context)
    expect(result.plan?.query_type).toBe('CUSTOMER_SUMMARY')
    expect(result.plan?.time_range).toEqual({ start: '2026-09-01', end: '2026-09-30', label: '上个月' })
    expect(result.answer).toContain('客户经营概览')
  })

  it('TEST05 counts new customers inside the parsed date range', () => {
    const expected = seedDatabase.customers.filter((customer) => customer.createdAt >= '2026-09-01' && customer.createdAt <= '2026-09-30').length
    const result = queryLocalAssistant(seedDatabase, '上个月新增了多少客户', context)
    expect(result.plan?.query_type).toBe('CUSTOMER_SUMMARY')
    expect(result.answer).toContain(`新增客户 ${expected}`)
  })

  it('TEST06 returns a customer list for “上个月有哪些客户”', () => {
    const result = queryLocalAssistant(seedDatabase, '上个月有哪些新客户', context)
    expect(result.plan?.query_type).toBe('CUSTOMER_LIST')
    expect(result.records?.length).toBeGreaterThan(0)
  })

  it('TEST07 counts paid enrollment records for a product', () => {
    const result = queryLocalAssistant(seedDatabase, '上个月觉塑报名多少人', context)
    expect(result.plan?.query_type).toBe('ENROLLMENT_QUERY')
    expect(result.answer).toContain('1 位报名客户')
    expect(result.debug?.repositories_used).toContain('EnrollmentRepository')
  })

  it('TEST08 inherits the previous plan and re-queries for a follow-up list', () => {
    const first = queryLocalAssistant(seedDatabase, '上个月觉塑报名多少人', context)
    const followup = queryLocalAssistant(seedDatabase, '把他们列出来', { ...context, lastQuery: first.continuation })
    expect(followup.plan?.query_type).toBe('ENROLLMENT_QUERY')
    expect(followup.plan?.time_range?.start).toBe('2026-09-01')
    expect(followup.records?.map((record) => record.name)).toEqual(['林知微'])
  })

  it('TEST09 calculates revenue from paid enrollment records only', () => {
    const result = queryLocalAssistant(seedDatabase, '上个月整体营收多少', context)
    expect(result.plan?.query_type).toBe('REVENUE_SUMMARY')
    expect(result.answer).toContain('¥6,660')
    expect(result.debug?.status).toBe('SUCCESS')
  })

  it('TEST10 only says customer is absent after resolver and repository return no rows', () => {
    const result = queryLocalAssistant(seedDatabase, '查一下不存在的客户林星河', context)
    expect(result.debug?.status).toBe('NO_DATA')
    expect(result.answer).toBe('系统当前没有查到这个客户。')
  })

  it('TEST11 distinguishes a missing enrollment data source from no data', () => {
    const database = { ...structuredClone(seedDatabase), _missingRepositories: ['EnrollmentRepository'] }
    const result = queryLocalAssistant(database, '上个月整体营收多少', context)
    expect(result.debug?.status).toBe('DATA_SOURCE_ERROR')
    expect(result.answer).toContain('数据源暂不可用')
    expect(result.answer).not.toContain('没有查到符合条件的数据')
  })

  it('TEST12 exposes a complete query debug context', () => {
    const result = queryLocalAssistant(seedDatabase, '现在有多少待分配预约', context, 'staff-founder')
    expect(result.debug).toMatchObject({ user_id: 'staff-founder', role: 'ADMIN', row_count: seedDatabase.appointments.length, status: 'SUCCESS' })
    expect(result.debug?.query_plan.query_type).toBe('STATUS_SUMMARY')
    expect(result.debug?.query_plan.joins).toEqual(['AppointmentRepository'])
    expect(result.debug?.executed_at).toMatch(/T/)
  })

  it('TEST13 reads a customer enrolled course list from EnrollmentRepository', () => {
    const result = queryLocalAssistant(seedDatabase, '林知微报过哪些课程', context)
    expect(result.kind).toBe('CUSTOMER_PURCHASES')
    expect(result.answer).toContain('觉塑')
    expect(result.answer).not.toContain('镜像技术')
  })

  it('TEST14 finds customers by structured product enrollment', () => {
    const result = queryLocalAssistant(seedDatabase, '报名觉塑的客户有哪些', context)
    expect(result.answer).toContain('林知微')
    expect(result.debug?.repositories_used).toContain('EnrollmentRepository')
  })

  it('TEST15 supports intersection and no-enrollment queries', () => {
    const intersection = queryLocalAssistant(seedDatabase, '同时报名觉塑和镜像技术的客户有多少', context)
    expect(intersection.answer).toContain('0 位')
    const none = queryLocalAssistant(seedDatabase, '目前没有报名任何课程的客户有哪些', context)
    expect(none.answer).toContain('没有报名课程的客户')
  })

  it('TEST16 ranks customers by structured enrollment count', () => {
    const database = structuredClone(seedDatabase)
    database.enrollments.push({ id: 'E-EXTRA', customerId: 'C00001298', productId: 'P-002', paid: false, amount: Number.NaN, date: '2026-10-04', status: '学习中' })
    const result = queryLocalAssistant(database, '报名课程最多的客户有哪些', context)
    expect(result.answer).toContain('林知微')
    expect(result.answer).toContain('2 门')
  })
})
