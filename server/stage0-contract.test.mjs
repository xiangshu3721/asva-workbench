import { describe, expect, it } from 'vitest'
import { parseDateFromFeishu, serializeDateForFeishu } from './date-contract.mjs'
import { field, fields } from './field-mapping.mjs'
import { SCHEMA_CONTRACT } from './schema-contract.mjs'

describe('ASVA Stage 0 contracts', () => {
  it('normalizes Feishu datetime values at the adapter boundary', () => {
    expect(parseDateFromFeishu(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(serializeDateForFeishu('2026-10-07T00:00:00.000Z')).toBe(new Date('2026-10-07T00:00:00.000Z').getTime())
  })

  it('serializes mapped date fields without changing internal keys', () => {
    expect(field('customers', 'wechat')).toBe('微信号')
    expect(fields('customers', { customer_id: 'STAGE0_TEST_1', created_at: '2026-10-07T00:00:00.000Z' })['创建时间']).toBe(new Date('2026-10-07T00:00:00.000Z').getTime())
    expect(fields('sourceRecords', { uploaded_at: '2026-10-07T00:00:00.000Z' })['上传时间']).toBe('2026-10-07T00:00:00.000Z')
    expect(fields('sourceRecords', { occurred_at: '约20岁' })['资料发生时间']).toBe('约20岁')
    expect(fields('sourceRecords', { created_at: '2026-10-07T00:00:00.000Z' })['创建时间']).toBe(new Date('2026-10-07T00:00:00.000Z').getTime())
    expect(fields('evidenceItems', { occurred_at: '约20岁' })['发生时间']).toBe('约20岁')
    expect(fields('profileChanges', { confidence: 0.9, confirmed: true, changed_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z' })).toMatchObject({ 置信度: 0.9, 已确认: true, 变更时间: new Date('2026-10-07T00:00:00.000Z').getTime(), 更新时间: new Date('2026-10-07T00:00:00.000Z').getTime() })
    expect(fields('profileUpdateProposals', { reviewed_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z' })).toMatchObject({ 审核时间: '2026-10-07T00:00:00.000Z', 更新时间: new Date('2026-10-07T00:00:00.000Z').getTime() })
    expect(fields('evidenceConflicts', { resolved_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z' })).toMatchObject({ 处理时间: '2026-10-07T00:00:00.000Z', 更新时间: new Date('2026-10-07T00:00:00.000Z').getTime() })
  })

  it('keeps deprecated mentor id read-only and carries field metadata', () => {
    const legacy = SCHEMA_CONTRACT.customers.find((item) => item.feishu_name === '导师ID')
    expect(legacy).toMatchObject({ deprecated: true, readable: true, writable: false })
    expect(SCHEMA_CONTRACT.customers.every((item) => 'internal_key' in item && 'feishu_name' in item && 'date_format' in item)).toBe(true)
  })
})
