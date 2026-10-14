import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpApi } from './clientApi'

afterEach(() => vi.restoreAllMocks())

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
})
