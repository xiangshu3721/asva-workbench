import { once } from 'node:events'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { materializeCustomerProfile } from '../shared/profile-materialization.mjs'

class SyntheticRepository {
  async customerProfile(actorId, customerId) {
    if (actorId !== 'MENTOR-PROFILE') throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const customer = {
      id: customerId,
      profileFields: {},
      age: 35,
      city: '杭州',
      occupation: '设计师',
      maritalStatus: '已婚',
      familySummary: '与家人同住',
      need: '正在考虑职业转型',
      helpExpectation: '希望梳理职业方向',
      goal: '三个月内确定下一步',
      notes: '客户情况来自基础资料录入',
    }
    return { customerId, profileFields: {}, profileFieldMeta: {}, profileMaterialization: materializeCustomerProfile({ customer, evidenceItems: [] }) }
  }
}

vi.mock('./repository.mjs', () => ({ FeishuRepository: SyntheticRepository }))

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.HOST = '127.0.0.1'
process.env.PORT = '0'
process.env.ASVA_FRONTEND_ORIGIN = 'https://xiangshu3721.github.io'

const { server } = await import('./index.mjs?http-profile-visibility-test')
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('real Node HTTP customer profile visibility flow with isolated data', () => {
  it('returns Customers base fields as profile sections without Evidence or Source records', async () => {
    const response = await fetch(`${baseUrl}/api/customers/CUS-PROFILE-SYN/profile`, { headers: { Origin: 'https://xiangshu3721.github.io', 'X-Staff-Id': 'MENTOR-PROFILE' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://xiangshu3721.github.io')
    const payload = await response.json()
    const rendered = payload.profileMaterialization.sections.flatMap((section) => section.items).map((item) => item.text)
    expect(rendered).toEqual(expect.arrayContaining(['35', '杭州', '设计师', '已婚', '与家人同住', '正在考虑职业转型', '希望梳理职业方向', '三个月内确定下一步', '客户情况来自基础资料录入']))
    expect(payload.profileMaterialization.coverage.percentage).toBeGreaterThan(0)
  })
})
