import { config } from './config.mjs'
import crypto from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_BACKOFF_MS = [500, 1_000, 2_000, 4_000]
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000

// Feishu requires a UUID-shaped client_token for create-record idempotency.
// Keep it deterministic so retries and repeated requests for one operation
// address the same provider-side idempotency key.
export function feishuClientToken(operationId, tableId) {
  if (!operationId || !tableId) return null
  const hash = crypto.createHash('sha256').update(`asva-feishu-v1:${tableId}:${operationId}`).digest('hex')
  const hex = hash.slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

export const FEISHU_ERROR_CODES = Object.freeze({
  NETWORK: 'FEISHU_NETWORK_ERROR', TIMEOUT: 'FEISHU_TIMEOUT', RATE_LIMITED: 'FEISHU_RATE_LIMITED',
  TEMPORARILY_UNAVAILABLE: 'FEISHU_TEMPORARILY_UNAVAILABLE', SERVER_ERROR: 'FEISHU_SERVER_ERROR',
  TOKEN_EXPIRED: 'FEISHU_TOKEN_EXPIRED', AUTH_ERROR: 'FEISHU_AUTH_ERROR', PERMISSION_ERROR: 'FEISHU_PERMISSION_ERROR',
  SCHEMA_ERROR: 'FEISHU_SCHEMA_ERROR', FIELD_ERROR: 'FEISHU_FIELD_ERROR', VALIDATION_ERROR: 'FEISHU_VALIDATION_ERROR',
  NOT_FOUND: 'FEISHU_NOT_FOUND', CONFLICT: 'FEISHU_CONFLICT',
})

export class FeishuUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'FeishuUnavailableError'
    this.code = details.code || 'FEISHU_UNAVAILABLE'
    this.providerCode = details.providerCode
    this.providerMessage = details.providerMessage
    this.providerRequestId = details.providerRequestId
    this.httpStatus = details.httpStatus
    this.retryable = details.retryable === true
    this.operation = details.operation
    this.attempt = details.attempt
    this.customerId = details.customerId
    this.entityType = details.entityType
    // True once a write request has been handed to fetch. Timeouts and lost
    // responses after this point cannot be treated as "not started".
    this.writeDispatched = details.writeDispatched === true
  }
}

function requestId(response, payload) {
  return response?.headers?.get?.('x-tt-logid') || response?.headers?.get?.('x-request-id') || payload?.request_id || payload?.data?.request_id || undefined
}
function isTimeout(error) { return error?.name === 'AbortError' || error?.code === 'ETIMEDOUT' || error?.code === 'UND_ERR_CONNECT_TIMEOUT' }
function isNetwork(error) { return ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code) || error?.name === 'TypeError' }
function statusIsTransient(status) { return status === 429 || status === 502 || status === 503 || status === 504 || status >= 500 }
function providerCodeIsTransient(code) { return [1254607, 99991400].includes(Number(code)) }
function looksLikeTokenError(status, code, message) {
  const source = String(message || '').toLowerCase()
  return status === 401 || (/token/.test(source) && /(invalid|expired|expire|无效|过期)/.test(source)) || [99991663, 99991668, 99991403].includes(Number(code))
}
function normalizeProviderError({ status, providerCode, providerMessage, operation }) {
  if (looksLikeTokenError(status, providerCode, providerMessage)) return { code: FEISHU_ERROR_CODES.TOKEN_EXPIRED, retryable: true, message: '飞书会话已过期，正在重新连接' }
  if (status === 401) return { code: FEISHU_ERROR_CODES.AUTH_ERROR, retryable: false, message: '飞书鉴权失败' }
  if (status === 403) return { code: FEISHU_ERROR_CODES.PERMISSION_ERROR, retryable: false, message: '飞书权限不足' }
  if (status === 404) return { code: FEISHU_ERROR_CODES.NOT_FOUND, retryable: false, message: '飞书目标不存在' }
  if (status === 409) return { code: FEISHU_ERROR_CODES.CONFLICT, retryable: false, message: '飞书数据发生冲突' }
  if (status === 429) return { code: FEISHU_ERROR_CODES.RATE_LIMITED, retryable: true, message: '飞书请求过于频繁' }
  if (statusIsTransient(status) || providerCodeIsTransient(providerCode)) return { code: FEISHU_ERROR_CODES.SERVER_ERROR, retryable: true, message: '飞书服务暂时不可用' }
  const source = String(providerMessage || '').toLowerCase()
  if (/field|column|字段/.test(source)) return { code: FEISHU_ERROR_CODES.FIELD_ERROR, retryable: false, message: '飞书字段配置不匹配' }
  if (/schema|table|表结构/.test(source)) return { code: FEISHU_ERROR_CODES.SCHEMA_ERROR, retryable: false, message: '飞书表结构配置不匹配' }
  if (/not found|不存在/.test(source)) return { code: FEISHU_ERROR_CODES.NOT_FOUND, retryable: false, message: '飞书目标不存在' }
  if (/conflict|重复|冲突/.test(source)) return { code: FEISHU_ERROR_CODES.CONFLICT, retryable: false, message: '飞书数据发生冲突' }
  return { code: FEISHU_ERROR_CODES.VALIDATION_ERROR, retryable: false, message: operation === 'tenant_token' ? '飞书鉴权失败' : '飞书请求参数无效' }
}
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

