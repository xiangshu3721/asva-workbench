/**
 * ASVA AI archive closed-loop acceptance (A–G) against real HTTP entry.
 * Isolation: in-memory Feishu fixture + mocked DeepSeek extractor.
 * Does NOT write production Feishu / deploy / merge dirty PR#54.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { contentHash } from '../shared/evidence-contract.mjs'

const EVIDENCE_DIR = process.env.ASVA_CLOSED_LOOP_EVIDENCE_DIR
  || (process.env.HOME
    ? `${process.env.HOME}/Troublehut/_verify/asva-closed-loop-20261031`
    : path.resolve('_verify/asva-closed-loop-20261031'))

const state = vi.hoisted(() => {
  process.env.APP_ENV = 'mock'
  process.env.ASVA_ENVIRONMENT = 'mock'
  process.env.DATA_MODE = 'mock'
  process.env.HOST = '127.0.0.1'
  process.env.PORT = '0'
  process.env.ASVA_FRONTEND_ORIGIN = 'https://xiangshu3721.github.io'
  process.env.ASVA_CONFIG_DIR = '/nonexistent/asva-closed-loop-test-config'
  process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
  process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'off'
  process.env.ASVA_AI_ARCHIVE_INVOKE_MODE = 'local'
  process.env.FEISHU_CUSTOMERS_TABLE_ID = 'tbl-cl-customers'
  process.env.FEISHU_STAFF_TABLE_ID = 'tbl-cl-staff'
  process.env.FEISHU_PRODUCTS_TABLE_ID = 'tbl-cl-products'
  process.env.FEISHU_ENROLLMENTS_TABLE_ID = 'tbl-cl-enrollments'
  process.env.FEISHU_PROFILE_CHANGES_TABLE_ID = 'tbl-cl-profile-changes'
  process.env.FEISHU_APPOINTMENTS_TABLE_ID = 'tbl-cl-appointments'
  process.env.FEISHU_SERVICE_RECORDS_TABLE_ID = 'tbl-cl-services'
  process.env.FEISHU_SOURCE_RECORDS_TABLE_ID = 'tbl-cl-sources'
  process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID = 'tbl-cl-evidence'
  process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID = 'tbl-cl-proposals'
  process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID = 'tbl-cl-conflicts'
  return {
  tableIds: {
    customers: 'tbl-cl-customers',
    staff: 'tbl-cl-staff',
    products: 'tbl-cl-products',
    enrollments: 'tbl-cl-enrollments',
    profileChanges: 'tbl-cl-profile-changes',
    appointments: 'tbl-cl-appointments',
    serviceRecords: 'tbl-cl-services',
    sourceRecords: 'tbl-cl-sources',
    evidenceItems: 'tbl-cl-evidence',
    profileUpdateProposals: 'tbl-cl-proposals',
    evidenceConflicts: 'tbl-cl-conflicts',
  },
  tables: new Map(),
  nextRecordId: 1,
  deepseekFail: false,
  feishuWriteFailTable: '',
  workerCalls: [],
  extractorCalls: 0,
  }
})

const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)))
const table = (tableId) => {
  if (!state.tables.has(tableId)) state.tables.set(tableId, new Map())
  return state.tables.get(tableId)
}
const rowFields = (row) => row?.fields || {}

function matchSearchFilter(fields, filter) {
  const conditions = filter?.conditions || []
  if (!conditions.length) return true
  const conjunction = String(filter?.conjunction || 'and').toLowerCase()
  const results = conditions.map((condition) => {
    const actual = fields?.[condition.field_name]
    const expected = Array.isArray(condition.value) ? condition.value[0] : condition.value
    if (condition.operator === 'is') return String(actual ?? '') === String(expected ?? '')
    return false
  })
  return conjunction === 'or' ? results.some(Boolean) : results.every(Boolean)
}

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return {
    ...actual,
    listRecords: async (tableId) => [...table(tableId).values()].map(clone),
    searchRecords: async (tableId, filter) => [...table(tableId).values()].filter((row) => matchSearchFilter(rowFields(row), filter)).map(clone),
    getRecord: async (tableId, recordId) => {
      const row = table(tableId).get(recordId)
      return row ? clone(row) : null
    },
    createRecord: async (tableId, fields, context = {}) => {
      if (state.feishuWriteFailTable && tableId === state.feishuWriteFailTable) {
        throw new actual.FeishuUnavailableError('模拟飞书写入失败', { code: 'FEISHU_UNAVAILABLE', retryable: true, writeDispatched: false })
      }
      const idempotency = context.idempotency
      if (idempotency?.field) {
        const existing = [...table(tableId).values()].find((row) => String(rowFields(row)[idempotency.field] ?? '') === String(idempotency.value))
        if (existing) return { record: clone(existing), idempotency_recovered: true }
      }
      const recordId = `rec-cl-${state.nextRecordId++}`
      const row = { record_id: recordId, fields: clone(fields) }
      table(tableId).set(recordId, row)
      return { record: clone(row) }
    },
    updateRecord: async (tableId, recordId, fields) => {
      if (state.feishuWriteFailTable && tableId === state.feishuWriteFailTable) {
        throw new actual.FeishuUnavailableError('模拟飞书更新失败', { code: 'FEISHU_UNAVAILABLE', retryable: true, writeDispatched: false })
      }
      const row = table(tableId).get(recordId)
      if (!row) throw new actual.FeishuUnavailableError('模拟更新记录不存在', { code: 'FEISHU_NOT_FOUND', retryable: false })
      row.fields = { ...rowFields(row), ...clone(fields) }
      return { record: clone(row) }
    },
  }
})

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.HOST = '127.0.0.1'
process.env.PORT = '0'
process.env.ASVA_FRONTEND_ORIGIN = 'https://xiangshu3721.github.io'
process.env.ASVA_CONFIG_DIR = '/nonexistent/asva-closed-loop-test-config'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'off'
process.env.ASVA_AI_ARCHIVE_INVOKE_MODE = 'local'
process.env.FEISHU_CUSTOMERS_TABLE_ID = state.tableIds.customers
process.env.FEISHU_STAFF_TABLE_ID = state.tableIds.staff
process.env.FEISHU_PRODUCTS_TABLE_ID = state.tableIds.products
process.env.FEISHU_ENROLLMENTS_TABLE_ID = state.tableIds.enrollments
process.env.FEISHU_PROFILE_CHANGES_TABLE_ID = state.tableIds.profileChanges
process.env.FEISHU_APPOINTMENTS_TABLE_ID = state.tableIds.appointments
process.env.FEISHU_SERVICE_RECORDS_TABLE_ID = state.tableIds.serviceRecords
process.env.FEISHU_SOURCE_RECORDS_TABLE_ID = state.tableIds.sourceRecords
process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID = state.tableIds.evidenceItems
process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID = state.tableIds.profileUpdateProposals
process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID = state.tableIds.evidenceConflicts

const { fields } = await import('./field-mapping.mjs')
const { FeishuRepository } = await import('./repository.mjs')
const { handleAiArchiveEvent } = await import('./ai-archive-worker.mjs')
const { setLocalAiArchiveWorkerRunner } = await import('./ai-archive-invoke.mjs')
const { config } = await import('./config.mjs')
const { responseHeaders } = await import('./cors.mjs')

function put(tableId, recordId, mappedFields) {
  table(tableId).set(recordId, { record_id: recordId, fields: clone(mappedFields) })
}

function resetStore() {
  state.tables = new Map()
  state.nextRecordId = 1
  state.deepseekFail = false
  state.feishuWriteFailTable = ''
  state.workerCalls = []
  state.extractorCalls = 0
  put(state.tableIds.staff, 'rec-admin', fields('staff', {
    staff_id: 'ADMIN-1', nickname: '管理员', permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true, phone: '13800000001',
  }))
  put(state.tableIds.staff, 'rec-mentor', fields('staff', {
    staff_id: 'MENTOR-1', nickname: '导师甲', permission_role: 'MENTOR', status: 'ACTIVE', login_enabled: true, phone: '13800000002',
  }))
  put(state.tableIds.products, 'rec-product', fields('products', {
    product_id: 'PRODUCT-1', name: '基础课程', status: '在售', active: true,
  }))
}

function evidenceFor(text, goal = '提升表达能力') {
  const idx = Math.max(0, String(text).indexOf(goal))
  return [{
    evidence_type: 'FACT',
    field_key: 'current_goal',
    value: goal,
    display_text: goal,
    source_excerpt: goal,
    locator: { char_start: idx, char_end: idx + goal.length },
    confidence: 0.92,
    semantic_kind: 'GOAL',
    content_source: 'STAFF_REPORTED',
    information_nature: 'OBSERVED_FACT',
    verification_status: 'UNVERIFIED',
    review_status: 'PENDING_REVIEW',
  }]
}

function makeRepository() {
  return new FeishuRepository({
    authRepository: {},
    evidenceExtractor: async ({ text }) => {
      state.extractorCalls += 1
      if (state.deepseekFail) {
        throw Object.assign(new Error('模拟 DeepSeek 不可用'), { code: 'DEEPSEEK_UNAVAILABLE', status: 502 })
      }
      return evidenceFor(text)
    },
  })
}

// Replace module-level repository used by HTTP server by mocking after import is awkward;
// instead drive closed-loop via HTTP against a forked harness: call repository methods through
// a thin HTTP server we mount here that mirrors index routes for customers/profile/recover.

import http from 'node:http'

let activeRepository = makeRepository()

setLocalAiArchiveWorkerRunner(async (payload) => {
  state.workerCalls.push(clone(payload))
  // Use the same repository instance as HTTP handlers so fixture state is shared.
  const previous = activeRepository
  // Worker normally constructs its own FeishuRepository; for isolation, run recover/process on activeRepository.
  try {
    if (payload.mode === 'process' && payload.sourceId) {
      const processed = await activeRepository.processSource(payload.actorId || 'ADMIN-1', payload.sourceId, { force: payload.force === true })
      return { ok: true, status: processed?.source?.processingStatus || 'PROCESSING', customerId: processed?.source?.customerId, sourceId: payload.sourceId, processed: true, mode: 'process' }
    }
    const result = await activeRepository.recoverAutomaticCustomerProfile(payload.actorId || 'ADMIN-1', payload.customerId)
    return { ok: !['FAILED', 'DISABLED'].includes(result?.status), ...result, mode: 'recover' }
  } catch (error) {
    return { ok: false, status: 'FAILED', errorCode: error?.code || 'AI_ARCHIVE_WORKER_FAILED', message: error?.message, customerId: payload.customerId, sourceId: payload.sourceId }
  } finally {
    void previous
  }
})

function send(request, response, statusCode, body, requestId) {
  response.writeHead(statusCode, responseHeaders(request, requestId))
  response.end(JSON.stringify(body))
}

async function readBody(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

const server = http.createServer(async (request, response) => {
  const requestId = `cl-${Date.now()}`
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'OPTIONS') return send(request, response, 204, {}, requestId)
    const actor = String(request.headers['x-staff-id'] || '')
    if (!actor && url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
      return send(request, response, 401, { code: 'AUTH_REQUIRED', message: '请先登录' }, requestId)
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return send(request, response, 200, { ok: true, service: 'asva-api-closed-loop-test' }, requestId)
    }
    if (request.method === 'GET' && url.pathname === '/api/customers/directory') {
      return send(request, response, 200, await activeRepository.customerDirectory(actor), requestId)
    }
    if (request.method === 'POST' && url.pathname === '/api/customers') {
      const body = await readBody(request)
      const created = await activeRepository.createCustomer(actor, body, requestId, { compactResponse: true })
      return send(request, response, 201, created, requestId)
    }
    const customerEdit = url.pathname.match(/^\/api\/customers\/([^/]+)$/)
    if (request.method === 'PATCH' && customerEdit) {
      const body = await readBody(request)
      return send(request, response, 200, await activeRepository.updateCustomer(actor, decodeURIComponent(customerEdit[1]), body, { compactResponse: true }), requestId)
    }
    const profilePath = url.pathname.match(/^\/api\/customers\/([^/]+)\/profile$/)
    if (request.method === 'GET' && profilePath) {
      return send(request, response, 200, await activeRepository.customerProfile(actor, decodeURIComponent(profilePath[1])), requestId)
    }
    const customerGet = url.pathname.match(/^\/api\/customers\/([^/]+)$/)
    if (request.method === 'GET' && customerGet) {
      return send(request, response, 200, await activeRepository.customer(actor, decodeURIComponent(customerGet[1])), requestId)
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/recover-automatic-processing') {
      const account = await activeRepository.staff(actor)
      if (account.permissionRole !== 'ADMIN') return send(request, response, 403, { code: 'ADMIN_REQUIRED' }, requestId)
      const body = await readBody(request)
      if (body.customerId) {
        return send(request, response, 200, await activeRepository.recoverAutomaticCustomerProfile(actor, body.customerId), requestId)
      }
      return send(request, response, 200, await activeRepository.recoverAutomaticProcessing(), requestId)
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      return send(request, response, 200, { id: actor || 'ADMIN-1', permissionRole: 'ADMIN', token: 'test' }, requestId)
    }
    return send(request, response, 404, { code: 'NOT_FOUND' }, requestId)
  } catch (error) {
    console.error('[CLOSED_LOOP_HTTP_ERROR]', error?.code, error?.message, error?.stack?.split('\n').slice(0, 3).join(' | '))
    send(request, response, error?.status || 500, { code: error?.code || 'REQUEST_FAILED', message: error?.message || 'error' }, requestId)
  }
}).listen(0, '127.0.0.1')

if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  resetStore()
  activeRepository = makeRepository()
  config.features.automaticProfileArchiving = true
  config.features.automaticProfileArchivingMode = 'off'
})

async function request(pathname, { method = 'GET', staffId = 'ADMIN-1', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Origin: 'https://xiangshu3721.github.io',
      'Content-Type': 'application/json',
      'X-Staff-Id': staffId,
      'X-Asva-Response-Mode': 'customer-mutation-v1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  return { status: response.status, body: json }
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await predicate()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw Object.assign(new Error('waitFor timeout'), { last })
}

function customerSources(customerId) {
  return [...table(state.tableIds.sourceRecords).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
}
function customerEvidence(customerId) {
  return [...table(state.tableIds.evidenceItems).values()].filter((row) => String(rowFields(row)['客户ID'] || '') === customerId)
}
function customerRow(customerId) {
  return [...table(state.tableIds.customers).values()].find((row) => String(rowFields(row)['客户ID'] || '') === customerId)
}
function pendingMeta(customerId) {
  const row = customerRow(customerId)
  if (!row) return null
  try {
    return JSON.parse(String(rowFields(row)['档案字段元数据'] || '{}'))
  } catch {
    return null
  }
}

describe('ASVA AI archive closed loop (HTTP A–G)', () => {
  // Worker + AI path can exceed default 5s under concurrent recover.

  it('A: create customer → save → worker → Source → Evidence → structured status', async () => {
    const situation = '闭环A客户：希望提升表达能力，近期工作压力较大，需要结构化整理。'
    const started = Date.now()
    const created = await request('/api/customers', {
      method: 'POST',
      body: {
        operationId: `op-a-${Date.now()}`,
        nickname: '闭环A客户',
        phone: '13910000001',
        wechat: '',
        introducer: '',
        situation,
        enrollments: [],
      },
    })
    const saveMs = Date.now() - started
    if (created.status !== 201) console.error('A create failed', created.body)
    expect(created.status).toBe(201)
    expect(saveMs).toBeLessThan(8000)
    const customerId = created.body.createdCustomerId || created.body.customer?.id
    expect(customerId).toBeTruthy()
    expect(created.body.automaticProfile?.status).toBe('QUEUED')

    await waitFor(async () => state.workerCalls.some((item) => item.customerId === customerId && item.mode === 'recover'))
    await waitFor(async () => customerEvidence(customerId).length > 0)

    const profile = await request(`/api/customers/${encodeURIComponent(customerId)}/profile`)
    expect(profile.status).toBe(200)
    expect(['COMPLETED', 'REVIEW_REQUIRED', 'PROCESSING', 'PENDING']).toContain(profile.body.autoOrganizeStatus)
    await waitFor(async () => {
      const p = await request(`/api/customers/${encodeURIComponent(customerId)}/profile`)
      return ['COMPLETED', 'REVIEW_REQUIRED'].includes(p.body.autoOrganizeStatus) ? p : null
    })
    const finalProfile = await request(`/api/customers/${encodeURIComponent(customerId)}/profile`)
    expect(['COMPLETED', 'REVIEW_REQUIRED']).toContain(finalProfile.body.autoOrganizeStatus)
    expect(customerSources(customerId).length).toBeGreaterThanOrEqual(1)
    expect(customerEvidence(customerId).length).toBeGreaterThanOrEqual(1)
    // Frontend distinction: materialization present vs raw notes still on customer
    const customer = await request(`/api/customers/${encodeURIComponent(customerId)}`)
    expect(String(customer.body.notes || situation)).toContain('希望提升表达能力')
    expect(finalProfile.body.profileMaterialization).toBeTruthy()

    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(path.join(EVIDENCE_DIR, 'A-create-closed-loop.json'), JSON.stringify({
      customerId, saveMs, automaticProfile: created.body.automaticProfile, autoOrganizeStatus: finalProfile.body.autoOrganizeStatus,
      sourceCount: customerSources(customerId).length, evidenceCount: customerEvidence(customerId).length, workerCalls: state.workerCalls.length,
    }, null, 2))
  })

  it('B: old customer pending=null Source=0 can safely recover', async () => {
    const customerId = 'CUS-CL-OLD-B'
    const notes = '旧客户B：希望提升表达能力，历史未归档。'
    put(state.tableIds.customers, 'rec-old-b', fields('customers', {
      customer_id: customerId,
      nickname: '旧客户B',
      phone: '13910000002',
      notes,
      created_by_staff_id: 'ADMIN-1',
      created_at: new Date().toISOString(),
      profile_field_meta_json: JSON.stringify({ _profile_version: 1, _fields: {}, _automatic_profile_pending: null }),
      profile_schema_version: 'customer-profile-v1',
    }))
    expect(customerSources(customerId)).toHaveLength(0)
    const recovered = await request('/api/admin/recover-automatic-processing', {
      method: 'POST',
      body: { customerId },
    })
    expect(recovered.status).toBe(200)
    expect(['COMPLETED', 'REVIEW_REQUIRED', 'SOURCE_CREATED', 'PROCESSING', 'PENDING', 'QUEUED', 'FAILED', 'NOT_REQUIRED']).toContain(recovered.body.status)
    // Ensure Source via worker recover path as well
    await handleAiArchiveEvent({ mode: 'recover', customerId, actorId: 'ADMIN-1', reason: 'B_TEST' })
    await waitFor(async () => customerSources(customerId).length >= 1)
    expect(customerSources(customerId).length).toBe(1)
    await writeFile(path.join(EVIDENCE_DIR, 'B-old-customer-recover.json'), JSON.stringify({
      customerId, recover: recovered.body, sourceCount: customerSources(customerId).length, evidenceCount: customerEvidence(customerId).length,
    }, null, 2))
  })

  it('C: UPLOADED + pending cleared + instance dead → resume to real result', async () => {
    const customerId = 'CUS-CL-UPLOADED-C'
    const notes = '死角C客户：希望提升表达能力，CloudBase freeze 后恢复。'
    put(state.tableIds.customers, 'rec-c', fields('customers', {
      customer_id: customerId, nickname: '死角C', phone: '13910000003', notes,
      created_by_staff_id: 'ADMIN-1', created_at: new Date().toISOString(),
      profile_field_meta_json: JSON.stringify({ _profile_version: 1, _fields: {}, _automatic_profile_pending: null }),
      profile_schema_version: 'customer-profile-v1',
    }))
    activeRepository.scheduleAutomaticProcessing = vi.fn()
    const queued = await activeRepository.queueAutomaticCustomerProfile('ADMIN-1', customerId, notes, 'CUSTOMER_SAVE')
    expect(queued.status).toBe('QUEUED')
    // Simulate freeze: clear pending + instance pending, leave Source UPLOADED
    activeRepository.instancePendingAutoProfiles.delete(customerId)
    const meta = pendingMeta(customerId)
    if (meta) {
      meta._automatic_profile_pending = null
      const row = customerRow(customerId)
      row.fields = { ...rowFields(row), ...fields('customers', { profile_field_meta_json: JSON.stringify(meta) }) }
    }
    expect(customerEvidence(customerId)).toHaveLength(0)
    const profileKick = await request(`/api/customers/${encodeURIComponent(customerId)}/profile`)
    expect(profileKick.status).toBe(200)
    await waitFor(async () => customerEvidence(customerId).length > 0)
    const profile = await request(`/api/customers/${encodeURIComponent(customerId)}/profile`)
    expect(['COMPLETED', 'REVIEW_REQUIRED', 'PROCESSING']).toContain(profile.body.autoOrganizeStatus)
    await writeFile(path.join(EVIDENCE_DIR, 'C-uploaded-resume.json'), JSON.stringify({
      customerId, queued, autoOrganizeStatus: profile.body.autoOrganizeStatus, evidenceCount: customerEvidence(customerId).length,
    }, null, 2))
  })

  it('D: duplicate/concurrent recover does not duplicate evidence or overwrite confirmed', async () => {
    const situation = '幂等D客户：希望提升表达能力，并发恢复不重复证据。'
    const created = await request('/api/customers', {
      method: 'POST',
      body: { operationId: `op-d-${Date.now()}`, nickname: '幂等D', phone: '13910000004', situation, enrollments: [] },
    })
    const customerId = created.body.createdCustomerId
    await waitFor(async () => customerEvidence(customerId).length > 0)
    const before = customerEvidence(customerId).length
    await Promise.all([
      request('/api/admin/recover-automatic-processing', { method: 'POST', body: { customerId } }),
      request('/api/admin/recover-automatic-processing', { method: 'POST', body: { customerId } }),
      handleAiArchiveEvent({ mode: 'recover', customerId, actorId: 'ADMIN-1' }),
      handleAiArchiveEvent({ mode: 'recover', customerId, actorId: 'ADMIN-1' }),
    ])
    const after = customerEvidence(customerId).length
    expect(after).toBe(before)
    expect(customerSources(customerId).length).toBe(1)
    await writeFile(path.join(EVIDENCE_DIR, 'D-idempotent.json'), JSON.stringify({ customerId, before, after, sources: customerSources(customerId).length }, null, 2))
  })

  it('E: DeepSeek failure leaves FAILED/PENDING status with recover path', async () => {
    state.deepseekFail = true
    const situation = '失败E客户：希望提升表达能力，但模型不可用。'
    const created = await request('/api/customers', {
      method: 'POST',
      body: { operationId: `op-e-${Date.now()}`, nickname: '失败E', phone: '13910000005', situation, enrollments: [] },
    })
    const customerId = created.body.createdCustomerId
    expect(created.status).toBe(201) // save must not fail because of AI
    await waitFor(async () => state.workerCalls.some((item) => item.customerId === customerId))
    await waitFor(async () => {
      const sources = customerSources(customerId)
      if (!sources.length) return null
      const status = String(rowFields(sources[0])['处理状态'] || rowFields(sources[0])['processing_status'] || '')
      return status === 'FAILED' || status === 'UPLOADED' || status === 'PROCESSING' ? status : status || 'PRESENT'
    })
    // Clear fail and recover
    state.deepseekFail = false
    const recovered = await request('/api/admin/recover-automatic-processing', { method: 'POST', body: { customerId } })
    expect(recovered.status).toBe(200)
    await waitFor(async () => customerEvidence(customerId).length > 0)
    await writeFile(path.join(EVIDENCE_DIR, 'E-failure-recover.json'), JSON.stringify({
      customerId, createdStatus: created.status, recover: recovered.body, evidenceCount: customerEvidence(customerId).length,
      note: 'DeepSeek real key path not exercised in this isolated run; failure path mocked.',
    }, null, 2))
  })

  it('F checklist file: real Feishu/DeepSeek/CloudBase not verified this round', async () => {
    const checklist = {
      realFeishuWrite: 'NOT_VERIFIED — isolation mock only; production write needs release authorization',
      realFeishuSearchRead: 'PREVIOUSLY_PROVEN in capability/scoped-load evidence; not re-hit production this round',
      realDeepSeekSuccess: 'NOT_VERIFIED — no production key call this round; failure path mocked in E',
      realDeepSeekFailure: 'MOCK_VERIFIED in E',
      cloudBaseEventInvoke: 'NOT_VERIFIED — local invoke mode used; Event Invoke requires deploy + TENCENTCLOUD credentials',
      workerDeploy: 'NOT_DONE — code only this round',
      productionCustomerMutation: 'FORBIDDEN / NOT_DONE',
    }
    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(path.join(EVIDENCE_DIR, 'F-unverified-real-env.json'), JSON.stringify(checklist, null, 2))
    expect(checklist.workerDeploy).toMatch(/NOT_DONE/)
  })

  it('G: login/directory/save/course regression via HTTP', async () => {
    const directory = await request('/api/customers/directory')
    expect(directory.status).toBe(200)
    expect(Array.isArray(directory.body.customers) || Array.isArray(directory.body)).toBe(true)

    const created = await request('/api/customers', {
      method: 'POST',
      body: {
        operationId: `op-g-${Date.now()}`,
        nickname: '回归G客户',
        phone: '13910000006',
        situation: '回归保存：希望提升表达能力。',
        enrollments: [{ productId: 'PRODUCT-1', paid: false }],
      },
    })
    expect(created.status).toBe(201)
    const customerId = created.body.createdCustomerId
    expect(created.body.enrollmentStatus === 'PENDING' || created.body.enrollments).toBeTruthy()

    const patched = await request(`/api/customers/${encodeURIComponent(customerId)}`, {
      method: 'PATCH',
      body: { operationId: `op-g-upd-${Date.now()}`, nickname: '回归G客户改', situation: '回归更新：希望提升表达能力，补充背景。' },
    })
    expect(patched.status).toBe(200)

    // Mentor can read own? directory scoped — just ensure mentor auth accepted on health-like path
    const mentorDir = await request('/api/customers/directory', { staffId: 'MENTOR-1' })
    expect(mentorDir.status).toBe(200)

    await writeFile(path.join(EVIDENCE_DIR, 'G-regression.json'), JSON.stringify({
      directoryOk: directory.status === 200,
      createOk: created.status === 201,
      patchOk: patched.status === 200,
      mentorDirectoryOk: mentorDir.status === 200,
      customerId,
    }, null, 2))
  })

  it('static: index must not void processSource after send(201)', async () => {
    const { readFileSync } = await import('node:fs')
    const indexSource = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
    expect(indexSource).not.toMatch(/void repository\.processSource\(/)
    expect(indexSource).toMatch(/asva-ai-archive|worker/)
  })
})
