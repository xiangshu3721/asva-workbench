import { config } from './config.mjs'

export class FeishuUnavailableError extends Error {
  code = 'FEISHU_UNAVAILABLE'
}

let tokenCache = null

function assertConfigured() {
  if (!config.feishu.appId || !config.feishu.appSecret || !config.feishu.baseToken) throw new FeishuUnavailableError('飞书多维表格尚未配置')
}

async function tenantToken() {
  assertConfigured()
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token
  const response = await fetch(`${config.feishu.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.appSecret }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.code || !payload?.tenant_access_token) throw new FeishuUnavailableError(payload?.msg || `飞书鉴权失败 HTTP ${response.status}`)
  tokenCache = { token: payload.tenant_access_token, expiresAt: Date.now() + (payload.expire || 7_200) * 1000 }
  return tokenCache.token
}

async function request(path, options = {}) {
  const token = await tenantToken()
  const response = await fetch(`${config.feishu.baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.code) throw new FeishuUnavailableError(payload?.msg || `飞书 API HTTP ${response.status}`)
  return payload?.data ?? payload
}

export async function listRecords(tableId) {
  const rows = []
  let pageToken = ''
  do {
    const query = new URLSearchParams({ page_size: '500' })
    if (pageToken) query.set('page_token', pageToken)
    const data = await request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/records?${query}`)
    rows.push(...(data.items || []))
    pageToken = data.has_more ? data.page_token || '' : ''
  } while (pageToken)
  return rows
}

export function createRecord(tableId, fields) {
  return request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/records`, { method: 'POST', body: JSON.stringify({ fields }) })
}

export function updateRecord(tableId, recordId, fields) {
  return request(`/open-apis/bitable/v1/apps/${config.feishu.baseToken}/tables/${tableId}/records/${recordId}`, { method: 'PUT', body: JSON.stringify({ fields }) })
}
