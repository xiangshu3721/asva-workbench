import { once } from 'node:events'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ failReads: false }))

const accessError = () => Object.assign(new Error('客户不存在或当前账号无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
const feishuError = () => Object.assign(new Error('Synthetic Feishu read failed'), { code: 'FEISHU_UNAVAILABLE', status: 502 })
const assertAccess = (actorId, customerId) => {
  if (actorId === 'ADMIN-P0') return
  if (actorId === 'MENTOR-P0' && customerId === 'CUS-P0-1') return
  throw accessError()
}
const assertReadable = (actorId, customerId) => {
  assertAccess(actorId, customerId)
  if (state.failReads) throw feishuError()
}

class SyntheticRepository {
  async staff(staffId) {
    if (staffId === 'ADMIN-P0') return { id: staffId, name: 'Synthetic Admin', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }
    return { id: staffId, name: 'Synthetic Mentor', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }
  }

  async validateSession() { throw Object.assign(new Error('session not used in synthetic HTTP test'), { code: 'AUTH_REQUIRED', status: 401 }) }

  async customerProfile(actorId, customerId) {
    assertReadable(actorId, customerId)
    return {
      customerId,
      profileMaterialization: {
        sections: [{ title: '当前状态与目标', items: [{ text: '客户已录入职业转型目标', source: 'CUSTOMER_RECORD' }] }],
      },
    }
  }

  async getCustomerUnderstanding(actorId, customerId) {
    assertReadable(actorId, customerId)
    return {
      customerId,
      status: 'AVAILABLE',
      understanding: {
        one_line_understanding: { text: '客户正在考虑职业转型', confidence: 'LOW', evidence_ids: [] },
      },
      meta: { source: 'STRUCTURED_FALLBACK', generatedAt: null },
    }
  }

  async getCustomerSalesUnderstanding(actorId, customerId) {
    assertReadable(actorId, customerId)
    return {
      customerId,
      status: 'AVAILABLE',
      salesUnderstanding: {
        pain_points: [{ title: '职业方向困惑', confidence: 'LOW', evidence_ids: [] }],
        aspirations: [{ title: '找到下一步方向', confidence: 'LOW', evidence_ids: [] }],
        willingness_to_pay: { level: 'UNKNOWN' },
        ability_to_pay: { level: 'UNKNOWN' },
      },
      meta: { source: 'STRUCTURED_FALLBACK', generatedAt: null },
    }
  }
}

vi.mock('./repository.mjs', () => ({ SyntheticRepository, FeishuRepository: SyntheticRepository }))

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.HOST = '127.0.0.1'
process.env.PORT = '0'
process.env.ASVA_FRONTEND_ORIGIN = 'https://xiangshu3721.github.io'

const { server } = await import('./index.mjs?p0-core-http-test')
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

beforeEach(() => { state.failReads = false })

async function request(path, staffId = 'MENTOR-P0') {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Origin: 'https://xiangshu3721.github.io', 'X-Staff-Id': staffId },
  })
  const payload = await response.json()
  return { response, payload }
}

afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('isolated real HTTP P0 core visibility smoke', () => {
  it('serves profile, understanding fallback, and sales fallback through HTTP', async () => {
    const profile = await request('/api/customers/CUS-P0-1/profile')
    expect(profile.response.status).toBe(200)
    expect(profile.payload.profileMaterialization.sections[0].items[0].text).toBe('客户已录入职业转型目标')

    const understanding = await request('/api/customers/CUS-P0-1/understanding')
    expect(understanding.response.status).toBe(200)
    expect(understanding.payload.meta.source).toBe('STRUCTURED_FALLBACK')
    expect(understanding.payload.understanding.one_line_understanding.text).toBe('客户正在考虑职业转型')

    const sales = await request('/api/customers/CUS-P0-1/sales-understanding')
    expect(sales.response.status).toBe(200)
    expect(sales.payload.meta.source).toBe('STRUCTURED_FALLBACK')
    expect(sales.payload.salesUnderstanding.aspirations[0].title).toBe('找到下一步方向')
  })

  it('rejects an out-of-scope mentor without exposing customer data', async () => {
    const response = await request('/api/customers/CUS-P0-OTHER/profile')
    expect(response.response.status).toBe(404)
    expect(response.payload.code).toBe('CUSTOMER_NOT_FOUND')
    expect(response.payload).not.toHaveProperty('profileMaterialization')
  })

  it('returns a read failure instead of disguising Feishu failure as fallback data', async () => {
    state.failReads = true
    for (const path of ['/api/customers/CUS-P0-1/profile', '/api/customers/CUS-P0-1/understanding', '/api/customers/CUS-P0-1/sales-understanding']) {
      const result = await request(path)
      expect(result.response.status).toBe(502)
      expect(result.payload.code).toBe('FEISHU_UNAVAILABLE')
      expect(result.payload).not.toHaveProperty('meta.source', 'STRUCTURED_FALLBACK')
    }
  })
})
