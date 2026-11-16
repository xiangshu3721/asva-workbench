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
const { CUSTOMER_UNDERSTANDING_PROMPT_VERSION, understandingInputFingerprint } = await import('../shared/customer-understanding.mjs')

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


function stageLogs(spy) {
  return spy.mock.calls
    .filter(([prefix]) => prefix === '[ASVA_UNDERSTANDING_STAGE_MS]')
    .map(([, payload]) => JSON.parse(payload))
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
  it('returns fresh scoped consultation topics without a DeepSeek call on ordinary read', async () => {
    const repository = createRepository()
    repository._testDatabase.customers[0].need = '更多咨询情感问题'
    const second = { ...repository._testDatabase.customers[0], id: 'CUS-2', need: '', notes: '', profileFields: {} }
    repository._testDatabase.customers.push(second)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const first = await repository.getCustomerUnderstanding('STAFF-1', 'CUS-1')
    const another = await repository.getCustomerUnderstanding('STAFF-1', 'CUS-2')

    expect(first.consultation_topics).toMatchObject({
      customer_id: 'CUS-1', status: 'HAS_SIGNALS',
      topics: [expect.objectContaining({ kind: 'PROVISIONAL_DIRECTION', title: '亲密关系方面的咨询方向' })],
    })
    expect(another.consultation_topics).toMatchObject({ customer_id: 'CUS-2', status: 'INSUFFICIENT_INFORMATION', topics: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not mistake an old stored AI issue for the current consultation signal', async () => {
    const repository = createRepository()
    const customer = repository._testDatabase.customers[0]
    customer.need = '更多咨询情感问题'
    customer.understanding = { ...validUnderstanding(), top_issues: [{ text: '旧工作压力', title: '旧工作压力', evidence_ids: [], confidence: 'HIGH', type: 'SYNTHESIS' }] }
    customer.understandingMeta = { status: 'STALE', inputFingerprint: 'old-fingerprint', promptVersion: CUSTOMER_UNDERSTANDING_PROMPT_VERSION }
    vi.stubGlobal('fetch', vi.fn())

    const response = await repository.getCustomerUnderstanding('STAFF-1', 'CUS-1')
    expect(response.understanding.top_issues[0].title).toBe('旧工作压力')
    expect(response.consultation_topics.topics[0]).toMatchObject({ title: '亲密关系方面的咨询方向', kind: 'PROVISIONAL_DIRECTION' })
    expect(response.status).toBe('STALE')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns a fresh result after one model call and does not perform a second full read', async () => {
    const repository = createRepository()
    const fetchMock = vi.fn(async () => response(validUnderstanding()))
    vi.stubGlobal('fetch', fetchMock)

    const result = await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })

    expect(result).toMatchObject({ status: 'FRESH', meta: { source: 'DEEPSEEK' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(repository.load).toHaveBeenCalledTimes(1)
  })

  it('applies Stage 6A confidence boundary before persisting a successful AI result', async () => {
    const repository = createRepository()
    const ungrounded = validUnderstanding()
    ungrounded.one_line_understanding = { text: '客户一定缺乏自我价值', confidence: 'HIGH', type: 'FACT_BASED', evidence_ids: [] }
    ungrounded.current_needs = [{ need: '客户需要立即辞职', confidence: 'HIGH', type: 'FACT_BASED', evidence_ids: [] }]
    ungrounded.working_hypotheses = [{ text: '客户可能害怕改变', confidence: 'HIGH', type: 'WORKING_HYPOTHESIS', evidence_ids: [] }]
    ungrounded.meta.overall_confidence = 'HIGH'
    const fetchMock = vi.fn(async () => response(ungrounded))
    vi.stubGlobal('fetch', fetchMock)

    const result = await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })

    expect(result.status).toBe('FRESH')
    expect(result.understanding.one_line_understanding).toMatchObject({ confidence: 'LOW', type: 'SYNTHESIS', text: '客户一定缺乏自我价值' })
    expect(result.understanding.current_needs[0]).toMatchObject({ confidence: 'LOW', type: 'SYNTHESIS' })
    expect(result.understanding.working_hypotheses[0]).toMatchObject({ confidence: 'LOW', type: 'WORKING_HYPOTHESIS' })
    expect(result.understanding.meta.overall_confidence).toBe('LOW')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updateRecordMock).toHaveBeenCalledTimes(2)
  })

  it('does not let a confirmed AI inference persist as a current core issue', async () => {
    const repository = createRepository()
    repository._testDatabase.evidenceItems.push({
      id: 'EVD-AI', customerId: 'CUS-1', sourceId: 'SRC-AI', evidenceType: 'AI_INFERENCE', semanticKind: 'NEED',
      fieldKey: 'current_core_issue', displayText: 'AI 推断客户存在职业困扰', sourceExcerpt: 'AI 推断', reviewStatus: 'CONFIRMED', confidence: 1,
    })
    const generated = validUnderstanding()
    generated.top_issues = [{ title: '职业困扰', why_it_matters: 'AI 推断', confidence: 'HIGH', type: 'FACT_BASED', evidence_ids: ['E1'] }]
    generated.meta.overall_confidence = 'HIGH'
    const fetchMock = vi.fn(async () => response(generated))
    vi.stubGlobal('fetch', fetchMock)

    const result = await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })

    expect(result.status).toBe('FRESH')
    expect(result.understanding.top_issues).toEqual([])
    expect(result.understanding.meta.overall_confidence).toBe('LOW')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updateRecordMock).toHaveBeenCalledTimes(2)
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
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const repository = createRepository()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))))

    const pending = repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })
    await vi.advanceTimersByTimeAsync(CUSTOMER_UNDERSTANDING_TIMEOUT_MS)
    const result = await pending

    expect(result).toMatchObject({ status: 'FAILED', meta: { errorCode: 'DEEPSEEK_TIMEOUT', source: 'STRUCTURED_FALLBACK' } })
    expect(stageLogs(log)).toEqual([
      expect.objectContaining({
        result: 'STRUCTURED_FALLBACK',
        deepseek_ms: CUSTOMER_UNDERSTANDING_TIMEOUT_MS,
        terminal_write_ms: expect.any(Number),
      }),
    ])
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
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const repository = createRepository({ updateDelayMs: () => CUSTOMER_UNDERSTANDING_REFRESH_BUDGET_MS })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const pending = expect(repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })).rejects.toMatchObject({ code: 'UNDERSTANDING_STATUS_WRITE_UNKNOWN' })
    await vi.advanceTimersByTimeAsync(CUSTOMER_UNDERSTANDING_REFRESH_BUDGET_MS)
    await pending

    expect(fetchMock).not.toHaveBeenCalled()
    expect(updateRecordMock).toHaveBeenCalledTimes(1)
    expect(stageLogs(log)).toEqual([
      expect.objectContaining({
        result: 'STATUS_WRITE_UNKNOWN',
        queue_wait_ms: expect.any(Number),
        feishu_read_ms: expect.any(Number),
        processing_write_ms: expect.any(Number),
        deepseek_ms: null,
        terminal_write_ms: null,
      }),
    ])
  })

  it('does not let an expired processing lease block a later refresh', async () => {
    const repository = createRepository()
    repository._testDatabase.customers[0].understandingMeta = { status: 'PROCESSING', updatedAt: new Date().toISOString(), processingExpiresAt: new Date(Date.now() - 1).toISOString() }
    const fetchMock = vi.fn(async () => response(validUnderstanding()))
    vi.stubGlobal('fetch', fetchMock)

    await expect(repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })).resolves.toMatchObject({ status: 'FRESH' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('marks cache and active-processing early returns without inventing later stage timings', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    for (const [status, expectedResult] of [['FRESH', 'REUSED_FRESH'], ['PROCESSING', 'REUSED_PROCESSING']]) {
      const repository = createRepository()
      const customer = repository._testDatabase.customers[0]
      customer.understanding = validUnderstanding()
      customer.understandingMeta = {
        status,
        inputFingerprint: understandingInputFingerprint({ customer, evidenceItems: [], conflicts: [] }),
        promptVersion: CUSTOMER_UNDERSTANDING_PROMPT_VERSION,
        ...(status === 'PROCESSING' ? { processingExpiresAt: new Date(Date.now() + 60_000).toISOString() } : {}),
      }
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const before = stageLogs(log).length

      await expect(repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1')).resolves.toMatchObject({ status })
      expect(stageLogs(log).slice(before)).toEqual([
        expect.objectContaining({
          result: expectedResult,
          feishu_read_ms: expect.any(Number),
          processing_write_ms: null,
          deepseek_ms: null,
          terminal_write_ms: null,
        }),
      ])
      expect(fetchMock).not.toHaveBeenCalled()
      expect(updateRecordMock).not.toHaveBeenCalled()
    }
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

  it('keeps two legacy caches fresh without AI calls when snapshot-only records change, while a changed managed field is stale', async () => {
    const repository = createRepository()
    const legacyCustomers = [
      { id: 'CUS-LEGACY-A', name: '旧客户A', phone: '', wechat: '', profileVersion: 4, profileFields: {}, profileFieldMeta: {}, notes: '职业转型', need: '理清工作方向', goal: '', helpExpectation: '' },
      { id: 'CUS-LEGACY-B', name: '旧客户B', phone: '', wechat: '', profileVersion: 2, profileFields: {}, profileFieldMeta: {}, notes: '家庭沟通', need: '改善家庭沟通', goal: '', helpExpectation: '' },
    ]
    const newCustomer = { id: 'CUS-NEW-C', name: '新客户C', phone: '', wechat: '', profileVersion: 0, profileFields: {}, profileFieldMeta: {}, notes: '新客户资料', need: '', goal: '', helpExpectation: '' }
    for (const customer of legacyCustomers) {
      customer.understanding = validUnderstanding()
      customer.understandingMeta = { status: 'FRESH', inputFingerprint: understandingInputFingerprint({ customer, evidenceItems: [], conflicts: [] }), promptVersion: CUSTOMER_UNDERSTANDING_PROMPT_VERSION, provider: 'DEEPSEEK' }
    }
    repository._testDatabase.customers = [...legacyCustomers, newCustomer]
    repository._testDatabase.sessions = [{ id: 'SRV-A', customerId: 'CUS-LEGACY-A', date: '2026-11-01', note: '新增服务记录' }]
    repository._testDatabase.sourceRecords = [{ id: 'SRC-A', customerId: 'CUS-LEGACY-A', title: '新增资料', sourceType: 'NOTE', processingStatus: 'COMPLETED' }]
    repository._testDatabase._rows.customers = repository._testDatabase.customers.map((customer) => ({ record_id: `rec-${customer.id}`, fields: fields('customers', { customer_id: customer.id, nickname: customer.name }) }))
    const fetchMock = vi.fn(async () => response(validUnderstanding()))
    vi.stubGlobal('fetch', fetchMock)

    await expect(repository.getCustomerUnderstanding('STAFF-1', 'CUS-LEGACY-A')).resolves.toMatchObject({ status: 'FRESH' })
    await expect(repository.getCustomerUnderstanding('STAFF-1', 'CUS-LEGACY-B')).resolves.toMatchObject({ status: 'FRESH' })
    await expect(repository.getCustomerUnderstanding('STAFF-1', 'CUS-NEW-C')).resolves.toMatchObject({ status: 'STALE' })
    await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-LEGACY-A')
    await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-LEGACY-A')
    expect(fetchMock).not.toHaveBeenCalled()

    repository._testDatabase.customers[0] = { ...repository._testDatabase.customers[0], need: '已明确的新需求' }
    await expect(repository.getCustomerUnderstanding('STAFF-1', 'CUS-LEGACY-A')).resolves.toMatchObject({ status: 'STALE' })
  })
  it('logs only anonymous scalar timings for successful refresh without extra API work', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const repository = createRepository()
    const fetchMock = vi.fn(async () => response(validUnderstanding()))
    vi.stubGlobal('fetch', fetchMock)

    const result = await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })
    expect(result.status).toBe('FRESH')

    const metrics = stageLogs(log)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({
      result: 'FRESH',
      queue_wait_ms: expect.any(Number),
      feishu_read_ms: expect.any(Number),
      processing_write_ms: expect.any(Number),
      deepseek_ms: expect.any(Number),
      terminal_write_ms: expect.any(Number),
      execution_ms: expect.any(Number),
    })
    expect(Object.keys(metrics[0]).sort()).toEqual([
      'deepseek_ms', 'execution_ms', 'feishu_read_ms', 'processing_write_ms',
      'queue_wait_ms', 'result', 'terminal_write_ms',
    ].sort())
    expect(JSON.stringify(metrics)).not.toMatch(/CUS-1|STAFF-1|合成客户|rec-customer|synthetic-test-key/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updateRecordMock).toHaveBeenCalledTimes(2)
    expect(getRecordMock).toHaveBeenCalledTimes(4)
  })

  it('records model duration on a fallback without pretending the AI succeeded', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const repository = createRepository()
    vi.stubGlobal('fetch', vi.fn(async () => response({}, 503)))

    const result = await repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })
    expect(result.status).toBe('FAILED')
    expect(stageLogs(log)).toEqual([
      expect.objectContaining({
        result: 'STRUCTURED_FALLBACK',
        feishu_read_ms: expect.any(Number),
        processing_write_ms: expect.any(Number),
        deepseek_ms: expect.any(Number),
        terminal_write_ms: expect.any(Number),
      }),
    ])
  })

  it('emits a partial stage record when the initial read fails before any writes or AI calls', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const repository = createRepository()
    repository.load = vi.fn(async () => { throw Object.assign(new Error('synthetic read failed'), { code: 'SYNTHETIC_READ_FAILED' }) })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(repository.refreshCustomerUnderstanding('STAFF-1', 'CUS-1', { force: true })).rejects.toMatchObject({ code: 'SYNTHETIC_READ_FAILED' })
    const metrics = stageLogs(log)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({
      result: 'INCOMPLETE',
      queue_wait_ms: expect.any(Number),
      feishu_read_ms: expect.any(Number),
      processing_write_ms: null,
      deepseek_ms: null,
      terminal_write_ms: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(updateRecordMock).not.toHaveBeenCalled()
  })

})
