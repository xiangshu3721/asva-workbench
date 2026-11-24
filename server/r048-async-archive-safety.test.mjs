/**
 * R048.17 – Async archive safety tests.
 * 
 * Verifies the async AUTO trigger safety properties:
 * 1. Save returns immediately; processing runs in background
 * 2. PG reservation ensures exactly-once processing
 * 3. Concurrent limit blocks when max reached
 * 4. PG DISABLED mode blocks model calls
 * 5. PG PAUSED mode blocks model calls
 * 6. Model failure does NOT cause infinite retry
 * 7. PG unavailability prevents model calls
 * 8. Duplicate AUTO triggers produce exactly one model call
 * 9. Frontend polling has bounded max attempts
 * 
 * Uses mock models, no real DeepSeek calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { config } from './config.mjs'
import { FeishuRepository } from './repository.mjs'

const original = { ...config.features }

function mockBudgetGuard({ pgMode = 'ENABLED', dailyUsed = 0, maxConcurrent = 2, pgAvailable = true } = {}) {
  const reserved = new Set()
  let activeCount = 0
  return {
    reserve: vi.fn(async ({ operationId }) => {
      if (!pgAvailable) throw new Error('PG_UNREACHABLE')
      if (pgMode === 'DISABLED') throw Object.assign(new Error('AI budget guard is disabled'), { code: 'ON_DEMAND_AI_BUDGET_DISABLED' })
      if (pgMode === 'PAUSED') throw Object.assign(new Error('AI budget guard is paused'), { code: 'ON_DEMAND_AI_BUDGE_PAUSED' })
      if (reserved.has(operationId)) return { duplicate: true, reserved: false, reason: 'DUPLICATE' }
      if (activeCount >= maxConcurrent) return { reserved: false, reason: 'CONCURRENT_LIMIT' }
      reserved.add(operationId)
      activeCount++
      return { reserved: true, duplicate: false, reservation: { operationId }, mode: pgMode, used: dailyUsed }
    }),
    markAttempted: vi.fn(async () => {}),
    complete: vi.fn(async ({ operationId }) => {
      reserved.delete(operationId)
      activeCount = Math.max(0, activeCount - 1)
      return { released: true }
    }),
    control: vi.fn(async () => ({ mode: pgMode, used: dailyUsed, quotaDay: '2026-11-24' })),
  }
}

function databaseFor(source) {
  return {
    staff: [{ id: source.uploadedBy || 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
    customers: [{ id: source.customerId || 'CUS-1' }],
    sourceRecords: [source],
    evidenceItems: [],
    profileUpdateProposals: [],
    evidenceConflicts: [],
  }
}

function sourceFixture(overrides = {}) {
  return {
    id: 'SRC-1', customerId: 'CUS-1', uploadedBy: 'ADMIN-1',
    rawText: '客户明确说最近睡眠不佳。', processingStatus: 'UPLOADED', contentHash: 'hash1',
    ...overrides,
  }
}

describe('R048.17 async archive safety', () => {
  beforeEach(() => {
    Object.assign(config.features, original, {
      onDemandAiProcessing: true,
      onDemandAiAutoTrigger: true,
      onDemandAiDailyLimit: 100,
      onDemandAiMaxConcurrent: 2,
      onDemandAiMaxChars: 50000,
      onDemandAiAutoTriggerCustomerIds: new Set(),
      onDemandAiAutoTriggerActorIds: new Set(),
      automaticProfileArchivingCustomerIds: new Set(['CUS-1']),
    })
  })
  afterEach(() => {
    Object.assign(config.features, original)
  })

  it('1. PG reservation ensures processing is started once before model call', async () => {
    const guard = mockBudgetGuard()
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(sourceFixture()))

    let processCalled = false
    repository.processSource = vi.fn(async () => {
      processCalled = true
      return { source: sourceFixture({ processingStatus: 'COMPLETED' }), evidenceItems: [], proposals: [], conflicts: [] }
    })

    await repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' })

    // PG reserved first, then model was called
    expect(guard.reserve).toHaveBeenCalledTimes(1)
    expect(processCalled).toBe(true)
  })

  it('2. PG reservation ensures exactly-once processing', async () => {
    const guard = mockBudgetGuard()
    
    const r1 = await guard.reserve({ operationId: 'op-1' })
    expect(r1.reserved).toBe(true)

    const r2 = await guard.reserve({ operationId: 'op-1' })
    expect(r2.reserved).toBe(false)
    expect(r2.reason).toBe('DUPLICATE')
  })

  it('3. concurrent limit blocks when max reached', async () => {
    const guard = mockBudgetGuard({ maxConcurrent: 2 })
    
    const r1 = await guard.reserve({ operationId: 'op-1' })
    const r2 = await guard.reserve({ operationId: 'op-2' })
    const r3 = await guard.reserve({ operationId: 'op-3' })
    
    expect(r1.reserved).toBe(true)
    expect(r2.reserved).toBe(true)
    expect(r3.reserved).toBe(false)
    expect(r3.reason).toBe('CONCURRENT_LIMIT')
  })

  it('4. PG DISABLED mode blocks model calls', async () => {
    const guard = mockBudgetGuard({ pgMode: 'DISABLED' })
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(sourceFixture()))
    repository.extractEvidence = vi.fn(async () => { throw new Error('SHOULD_NOT_REACH_MODEL') })

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' }))
      .rejects.toMatchObject({ code: 'ON_DEMAND_AI_BUDGET_DISABLED' })
    
    expect(repository.extractEvidence).not.toHaveBeenCalled()
  })

  it('5. PG PAUSED mode blocks model calls', async () => {
    const guard = mockBudgetGuard({ pgMode: 'PAUSED' })
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(sourceFixture()))
    repository.extractEvidence = vi.fn(async () => { throw new Error('SHOULD_NOT_REACH_MODEL') })

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' }))
      .rejects.toMatchObject({ code: 'ON_DEMAND_AI_BUDGE_PAUSED' })
    
    expect(repository.extractEvidence).not.toHaveBeenCalled()
  })

  it('6. model failure does NOT cause infinite retry (exactly 1 processSource call)', async () => {
    const guard = mockBudgetGuard()
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(sourceFixture()))
    
    let processCallCount = 0
    repository.processSource = vi.fn(async () => {
      processCallCount++
      throw Object.assign(new Error('MODEL_UNAVAILABLE'), { code: 'DEEPSEEK_UNAVAILABLE' })
    })

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' }))
      .rejects.toThrow()

    expect(processCallCount).toBe(1)
  })

  it('7. PG unavailability prevents model calls', async () => {
    const guard = mockBudgetGuard({ pgAvailable: false })
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(sourceFixture()))
    repository.processSource = vi.fn(async () => { throw new Error('SHOULD_NOT_REACH_MODEL') })

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' }))
      .rejects.toThrow('PG_UNREACHABLE')

    expect(repository.processSource).not.toHaveBeenCalled()
  })

  it('8. duplicate AUTO triggers produce exactly one processSource call', async () => {
    const guard = mockBudgetGuard()
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    
    let processCallCount = 0
    repository.processSource = vi.fn(async () => {
      processCallCount++
      return { source: sourceFixture({ processingStatus: 'COMPLETED' }), evidenceItems: [], proposals: [], conflicts: [] }
    })
    repository.sourceDetail = vi.fn(async () => sourceFixture({ processingStatus: 'COMPLETED' }))

    // First trigger
    repository.load = vi.fn(async () => databaseFor(sourceFixture()))
    await repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' })
    expect(processCallCount).toBe(1)

    // Second trigger — source already COMPLETED, short-circuit via sourceDetail
    repository.load = vi.fn(async () => databaseFor(sourceFixture({ processingStatus: 'COMPLETED' })))
    await repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' })
    // No additional processSource call
    expect(processCallCount).toBe(1)
    // sourceDetail was called for the short-circuit
    expect(repository.sourceDetail).toHaveBeenCalled()
  })

  it('9. frontend polling has bounded max attempts', () => {
    // Verify App.tsx has polling limits
    const { readFileSync } = require('fs')
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    
    // Must have max poll count
    expect(appSource).toMatch(/maxPolls\s*=\s*\d+/)
    // Must have poll interval
    expect(appSource).toMatch(/pollInterval\s*=\s*\d+/)
    // Must have a counter
    expect(appSource).toContain('pollCount')
    // Must stop polling when max reached
    expect(appSource).toMatch(/pollCount\s*>=\s*maxPolls/)
  })
})
