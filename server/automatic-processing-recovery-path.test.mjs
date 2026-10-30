import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(join(here, 'index.mjs'), 'utf8')

describe('automatic processing recovery route (master integration)', () => {
  it('exposes an ADMIN-guarded on-demand recovery route', () => {
    expect(indexSource).toMatch(/url\.pathname === '\/api\/admin\/recover-automatic-processing'/)
    expect(indexSource).toMatch(/POST' && url\.pathname === '\/api\/admin\/recover-automatic-processing'[\s\S]*?await guardAdmin\(request\)/)
    expect(indexSource).toMatch(/recoverAutomaticCustomerProfile\(actor, customerId\)/)
    expect(indexSource).toMatch(/recoverAutomaticProcessing\(\)/)
  })

})

const state = vi.hoisted(() => ({
  recoverCalls: 0,
  lastRecoverResult: { status: 'OK', scheduledCustomers: 2, scheduledSources: 3 },
}))

class SyntheticRepository {
  async staff(staffId) {
    if (staffId === 'ADMIN-RECOVERY') return { id: staffId, name: 'Admin', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }
    return { id: staffId, name: 'Mentor', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }
  }

  async validateSession() {
    throw Object.assign(new Error('session not used in synthetic HTTP test'), { code: 'AUTH_REQUIRED', status: 401 })
  }

  async recoverAutomaticProcessing() {
    state.recoverCalls += 1
    return state.lastRecoverResult
  }

  async recoverAutomaticCustomerProfile(_actor, customerId) {
    state.recoverCalls += 1
    return { status: 'SOURCE_CREATED', customerId, sourceId: 'SRC-SYNTH', reused: false, scheduledProcessing: true }
  }

  audit() {}
}

vi.mock('./repository.mjs', () => ({ SyntheticRepository, FeishuRepository: SyntheticRepository }))

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.HOST = '127.0.0.1'
process.env.PORT = '0'
process.env.ASVA_FRONTEND_ORIGIN = 'https://xiangshu3721.github.io'

const { server } = await import('./index.mjs?automatic-processing-recovery-path-test')
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

beforeEach(() => {
  state.recoverCalls = 0
  state.lastRecoverResult = { status: 'OK', scheduledCustomers: 2, scheduledSources: 3 }
})

async function request(path, { staffId = 'ADMIN-RECOVERY', method = 'POST', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Origin: 'https://xiangshu3721.github.io',
      'Content-Type': 'application/json',
      'X-Staff-Id': staffId,
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('on-demand admin recovery HTTP route', () => {
  it('rejects non-admin and recovers for admin bulk + customerId', async () => {
    // Master may still invoke recover on module load; beforeEach resets the counter.
    const health = await request('/api/health', { method: 'GET', staffId: 'MENTOR-RECOVERY' })
    expect(health.response.status).toBe(200)
    const callsAfterHealth = state.recoverCalls

    const denied = await request('/api/admin/recover-automatic-processing', { staffId: 'MENTOR-RECOVERY' })
    expect(denied.response.status).toBe(403)
    expect(denied.payload.code).toBe('ADMIN_REQUIRED')
    expect(state.recoverCalls).toBe(callsAfterHealth)

    const ok = await request('/api/admin/recover-automatic-processing', { staffId: 'ADMIN-RECOVERY' })
    expect(ok.response.status).toBe(200)
    expect(ok.payload).toEqual({ status: 'OK', scheduledCustomers: 2, scheduledSources: 3 })
    expect(state.recoverCalls).toBe(callsAfterHealth + 1)

    const scoped = await request('/api/admin/recover-automatic-processing', { staffId: 'ADMIN-RECOVERY', body: { customerId: 'CUS-TARGET-1' } })
    expect(scoped.response.status).toBe(200)
    expect(scoped.payload).toMatchObject({ status: 'SOURCE_CREATED', customerId: 'CUS-TARGET-1', sourceId: 'SRC-SYNTH', reused: false })
    expect(state.recoverCalls).toBe(callsAfterHealth + 2)
  })
})
