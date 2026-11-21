import { describe, expect, it } from 'vitest'
import { AiBudgetGuardError, CloudBaseAiBudgetGuard, chinaDay, operationIdForSource, reservationId } from './ai-budget-guard.mjs'

function memoryRpc({ failComplete = false } = {}) {
  const docs = new Map()
  let tail = Promise.resolve()
  const clone = (value) => value && structuredClone(value)
  const respond = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(data) })
  const error = (message, code, status) => respond({ error: { message, code, status } }, status)
  const fetchImpl = async (_url, options) => {
    const previous = tail
    let unlock
    tail = new Promise((resolve) => { unlock = resolve })
    await previous
    try {
      const body = JSON.parse(options.body)
      const id = body.reservationId || reservationId(body.reservation?.operationId || '')
      if (body.action === 'set_control') {
        const before = docs.get('control') || { id: 'control', mode: 'DISABLED', used: 0, active: 0, activeOperationId: '' }
        docs.set('control', { ...before, mode: body.mode, updatedBy: body.actorId })
        return respond(docs.get('control'))
      }
      if (body.action === 'control') return respond(docs.get('control') || { mode: 'DISABLED' })
      const control = docs.get('control') || { mode: 'DISABLED', used: 0, active: 0, activeOperationId: '' }
      if (body.action === 'reserve') {
        if (control.mode !== 'ENABLED') return error('disabled', control.mode === 'PAUSED' ? 'AI_BUDGET_EMERGENCY_PAUSED' : 'AI_BUDGET_CONTROL_DISABLED', 409)
        const existing = docs.get(id)
        if (existing) return respond({ duplicate: true, reservation: existing })
        const used = control.quotaDay === body.day ? Number(control.used || 0) : 0
        if (used >= body.dailyLimit) return error('limit', 'ON_DEMAND_AI_DAILY_LIMIT_REACHED', 429)
        if (Number(control.active || 0) >= body.maxConcurrent || control.activeOperationId) return error('concurrency', 'ON_DEMAND_AI_CONCURRENCY_REACHED', 429)
        const reservation = { _id: id, operationId: body.operationId, sourceId: body.sourceId, sourceVersion: body.sourceVersion, actorId: body.actorId, day: body.day, status: 'RESERVED' }
        docs.set('control', { ...control, quotaDay: body.day, used: used + 1, active: 1, activeOperationId: id })
        docs.set(`day:${body.day}`, { day: body.day, used: used + 1, active: 1 })
        docs.set(id, reservation)
        return respond({ duplicate: false, reservation })
      }
      if (body.action === 'mark_attempted') {
        if (control.mode !== 'ENABLED') return error('paused', control.mode === 'PAUSED' ? 'AI_BUDGET_EMERGENCY_PAUSED' : 'AI_BUDGET_CONTROL_DISABLED', 409)
        const reservation = body.reservation
        const current = docs.get(reservation._id || id)
        if (!current || current.status !== 'RESERVED') return error('unknown', 'AI_BUDGET_RESERVATION_UNKNOWN', 503)
        if (control.activeOperationId !== (current._id || id) || Number(control.active) !== 1) return error('token', 'AI_BUDGET_CONCURRENCY_UNKNOWN', 503)
        docs.set(current._id || id, { ...current, status: 'ATTEMPTED' })
        return respond({ ok: true })
      }
      if (body.action === 'complete') {
        const reservation = body.reservation
        const current = docs.get(reservation._id || id)
        if (!current || current.status !== 'ATTEMPTED') return error('unknown', 'AI_BUDGET_RESERVATION_UNKNOWN', 503)
        if (failComplete) return error('timeout', 'AI_BUDGET_STORE_UNAVAILABLE', 503)
        docs.set(current._id || id, { ...current, status: body.status })
        if (body.releaseActive) {
          if (control.activeOperationId !== (current._id || id) || Number(control.active) !== 1) return error('token', 'AI_BUDGET_CONCURRENCY_UNKNOWN', 503)
          docs.set('control', { ...control, active: 0, activeOperationId: '' })
          const bucket = docs.get(`day:${current.day}`)
          docs.set(`day:${current.day}`, { ...bucket, active: Math.max(0, Number(bucket?.active || 0) - 1) })
        }
        return respond({ ok: true })
      }
      return error('unsupported', 'AI_BUDGET_STORE_UNAVAILABLE', 503)
    } finally { unlock() }
  }
  return { fetchImpl, docs }
}

