import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(join(here, 'index.mjs'), 'utf8')
const repositorySource = readFileSync(join(here, 'repository.mjs'), 'utf8')

describe('automatic processing recovery path isolation', () => {
  it('does not start recover or a 30s interval from server module bootstrap', () => {
    const moduleTop = indexSource.slice(0, indexSource.indexOf('function send('))
    expect(moduleTop).toMatch(/const repository = new FeishuRepository\(\)/)
    expect(moduleTop).not.toMatch(/recoverAutomaticProcessing\s*\(/)
    expect(moduleTop).not.toMatch(/startAutomaticProcessingRecovery\s*\(/)
    expect(moduleTop).toMatch(/Do not run the 11-table recoverAutomaticProcessing scan/)
    expect(indexSource).not.toMatch(/repository\.startAutomaticProcessingRecovery\s*\?\.\s*\(/)
    expect(indexSource).not.toMatch(/void repository\.recoverAutomaticProcessing\s*\(/)
    expect(repositorySource).not.toMatch(/setInterval\s*\(\s*\(\)\s*=>\s*\{\s*void this\.recoverAutomaticProcessing/)
    expect(repositorySource).not.toMatch(/AUTO_PROCESSING_INTERVAL_MS/)
    expect(repositorySource).toMatch(/startAutomaticProcessingRecovery\(\)\s*\{\s*\/\/ Periodic 11-table recovery was removed[\s\S]*?return\s*\}/)
    expect(repositorySource).toMatch(/scheduleAutomaticProcessing\(actorId, sourceId\)\s*\{\s*if \(!config\.features\.automaticProfileArchiving\) return\s*setImmediate/)
  })

  it('exposes an ADMIN-guarded on-demand recovery route', () => {
    expect(indexSource).toMatch(/url\.pathname === '\/api\/admin\/recover-automatic-processing'/)
    expect(indexSource).toMatch(/POST' && url\.pathname === '\/api\/admin\/recover-automatic-processing'[\s\S]*?await guardAdmin\(request\)[\s\S]*?recoverAutomaticProcessing\(\)/)
  })

  it('keeps frozen login hotfixes: parallel validateSession and local verifySession error logging', () => {
    expect(repositorySource).toMatch(/const \[account, credential\] = await Promise\.all\(\[/)
    expect(repositorySource).toMatch(/config\.authMode === 'PASSWORD' \? this\.authRepository\.findByStaffId\(staffId\) : Promise\.resolve\(null\)/)
    expect(indexSource).toMatch(/Error logging must never re-enter Feishu-dependent session validation/)
    expect(indexSource).toMatch(/return token \? String\(verifySession\(token\)\.sub \|\| ''\) : ''/)
    expect(indexSource).not.toMatch(/const operatorId = await \(async \(\) => \{ try \{ return await actorId\(request\)/)
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
const recoverCallsAtImport = state.recoverCalls
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

beforeEach(() => {
  state.recoverCalls = 0
  state.lastRecoverResult = { status: 'OK', scheduledCustomers: 2, scheduledSources: 3 }
})

async function request(path, { staffId = 'ADMIN-RECOVERY', method = 'POST' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Origin: 'https://xiangshu3721.github.io',
      'Content-Type': 'application/json',
      'X-Staff-Id': staffId,
    },
    body: method === 'POST' ? '{}' : undefined,
  })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('on-demand admin recovery HTTP route', () => {
  it('does not recover on health, rejects non-admin, and recovers for admin', async () => {
    expect(recoverCallsAtImport).toBe(0)
    expect(state.recoverCalls).toBe(0)

    const health = await request('/api/health', { method: 'GET', staffId: 'MENTOR-RECOVERY' })
    expect(health.response.status).toBe(200)
    expect(state.recoverCalls).toBe(0)

    const denied = await request('/api/admin/recover-automatic-processing', { staffId: 'MENTOR-RECOVERY' })
    expect(denied.response.status).toBe(403)
    expect(denied.payload.code).toBe('ADMIN_REQUIRED')
    expect(state.recoverCalls).toBe(0)

    const ok = await request('/api/admin/recover-automatic-processing', { staffId: 'ADMIN-RECOVERY' })
    expect(ok.response.status).toBe(200)
    expect(ok.payload).toEqual({ status: 'OK', scheduledCustomers: 2, scheduledSources: 3 })
    expect(state.recoverCalls).toBe(1)
  })
})
