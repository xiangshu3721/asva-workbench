import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_DEFAULT_TIMEOUT_MS, CLIENT_SOURCE_SAVE_TIMEOUT_MS, classifyFetchFailure, createHttpApi } from './clientApi'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('HTTP environment diagnostics', () => {
  it('classifies HTTP auth failures while preserving the server error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'AUTH_INVALID', message: '登录信息验证失败' }), { status: 401, headers: { 'Content-Type': 'application/json' } })))
    await expect(createHttpApi('http://127.0.0.1:8788').login('15000000000', 'bad')).rejects.toMatchObject({ code: 'HTTP_401', serverCode: 'AUTH_INVALID', httpStatus: 401 })
  })

  it('reports an invalid successful response explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })))
    await expect(createHttpApi('http://127.0.0.1:8788').health()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('does not turn an empty API base into a local fallback', async () => {
    await expect(createHttpApi('').health()).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' })
  })

  it('does not misdiagnose a generic fetch failure as CORS', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(createHttpApi('https://api.example.com').health()).rejects.toMatchObject({ code: 'NETWORK_UNREACHABLE', message: '请求未完成，请检查网络或稍后重试。' })
    expect(classifyFetchFailure(new TypeError('Load failed')).code).toBe('NETWORK_UNREACHABLE')
  })

  it('reports CORS only when the browser error contains explicit CORS evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Blocked by CORS policy: preflight request failed') }))
    await expect(createHttpApi('https://api.example.com').health()).rejects.toMatchObject({ code: 'CORS_PREFLIGHT_FAILED' })
    expect(classifyFetchFailure(new TypeError('preflight response is invalid')).code).toBe('CORS_PREFLIGHT_FAILED')
  })

  it('AI_RETRY_DOES_NOT_RESAVE_SOURCE', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ source: { id: 'SRC-1', processingStatus: 'COMPLETED' }, evidenceItems: [], proposals: [], conflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await createHttpApi('http://127.0.0.1:8788').processSource('STAFF-1', 'SRC-1', true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(firstCall[0]).toContain('/api/sources/SRC-1/process')
    expect(JSON.parse(String(firstCall[1].body))).toEqual({ force: true })
  })

  it('AI_RETRY_SUCCESS', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ source: { id: 'SRC-1', processingStatus: 'COMPLETED' }, evidenceItems: [], proposals: [], conflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createHttpApi('http://127.0.0.1:8788')
    await api.processSource('STAFF-1', 'SRC-1', true)
    await api.processSource('STAFF-1', 'SRC-1', true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every((call) => (call as unknown as [string, RequestInit])[0].includes('/api/sources/SRC-1/process'))).toBe(true)
  })

  it('MULTIPLE_AI_RETRY_NO_DUPLICATE_SOURCE', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ source: { id: 'SRC-1', processingStatus: 'COMPLETED' }, evidenceItems: [], proposals: [], conflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createHttpApi('http://127.0.0.1:8788')
    await Promise.all([api.processSource('STAFF-1', 'SRC-1', true), api.processSource('STAFF-1', 'SRC-1', true), api.processSource('STAFF-1', 'SRC-1', true)])
    expect(fetchMock.mock.calls.filter((call) => (call as unknown as [string, RequestInit])[0].endsWith('/api/sources')).length).toBe(0)
  })

  it('CLIENT_TIMEOUT_BOUNDED uses the longer source-save budget and reports UNKNOWN-compatible timeout', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = expect(createHttpApi('http://127.0.0.1:8788').createSource('STAFF-1', { customerId: 'CUS-1', sourceType: 'TEXT_INPUT', rawText: 'slow', operationId: 'stable-operation-1' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(CLIENT_SOURCE_SAVE_TIMEOUT_MS)
    await pending
    expect(CLIENT_SOURCE_SAVE_TIMEOUT_MS).toBeGreaterThan(CLIENT_DEFAULT_TIMEOUT_MS)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) })
  })

  it('CLIENT_TIMEOUT_BOUNDED also covers a response body that never finishes', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
      resolve({ ok: true, status: 200, headers: new Headers(), json: () => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) } as Response)
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = expect(createHttpApi('http://127.0.0.1:8788').health()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(CLIENT_DEFAULT_TIMEOUT_MS)
    await pending
  })

  it('recovers a customer save through the original operation id after the write response is lost', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'FEISHU_UNAVAILABLE', message: '响应丢失' }), { status: 502, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'stable-customer-save-1', customerId: 'CUS-1', status: 'COMMITTED', customer: { id: 'CUS-1', name: 'Synthetic Customer' }, enrollments: [], profileChanges: [], createdCustomerId: 'CUS-1', customerCreated: true, persistenceStatus: 'COMMITTED' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpApi('http://127.0.0.1:8788').createCustomer('STAFF-1', { operationId: 'stable-customer-save-1', nickname: 'Synthetic Customer', phone: '13800000001', wechat: '', introducer: '', situation: '', needsFollowup: false, mentorId: null, source: 'Synthetic', caseSource: 'SYNTHETIC', enrollments: [] })

    expect(result).toMatchObject({ createdCustomerId: 'CUS-1', customer: { id: 'CUS-1' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/customer-save-status?operationId=stable-customer-save-1')
  })

  it('does not treat PERSISTED as a final successful save', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'persisted-then-committed', customerId: 'CUS-1', status: 'PERSISTED', customer: { id: 'CUS-1', name: 'Synthetic Customer' }, enrollments: [], profileChanges: [], createdCustomerId: 'CUS-1', customerCreated: true, persistenceStatus: 'PERSISTED', mutation: { operationId: 'persisted-then-committed', customerId: 'CUS-1', kind: 'CREATE', status: 'PERSISTED' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'persisted-then-committed', customerId: 'CUS-1', status: 'COMMITTED', customer: { id: 'CUS-1', name: 'Synthetic Customer' }, enrollments: [], profileChanges: [], createdCustomerId: 'CUS-1', customerCreated: true, persistenceStatus: 'COMMITTED', mutation: { operationId: 'persisted-then-committed', customerId: 'CUS-1', kind: 'CREATE', status: 'COMMITTED' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = createHttpApi('http://127.0.0.1:8788').createCustomer('STAFF-1', { operationId: 'persisted-then-committed', nickname: 'Synthetic Customer', phone: '13800000003', wechat: '', introducer: '', situation: '', needsFollowup: false, mentorId: null, source: 'Synthetic', caseSource: 'SYNTHETIC', enrollments: [] })
    await vi.advanceTimersByTimeAsync(500)
    await expect(pending).resolves.toMatchObject({ persistenceStatus: 'COMMITTED', mutation: { status: 'COMMITTED' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/customers/CUS-1/save-status?operationId=persisted-then-committed')
  })

  it('does not convert a PERSISTED write followed by a confirmed failure into COMMITTED', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'persisted-then-failed', customerId: 'CUS-2', status: 'PERSISTED', customer: null, persistenceStatus: 'PERSISTED', mutation: { operationId: 'persisted-then-failed', customerId: 'CUS-2', kind: 'UPDATE', status: 'PERSISTED' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ operationId: 'persisted-then-failed', customerId: 'CUS-2', status: 'FAILED', customer: null, mutation: { operationId: 'persisted-then-failed', customerId: 'CUS-2', kind: 'UPDATE', status: 'FAILED' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createHttpApi('http://127.0.0.1:8788').updateCustomer('STAFF-1', 'CUS-2', { operationId: 'persisted-then-failed', nickname: 'Synthetic Customer', phone: '13800000004', wechat: '', situation: '', needsFollowup: false, mentorId: null, source: 'Synthetic', caseSource: 'SYNTHETIC', enrollments: [] })).rejects.toMatchObject({ code: 'CUSTOMER_SAVE_CONFIRMED_FAILED' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses the original operation id for explicit profile history repair', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ operationId: 'history-repair-1', customerId: 'CUS-2', status: 'COMMITTED', historyStatus: 'COMPLETE', repaired: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await createHttpApi('http://127.0.0.1:8788').repairCustomerHistory('STAFF-1', 'history-repair-1', 'CUS-2')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/customers/CUS-2/save-status/repair-history')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ operationId: 'history-repair-1' })
  })
})