export function isRetryableFeishuError(error) {
  return error?.retryable === true || [FEISHU_ERROR_CODES.NETWORK, FEISHU_ERROR_CODES.TIMEOUT, FEISHU_ERROR_CODES.RATE_LIMITED, FEISHU_ERROR_CODES.SERVER_ERROR, FEISHU_ERROR_CODES.TEMPORARILY_UNAVAILABLE].includes(error?.code) || isTimeout(error) || isNetwork(error)
}

export function buildSearchExactFilter(fieldName, value) {
  const field = String(fieldName || '').trim()
  if (!field) throw new TypeError('Feishu search field is required')
  return {
    conjunction: 'and',
    conditions: [{ field_name: field, operator: 'is', value: [String(value ?? '')] }],
  }
}

export function createFeishuGateway({
  fetchImpl = globalThis.fetch, sleepImpl = sleep, random = Math.random, now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS, backoffMs = DEFAULT_BACKOFF_MS,
  baseUrl = config.feishu.baseUrl, appId = config.feishu.appId, appSecret = config.feishu.appSecret,
  baseToken = config.feishu.baseToken, logger = console,
} = {}) {
  let tokenCache = null
  let refreshPromise = null
  let breaker = { state: 'CLOSED', failures: 0, openedAt: 0 }
  const metrics = { requests: 0, successes: 0, timeoutCount: 0, rateLimitCount: 0, serverErrorCount: 0, retryCount: 0, retryRecoveredCount: 0, duplicatePreventedCount: 0 }
  const assertConfigured = () => { if (!appId || !appSecret || !baseToken) throw new FeishuUnavailableError('飞书多维表格尚未配置', { code: FEISHU_ERROR_CODES.AUTH_ERROR, operation: 'configuration' }) }
  const providerStatus = () => ({ state: breaker.state === 'OPEN' ? 'unavailable' : breaker.failures ? 'degraded' : 'healthy', circuit: breaker.state, failures: breaker.failures, metrics: { ...metrics } })
  const recordFailure = (error) => { if (isRetryableFeishuError(error)) { breaker.failures += 1; if (breaker.failures >= 5) breaker = { state: 'OPEN', failures: breaker.failures, openedAt: now() } } }
  const recordSuccess = (attempt) => { if (attempt > 0) metrics.retryRecoveredCount += 1; breaker = { state: 'CLOSED', failures: 0, openedAt: 0 } }
  const ensureCircuit = () => { if (breaker.state !== 'OPEN') return; if (now() - breaker.openedAt >= 30_000) { breaker = { ...breaker, state: 'HALF_OPEN' }; return } throw new FeishuUnavailableError('飞书服务暂时不可用', { code: FEISHU_ERROR_CODES.TEMPORARILY_UNAVAILABLE, retryable: true, operation: 'circuit_breaker' }) }

  async function refreshToken() {
    assertConfigured()
    let response
    try {
      response = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const code = isTimeout(error) ? FEISHU_ERROR_CODES.TIMEOUT : FEISHU_ERROR_CODES.NETWORK
      if (code === FEISHU_ERROR_CODES.TIMEOUT) metrics.timeoutCount += 1
      throw new FeishuUnavailableError('飞书鉴权暂时不可用', { code, retryable: true, operation: 'tenant_token' })
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.code || !payload?.tenant_access_token) {
      const normalized = normalizeProviderError({ status: response.status, providerCode: payload?.code, providerMessage: payload?.msg, operation: 'tenant_token' })
      throw new FeishuUnavailableError(normalized.message, { ...normalized, providerCode: payload?.code, providerMessage: payload?.msg, providerRequestId: requestId(response, payload), httpStatus: response.status, operation: 'tenant_token' })
    }
    tokenCache = { token: payload.tenant_access_token, expiresAt: now() + (payload.expire || 7_200) * 1_000 }
    return tokenCache.token
  }
  async function getToken({ force = false } = {}) {
    if (!force && tokenCache && tokenCache.expiresAt > now() + TOKEN_REFRESH_SKEW_MS) return tokenCache.token
    if (!refreshPromise) refreshPromise = refreshToken().finally(() => { refreshPromise = null })
    return refreshPromise
  }

  async function request(path, options = {}, context = {}) {
    assertConfigured(); ensureCircuit()
    const operation = context.operation || options.method || 'GET'
    const method = String(options.method || 'GET').toUpperCase()
    // records/search is POST but read-only; keep write logs/idempotency for true mutations only.
    const readOnlyOperations = new Set(['search_records', 'list_records', 'list_fields', 'list_tables', 'get_record'])
    const isWrite = !['GET', 'HEAD'].includes(method) && !readOnlyOperations.has(operation)
    const retryEnabled = context.retry !== false
    const operationId = context.operationId || options.operationId
    const isCreateRecord = method === 'POST' && context.table && operationId && (operation === 'create_record' || operation.endsWith('.create'))
    const clientToken = isCreateRecord ? feishuClientToken(operationId, context.table) : null
    const requestPath = clientToken ? `${path}${path.includes('?') ? '&' : '?'}client_token=${encodeURIComponent(clientToken)}` : path
    let refreshedAfterTokenError = false
    let writeDispatched = false
    let lastError
    for (let attempt = 0; attempt < (retryEnabled ? maxAttempts : 1); attempt += 1) {
      try {
        const token = await getToken({ force: refreshedAfterTokenError })
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
        if (operationId) headers['X-Idempotency-Key'] = String(operationId)
        const startedAt = now(); metrics.requests += 1
        let response
        if (isWrite) writeDispatched = true
        try { response = await fetchImpl(`${baseUrl}${requestPath}`, { ...options, headers, signal: options.signal || AbortSignal.timeout(timeoutMs) }) } catch (error) {
          const timeout = isTimeout(error)
          if (timeout) metrics.timeoutCount += 1
          throw new FeishuUnavailableError(timeout ? '飞书请求超时' : '飞书网络请求暂时不可用', { code: timeout ? FEISHU_ERROR_CODES.TIMEOUT : FEISHU_ERROR_CODES.NETWORK, retryable: true, operation, attempt, customerId: context.customerId, entityType: context.entityType })
        }
        const rawText = await response.text().catch(() => '')
        let payload = null
        try { payload = rawText ? JSON.parse(rawText) : null } catch { payload = { msg: String(rawText || '').slice(0, 300), non_json_body: true } }
        // Feishu success is HTTP 200 with code === 0. Any other provider code or non-2xx is an error.
        if (!response.ok || (payload && payload.code !== undefined && Number(payload.code) !== 0)) {
          const normalized = normalizeProviderError({ status: response.status, providerCode: payload?.code, providerMessage: payload?.msg, operation })
          if (normalized.code === FEISHU_ERROR_CODES.RATE_LIMITED) metrics.rateLimitCount += 1
          if (normalized.code === FEISHU_ERROR_CODES.SERVER_ERROR) metrics.serverErrorCount += 1
          throw new FeishuUnavailableError(normalized.message, { ...normalized, providerCode: payload?.code, providerMessage: payload?.msg, providerRequestId: requestId(response, payload), httpStatus: response.status, operation, attempt, customerId: context.customerId, entityType: context.entityType, table: context.table })
        }
        metrics.successes += 1; recordSuccess(attempt)
        if (isWrite) logger.info?.('[ASVA_FEISHU_WRITE]', JSON.stringify({ request_id: requestId(response, payload), operation, operation_id: operationId, client_token: clientToken, customer_id: context.customerId, entity_type: context.entityType, table: context.table, attempt: attempt + 1, latency_ms: now() - startedAt, result: 'SUCCESS' }))
        return payload?.data ?? payload
      } catch (error) {
        lastError = error
        if (isWrite && writeDispatched && error instanceof FeishuUnavailableError) error.writeDispatched = true
        if (error?.code === FEISHU_ERROR_CODES.TOKEN_EXPIRED && !refreshedAfterTokenError) { tokenCache = null; refreshedAfterTokenError = true; metrics.retryCount += 1; continue }
        recordFailure(error)
        const canRetry = retryEnabled && isRetryableFeishuError(error) && attempt < maxAttempts - 1
        if (isWrite && context.idempotency && isRetryableFeishuError(error)) {
          const existing = await findExistingRecord(context.table, context.idempotency).catch(() => null)
          if (existing) { metrics.duplicatePreventedCount += 1; logger.warn?.('[ASVA_FEISHU_WRITE]', JSON.stringify({ operation, operation_id: operationId, client_token: clientToken, customer_id: context.customerId, entity_type: context.entityType, table: context.table, result: 'DUPLICATE_PREVENTED' })); return { record: existing, idempotency_recovered: true } }
        }
        if (!canRetry) {
          if (isWrite) logger.error?.('[ASVA_FEISHU_WRITE]', JSON.stringify({ operation, operation_id: operationId, client_token: clientToken, customer_id: context.customerId, entity_type: context.entityType, table: context.table, attempt: attempt + 1, result: 'FAILED', normalized_error: error?.code || 'FEISHU_UNAVAILABLE', http_status: error?.httpStatus, provider_code: error?.providerCode, provider_message: error?.providerMessage, provider_request_id: error?.providerRequestId }))
          throw error
        }
        metrics.retryCount += 1
        const baseDelay = backoffMs[Math.min(attempt, backoffMs.length - 1)] || backoffMs[backoffMs.length - 1]
        await sleepImpl(Math.round(baseDelay * (0.5 + random())))
      }
    }
    throw lastError || new FeishuUnavailableError('飞书请求未完成', { code: FEISHU_ERROR_CODES.TEMPORARILY_UNAVAILABLE, retryable: true, operation, writeDispatched: isWrite && writeDispatched })
  }
  async function listPaged(pathFactory, operation, context = {}) {
    const rows = []; let pageToken = ''
    do {
      const query = new URLSearchParams({ page_size: operation === 'list_tables' ? '100' : '500' }); if (pageToken) query.set('page_token', pageToken)
      const data = await request(pathFactory(query), {}, { ...context, operation, retry: true }); rows.push(...(data.items || [])); pageToken = data.has_more ? data.page_token || '' : ''
    } while (pageToken)
    return rows
  }
  async function searchPaged(tableId, body, context = {}) {
    const rows = []; let pageToken = ''
    do {
      const payload = { ...(body || {}), page_size: Number(body?.page_size) || 500 }
      if (pageToken) payload.page_token = pageToken
      else delete payload.page_token
      const data = await request(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/search`, { method: 'POST', body: JSON.stringify(payload) }, { ...context, operation: 'search_records', table: tableId, retry: true })
      rows.push(...(data.items || []))
      pageToken = data.has_more ? data.page_token || '' : ''
    } while (pageToken)
    return rows
  }
  async function findExistingRecord(tableId, idempotency) {
    if (!tableId || !idempotency?.field || idempotency.value === undefined || idempotency.value === null) return null
    const rows = await listPaged((query) => `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?${query}`, 'list_records', { table: tableId })
    return rows.find((row) => String(row?.fields?.[idempotency.field] ?? '') === String(idempotency.value)) || null
  }
  return {
    request, getToken, providerStatus, metrics: () => ({ ...metrics }),
    findExistingRecord,
    listRecords: (tableId) => listPaged((query) => `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?${query}`, 'list_records', { table: tableId }),
    searchRecords: (tableId, filter, options = {}) => searchPaged(tableId, {
      filter,
      ...(Array.isArray(options.fieldNames) && options.fieldNames.length ? { field_names: options.fieldNames } : {}),
      ...(options.automatic_fields !== undefined ? { automatic_fields: options.automatic_fields } : {}),
    }, { readContext: options.readContext }),
    getRecord: async (tableId, recordId) => { const data = await request(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${encodeURIComponent(recordId)}`, {}, { operation: 'get_record', table: tableId }); return data?.record || data },
    listFields: (tableId) => listPaged((query) => `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields?${query}`, 'list_fields', { table: tableId }),
    listTables: () => listPaged((query) => `/open-apis/bitable/v1/apps/${baseToken}/tables?${query}`, 'list_tables'),
    createTable: (name, fields = []) => request(`/open-apis/bitable/v1/apps/${baseToken}/tables`, { method: 'POST', body: JSON.stringify({ table: { name, default_view_name: '默认视图', fields } }) }, { operation: 'create_table', retry: false }),
    createField: (tableId, fieldName, type = 1) => request(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields`, { method: 'POST', body: JSON.stringify({ field_name: fieldName, type }) }, { operation: 'create_field', table: tableId, retry: false }),
    createRecord: (tableId, fields, context = {}) => request(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`, { method: 'POST', body: JSON.stringify({ fields }) }, { ...context, operation: context.operation || 'create_record', table: tableId, retry: true }),
    updateRecord: (tableId, recordId, fields, context = {}) => request(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recordId}`, { method: 'PUT', body: JSON.stringify({ fields }) }, { ...context, operation: context.operation || 'update_record', table: tableId, retry: true }),
    deleteRecord: (tableId, recordId, context = {}) => request(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recordId}`, { method: 'DELETE' }, { ...context, operation: context.operation || 'delete_record', table: tableId, retry: false }),
  }
}

const gateway = createFeishuGateway()
export const feishuGateway = gateway
export const listRecords = (tableId) => gateway.listRecords(tableId)
export const searchRecords = (tableId, filter, options = {}) => gateway.searchRecords(tableId, filter, options)
export const getRecord = (tableId, recordId) => gateway.getRecord(tableId, recordId)
export const listFields = (tableId) => gateway.listFields(tableId)
export const listTables = () => gateway.listTables()
export const createTable = (name, fields = []) => gateway.createTable(name, fields)
export const createField = (tableId, fieldName, type = 1) => gateway.createField(tableId, fieldName, type)
export function createFeishuWriteClient({ gateway: writeGateway = gateway } = {}) {
  return {
    createRecord: (tableId, fields, context = {}) => writeGateway.createRecord(tableId, fields, context),
    updateRecord: (tableId, recordId, fields, context = {}) => writeGateway.updateRecord(tableId, recordId, fields, context),
  }
}

const writeClient = createFeishuWriteClient()
export const createRecord = (...args) => writeClient.createRecord(...args)
export const updateRecord = (...args) => writeClient.updateRecord(...args)
export const deleteRecord = (tableId, recordId, context = {}) => gateway.deleteRecord(tableId, recordId, context)