function guard(shared, clock = () => new Date('2026-11-20T05:00:00.000Z')) {
  return new CloudBaseAiBudgetGuard({ table: 'asva_ai_budget_v1', rpcBaseUrl: 'https://rpc.test/v1/rdb/rest/rpc', rpcFunction: 'asva_ai_budget_guard', apiKey: 'simulated-key', fetchImpl: shared.fetchImpl, clock })
}

const request = (operationId, sourceId = 'SRC-1') => ({ operationId, sourceId, sourceVersion: 'hash-v1', actorId: 'ADMIN-1', dailyLimit: 2, maxConcurrent: 1 })

describe('durable on-demand AI budget guard over HTTPS RPC', () => {
  it('uses China-local daily buckets and stable source operation ids', () => {
    expect(chinaDay(new Date('2026-11-20T15:59:59.000Z'))).toBe('2026-11-20')
    expect(chinaDay(new Date('2026-11-20T16:00:00.000Z'))).toBe('2026-11-21')
    expect(operationIdForSource({ id: 'SRC-1', rawText: '原始资料' })).toBe(operationIdForSource({ id: 'SRC-1', rawText: '原始资料' }))
  })

  it('atomically deduplicates concurrent requests from separate instances', async () => {
    const shared = memoryRpc(); const first = guard(shared); const second = guard(shared)
    await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })
    const [one, two] = await Promise.all([first.reserve(request('same-operation')), second.reserve(request('same-operation'))])
    expect([one, two].filter((item) => item.duplicate)).toHaveLength(1)
    expect([one, two].filter((item) => !item.duplicate)).toHaveLength(1)
    expect(shared.docs.get('day:2026-11-20')).toMatchObject({ used: 1, active: 1 })
  })

  it('enforces daily quota and one active attempt across instances', async () => {
    const shared = memoryRpc(); const first = guard(shared); const second = guard(shared)
    await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' }); const one = await first.reserve(request('one'))
    await expect(second.reserve(request('two', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
    await first.markAttempted(one.reservation); await first.complete(one.reservation, { status: 'SUCCEEDED' })
    await second.reserve(request('two', 'SRC-2'))
    await expect(first.reserve(request('three', 'SRC-3'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_DAILY_LIMIT_REACHED', status: 429 })
  })

  it('keeps empty-day race below hard quota with ten instances', async () => {
    const shared = memoryRpc(); const guards = Array.from({ length: 10 }, () => guard(shared)); await guards[0].setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })
    const wave = await Promise.allSettled(guards.map((item, index) => item.reserve({ operationId: `concurrent-${index}`, sourceId: `SRC-${index}`, sourceVersion: 'hash-v1', actorId: 'ADMIN-1', dailyLimit: 99, maxConcurrent: 99 })))
    const allocated = wave.filter((item) => item.status === 'fulfilled'); expect(allocated).toHaveLength(1)
    const first = allocated[0].value.reservation; await guards[0].markAttempted(first); await guards[0].complete(first, { status: 'SUCCEEDED' })
    for (const [index, operationId] of ['second', 'third'].entries()) { const item = await guards[index + 1].reserve({ operationId, sourceId: `SRC-${operationId}`, sourceVersion: 'hash-v1', actorId: 'ADMIN-1', dailyLimit: 99, maxConcurrent: 99 }); await guards[index + 1].markAttempted(item.reservation); await guards[index + 1].complete(item.reservation, { status: 'SUCCEEDED' }) }
    await expect(guards[0].reserve({ operationId: 'fourth', sourceId: 'SRC-fourth', sourceVersion: 'hash-v1', actorId: 'ADMIN-1', dailyLimit: 99, maxConcurrent: 99 })).rejects.toMatchObject({ code: 'ON_DEMAND_AI_DAILY_LIMIT_REACHED', status: 429 })
    expect(shared.docs.get('control')).toMatchObject({ used: 3, active: 0 })
  })

  it('keeps one active token across Beijing midnight', async () => {
    const shared = memoryRpc(); const before = guard(shared, () => new Date('2026-11-20T15:59:59.000Z')); const after = guard(shared, () => new Date('2026-11-20T16:00:00.000Z'))
    await before.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' }); const previous = await before.reserve(request('before-midnight')); await before.markAttempted(previous.reservation)
    await expect(after.reserve(request('after-midnight', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
    await before.complete(previous.reservation, { status: 'SUCCEEDED' }); const next = await after.reserve(request('after-midnight', 'SRC-2'))
    expect(next.duplicate).toBe(false); expect(shared.docs.get('control')).toMatchObject({ quotaDay: '2026-11-21', used: 1, active: 1 })
  })

  it('fails closed under pause, missing configuration, and RPC faults', async () => {
    const shared = memoryRpc(); const enabled = guard(shared); const paused = guard(shared); await enabled.setControl({ mode: 'PAUSED', actorId: 'ADMIN-1' })
    await expect(paused.reserve(request('blocked'))).rejects.toMatchObject({ code: 'AI_BUDGET_EMERGENCY_PAUSED', status: 409 })
    const unavailable = new CloudBaseAiBudgetGuard({ collection: 'asva_ai_budget_v1', fetchImpl: shared.fetchImpl }); await expect(unavailable.reserve(request('missing'))).rejects.toMatchObject({ code: 'AI_BUDGET_STORE_UNCONFIGURED', status: 409 })
    const broken = new CloudBaseAiBudgetGuard({ table: 'asva_ai_budget_v1', rpcBaseUrl: 'https://rpc.test', apiKey: 'simulated', fetchImpl: async () => { throw new Error('network down') } }); await expect(broken.reserve(request('fault'))).rejects.toMatchObject({ code: 'AI_BUDGET_STORE_UNAVAILABLE', status: 503 })
  })

  it('does not release an unknown attempt and keeps failed calls fail-closed', async () => {
    const shared = memoryRpc(); const first = guard(shared); const second = guard(shared); await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' }); const item = await first.reserve(request('failed')); await first.markAttempted(item.reservation); await first.complete(item.reservation, { status: 'FAILED' })
    await expect(second.reserve(request('later', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
    expect(shared.docs.get('control')).toMatchObject({ active: 1, activeOperationId: item.reservation._id })
  })

  it('blocks the pre-model pause window', async () => {
    const shared = memoryRpc(); const first = guard(shared); await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' }); const item = await first.reserve(request('pause-window')); await first.setControl({ mode: 'PAUSED', actorId: 'ADMIN-1' })
    await expect(first.markAttempted(item.reservation)).rejects.toMatchObject({ code: 'AI_BUDGET_EMERGENCY_PAUSED', status: 409 })
  })

  it('keeps token consumed when completion is unknown', async () => {
    const shared = memoryRpc({ failComplete: true }); const first = guard(shared); const second = guard(shared); await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' }); const item = await first.reserve(request('unknown')); await first.markAttempted(item.reservation)
    await expect(first.complete(item.reservation, { status: 'SUCCEEDED' })).rejects.toMatchObject({ code: 'AI_BUDGET_STORE_UNAVAILABLE', status: 503 })
    await expect(second.reserve(request('later', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
  })
})
