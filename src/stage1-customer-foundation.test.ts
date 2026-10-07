import { beforeEach, describe, expect, it } from 'vitest'
import { createLocalApi } from './api'
import { createLocalRepository } from './repositories'

function setupStorage() {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } },
  })
}

beforeEach(() => setupStorage())

describe('Stage 1 Customer Foundation V1', () => {
  it('requires at least one contact and accepts normalized international phones', () => {
    const api = createLocalApi(createLocalRepository())
    expect(() => api.createCustomer('staff-admin', { nickname: '无联系方式', situation: '', needsFollowup: false })).toThrow('至少填写一个')
    const database = api.createCustomer('staff-admin', { nickname: '国际客户', phone: '+1 (415) 555-0100', situation: '', needsFollowup: false })
    expect(database.customers.find((item) => item.name === '国际客户')?.phone).toBe('+14155550100')
  })

  it('blocks exact phone, exact WeChat, and cross-record contact conflicts', () => {
    const api = createLocalApi(createLocalRepository())
    api.createCustomer('staff-admin', { nickname: '手机号客户', phone: '13900002101', situation: '', needsFollowup: false })
    api.createCustomer('staff-admin', { nickname: '微信客户', wechat: 'stage1-wechat-02', situation: '', needsFollowup: false })
    expect(() => api.createCustomer('staff-admin', { nickname: '新名字', phone: '13900002101', situation: '', needsFollowup: false })).toThrow('联系方式')
    expect(() => api.createCustomer('staff-admin', { nickname: '另一个名字', phone: '13900002101', wechat: 'STAGE1-WECHAT-02', situation: '', needsFollowup: false })).toThrow('人工确认')
  })

  it('requires explicit confirmation for a same-nickname possible match and never opens an Appointment', () => {
    const api = createLocalApi(createLocalRepository())
    const preview = api.previewCustomer('staff-admin', { nickname: '林知微', phone: '13900002103', situation: '', needsFollowup: false })
    expect(preview.identity?.result).toBe('POSSIBLE_MATCH')
    expect(() => api.createCustomer('staff-admin', { nickname: '林知微', phone: '13900002103', situation: '', needsFollowup: false })).toThrow('可能重复')
    const database = api.createCustomer('staff-admin', { nickname: '林知微', phone: '13900002103', situation: '', needsFollowup: false, confirmedNotSame: true })
    const customer = database.customers.find((item) => item.phone === '13900002103')
    expect(customer).toBeDefined()
    expect(database.appointments.some((item) => item.customerId === customer?.id)).toBe(false)
  })

  it('increments Profile Version and keeps confirmed provenance in Profile Changes', () => {
    const api = createLocalApi(createLocalRepository())
    const created = api.createCustomer('staff-admin', { nickname: '档案客户', phone: '13900002104', situation: '', needsFollowup: false })
    const customer = created.customers.find((item) => item.name === '档案客户')!
    expect(customer.profileVersion).toBe(1)
    api.updateCustomer('staff-admin', customer.id, { nickname: customer.name, phone: '13900002105', situation: '', needsFollowup: false })
    const saved = api.dashboard('staff-admin')
    const updated = saved.customers.find((item) => item.id === customer.id)!
    expect(updated.profileVersion).toBe(2)
    expect(updated.profileFieldMeta?.phone?.source).toBe('ADMIN_CONFIRMED')
    expect(saved.profileChanges.find((item) => item.customerId === customer.id && item.field === 'phone')?.source).toBe('ADMIN_CONFIRMED')
  })
})
