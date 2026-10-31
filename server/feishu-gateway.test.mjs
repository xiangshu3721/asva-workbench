import { describe, expect, it } from 'vitest'
import { createFeishuGateway, createFeishuWriteClient, FEISHU_ERROR_CODES } from './feishu.mjs'

function response(payload, { status = 200, headers = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[name] || null }, json: async () => payload }
}

function gatewayWith(sequence, options = {}) {
  let index = 0
  const calls = []
  const fetchImpl = async (url, request) => {
    calls.push({ url, request })
    const next = sequence[Math.min(index++, sequence.length - 1)]
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(url, request) : next
  }
  return { gateway: createFeishuGateway({ appId: 'app', appSecret: 'secret', baseToken: 'base', fetchImpl, sleepImpl: async () => {}, random: () => 0, ...options }), calls }
}

describe('FeishuGateway', () => {
  it('caches the tenant token and shares one refresh promise', async () => {
    let tokenCalls = 0
    const fetchImpl = async (url) => {
      if (url.includes('/tenant_access_token/')) { tokenCalls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return response({ tenant_access_token: 'token-1', expire: 7200 }) }
      return response({ data: { items: [] } })
    }
    const gateway = createFeishuGateway({ appId: 'app', appSecret: 'secret', baseToken: 'base', fetchImpl })
    await Promise.all([gateway.listRecords('tbl-a'), gateway.listRecords('tbl-a'), gateway.listRecords('tbl-a')])
    expect(tokenCalls).toBe(1)
  })

  it('retries transient 429 with backoff and succeeds', async () => {
    const { gateway, calls } = gatewayWith([
      response({ tenant_access_token: 'token-1', expire: 7200 }),
      response({ code: 125429, msg: 'too many requests' }, { status: 429 }),
      response({ data: { items: [{ record_id: 'rec-1' }] } }),
    ])
    await expect(gateway.listRecords('tbl-a')).resolves.toEqual([{ record_id: 'rec-1' }])
    expect(calls).toHaveLength(3)
    expect(gateway.metrics().rateLimitCount).toBe(1)
    expect(gateway.metrics().retryRecoveredCount).toBe(1)
  })

  it('retries a transient 503 with the same bounded policy', async () => {
    const { gateway, calls } = gatewayWith([
      response({ tenant_access_token: 'token-1', expire: 7200 }),
      response({ code: 1254607, msg: 'temporarily unavailable' }, { status: 503 }),
      response({ data: { items: [] } }),
    ])
    await expect(gateway.listRecords('tbl-a')).resolves.toEqual([])
    expect(calls).toHaveLength(3)
    expect(gateway.metrics().serverErrorCount).toBe(1)
  })

  it('does not retry schema or validation errors', async () => {
    const { gateway, calls } = gatewayWith([
      response({ tenant_access_token: 'token-1', expire: 7200 }),
      response({ code: 999, msg: 'field not found' }, { status: 400 }),
    ])
    await expect(gateway.listRecords('tbl-a')).rejects.toMatchObject({ code: FEISHU_ERROR_CODES.FIELD_ERROR, retryable: false })
    expect(calls).toHaveLength(2)
  })

  it('refreshes an expired token once and retries the original request', async () => {
    const { gateway, calls } = gatewayWith([
      response({ tenant_access_token: 'token-1', expire: 7200 }),
      response({ code: 99991663, msg: 'token expired' }, { status: 401 }),
      response({ tenant_access_token: 'token-2', expire: 7200 }),
      response({ data: { items: [] } }),
    ])
    await expect(gateway.listRecords('tbl-a')).resolves.toEqual([])
    expect(calls).toHaveLength(4)
    expect(calls[1].request.headers.Authorization).toBe('Bearer token-1')
    expect(calls[3].request.headers.Authorization).toBe('Bearer token-2')
  })

  it('maps network timeout into a retryable normalized error after bounded attempts', async () => {
    const timeout = Object.assign(new Error('deadline'), { name: 'AbortError' })
    const { gateway, calls } = gatewayWith([response({ tenant_access_token: 'token-1', expire: 7200 }), timeout])
    await expect(gateway.listRecords('tbl-a')).rejects.toMatchObject({ code: FEISHU_ERROR_CODES.TIMEOUT, retryable: true })
    expect(calls).toHaveLength(5)
    expect(gateway.metrics().timeoutCount).toBe(4)
  })

  it('prevents a duplicate create when the first response times out after commit', async () => {
    const timeout = Object.assign(new Error('deadline'), { name: 'AbortError' })
    const existing = { record_id: 'rec-created-before-timeout', fields: { 资料ID: 'SRC-1' } }
    const { gateway, calls } = gatewayWith([
      response({ tenant_access_token: 'token-1', expire: 7200 }),
      timeout,
      response({ data: { items: [existing] } }),
    ])
    await expect(gateway.createRecord('tbl-source', { 资料ID: 'SRC-1' }, { operation: 'source.create', operationId: 'SRC-1', idempotency: { field: '资料ID', value: 'SRC-1' } })).resolves.toMatchObject({ record: existing, idempotency_recovered: true })
    expect(calls).toHaveLength(3)
    expect(gateway.metrics().duplicatePreventedCount).toBe(1)
  })

  it('returns a direct Feishu failure after bounded retry instead of claiming a queued save', async () => {
    const failure = Object.assign(new Error('down'), { code: FEISHU_ERROR_CODES.TIMEOUT, retryable: true })
    const client = createFeishuWriteClient({ gateway: { createRecord: async () => { throw failure } } })
    await expect(client.createRecord('tbl-source', { 资料ID: 'SRC-2' }, { operation: 'source.create', operationId: 'SRC-2', entityType: 'sourceRecords' })).rejects.toBe(failure)
  })

  it('does not turn a retryable update failure into a false success', async () => {
    const failure = Object.assign(new Error('down'), { code: FEISHU_ERROR_CODES.SERVER_ERROR, retryable: true })
    const client = createFeishuWriteClient({ gateway: { updateRecord: async () => { throw failure } } })
    await expect(client.updateRecord('tbl-customers', 'rec-1', { 状态: '待同步' }, { operation: 'customer.update', operationId: 'CUS-1', entityType: 'customers' })).rejects.toBe(failure)
  })
})


describe('FeishuGateway records/search', () => {
  it('searchRecords posts filter body to records/search and pages results', async () => {
    const { gateway, calls } = gatewayWith([
      response({ tenant_access_token: 'token-1', expire: 7200 }),
      response({ data: { items: [{ record_id: 'rec-1' }], has_more: true, page_token: 'p2' } }),
      response({ data: { items: [{ record_id: 'rec-2' }], has_more: false } }),
    ])
    const filter = { conjunction: 'and', conditions: [{ field_name: '客户ID', operator: 'is', value: ['CUS-1'] }] }
    await expect(gateway.searchRecords('tbl-customers', filter)).resolves.toEqual([{ record_id: 'rec-1' }, { record_id: 'rec-2' }])
    expect(calls).toHaveLength(3)
    expect(String(calls[1].url)).toContain('/records/search')
    expect(JSON.parse(calls[1].request.body)).toMatchObject({ filter, page_size: 500 })
    expect(JSON.parse(calls[2].request.body)).toMatchObject({ page_token: 'p2' })
  })
})
