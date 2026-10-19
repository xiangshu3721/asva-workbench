import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_DEFAULT_TIMEOUT_MS, CLIENT_SOURCE_SAVE_TIMEOUT_MS, createHttpApi } from './clientApi'

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
})
