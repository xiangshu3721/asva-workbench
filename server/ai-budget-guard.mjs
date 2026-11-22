import crypto from 'node:crypto'

const CONTROL_ID = 'control'
const dayId = (day) => `day:${day}`
const reservationId = (operationId) => `op:${crypto.createHash('sha256').update(operationId).digest('hex')}`
const time = () => new Date().toISOString()
// R048.13: raised from 3/1 to 100/2. Daily limit is a safety fuse, not a
// permanent business policy. Concurrency 2 is validated against the Feishu
// write path; if parallel writes cause issues, reduce back to 1.
const HARD_DAILY_LIMIT = 100
const HARD_MAX_CONCURRENT = 2

export const operationIdForSource = (source = {}) => {
  const contentVersion = String(source.contentHash || crypto.createHash('sha256').update(String(source.rawText || '')).digest('hex'))
  return `source:${source.id}:${contentVersion}:${source.extractorVersion || 'evidence-v1'}`
}

export const chinaDay = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const value = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export class AiBudgetGuardError extends Error {
  constructor(message, code, status = 503, cause) {
    super(message, { cause })
    this.code = code
    this.status = status
  }
}

function unavailable(error) {
  if (error instanceof AiBudgetGuardError) return error
  return new AiBudgetGuardError('AI 额度守门不可用，已停止本次整理。', 'AI_BUDGET_STORE_UNAVAILABLE', 503, error)
}

function requireReservation(reservation) {
  if (!reservation?.operationId || !reservation?.day) throw new AiBudgetGuardError('AI 额度预留信息无效。', 'AI_BUDGET_RESERVATION_INVALID', 503)
  return reservation
}

/**
 * PostgreSQL HTTPS RPC adapter. PostgreSQL owns the single-table transaction,
 * row locks and hard quota. This client sends exactly one request per state
 * transition and never retries.
 */
