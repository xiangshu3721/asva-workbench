import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getRecordMock, updateRecordMock } = vi.hoisted(() => ({ getRecordMock: vi.fn(), updateRecordMock: vi.fn() }))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return { ...actual, getRecord: getRecordMock, updateRecord: updateRecordMock }
})

const { config } = await import('./config.mjs')
const { fields } = await import('./field-mapping.mjs')
const { CUSTOMER_UNDERSTANDING_TIMEOUT_MS } = await import('./deepseek.mjs')
const { CUSTOMER_UNDERSTANDING_REFRESH_BUDGET_MS, FeishuRepository } = await import('./repository.mjs')

const originalDeepseek = { ...config.deepseek }
const validUnderstanding = () => ({
  one_line_understanding: { text: '当前资料有限，先确认最近最想处理的事情。', confidence: 'LOW', type: 'SYNTHESIS', evidence_ids: [] },
  top_issues: [], current_life_phase: null, current_needs: [], core_blocks: [], resources_and_strengths: [], key_tensions: [],
  knowledge_gaps: [{ question: '最近最想优先谈的具体事情是什么？', priority: 'HIGH', evidence_ids: [] }],
  next_conversation: [], service_cautions: [], working_hypotheses: [], meta: { overall_confidence: 'LOW', evidence_count: 0 },
})

function response(content, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] } : { error: { message: 'synthetic upstream failure' } }), { status, headers: { 'content-type': 'application/json' } })
}

function createWorkspace() {
  const customer = { id: 'CUS-1', name: '合成客户', phone: '', wechat: '', profileVersion: 1, profileFields: {}, profileFieldMeta: {}, notes: '', need: '', goal: '', helpExpectation: '' }
  return {
    staff: [{ id: 'STAFF-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
    customers: [customer], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
    _rows: { customers: [{ record_id: 'rec-customer-1', fields: fields('customers', { customer_id: 'CUS-1', nickname: '合成客户' }) }] },
  }
}

function createRepository({ updateDelayMs = () => 0 } = {}) {
  const database = createWorkspace()
  let persistedRow = database._rows.customers[0]
  getRecordMock.mockImplementation(async () => persistedRow)
  updateRecordMock.mockImplementation(async (_table, recordId, nextFields) => {
    const delayMs = updateDelayMs()
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    persistedRow = { ...persistedRow, record_id: recordId, fields: { ...persistedRow.fields, ...nextFields } }
    return persistedRow
  })
  const repository = new FeishuRepository({ authRepository: {} })
  repository.load = vi.fn(async () => database)
  repository.invalidateDatabaseCache = vi.fn()
  repository._testDatabase = database
  return repository
}

beforeEach(() => {
  config.deepseek.apiKey = 'synthetic-test-key'
  config.deepseek.baseUrl = 'https://deepseek.test'
  config.deepseek.model = 'synthetic-model'
  getRecordMock.mockReset()
  updateRecordMock.mockReset()
})

afterEach(() => {
  Object.assign(config.deepseek, originalDeepseek)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('consultation understanding refresh reliability', () => {
  it('returns a fresh result after one model call and does not perform a second full read', async () => {
    const repository = createRepository()
    const fetchMock = vi.fn(async () => response(validUnderstanding()))
    vi.stubGlobal('fetch', fetchMock)

    const result = await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })

    expect(result).toMatchObject({ status: 'FRESH', meta: { source: 'DEEPSEEK' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(repository.load).toHaveBeenCalledTimes(1)
  })

  it('returns a structured fallback when DeepSeek is unavailable instead of an empty result', async () => {
    const repository = createRepository()
    vi.stubGlobal('fetch', vi.fn(async () => response({}, 503)))

    const result = await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })

    expect(result).toMatchObject({ status: 'FAILED', meta: { source: 'STRUCTURED_FALLBACK', errorCode: 'DEEPSEEK_UNAVAILABLE' } })
    expect(result.understanding.one_line_understanding.text).toBeTruthy()
  })

  it('uses the same fallback after a quality failure without a second DeepSeek generation', async () => {
    const repository = createRepository()
    const fetchMock = vi.fn(async () => response({}))
    vi.stubGlobal('fetch', fetchMock)

    const result = await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })

    expect(result).toMatchObject({ status: 'FAILED', meta: { errorCode: 'UNDERSTANDING_QUALITY_FAILED', source: 'STRUCTURED_FALLBACK' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('times out the model inside the CloudBase budget and still returns a fallback', async () => {
    vi.useFakeTimers()
    const repository = createRepository()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))))

    const pending = repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })
    await vi.advanceTimersByTimeAsync(CUSTOMER_UNDERSTANDING_TIMEOUT_MS)
    const result = await pending

    expect(result).toMatchObject({ status: 'FAILED', meta: { errorCode: 'DEEPSEEK_TIMEOUT', source: 'STRUCTURED_FALLBACK' } })
  })

  it('ends a slow Feishu read inside the server budget without starting a model call', async () => {
    vi.useFakeTimers()
    const repository = createRepository()
    repository.load = vi.fn(() => new Promise(() => {}))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const pending = expect(repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })).rejects.toMatchObject({ code: 'UNDERSTANDING_SOURCE_READ_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(CUSTOMER_UNDERSTANDING_REFRESH_BUDGET_MS)
    await pending
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reserves final-write time when a Feishu write completes near the budget boundary', async () => {
    vi.useFakeTimers()
    let writeCount = 0
    const repository = createRepository({ updateDelayMs: () => (++writeCount === 1 ? 14_000 : 7_000) })
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(response(validUnderstanding())), 21_000))))

    const pending = repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })
    await vi.advanceTimersByTimeAsync(42_000)

    await expect(pending).resolves.toMatchObject({ status: 'FRESH', meta: { status: 'FRESH' } })
    expect(updateRecordMock).toHaveBeenCalledTimes(2)
  })

  it('does not issue a competing terminal write when the processing write times out with an unknown result', async () => {
    vi.useFakeTimers()
    const repository = createRepository({ updateDelayMs: () => CUSTOMER_UNDERSTANDING_REFRESH_BUDGET_MS })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const pending = expect(repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })).rejects.toMatchObject({ code: 'UNDERSTANDING_STATUS_WRITE_UNKNOWN' })
    await vi.advanceTimersByTimeAsync(CUSTOMER_UNDERSTANDING_REFRESH_BUDGET_MS)
    await pending

    expect(fetchMock).not.toHaveBeenCalled()
    expect(updateRecordMock).toHaveBeenCalledTimes(1)
  })

  it('does not let an expired processing lease block a later refresh', async () => {
    const repository = createRepository()
    repository._testDatabase.customers[0].understandingMeta = { status: 'PROCESSING', updatedAt: new Date().toISOString(), processingExpiresAt: new Date(Date.now() - 1).toISOString() }
    const fetchMock = vi.fn(async () => response(validUnderstanding()))
    vi.stubGlobal('fetch', fetchMock)

    await expect(repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })).resolves.toMatchObject({ status: 'FRESH' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces a repeated refresh into a scoped read instead of starting a second AI call', async () => {
    const repository = createRepository()
    let resolveModel
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveModel = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const first = repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const second = repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })
    resolveModel(response(validUnderstanding()))

    await expect(first).resolves.toMatchObject({ status: 'FRESH' })
    await expect(second).resolves.toHaveProperty('customerId', 'CUS-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
