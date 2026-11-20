import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from './config.mjs'
import { FeishuRepository } from './repository.mjs'

const original = { ...config.features }

function databaseFor(source) {
  return {
    staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', role: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
    customers: [{ id: 'CUS-1', createdByStaffId: 'ADMIN-1', profileFields: {} }],
    sourceRecords: [source],
  }
}

function budgetGuard({ duplicate = false, reservationStatus = 'RESERVED' } = {}) {
  const reservation = { _id: 'op-1', operationId: 'source:SRC-1:hash:evidence-v1', day: '2026-11-20', status: reservationStatus }
  return {
    reserve: vi.fn(async () => ({ duplicate, reservation })),
    markAttempted: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    control: vi.fn(async () => ({ mode: 'DISABLED' })),
    setControl: vi.fn(async () => ({ mode: 'DISABLED' })),
  }
}

describe('on-demand source processing', () => {
  beforeEach(() => {
    Object.assign(config.features, original, {
      onDemandAiProcessing: true,
      onDemandAiAutoTrigger: false,
      onDemandAiDailyLimit: 2,
      onDemandAiMaxChars: 4000,
      onDemandAiMaxTokens: 2048,
      onDemandAiTimeoutMs: 45_000,
      onDemandAiMaxConcurrent: 1,
    })
  })
  afterEach(() => Object.assign(config.features, original))

  it('fails closed before reading data when the endpoint switch is off', async () => {
    config.features.onDemandAiProcessing = false
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn()

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1')).rejects.toMatchObject({ code: 'ON_DEMAND_AI_DISABLED', status: 409 })
    expect(repository.load).not.toHaveBeenCalled()
  })

  it('rejects save-triggered AI when the separate auto switch is off', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn()

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' })).rejects.toMatchObject({ code: 'ON_DEMAND_AI_AUTO_TRIGGER_DISABLED', status: 409 })
    expect(repository.load).not.toHaveBeenCalled()
  })

  it('keeps save-triggered AI closed even if a stale auto flag is set without a hard quota', async () => {
    config.features.onDemandAiAutoTrigger = true
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn()

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'AUTO' })).rejects.toMatchObject({ code: 'ON_DEMAND_AI_AUTO_TRIGGER_DISABLED', status: 409 })
    expect(repository.load).not.toHaveBeenCalled()
  })

  it('starts at most one explicitly requested processing call with on-demand limits', async () => {
    const source = { id: 'SRC-1', customerId: 'CUS-1', rawText: '客户明确说最近睡眠不佳。', processingStatus: 'UPLOADED' }
    const guard = budgetGuard()
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(source))
    repository.processSource = vi.fn(async (_actorId, sourceId, options) => ({ source: { ...source, id: sourceId, processingStatus: 'COMPLETED' }, evidenceItems: [], proposals: [], conflicts: [], options }))

    const result = await repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'MANUAL' })

    expect(result.source.processingStatus).toBe('COMPLETED')
    expect(repository.processSource).toHaveBeenCalledTimes(1)
    expect(repository.processSource).toHaveBeenCalledWith('ADMIN-1', 'SRC-1', { onDemand: true })
    expect(guard.reserve).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'SRC-1', dailyLimit: 2, maxConcurrent: 1 }))
    expect(guard.markAttempted).toHaveBeenCalledTimes(1)
    expect(guard.complete).toHaveBeenCalledWith(expect.any(Object), { status: 'SUCCEEDED' })
  })

  it('does not call the model for completed sources or oversized input', async () => {
    const completed = { id: 'SRC-DONE', customerId: 'CUS-1', rawText: '已整理资料', processingStatus: 'COMPLETED' }
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: budgetGuard() })
    repository.load = vi.fn(async () => databaseFor(completed))
    repository.sourceDetail = vi.fn(async () => ({ source: completed, evidenceItems: [], proposals: [], conflicts: [] }))
    repository.processSource = vi.fn()

    await repository.processSourceOnDemand('ADMIN-1', 'SRC-DONE')
    expect(repository.processSource).not.toHaveBeenCalled()

    const tooLarge = { ...completed, id: 'SRC-LARGE', rawText: '甲'.repeat(4001), processingStatus: 'UPLOADED' }
    repository.load = vi.fn(async () => databaseFor(tooLarge))
    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-LARGE')).rejects.toMatchObject({ code: 'ON_DEMAND_AI_INPUT_TOO_LARGE', status: 413 })
    expect(repository.processSource).not.toHaveBeenCalled()
  })

  it('does not reissue the model call when a persistent reservation already exists', async () => {
    const source = { id: 'SRC-1', customerId: 'CUS-1', rawText: '客户明确说最近睡眠不佳。', processingStatus: 'UPLOADED' }
    const guard = budgetGuard({ duplicate: true, reservationStatus: 'ATTEMPTED' })
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(source))
    repository.processSource = vi.fn()

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1')).rejects.toMatchObject({ code: 'ON_DEMAND_AI_DUPLICATE_OPERATION', status: 409 })
    expect(repository.processSource).not.toHaveBeenCalled()
    expect(guard.markAttempted).not.toHaveBeenCalled()
  })

  it('closes the request if durable finalization cannot be confirmed', async () => {
    const source = { id: 'SRC-1', customerId: 'CUS-1', rawText: '客户明确说最近睡眠不佳。', processingStatus: 'UPLOADED' }
    const guard = budgetGuard()
    guard.complete.mockRejectedValue(Object.assign(new Error('storage unavailable'), { code: 'AI_BUDGET_STORE_UNAVAILABLE', status: 503 }))
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(source))
    repository.processSource = vi.fn(async () => ({ source, evidenceItems: [], proposals: [], conflicts: [] }))

    await expect(repository.processSourceOnDemand('ADMIN-1', 'SRC-1')).rejects.toMatchObject({ code: 'AI_BUDGET_STORE_UNAVAILABLE', status: 503 })
    expect(repository.processSource).toHaveBeenCalledTimes(1)
  })
})
