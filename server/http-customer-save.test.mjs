import { once } from 'node:events'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  customers: new Map(),
  operations: new Map(),
  enrollments: new Map(),
  nextId: 1,
  createAttempts: 0,
  createWrites: 0,
  failAfterCommitOnce: false,
}))

const publicCustomer = (item) => ({ ...item })
const database = () => ({
  staff: [{ id: 'MENTOR-HTTP', name: 'Synthetic Mentor', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }],
  customers: [...state.customers.values()].map(publicCustomer),
  appointments: [], sessions: [], followups: [], products: [{ id: 'PRODUCT-1', name: 'Synthetic Course', status: '在售', active: true }],
  enrollments: [...state.enrollments.values()], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
})
const mutation = (customer, customerCreated) => ({ customer: publicCustomer(customer), enrollments: [...state.enrollments.values()].filter((item) => item.customerId === customer.id), createdCustomerId: customer.id, customerCreated, persistenceStatus: 'COMMITTED' })
const failure = (message, code, status) => Object.assign(new Error(message), { code, status })

class SyntheticRepository {
  async createCustomer(_actorId, input, _requestId = '', { compactResponse = false } = {}) {
    state.createAttempts += 1
    const operationId = String(input.operationId || '')
    const existingOperationId = state.operations.get(operationId)
    if (existingOperationId) {
      const existing = state.customers.get(existingOperationId)
      return compactResponse ? mutation(existing, false) : database()
    }
    if ([...state.customers.values()].some((item) => item.phone && item.phone === input.phone)) throw failure('该联系方式已匹配到现有客户，请打开原档案更新。', 'CUSTOMER_DUPLICATE', 409)
    const id = `CUS-HTTP-${state.nextId++}`
    const customer = { id, name: input.nickname, phone: input.phone || '', wechat: input.wechat || '', referrerName: input.introducer || '', notes: input.situation || '' }
    state.customers.set(id, customer)
    if (operationId) state.operations.set(operationId, id)
    state.createWrites += 1
    if (state.failAfterCommitOnce) {
      state.failAfterCommitOnce = false
      throw failure('模拟响应丢失', 'FEISHU_UNAVAILABLE', 502)
    }
    return compactResponse ? mutation(customer, true) : { ...database(), createdCustomerId: id, customerCreated: true }
  }

  async updateCustomer(_actorId, customerId, input, { compactResponse = false } = {}) {
    const customer = state.customers.get(customerId)
    if (!customer) throw failure('客户不存在', 'CUSTOMER_NOT_FOUND', 404)
    Object.assign(customer, { name: input.nickname || customer.name, phone: input.phone ?? customer.phone, wechat: input.wechat ?? customer.wechat, referrerName: input.introducer ?? customer.referrerName, notes: input.situation ?? customer.notes })
    return compactResponse ? mutation(customer, false) : database()
  }

  async updateCustomerEnrollments(_actorId, customerId, drafts) {
    if (!state.customers.has(customerId)) throw failure('客户不存在', 'CUSTOMER_NOT_FOUND', 404)
    for (const [key] of state.enrollments) if (key.startsWith(`${customerId}:`)) state.enrollments.delete(key)
    for (const draft of Array.isArray(drafts) ? drafts : []) state.enrollments.set(`${customerId}:${draft.productId}`, { id: `${customerId}:${draft.productId}`, customerId, productId: draft.productId, status: 'ACTIVE' })
    return database()
  }

  async customerDirectory() { return database() }
  async customerDetail(_actorId, customerId) { return { ...database(), customers: database().customers.filter((item) => item.id === customerId), enrollments: database().enrollments.filter((item) => item.customerId === customerId) } }
  async customer(_actorId, customerId) { return state.customers.get(customerId) || null }
}

vi.mock('./repository.mjs', () => ({ SyntheticRepository, FeishuRepository: SyntheticRepository }))

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.HOST = '127.0.0.1'
process.env.PORT = '0'
process.env.ASVA_FRONTEND_ORIGIN = 'https://xiangshu3721.github.io'

const { server } = await import('./index.mjs?http-customer-save-test')
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

beforeEach(() => {
  state.customers.clear()
  state.operations.clear()
  state.enrollments.clear()
  state.nextId = 1
  state.createAttempts = 0
  state.createWrites = 0
  state.failAfterCommitOnce = false
})

