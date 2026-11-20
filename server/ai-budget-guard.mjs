import crypto from 'node:crypto'
import cloudbase from '@cloudbase/node-sdk'

const CONTROL_ID = 'control'
const dayId = (day) => `day:${day}`
const reservationId = (operationId) => `op:${crypto.createHash('sha256').update(operationId).digest('hex')}`
const time = () => new Date().toISOString()

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

function asDocument(result) {
  const data = result?.data
  if (Array.isArray(data)) return data[0] || null
  return data || null
}

function writable(document) {
  const { _id, ...data } = document || {}
  return data
}

function requireReservation(reservation) {
  if (!reservation?.operationId || !reservation?.day) throw new AiBudgetGuardError('AI 额度预留信息无效。', 'AI_BUDGET_RESERVATION_INVALID', 503)
  return reservation
}

/**
 * pgdoc is CloudBase's PostgreSQL-backed document layer. Every state
 * transition touches a deterministic daily document and a deterministic
 * operation document inside one server-side transaction. A store error is a
 * hard stop: the caller must never reach the model without a reservation.
 *
 * This guard deliberately never creates its collection. Enabling pgdoc,
 * creating the dedicated collection, and injecting the server API key are
 * reviewed production setup steps; an incomplete setup must fail closed.
 */
export class CloudBaseAiBudgetGuard {
  constructor({ collection, envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.TCB_ENV_ID || '', apiKey = process.env.CLOUDBASE_APIKEY || '', clock = () => new Date(), app } = {}) {
    this.collection = String(collection || '').trim()
    this.clock = clock
    this.app = app || null
    this.envId = envId
    this.apiKey = String(apiKey || '').trim()
  }

  database() {
    if (!this.collection) throw new AiBudgetGuardError('AI 额度存储尚未配置。', 'AI_BUDGET_STORE_UNCONFIGURED', 409)
    // HTTP Cloud Functions do not receive the default CloudBase credential.
    // Do not fall back to an unauthenticated or client-side key: this is a
    // server-only guard and must stop before the model on incomplete setup.
    if (!this.app) {
      if (!this.envId || !this.apiKey) throw new AiBudgetGuardError('AI 额度存储尚未完成服务端配置。', 'AI_BUDGET_STORE_UNCONFIGURED', 409)
      this.app = cloudbase.init({ env: this.envId, accessKey: this.apiKey })
    }
    return this.app.database()
  }

  async transaction(task) {
    const transaction = await this.database().startTransaction()
    try {
      const result = await task(transaction)
      await transaction.commit()
      return result
    } catch (error) {
      // A rollback failure cannot turn a failed reservation into permission to
      // call the model. Preserve the original failure and fail closed.
      try { await transaction.rollback(error) } catch {}
      throw error
    }
  }

  async reserve({ operationId, sourceId, sourceVersion, actorId, dailyLimit, maxConcurrent }) {
    if (!operationId || !sourceId || !sourceVersion || !actorId) throw new AiBudgetGuardError('AI 额度预留参数无效。', 'AI_BUDGET_RESERVATION_INVALID', 400)
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new AiBudgetGuardError('AI 额度限制尚未配置。', 'AI_BUDGET_LIMIT_INVALID', 409)
    const day = chinaDay(this.clock())
    const now = time()
    const opId = reservationId(operationId)
    try {
      const result = await this.transaction(async (transaction) => {
        const records = transaction.collection(this.collection)
        const control = asDocument(await records.doc(CONTROL_ID).get())
        if (!control || control.mode !== 'ENABLED') {
          const paused = control?.mode === 'PAUSED'
          throw new AiBudgetGuardError(paused ? 'AI 整理已被管理员紧急暂停。' : 'AI 整理尚未由管理员启用。', paused ? 'AI_BUDGET_EMERGENCY_PAUSED' : 'AI_BUDGET_CONTROL_DISABLED', 409)
        }
        const existing = asDocument(await records.doc(opId).get())
        if (existing) return { duplicate: true, reservation: existing }
        const current = asDocument(await records.doc(dayId(day)).get()) || { _id: dayId(day), kind: 'DAY', day, used: 0, active: 0 }
        if (Number(current.used || 0) >= dailyLimit) throw new AiBudgetGuardError('今日按需 AI 整理额度已用完。', 'ON_DEMAND_AI_DAILY_LIMIT_REACHED', 429)
        if (Number(current.active || 0) >= maxConcurrent) throw new AiBudgetGuardError('已有一条 AI 整理正在执行，请稍后查看结果。', 'ON_DEMAND_AI_CONCURRENCY_REACHED', 429)
        const reservation = {
          _id: opId, kind: 'RESERVATION', operationId, sourceId, sourceVersion, actorId, day,
          status: 'RESERVED', createdAt: now, updatedAt: now,
        }
        await records.doc(dayId(day)).set(writable({ ...current, used: Number(current.used || 0) + 1, active: Number(current.active || 0) + 1, updatedAt: now }))
        await records.doc(opId).set(writable(reservation))
        return { duplicate: false, reservation }
      })
      return result
    } catch (error) { throw unavailable(error) }
  }

