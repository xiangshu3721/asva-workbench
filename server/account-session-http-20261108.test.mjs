import { once } from 'node:events'
import { afterAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ accounts: new Map(), customers: new Map() }))
const authError = () => Object.assign(new Error('登录信息验证失败'), { code: 'AUTH_INVALID', status: 401 })
const conflictError = () => Object.assign(new Error('该手机号已绑定完整导师账户，无需重复创建。'), { code: 'ACCOUNT_ALREADY_EXISTS', status: 409 })

class SyntheticRepository {
  constructor() {
    state.accounts.set('admin-1', { id: 'admin-1', name: '隔离管理员', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true, phone: '13800000001', loginPhone: '13800000001', authVersion: 4, mustChangePassword: false, authMode: 'PASSWORD' })
    state.accounts.set('mentor-1', { id: 'mentor-1', name: '重复导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: '13900000001', loginPhone: '13900000001', authVersion: 3, mustChangePassword: false, authMode: 'PASSWORD' })
    state.customers.set('mentor-1', [{ id: 'CUS-OWNED', name: '本人客户' }])
  }
  async authenticate(phone, password) {
    const normalized = String(phone).replace(/[\s-]/g, '')
    const account = [...state.accounts.values()].find((item) => item.loginPhone === normalized)
    if (!account || password !== 'Correct-Password-8472!') throw authError()
    return { ...account }
  }
  async validateSession(staffId, authVersion, authMode) {
    const account = state.accounts.get(staffId)
    if (!account || authMode !== 'PASSWORD' || Number(authVersion) !== account.authVersion) throw authError()
    return { account: { ...account }, credential: { staffId, authVersion: account.authVersion, credentialStatus: 'ACTIVE', mustChangePassword: false } }
  }
  async staff(staffId) { const account = state.accounts.get(staffId); if (!account) throw new Error('账号不存在'); return { ...account } }
  async dashboard(actorId) { return { actorId, customers: state.customers.get(actorId) || [] } }
  async customerDirectory(actorId) { return { customers: state.customers.get(actorId) || [] } }
  async changePassword(staffId) { return { ok: true, staffId, authVersion: 5, mustChangePassword: false } }
  async teamSnapshot(actorId) { if (actorId !== 'admin-1') throw Object.assign(new Error('只有 ADMIN 可以管理导师账户'), { status: 403, code: 'FORBIDDEN' }); return { mentors: [{ id: 'mentor-1' }] } }
  async createMentor(actorId) { if (actorId !== 'admin-1') throw Object.assign(new Error('只有 ADMIN 可以管理导师账户'), { status: 403, code: 'FORBIDDEN' }); throw conflictError() }
  async mentorAccountStatus(actorId) { if (actorId !== 'admin-1') throw Object.assign(new Error('只有 ADMIN 可以核实导师账户'), { status: 403, code: 'FORBIDDEN' }); return { status: 'DUPLICATE', mentorCount: 2, credentialCount: 1 } }
}

vi.mock('./repository.mjs', () => ({ FeishuRepository: SyntheticRepository }))
process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.AUTH_MODE = 'PASSWORD'
process.env.ASVA_AUTH_SECRET = 'isolated-session-secret'
process.env.HOST = '127.0.0.1'
process.env.PORT = '0'

const { server } = await import('./index.mjs?account-session-http-20261108')
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } })
  const payload = await response.json()
  return { response, payload }
}

afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('isolated HTTP account/session regression', () => {
  it('logs in and issues a session for a valid mentor', async () => {
    const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: '13900000001', password: 'Correct-Password-8472!' }) })
    expect(result.response.status).toBe(200)
    expect(result.payload.id).toBe('mentor-1')
    expect(result.payload.token).toEqual(expect.any(String))
  })

  it('accepts a session for an identical duplicate Staff identity', async () => {
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: '13900000001', password: 'Correct-Password-8472!' }) })
    const me = await request('/api/staff/me', { headers: { Authorization: `Bearer ${login.payload.token}` } })
    expect(me.response.status).toBe(200)
    expect(me.payload.id).toBe('mentor-1')
  })

  it('allows the mentor to enter the workbench and read only own customers', async () => {
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: '13900000001', password: 'Correct-Password-8472!' }) })
    const dashboard = await request('/api/dashboard', { headers: { Authorization: `Bearer ${login.payload.token}` } })
    const directory = await request('/api/customers/directory', { headers: { Authorization: `Bearer ${login.payload.token}` } })
    expect(dashboard.response.status).toBe(200)
    expect(directory.response.status).toBe(200)
    expect(directory.payload.customers).toEqual([{ id: 'CUS-OWNED', name: '本人客户' }])
  })

  it('rejects wrong passwords and does not expose a session', async () => {
    const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: '13900000001', password: 'Wrong-password!' }) })
    expect(result.response.status).toBe(401)
    expect(result.payload).not.toHaveProperty('token')
  })

  it('keeps admin-only mentor operations protected and rejects duplicate creation', async () => {
    const mentorLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: '13900000001', password: 'Correct-Password-8472!' }) })
    const denied = await request('/api/staff/mentors', { method: 'POST', headers: { Authorization: `Bearer ${mentorLogin.payload.token}` }, body: JSON.stringify({ name: '再次创建', phone: '13900000001' }) })
    expect(denied.response.status).toBe(403)

    const adminLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: '13800000001', password: 'Correct-Password-8472!' }) })
    const duplicate = await request('/api/staff/mentors', { method: 'POST', headers: { Authorization: `Bearer ${adminLogin.payload.token}` }, body: JSON.stringify({ name: '再次创建', phone: '13900000001' }) })
    expect(duplicate.response.status).toBe(409)
    expect(duplicate.payload.code).toBe('ACCOUNT_ALREADY_EXISTS')
  })

  it('allows password change through a valid session', async () => {
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: '13900000001', password: 'Correct-Password-8472!' }) })
    const changed = await request('/api/auth/change-password', { method: 'POST', headers: { Authorization: `Bearer ${login.payload.token}` }, body: JSON.stringify({ currentPassword: 'Correct-Password-8472!', newPassword: 'New-Correct-Password-8472!' }) })
    expect(changed.response.status).toBe(200)
    expect(changed.payload.token).toEqual(expect.any(String))
  })
})