async function request(path, init = {}) {
  const headers = new Headers({ Origin: 'https://xiangshu3721.github.io', 'Content-Type': 'application/json', 'X-Staff-Id': 'MENTOR-HTTP', ...(init.headers || {}) })
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

function customerInput(operationId, overrides = {}) {
  return { operationId, nickname: 'HTTP 合成客户', phone: '13800000001', wechat: '', introducer: 'Synthetic Mentor', situation: '首次通过真实 Node HTTP 路由保存。', enrollments: [], ...overrides }
}

afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('real Node HTTP customer save flow with isolated persistence', () => {
  it('creates, reads back, updates, and links an enrollment through HTTP', async () => {
    const input = customerInput('op-http-create-1', { enrollments: [{ productId: 'PRODUCT-1' }] })
    const created = await request('/api/customers', { method: 'POST', headers: { 'X-ASVA-Response-Mode': 'customer-mutation-v1', 'X-Idempotency-Key': input.operationId }, body: JSON.stringify(input) })
    expect(created.response.status).toBe(201)
    expect(created.response.headers.get('access-control-allow-origin')).toBe('https://xiangshu3721.github.io')
    expect(created.payload).toMatchObject({ customer: { name: input.nickname, phone: input.phone }, createdCustomerId: expect.any(String), persistenceStatus: 'COMMITTED' })
    const customerId = created.payload.createdCustomerId

    const directory = await request('/api/customers/directory')
    expect(directory.response.status).toBe(200)
    expect(directory.payload.customers.some((item) => item.id === customerId)).toBe(true)

    const detail = await request(`/api/customers/${customerId}/detail`)
    expect(detail.response.status).toBe(200)
    expect(detail.payload.customers[0]).toMatchObject({ id: customerId, name: input.nickname, phone: input.phone, notes: input.situation })

    const updated = await request(`/api/customers/${customerId}`, { method: 'PATCH', headers: { 'X-ASVA-Response-Mode': 'customer-mutation-v1', 'X-Idempotency-Key': 'op-http-update-1' }, body: JSON.stringify({ operationId: 'op-http-update-1', nickname: input.nickname, phone: input.phone, wechat: '', introducer: input.introducer, situation: '更新后的客户情况。', enrollments: [] }) })
    expect(updated.response.status).toBe(200)
    expect(updated.response.headers.get('access-control-allow-origin')).toBe('https://xiangshu3721.github.io')
    expect(updated.payload).toMatchObject({ customer: { id: customerId, notes: '更新后的客户情况。' }, persistenceStatus: 'COMMITTED' })

    const readAfterUpdate = await request(`/api/customers/${customerId}/detail`)
    expect(readAfterUpdate.payload.customers[0].notes).toBe('更新后的客户情况。')

    const enrollments = await request(`/api/customers/${customerId}/enrollments`, { method: 'PUT', body: JSON.stringify({ operationId: 'op-http-enrollment-1', enrollments: [{ productId: 'PRODUCT-1' }] }) })
    expect(enrollments.response.status).toBe(200)
    expect(enrollments.response.headers.get('access-control-allow-origin')).toBe('https://xiangshu3721.github.io')
    expect(enrollments.payload.enrollments).toEqual([{ id: `${customerId}:PRODUCT-1`, customerId, productId: 'PRODUCT-1', status: 'ACTIVE' }])
  })

  it('keeps compact and legacy responses compatible and prevents duplicate creates', async () => {
    const input = customerInput('op-http-idempotent-1', { nickname: '幂等合成客户', phone: '13800000002' })
    const first = await request('/api/customers', { method: 'POST', headers: { 'X-ASVA-Response-Mode': 'customer-mutation-v1' }, body: JSON.stringify(input) })
    const second = await request('/api/customers', { method: 'POST', headers: { 'X-ASVA-Response-Mode': 'customer-mutation-v1' }, body: JSON.stringify(input) })
    expect(first.payload.createdCustomerId).toBe(second.payload.createdCustomerId)
    expect(state.createWrites).toBe(1)
    const duplicate = await request('/api/customers', { method: 'POST', headers: { 'X-ASVA-Response-Mode': 'customer-mutation-v1' }, body: JSON.stringify(customerInput('op-http-different-1', { nickname: '重复号码', phone: input.phone })) })
    expect(duplicate.response.status).toBe(409)
    expect(duplicate.payload.code).toBe('CUSTOMER_DUPLICATE')

    const legacyInput = customerInput('op-http-legacy-1', { nickname: '旧客户端客户', phone: '13800000003' })
    const legacy = await request('/api/customers', { method: 'POST', body: JSON.stringify(legacyInput) })
    expect(legacy.response.status).toBe(201)
    expect(Array.isArray(legacy.payload.customers)).toBe(true)
    expect(state.createWrites).toBe(2)
  })

  it('recovers a committed write with the same operationId after a response failure', async () => {
    const input = customerInput('op-http-recovery-1', { nickname: '恢复合成客户', phone: '13800000004' })
    state.failAfterCommitOnce = true
    const failedResponse = await request('/api/customers', { method: 'POST', headers: { 'X-ASVA-Response-Mode': 'customer-mutation-v1' }, body: JSON.stringify(input) })
    expect(failedResponse.response.status).toBe(502)
    const retry = await request('/api/customers', { method: 'POST', headers: { 'X-ASVA-Response-Mode': 'customer-mutation-v1' }, body: JSON.stringify(input) })
    expect(retry.response.status).toBe(201)
    expect(retry.payload.customer.name).toBe(input.nickname)
    expect(state.createWrites).toBe(1)
  })

  it('fails closed without a staff identity and passes all mutation preflights', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ASVA-Response-Mode': 'customer-mutation-v1' }, body: JSON.stringify(customerInput('op-http-no-auth-1')) })
    expect(unauthenticated.status).toBe(401)

    for (const [method, path] of [['POST', '/api/customers'], ['PATCH', '/api/customers/CUS-HTTP-1'], ['PUT', '/api/customers/CUS-HTTP-1/enrollments']]) {
      const preflight = await request(path, { method: 'OPTIONS', headers: { Origin: 'https://xiangshu3721.github.io', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type,x-idempotency-key,x-asva-response-mode' } })
      expect(preflight.response.status).toBe(204)
      expect(preflight.response.headers.get('access-control-allow-origin')).toBe('https://xiangshu3721.github.io')
      expect(preflight.response.headers.get('access-control-allow-headers')).toContain('X-ASVA-Response-Mode')
      expect(preflight.response.headers.get('access-control-allow-methods')).toContain(method)
    }

    const blockedPreflight = await request('/api/customers', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-idempotency-key,x-asva-response-mode' } })
    expect(blockedPreflight.response.status).toBe(204)
    expect(blockedPreflight.response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
