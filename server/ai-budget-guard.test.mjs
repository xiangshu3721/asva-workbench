import { describe, expect, it } from 'vitest'
import { AiBudgetGuardError, CloudBaseAiBudgetGuard, chinaDay, operationIdForSource } from './ai-budget-guard.mjs'

function memoryCloudBase({ failUpdate } = {}) {
  const documents = new Map()
  let tail = Promise.resolve()
  const clone = (value) => value && structuredClone(value)
  const document = (id) => ({
    get: async () => ({ data: clone(documents.get(id)) || null }),
    set: async (data) => {
      if (!data || Object.prototype.hasOwnProperty.call(data, 'data')) throw new Error('CloudBase Node SDK set() requires document fields directly')
      documents.set(id, clone(data))
      return { updated: 1 }
    },
    update: async (data) => {
      if (!data || Object.prototype.hasOwnProperty.call(data, 'data')) throw new Error('CloudBase Node SDK update() requires document fields directly')
      const current = documents.get(id)
      if (!current) throw new Error(`missing ${id}`)
      const failure = failUpdate?.({ id, current: clone(current), data: clone(data) })
      if (failure) throw failure
      documents.set(id, { ...current, ...clone(data) })
      return { updated: 1 }
    },
  })
  const beginTransaction = async () => {
    let unlock
    const previous = tail
    tail = new Promise((resolve) => { unlock = resolve })
    await previous
    let finished = false
    const finish = () => {
      if (!finished) {
        finished = true
        unlock()
      }
    }
    return {
      collection: () => ({ doc: document }),
      commit: async () => finish(),
      rollback: async () => finish(),
    }
  }
  const db = {
    startTransaction: beginTransaction,
    collection: () => ({ doc: document }),
  }
  return { app: { database: () => db }, documents }
}

function guard(shared) {
  return new CloudBaseAiBudgetGuard({ collection: 'asva_ai_budget_v1', app: shared.app, clock: () => new Date('2026-11-20T05:00:00.000Z') })
}

const request = (operationId, sourceId = 'SRC-1') => ({ operationId, sourceId, sourceVersion: 'hash-v1', actorId: 'ADMIN-1', dailyLimit: 2, maxConcurrent: 1 })

