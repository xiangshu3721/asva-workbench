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

describe('on-demand source processing', () => {
  beforeEach(() => {
    Object.assign(config.features, original, {
      onDemandAiProcessing: true,
      onDemandAiAutoTrigger: false,
      onDemandAiDailyLimit: 2,
      onDemandAiMaxChars: 4000,
      onDemandAiMaxTokens: 2048,
      onDemandAiTimeoutMs: 45_000,
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
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => databaseFor(source))
    repository.processSource = vi.fn(async (_actorId, sourceId, options) => ({ source: { ...source, id: sourceId, processingStatus: 'COMPLETED' }, evidenceItems: [], proposals: [], conflicts: [], options }))

    const result = await repository.processSourceOnDemand('ADMIN-1', 'SRC-1', { trigger: 'MANUAL' })

    expect(result.source.processingStatus).toBe('COMPLETED')
    expect(repository.processSource).toHaveBeenCalledTimes(1)
    expect(repository.processSource).toHaveBeenCalledWith('ADMIN-1', 'SRC-1', { onDemand: true })
  })

  it('does not call the model for completed sources or oversized input', async () => {
    const completed = { id: 'SRC-DONE', customerId: 'CUS-1', rawText: '已整理资料', processingStatus: 'COMPLETED' }
    const repository = new FeishuRepository({ authRepository: {} })
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
})
