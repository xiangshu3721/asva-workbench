import { describe, expect, it } from 'vitest'
import { AiBudgetGuardError, CloudBaseAiBudgetGuard, chinaDay, operationIdForSource } from './ai-budget-guard.mjs'

function memoryCloudBase() {
  const documents = new Map()
  let tail = Promise.resolve()
  const clone = (value) => value && structuredClone(value)
  const document = (id) => ({
    get: async () => ({ data: clone(documents.get(id)) || null }),
    set: async ({ data }) => { documents.set(id, clone(data)); return { updated: 1 } },
    update: async ({ data }) => {
      const current = documents.get(id)
      if (!current) throw new Error(`missing ${id}`)
      documents.set(id, { ...current, ...clone(data) })
      return { updated: 1 }
    },
  })
  const transaction = { collection: () => ({ doc: document }) }
  const db = {
    runTransaction: async (fn) => {
      let unlock
      const previous = tail
      tail = new Promise((resolve) => { unlock = resolve })
      await previous
      try { return { result: await fn(transaction) } } finally { unlock() }
    },
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

  it('fails closed under emergency pause and never treats a store fault as permission', async () => {
    const shared = memoryCloudBase()
    const enabled = guard(shared)
    const paused = guard(shared)
    await enabled.setControl({ mode: 'PAUSED', actorId: 'ADMIN-1' })
    await expect(paused.reserve(request('blocked'))).rejects.toMatchObject({ code: 'AI_BUDGET_EMERGENCY_PAUSED', status: 409 })

    const unavailable = new CloudBaseAiBudgetGuard({ collection: '', app: shared.app })
    await expect(unavailable.reserve(request('unavailable'))).rejects.toMatchObject({ code: 'AI_BUDGET_STORE_UNCONFIGURED', status: 409 })
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
})