  async markAttempted(reservation) {
    const item = requireReservation(reservation)
    try {
      await this.transaction(async (transaction) => {
        const records = transaction.collection(this.collection)
        // A pause must also close the narrow window after reservation but
        // before the model request starts. In-flight requests may still
        // finalize, but no paused request may become ATTEMPTED.
        const control = asDocument(await records.doc(CONTROL_ID).get())
        if (!control || control.mode !== 'ENABLED') {
          const paused = control?.mode === 'PAUSED'
          throw new AiBudgetGuardError(paused ? 'AI 整理已被管理员紧急暂停。' : 'AI 整理尚未由管理员启用。', paused ? 'AI_BUDGET_EMERGENCY_PAUSED' : 'AI_BUDGET_CONTROL_DISABLED', 409)
        }
        const document = asDocument(await records.doc(item._id || reservationId(item.operationId)).get())
        if (!document || document.status !== 'RESERVED') throw new AiBudgetGuardError('AI 额度预留状态无法确认。', 'AI_BUDGET_RESERVATION_UNKNOWN', 503)
        await records.doc(document._id || reservationId(item.operationId)).update({ status: 'ATTEMPTED', attemptedAt: time(), updatedAt: time() })
      })
    } catch (error) { throw unavailable(error) }
  }

  async complete(reservation, { status }) {
    const item = requireReservation(reservation)
    if (!['SUCCEEDED', 'FAILED'].includes(status)) throw new AiBudgetGuardError('AI 额度完成状态无效。', 'AI_BUDGET_COMPLETION_INVALID', 400)
    try {
      await this.transaction(async (transaction) => {
        const records = transaction.collection(this.collection)
        const document = asDocument(await records.doc(item._id || reservationId(item.operationId)).get())
        if (!document || document.status !== 'ATTEMPTED') throw new AiBudgetGuardError('AI 额度完成状态无法确认。', 'AI_BUDGET_RESERVATION_UNKNOWN', 503)
        const bucket = asDocument(await records.doc(dayId(item.day)).get())
        if (!bucket) throw new AiBudgetGuardError('AI 每日额度记录无法确认。', 'AI_BUDGET_DAY_UNKNOWN', 503)
        const updatedAt = time()
        await records.doc(document._id || reservationId(item.operationId)).update({ status, completedAt: updatedAt, updatedAt })
        await records.doc(dayId(item.day)).update({ active: Math.max(0, Number(bucket.active || 0) - 1), updatedAt })
      })
    } catch (error) { throw unavailable(error) }
  }

  async control() {
    try { return asDocument(await this.database().collection(this.collection).doc(CONTROL_ID).get()) || { mode: 'DISABLED' } } catch (error) { throw unavailable(error) }
  }

  async setControl({ mode, actorId }) {
    if (!['ENABLED', 'PAUSED', 'DISABLED'].includes(mode)) throw new AiBudgetGuardError('AI 管理状态无效。', 'AI_BUDGET_CONTROL_INVALID', 400)
    if (!actorId) throw new AiBudgetGuardError('管理员身份无效。', 'AI_BUDGET_CONTROL_INVALID', 400)
    try {
      await this.transaction(async (transaction) => {
        const before = asDocument(await transaction.collection(this.collection).doc(CONTROL_ID).get()) || { _id: CONTROL_ID, kind: 'CONTROL', createdAt: time() }
        await transaction.collection(this.collection).doc(CONTROL_ID).set(writable({ ...before, mode, updatedAt: time(), updatedBy: actorId }))
      })
      return this.control()
    } catch (error) { throw unavailable(error) }
  }
}

export function createAiBudgetGuard(features = {}) {
  return new CloudBaseAiBudgetGuard({ collection: features.onDemandAiBudgetCollection, apiKey: features.onDemandAiBudgetApiKey })
}
