import { config } from './config.mjs'

export class FeishuUnavailableError extends Error {
  code = 'FEISHU_UNAVAILABLE'

  constructor(message, details = {}) {
    super(message)
    this.name = 'FeishuUnavailableError'
    this.providerCode = details.providerCode
    this.providerMessage = details.providerMessage
    this.providerRequestId = details.providerRequestId
    this.httpStatus = details.httpStatus
    this.retryable = details.retryable === true
    this.operation = details.operation
  }
}

export class FeishuWriteConfirmedReadbackError extends FeishuUnavailableError {
  code = 'WRITE_CONFIRMED_READBACK_FAILED'

  constructor(message, details = {}) {
    super(message, details)
    this.name = 'FeishuWriteConfirmedReadbackError'
    this.writeStatus = 'WRITE_SUCCESS'
    this.readbackStatus = 'READBACK_FAILED'
    this.writeRecordId = details.writeRecordId
  }
}

let tokenCache = null

function assertConfigured() {
  if (!config.feishu.appId || !config.feishu.appSecret || !config.feishu.baseToken) throw new FeishuUnavailableError('飞书多维表格尚未配置')
}

function requestId(response, payload) {
  return response.headers.get('x-tt-logid') || response.headers.get('x-request-id') || payload?.request_id || payload?.data?.request_id || undefined
}

function retryableStatus(status) { return status === 429 || status >= 500 }
function retryableProviderCode(code) { return Number(code) === 99991400 }

export function isRetryableFeishuError(error) {
  return error?.retryable === true || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET' || error?.code === 'ENOTFOUND'
}

function retryDelay(attempt) { return [1000, 2500][attempt] || 4000 }

async function tenantToken() {
  assertConfigured()
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token
  let response
  try {
    response = await fetch(`${config.feishu.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.appSecret }),
      signal: AbortSignal.timeout(12_000),
    })
  } catch (error) {
    throw new FeishuUnavailableError('飞书鉴权暂时不可用', { retryable: true, operation: 'tenant_token' })
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.code || !payload?.tenant_access_token) {
    throw new FeishuUnavailableError('飞书鉴权失败', { providerCode: payload?.code, providerMessage: payload?.msg, providerRequestId: requestId(response, payload), httpStatus: response.status, retryable: retryableStatus(response.status), operation: 'tenant_token' })
  }
  tokenCache = { token: payload.tenant_access_token, expiresAt: Date.now() + (payload.expire || 7_200) * 1000 }
  return tokenCache.token
}

async function request(path, options = {}, { retry = false, operation = options.method || 'GET' } = {}) {
  const token = await tenantToken()
  const isWrite = !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())
  for (let attempt = 0; attempt < (retry ? 3 : 1); attempt += 1) {
    let response
    try {
      response = await fetch(`${config.feishu.baseUrl}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
        signal: options.signal || AbortSignal.timeout(12_000),
      })
    } catch (error) {
      const unavailable = new FeishuUnavailableError('飞书网络请求暂时不可用', { retryable: true, operation })
      if (retry && attempt < 2) { await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt))); continue }
      throw unavailable
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.code) {
      const unavailable = new FeishuUnavailableError('飞书接口请求失败', { providerCode: payload?.code, providerMessage: payload?.msg, providerRequestId: requestId(response, payload), httpStatus: response.status, retryable: retryableStatus(response.status) || retryableProviderCode(payload?.code), operation })
      if (retry && isRetryableFeishuError(unavailable) && attempt < 2) { await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt))); continue }
      if (isWrite) console.error('[ASVA_FEISHU_WRITE]', JSON.stringify({ operation, record_id: undefined, request_id: unavailable.providerRequestId, write_status: 'WRITE_FAILED', readback_status: 'NOT_ATTEMPTED', retry_count: attempt, final_result: 'FAIL', provider_code: unavailable.providerCode, provider_http_status: unavailable.httpStatus }))
      throw unavailable
    }
    const data = payload?.data ?? payload
    if (isWrite) console.info('[ASVA_FEISHU_WRITE]', JSON.stringify({ operation, record_id: data?.record?.record_id || data?.record_id || data?.record?.id, request_id: requestId(response, payload), write_status: 'WRITE_SUCCESS', readback_status: 'PENDING', retry_count: attempt, final_result: 'SUCCESS' }))
    return data
  }
  throw new FeishuUnavailableError('飞书接口请求失败', { retryable: true, operation })
}

export async function listRecords(tableId) {
  const rows = []
  let pageToken = ''
  do {
    const query = new URLSearchParams({ page_size: '500' })
    if (pageToken) query.set('page_token', pageToken)
    const data = await request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/records?${query}`, {}, { retry: true, operation: 'list_records' })
    rows.push(...(data.items || []))
    pageToken = data.has_more ? data.page_token || '' : ''
  } while (pageToken)
  return rows
}

export async function listFields(tableId) {
  const rows = []
  let pageToken = ''
  do {
    const query = new URLSearchParams({ page_size: '500' })
    if (pageToken) query.set('page_token', pageToken)
    const data = await request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/fields?${query}`, {}, { retry: true, operation: 'list_fields' })
    rows.push(...(data.items || []))
    pageToken = data.has_more ? data.page_token || '' : ''
  } while (pageToken)
  return rows
}

export async function listTables() {
  const rows = []
  let pageToken = ''
  do {
    const query = new URLSearchParams({ page_size: '100' })
    if (pageToken) query.set('page_token', pageToken)
    const data = await request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables?${query}`, {}, { retry: true, operation: 'list_tables' })
    rows.push(...(data.items || []))
    pageToken = data.has_more ? data.page_token || '' : ''
  } while (pageToken)
  return rows
}

export function createTable(name, fields = []) {
  return request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables`, { method: 'POST', body: JSON.stringify({ table: { name, default_view_name: '默认视图', fields } }) }, { operation: 'create_table' })
}

export function createField(tableId, fieldName, type = 1) {
  return request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/fields`, { method: 'POST', body: JSON.stringify({ field_name: fieldName, type }) }, { operation: 'create_field' })
}

export function createRecord(tableId, fields) {
  return request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/records`, { method: 'POST', body: JSON.stringify({ fields }) }, { operation: 'create_record' })
}

export function updateRecord(tableId, recordId, fields) {
  return request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/records/${recordId}`, { method: 'PUT', body: JSON.stringify({ fields }) }, { operation: 'update_record' })
}

export function deleteRecord(tableId, recordId) {
  return request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/records/${recordId}`, { method: 'DELETE' }, { operation: 'delete_record' })
}