describe('durable on-demand AI budget guard', () => {
  it('uses a stable China-local daily bucket and source operation id', () => {
    expect(chinaDay(new Date('2026-11-20T15:59:59.000Z'))).toBe('2026-11-20')
    expect(chinaDay(new Date('2026-11-20T16:00:00.000Z'))).toBe('2026-11-21')
    expect(operationIdForSource({ id: 'SRC-1', rawText: '原始资料' })).toBe(operationIdForSource({ id: 'SRC-1', rawText: '原始资料' }))
  })

  it('atomically deduplicates concurrent requests from separate instances', async () => {
    const shared = memoryCloudBase()
    const first = guard(shared)
    const second = guard(shared)
    await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })

    const [one, two] = await Promise.all([first.reserve(request('same-operation')), second.reserve(request('same-operation'))])
    expect([one, two].filter((item) => item.duplicate)).toHaveLength(1)
    expect([one, two].filter((item) => !item.duplicate)).toHaveLength(1)
    expect(shared.documents.get('day:2026-11-20')).toMatchObject({ used: 1, active: 1 })
  })

  it('enforces daily quota and one active model attempt across instances', async () => {
    const shared = memoryCloudBase()
    const first = guard(shared)
    const second = guard(shared)
    await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })
    const firstReservation = await first.reserve(request('one'))

    await expect(second.reserve(request('two', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
    await first.markAttempted(firstReservation.reservation)
    await first.complete(firstReservation.reservation, { status: 'SUCCEEDED' })
    await second.reserve(request('two', 'SRC-2'))
    await expect(first.reserve(request('three', 'SRC-3'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_DAILY_LIMIT_REACHED', status: 429 })
  })

  it('keeps an empty-day race below the hard global quota with ten instances', async () => {
    const shared = memoryCloudBase()
    const guards = Array.from({ length: 10 }, () => guard(shared))
    await guards[0].setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })

    const firstWave = await Promise.allSettled(guards.map((item, index) => item.reserve({
      operationId: `concurrent-${index}`,
      sourceId: `SRC-${index}`,
      sourceVersion: 'hash-v1',
      actorId: 'ADMIN-1',
      dailyLimit: 99,
      maxConcurrent: 99,
    })))
    const allocated = firstWave.filter((item) => item.status === 'fulfilled')
    expect(allocated).toHaveLength(1)
    expect(shared.documents.get('control')).toMatchObject({ quotaDay: '2026-11-20', used: 1, active: 1 })

    const first = allocated[0].value.reservation
    await guards[0].markAttempted(first)
    await guards[0].complete(first, { status: 'SUCCEEDED' })
    for (const [index, operationId] of ['second', 'third'].entries()) {
      const reserved = await guards[index + 1].reserve({
        operationId,
        sourceId: `SRC-${operationId}`,
        sourceVersion: 'hash-v1',
        actorId: 'ADMIN-1',
        dailyLimit: 99,
        maxConcurrent: 99,
      })
      await guards[index + 1].markAttempted(reserved.reservation)
      await guards[index + 1].complete(reserved.reservation, { status: 'SUCCEEDED' })
    }
    await expect(guards[0].reserve({
      operationId: 'fourth', sourceId: 'SRC-fourth', sourceVersion: 'hash-v1', actorId: 'ADMIN-1', dailyLimit: 99, maxConcurrent: 99,
    })).rejects.toMatchObject({ code: 'ON_DEMAND_AI_DAILY_LIMIT_REACHED', status: 429 })
    expect(shared.documents.get('control')).toMatchObject({ used: 3, active: 0 })
  })

  it('keeps the one global active token across Beijing midnight', async () => {
    const shared = memoryCloudBase()
    const beforeMidnight = new CloudBaseAiBudgetGuard({ collection: 'asva_ai_budget_v1', app: shared.app, clock: () => new Date('2026-11-20T15:59:59.000Z') })
    const afterMidnight = new CloudBaseAiBudgetGuard({ collection: 'asva_ai_budget_v1', app: shared.app, clock: () => new Date('2026-11-20T16:00:00.000Z') })
    await beforeMidnight.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })
    const previousDay = await beforeMidnight.reserve(request('before-midnight'))
    await beforeMidnight.markAttempted(previousDay.reservation)

    await expect(afterMidnight.reserve(request('after-midnight', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
    await beforeMidnight.complete(previousDay.reservation, { status: 'SUCCEEDED' })
    const nextDay = await afterMidnight.reserve(request('after-midnight', 'SRC-2'))

    expect(nextDay.duplicate).toBe(false)
    expect(shared.documents.get('control')).toMatchObject({ quotaDay: '2026-11-21', used: 1, active: 1 })
    expect(shared.documents.get('day:2026-11-20')).toMatchObject({ active: 0 })
    expect(shared.documents.get('day:2026-11-21')).toMatchObject({ active: 1 })
  })

  it('fails closed under emergency pause and never treats a store fault as permission', async () => {
    const shared = memoryCloudBase()
    const enabled = guard(shared)
    const paused = guard(shared)
    await enabled.setControl({ mode: 'PAUSED', actorId: 'ADMIN-1' })
    await expect(paused.reserve(request('blocked'))).rejects.toMatchObject({ code: 'AI_BUDGET_EMERGENCY_PAUSED', status: 409 })

    const unavailable = new CloudBaseAiBudgetGuard({ collection: '', app: shared.app })
    await expect(unavailable.reserve(request('unavailable'))).rejects.toMatchObject({ code: 'AI_BUDGET_STORE_UNCONFIGURED', status: 409 })

    const missingServerCredential = new CloudBaseAiBudgetGuard({ collection: 'asva_ai_budget_v1', envId: 'env', apiKey: '' })
    await expect(missingServerCredential.reserve(request('missing-server-credential'))).rejects.toMatchObject({ code: 'AI_BUDGET_STORE_UNCONFIGURED', status: 409 })
  })

  it('does not release an unknown model attempt for another call', async () => {
    const shared = memoryCloudBase()
    const first = guard(shared)
    const second = guard(shared)
    await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })
    const reserved = await first.reserve(request('unknown'))
    await first.markAttempted(reserved.reservation)

    await expect(second.reserve(request('later', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
    expect(shared.documents.get('day:2026-11-20')).toMatchObject({ used: 1, active: 1 })
  })

  it('keeps the global token after a failed attempt until an administrator investigates', async () => {
    const shared = memoryCloudBase()
    const first = guard(shared)
    const second = guard(shared)
    await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })
    const reserved = await first.reserve(request('failed'))
    await first.markAttempted(reserved.reservation)
    await first.complete(reserved.reservation, { status: 'FAILED' })

    await expect(second.reserve(request('later', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
    expect(shared.documents.get('control')).toMatchObject({ active: 1, activeOperationId: reserved.reservation._id })
  })

  it('blocks a reserved call before model start when an administrator pauses AI', async () => {
    const shared = memoryCloudBase()
    const first = guard(shared)
    await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })
    const reserved = await first.reserve(request('pause-window'))
    await first.setControl({ mode: 'PAUSED', actorId: 'ADMIN-1' })

    await expect(first.markAttempted(reserved.reservation)).rejects.toMatchObject({ code: 'AI_BUDGET_EMERGENCY_PAUSED', status: 409 })
    expect(shared.documents.get(reserved.reservation._id)).toMatchObject({ status: 'RESERVED' })
    expect(shared.documents.get('day:2026-11-20')).toMatchObject({ used: 1, active: 1 })
  })

  it('keeps the concurrency slot consumed when successful completion is unknown', async () => {
    let failSuccessfulCompletion = true
    const shared = memoryCloudBase({
      failUpdate: ({ id, data }) => {
        if (failSuccessfulCompletion && id.startsWith('op:') && data.status === 'SUCCEEDED') {
          failSuccessfulCompletion = false
          return new Error('simulated finalization timeout')
        }
        return null
      },
    })
    const first = guard(shared)
    const second = guard(shared)
    await first.setControl({ mode: 'ENABLED', actorId: 'ADMIN-1' })
    const reserved = await first.reserve(request('unknown-completion'))
    await first.markAttempted(reserved.reservation)

    await expect(first.complete(reserved.reservation, { status: 'SUCCEEDED' })).rejects.toMatchObject({ code: 'AI_BUDGET_STORE_UNAVAILABLE', status: 503 })
    await expect(second.reserve(request('later', 'SRC-2'))).rejects.toMatchObject({ code: 'ON_DEMAND_AI_CONCURRENCY_REACHED', status: 429 })
    expect(shared.documents.get('day:2026-11-20')).toMatchObject({ used: 1, active: 1 })
  })
})
