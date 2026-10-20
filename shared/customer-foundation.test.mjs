import { describe, expect, it } from 'vitest'
import { contactRequired, normalizePhone, normalizeWechat, resolveCustomerIdentity, validateCustomerContactField, validateCustomerContacts } from './customer-foundation.mjs'

const customers = [
  { id: 'CUS-A', name: '王芳', phone: '13812345678', wechat: 'WangFang' },
  { id: 'CUS-B', name: '王芳', phone: '', wechat: 'other-wechat' },
]

describe('CustomerIdentityResolver V1', () => {
  it('normalizes mainland phone formatting and preserves other international prefixes', () => {
    expect(normalizePhone('138 1234 5678')).toBe('13812345678')
    expect(normalizePhone('+86 138-1234-5678')).toBe('13812345678')
    expect(normalizePhone('+14155550123')).toBe('+14155550123')
  })

  it('normalizes WeChat only for matching and keeps contact required strict', () => {
    expect(normalizeWechat('  WX_Name ')).toBe('wx_name')
    expect(contactRequired({ phone: '', wechat: ' WX_Name ' })).toBe(true)
    expect(contactRequired({ phone: '', wechat: '' })).toBe(false)
  })

  it('uses phone and wechat exact matches before nickname possibilities', () => {
    expect(resolveCustomerIdentity(customers, { nickname: '王芳', phone: '13812345678' }).result).toBe('EXACT_MATCH')
    expect(resolveCustomerIdentity(customers, { nickname: '王芳', wechat: 'OTHER-WECHAT' }).result).toBe('EXACT_MATCH')
    expect(resolveCustomerIdentity(customers, { nickname: '王芳', phone: '13900000000' }).result).toBe('POSSIBLE_MATCH')
  })

  it('blocks phone and WeChat matching different customers', () => {
    const result = resolveCustomerIdentity(customers, { nickname: '新客户', phone: '13812345678', wechat: 'other-wechat' })
    expect(result.result).toBe('CONFLICT')
    expect(result.match_reasons).toContain('PHONE_WECHAT_CONFLICT')
  })

  it('validates active customer contact input without changing legacy normalizers', () => {
    expect(validateCustomerContacts({ phone: '13812345678' }).ok).toBe(true)
    expect(validateCustomerContacts({ phone: '12812345678' }).field).toBe('phone')
    expect(validateCustomerContacts({ phone: '13812345678', wechat: 'wx_name' }).ok).toBe(true)
    expect(validateCustomerContacts({ wechat: 'wx name' }).field).toBe('wechat')
    expect(validateCustomerContacts({ wechat: '1invalid' }).field).toBe('wechat')
    expect(validateCustomerContacts({}).field).toBe('contact')
    expect(validateCustomerContactField('phone', '+1 415 555 0100').ok).toBe(false)
    expect(validateCustomerContactField('wechat', 'wxid@legacy').ok).toBe(false)
  })
})
