import { describe, expect, it } from 'vitest'
import { queryLocalAssistant } from './assistant'
import { seedDatabase } from './data'

const context = { now: '2026-10-04T12:00:00.000Z' }

const goldenQueries: Array<[string, string]> = [
  ['帮我查一下林知微的信息', 'ENTITY_DETAIL'],
  ['查一下138****1212', 'ENTITY_DETAIL'],
  ['帮我查一个客户信息叫林志微', 'ENTITY_DETAIL'],
  ['林知微的客户资料', 'ENTITY_DETAIL'],
  ['上个月有哪些新客户', 'ENTITY_LIST'],
  ['上个月客户名单', 'ENTITY_LIST'],
  ['有哪些导师', 'ENTITY_LIST'],
  ['有哪些课程', 'ENTITY_LIST'],
  ['有哪些服务记录', 'ENTITY_LIST'],
  ['订单列表', 'ENTITY_LIST'],
  ['总客户有多少', 'COUNT'],
  ['今天新增客户多少', 'COUNT'],
  ['最近7天新增客户多少', 'COUNT'],
  ['上周预约多少', 'COUNT'],
  ['今天完成预约多少', 'COUNT'],
  ['现在有多少待分配预约', 'COUNT'],
  ['付费客户多少', 'COUNT'],
  ['上个月觉塑报名多少人', 'COUNT'],
  ['订单多少', 'COUNT'],
  ['营收多少', 'AGGREGATE'],
  ['平均客单价多少', 'AGGREGATE'],
  ['上个月营收多少', 'AGGREGATE'],
  ['上个月整体情况', 'SUMMARY'],
  ['今年客户概览', 'SUMMARY'],
  ['按导师分客户数', 'GROUP_AGGREGATE'],
  ['各导师营收', 'GROUP_AGGREGATE'],
  ['按课程分营收', 'GROUP_AGGREGATE'],
  ['按介绍人统计客户数', 'GROUP_AGGREGATE'],
  ['按SABC分别多少', 'GROUP_AGGREGATE'],
  ['按城市统计客户数', 'GROUP_AGGREGATE'],
  ['按职业统计客户数', 'GROUP_AGGREGATE'],
  ['按预约状态统计', 'GROUP_AGGREGATE'],
  ['按付费状态统计', 'GROUP_AGGREGATE'],
  ['按导师分服务记录', 'GROUP_AGGREGATE'],
  ['客户最多的导师', 'RANK'],
  ['导师排名', 'RANK'],
  ['哪位导师客户量最高', 'RANK'],
  ['最近3个月营收趋势', 'TREND'],
  ['最近3个月新增客户趋势', 'TREND'],
  ['9月和8月营收相比怎么样', 'COMPARE'],
  ['9月和8月客户数相比怎么样', 'COMPARE'],
  ['S级客户有多少', 'COUNT'],
  ['所有预约有多少', 'COUNT'],
  ['所有服务记录有多少', 'COUNT'],
  ['当前报名客户有多少', 'COUNT'],
  ['最近30天客户数量', 'COUNT'],
  ['2026-09-01至2026-09-30新增客户多少', 'COUNT'],
  ['去年营收多少', 'AGGREGATE'],
  ['本月预约数量', 'COUNT'],
  ['昨天完成预约多少', 'COUNT'],
]

describe('ASVA AI V1.0 golden query set', () => {
  it.each(goldenQueries)('GOLDEN %s -> %s', (question, operation) => {
    const result = queryLocalAssistant(seedDatabase, question, context)
    expect(result.dsl?.operation).toBe(operation)
    expect(result.debug?.status).not.toBe('DATA_SOURCE_ERROR')
  })

  it('keeps product and time when the next question asks for the matching customers', () => {
    const first = queryLocalAssistant(seedDatabase, '上个月觉塑报名多少人', context)
    const result = queryLocalAssistant(seedDatabase, '把他们列出来', { ...context, lastQuery: first.continuation })
    expect(result.dsl?.operation).toBe('ENTITY_LIST')
    expect(result.dsl?.filters).toEqual(expect.arrayContaining([{ field: 'product', operator: 'EQ', value: '觉塑' }]))
    expect(result.dsl?.time_range?.start).toBe('2026-09-01')
  })

  it('adds a paid filter without losing the carried scope', () => {
    const first = queryLocalAssistant(seedDatabase, '上个月觉塑报名多少人', context)
    const result = queryLocalAssistant(seedDatabase, '只看付费的', { ...context, lastQuery: first.continuation })
    expect(result.dsl?.filters).toEqual(expect.arrayContaining([{ field: 'product', operator: 'EQ', value: '觉塑' }, { field: 'payment_status', operator: 'EQ', value: 'PAID' }]))
    expect(result.dsl?.time_range?.label).toBe('上个月')
  })

  it('adds a mentor dimension to the carried customer scope', () => {
    const first = queryLocalAssistant(seedDatabase, '上个月有哪些客户', context)
    const result = queryLocalAssistant(seedDatabase, '按导师分一下', { ...context, lastQuery: first.continuation })
    expect(result.dsl?.operation).toBe('GROUP_AGGREGATE')
    expect(result.dsl?.dimensions).toContain('MENTOR')
  })

  it('replaces the carried month for an explicit follow-up month', () => {
    const first = queryLocalAssistant(seedDatabase, '上个月有哪些客户', context)
    const result = queryLocalAssistant(seedDatabase, '那8月呢', { ...context, lastQuery: first.continuation })
    expect(result.dsl?.time_range?.start).toBe('2026-08-01')
    expect(result.dsl?.time_range?.end).toBe('2026-08-31')
  })

  it('resolves both periods for an independent comparison', () => {
    const result = queryLocalAssistant(seedDatabase, '9月和8月营收相比怎么样', context)
    expect(result.dsl?.time_range?.start).toBe('2026-09-01')
    expect(result.dsl?.compare_time_range?.start).toBe('2026-08-01')
  })

  it('clears a previous scope for an independent question', () => {
    const first = queryLocalAssistant(seedDatabase, '上个月觉塑报名多少人', context)
    const result = queryLocalAssistant(seedDatabase, '总客户有多少', { ...context, lastQuery: first.continuation })
    expect(result.dsl?.operation).toBe('COUNT')
    expect(result.dsl?.filters).toEqual([])
    expect(result.debug?.context_cleared).toContain('previous_query')
  })

  it('returns no data and does not invent a customer', () => {
    const result = queryLocalAssistant(seedDatabase, '查一下不存在的客户林星河', context)
    expect(result.debug?.status).toBe('NO_DATA')
    expect(result.answer).toBe('系统当前没有查到这个客户。')
  })

  it('returns ambiguity instead of choosing one duplicate', () => {
    const database = structuredClone(seedDatabase)
    database.customers.push({ ...seedDatabase.customers[0], id: 'C-DUPLICATE', phone: '133****0000' })
    const result = queryLocalAssistant(database, '查一下林知微', context)
    expect(result.debug?.status).toBe('AMBIGUOUS')
    expect(result.candidates).toHaveLength(2)
  })

  it('reports missing data sources separately from empty results', () => {
    const database = { ...structuredClone(seedDatabase), _missingRepositories: ['EnrollmentRepository'] }
    const result = queryLocalAssistant(database, '上个月营收多少', context)
    expect(result.debug?.status).toBe('DATA_SOURCE_ERROR')
    expect(result.dataBasis?.[0]?.coverage?.complete).toBe(false)
  })
})