export class CloudBaseAiBudgetGuard {
  constructor({
    collection,
    table,
    envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.TCB_ENV_ID || '',
    apiKey = process.env.CLOUDBASE_APIKEY || '',
    rpcBaseUrl = process.env.ON_DEMAND_AI_BUDGET_RPC_BASE_URL || '',
    rpcFunction = process.env.ON_DEMAND_AI_BUDGET_RPC_FUNCTION || 'asva_ai_budget_guard',
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    this.collection = String(collection || table || '').trim()
    this.envId = String(envId || '').trim()
    this.apiKey = String(apiKey || '').trim()
    this.rpcBaseUrl = String(rpcBaseUrl || (this.envId ? `https://${this.envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc` : '')).replace(/\/$/, '')
    this.rpcFunction = String(rpcFunction || '').trim()
    this.fetchImpl = fetchImpl
    this.clock = clock
  }

  configured() {
    return Boolean(this.collection && this.rpcBaseUrl && this.rpcFunction && this.apiKey && typeof this.fetchImpl === 'function')
  }

  async rpc(action, payload = {}) {
    if (!this.configured()) throw new AiBudgetGuardError('AI 额度存储尚未完成服务端配置。', 'AI_BUDGET_STORE_UNCONFIGURED', 409)
    const url = `${this.rpcBaseUrl}/${encodeURIComponent(this.rpcFunction)}`
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        // Keep one stable PostgREST argument so camelCase payload fields are
        // not subject to PostgreSQL identifier folding. The SQL RPC validates
        // and ignores the client-supplied table name in favor of its fixed
        // budget table.
        body: JSON.stringify({ request: { action, table: this.collection, ...payload } }),
      })
    } catch (error) { throw unavailable(error) }
    let body = null
    try { body = await response.json() } catch {}
    const data = body?.data ?? body?.result ?? body
    if (!response.ok) {
      const error = body?.error || body || {}
      throw new AiBudgetGuardError(error.message || 'AI 额度 RPC 请求失败。', error.code || 'AI_BUDGET_STORE_UNAVAILABLE', Number(error.status || response.status || 503), error)
    }
    if (data?.error) {
      const error = data.error
      throw new AiBudgetGuardError(error.message || 'AI 额度 RPC 请求失败。', error.code || 'AI_BUDGET_STORE_UNAVAILABLE', Number(error.status || 503), error)
    }
    return data
  }

  async reserve({ operationId, sourceId, sourceVersion, actorId, dailyLimit, maxConcurrent }) {
    if (!operationId || !sourceId || !sourceVersion || !actorId) throw new AiBudgetGuardError('AI 额度预留参数无效。', 'AI_BUDGET_RESERVATION_INVALID', 400)
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new AiBudgetGuardError('AI 额度限制尚未配置。', 'AI_BUDGET_LIMIT_INVALID', 409)
    const day = chinaDay(this.clock())
    try {
      const result = await this.rpc('reserve', {
        operationId,
        reservationId: reservationId(operationId),
        sourceId,
        sourceVersion,
        actorId,
        day,
        now: time(),
        dailyLimit: Math.min(dailyLimit, HARD_DAILY_LIMIT),
        maxConcurrent: Math.min(maxConcurrent, HARD_MAX_CONCURRENT),
      })
      if (!result?.reservation || typeof result.duplicate !== 'boolean') throw new AiBudgetGuardError('AI 额度预留结果无法确认。', 'AI_BUDGET_RESERVATION_UNKNOWN', 503)
      return result
    } catch (error) { throw unavailable(error) }
  }

  async markAttempted(reservation) {
    const item = requireReservation(reservation)
    try { await this.rpc('mark_attempted', { reservation: item, now: time() }) } catch (error) { throw unavailable(error) }
  }

  async complete(reservation, { status, releaseActive = status === 'SUCCEEDED', inputTokens = 0, outputTokens = 0 } = {}) {
    const item = requireReservation(reservation)
    if (!['SUCCEEDED', 'FAILED'].includes(status)) throw new AiBudgetGuardError('AI 额度完成状态无效。', 'AI_BUDGET_COMPLETION_INVALID', 400)
    try {
      await this.rpc('complete', {
        reservation: item,
        status,
        releaseActive: Boolean(releaseActive),
        inputTokens: Number.isInteger(inputTokens) ? inputTokens : 0,
        outputTokens: Number.isInteger(outputTokens) ? outputTokens : 0,
        now: time(),
      })
    } catch (error) { throw unavailable(error) }
  }

  async control() {
    try { return (await this.rpc('control')) || { mode: 'DISABLED' } } catch (error) { throw unavailable(error) }
  }

  async dailyStats(day) {
    try {
      // R048.14: Default to Beijing time (UTC+8) for daily stats
      const defaultDay = chinaDay(this.clock())
      const result = await this.rpc('daily_stats', { day: day || defaultDay })
      const stats = result || { day: day || defaultDay, used: 0, successCount: 0, failCount: 0, totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0 }
      // Add cost estimate note
      stats.costEstimateNote = 'DeepSeek API 估算：$0.14/M input + $0.28/M output，不含缓存 token 折扣，非实际账单'
      return stats
    } catch (error) { throw unavailable(error) }
  }

  // R048.14: Anomaly detection and alerting
  async checkAndAlertAnomalies(day) {
    try {
      const stats = await this.dailyStats(day)
      const anomalies = []
      // High failure rate
      if (stats.used > 0 && stats.failCount / stats.used > 0.3) {
        anomalies.push({ type: 'HIGH_FAILURE_RATE', message: `失败率 ${(stats.failCount / stats.used * 100).toFixed(1)}% 超过 30% 阈值`, severity: 'WARNING' })
      }
      // High cost
      if (stats.estimatedCostUsd > 1.0) {
        anomalies.push({ type: 'HIGH_DAILY_COST', message: `日估算费用 $${stats.estimatedCostUsd.toFixed(4)} 超过 $1.00 阈值`, severity: 'WARNING' })
      }
      // Pending tasks stuck
      if (stats.pendingCount > 0) {
        anomalies.push({ type: 'PENDING_TASKS', message: `${stats.pendingCount} 个任务处于待处理状态`, severity: 'INFO' })
      }
      if (anomalies.length > 0) {
        // Log alerts for now; future: integrate with Feishu/notification channel
        console.warn('[ASVA_BUDGET_ANOMALY]', JSON.stringify({ day, anomalies, stats }))
        // Future: await this.sendAlert(anomalies, stats)
      }
      return { stats, anomalies }
    } catch (error) {
      console.error('[ASVA_BUDGET_ANOMALY_CHECK_FAILED]', error.message)
      return { stats: null, anomalies: [], error: error.message }
    }
  }

  async setControl({ mode, actorId }) {
    if (!['ENABLED', 'PAUSED', 'DISABLED'].includes(mode)) throw new AiBudgetGuardError('AI 管理状态无效。', 'AI_BUDGET_CONTROL_INVALID', 400)
    if (!actorId) throw new AiBudgetGuardError('管理员身份无效。', 'AI_BUDGET_CONTROL_INVALID', 400)
    try {
      await this.rpc('set_control', { mode, actorId, now: time(), controlId: CONTROL_ID })
      return this.control()
    } catch (error) { throw unavailable(error) }
  }
}

export function createAiBudgetGuard(features = {}) {
  return new CloudBaseAiBudgetGuard({
    collection: features.onDemandAiBudgetCollection,
    apiKey: features.onDemandAiBudgetApiKey,
    rpcBaseUrl: features.onDemandAiBudgetRpcBaseUrl,
    rpcFunction: features.onDemandAiBudgetRpcFunction,
  })
}

export { CONTROL_ID, HARD_DAILY_LIMIT, HARD_MAX_CONCURRENT, dayId, reservationId }
