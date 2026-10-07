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
  })

  it('keeps deprecated mentor id read-only and carries field metadata', () => {
    const legacy = SCHEMA_CONTRACT.customers.find((item) => item.feishu_name === '导师ID')
    expect(legacy).toMatchObject({ deprecated: true, readable: true, writable: false })
    expect(SCHEMA_CONTRACT.customers.every((item) => 'internal_key' in item && 'feishu_name' in item && 'date_format' in item)).toBe(true)
  })
})
