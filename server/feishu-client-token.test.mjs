import { describe, it, expect, beforeEach, vi } from 'vitest'
import { feishuClientToken, createFeishuGateway } from './feishu.mjs'

describe('feishuClientToken', () => {
  it('generates UUID v4 format', () => {
    const token = feishuClientToken('op-123', 'tbl-abc')
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('generates stable token for same operationId and tableId', () => {
    const token1 = feishuClientToken('op-123', 'tbl-abc')
    const token2 = feishuClientToken('op-123', 'tbl-abc')
    expect(token1).toBe(token2)
  })

  it('generates different tokens for different operationIds', () => {
    const token1 = feishuClientToken('op-123', 'tbl-abc')
    const token2 = feishuClientToken('op-456', 'tbl-abc')
    expect(token1).not.toBe(token2)
  })

  it('generates different tokens for different tableIds', () => {
    const token1 = feishuClientToken('op-123', 'tbl-abc')
    const token2 = feishuClientToken('op-123', 'tbl-def')
    expect(token1).not.toBe(token2)
  })

  it('returns null when operationId is missing', () => {
    expect(feishuClientToken('', 'tbl-abc')).toBeNull()
    expect(feishuClientToken(null, 'tbl-abc')).toBeNull()
    expect(feishuClientToken(undefined, 'tbl-abc')).toBeNull()
  })

  it('returns null when tableId is missing', () => {
    expect(feishuClientToken('op-123', '')).toBeNull()
    expect(feishuClientToken('op-123', null)).toBeNull()
    expect(feishuClientToken('op-123', undefined)).toBeNull()
  })
})

describe('Feishu gateway client_token integration', () => {
  let mockFetch
  let gateway

  beforeEach(() => {
    mockFetch = vi.fn()
    gateway = createFeishuGateway({
      fetchImpl: mockFetch,
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      baseUrl: 'https://test.feishu.cn',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
  })

  it('appends client_token to createRecord requests', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tenant_access_token: 'test-token', expire: 7200 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { record: { id: 'rec-1' } } }) })

    await gateway.createRecord('tbl-abc', { field1: 'value1' }, {
      operationId: 'op-123',
      customerId: 'cus-1',
      entityType: 'customers'
    })

    const createCall = mockFetch.mock.calls[1]
    const url = createCall[0]
    expect(url).toContain('client_token=')
    const clientToken = url.match(/client_token=([^&]+)/)[1]
    expect(clientToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('uses stable client_token for same operationId', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tenant_access_token: 'test-token', expire: 7200 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { record: { id: 'rec-1' } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { record: { id: 'rec-2' } } }) })

    await gateway.createRecord('tbl-abc', { field1: 'value1' }, {
      operationId: 'op-123',
      customerId: 'cus-1'
    })

    await gateway.createRecord('tbl-abc', { field1: 'value1' }, {
      operationId: 'op-123',
      customerId: 'cus-1'
    })

    const url1 = mockFetch.mock.calls[1][0]
    const url2 = mockFetch.mock.calls[2][0]
    const token1 = url1.match(/client_token=([^&]+)/)[1]
    const token2 = url2.match(/client_token=([^&]+)/)[1]
    expect(token1).toBe(token2)
  })

  it('does not append client_token to updateRecord requests', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tenant_access_token: 'test-token', expire: 7200 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { record: { id: 'rec-1' } } }) })

    await gateway.updateRecord('tbl-abc', 'rec-1', { field1: 'value1' }, {
      operationId: 'op-123',
      customerId: 'cus-1'
    })

    const updateCall = mockFetch.mock.calls[1]
    const url = updateCall[0]
    expect(url).not.toContain('client_token=')
  })

  it('does not append client_token when operationId is missing', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tenant_access_token: 'test-token', expire: 7200 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { record: { id: 'rec-1' } } }) })

    await gateway.createRecord('tbl-abc', { field1: 'value1' }, {
      customerId: 'cus-1'
    })

    const createCall = mockFetch.mock.calls[1]
    const url = createCall[0]
    expect(url).not.toContain('client_token=')
  })
})
