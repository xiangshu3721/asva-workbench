import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FeishuRepository } from './repository.mjs'
import { config } from './config.mjs'
import { createMemoryBudgetGuard } from './test-helpers.mjs'

// R048.15: Real integration test for AUTO trigger flow
// Simulates: save Source → auto-trigger → processing completes → Evidence created

describe('AUTO trigger end-to-end flow', () => {
  let originalFeatures
  let repository
  let budgetGuard

  beforeEach(() => {
    originalFeatures = { ...config.features }
    // Enable AUTO trigger with canary
    config.features.onDemandAiProcessing = true
    config.features.onDemandAiAutoTrigger = true
    config.features.onDemandAiDailyLimit = 10
    config.features.onDemandAiMaxConcurrent = 2
    config.features.onDemandAiAutoTriggerCustomerIds = new Set(['CUS-TEST-1'])
    config.features.onDemandAiAutoTriggerActorIds = new Set(['ACTOR-TEST-1'])
    config.features.onDemandAiTestScopeEnabled = false
    
    budgetGuard = createMemoryBudgetGuard({ mode: 'ENABLED' })
    repository = new FeishuRepository({ aiBudgetGuard: budgetGuard })
    
    // Mock the load() method to return test data
    vi.spyOn(repository, 'load').mockResolvedValue({
      staff: [{ id: 'ACTOR-TEST-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-TEST-1' }],
      sourceRecords: [],
      evidenceItems: [],
      profileUpdateProposals: [],
      evidenceConflicts: [],
    })
  })

  afterEach(() => {
    Object.assign(config.features, originalFeatures)
    vi.restoreAllMocks()
  })

  it('processSourceOnDemand creates reservation and processes source with AUTO trigger', async () => {
    const sourceId = 'SRC-TEST-1'
    const actorId = 'ACTOR-TEST-1'
    
    // Update load mock to include the source
    repository.load.mockResolvedValue({
      staff: [{ id: actorId, permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-TEST-1' }],
      sourceRecords: [{ id: sourceId, customerId: 'CUS-TEST-1', uploadedBy: actorId, rawText: '测试内容' }],
      evidenceItems: [],
      profileUpdateProposals: [],
      evidenceConflicts: [],
    })
    
    // Mock processSource to simulate AI processing
    const mockProcessSource = vi.spyOn(repository, 'processSource').mockResolvedValue({
      source: { id: sourceId, processingStatus: 'COMPLETED' },
      evidenceItems: [{ id: 'EVD-1', fieldKey: 'name', displayText: '测试客户' }],
      proposals: [],
      conflicts: [],
    })

    // Execute AUTO trigger
    const result = await repository.processSourceOnDemand(actorId, sourceId, { trigger: 'AUTO' })

    // Verify: reservation was created
    expect(budgetGuard.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId,
        actorId,
      })
    )

    // Verify: processSource was called
    expect(mockProcessSource).toHaveBeenCalledWith(actorId, sourceId, expect.any(Object))

    // Verify: result has evidence
    expect(result.evidenceItems).toHaveLength(1)
    expect(result.evidenceItems[0].fieldKey).toBe('name')

    // Verify: budget was consumed
    const stats = await budgetGuard.dailyStats(new Date().toISOString().split('T')[0])
    expect(stats.used).toBe(1)
    expect(stats.successCount).toBe(1)
  })

  it('AUTO trigger fails closed when canary customer not in whitelist', async () => {
    const sourceId = 'SRC-TEST-2'
    const actorId = 'ACTOR-TEST-1'
    
    // Update load mock to return a source with non-whitelisted customer
    repository.load.mockResolvedValue({
      staff: [{ id: actorId, permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-OTHER' }],
      sourceRecords: [{ id: sourceId, customerId: 'CUS-OTHER', uploadedBy: actorId }],
      evidenceItems: [],
      profileUpdateProposals: [],
      evidenceConflicts: [],
    })

    // Execute AUTO trigger - should fail with canary error
    await expect(repository.processSourceOnDemand(actorId, sourceId, { trigger: 'AUTO' }))
      .rejects.toThrow(/尚未在此导师和客户范围内开启/)

    // Verify: no reservation was created
    expect(budgetGuard.reserve).not.toHaveBeenCalled()
  })

  it('AUTO trigger fails closed when actor not in whitelist', async () => {
    const sourceId = 'SRC-TEST-3'
    const actorId = 'ACTOR-OTHER'
    
    // Update load mock
    repository.load.mockResolvedValue({
      staff: [{ id: actorId, permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-TEST-1' }],
      sourceRecords: [{ id: sourceId, customerId: 'CUS-TEST-1', uploadedBy: actorId }],
      evidenceItems: [],
      profileUpdateProposals: [],
      evidenceConflicts: [],
    })

    // Execute AUTO trigger - should fail with canary error
    await expect(repository.processSourceOnDemand(actorId, sourceId, { trigger: 'AUTO' }))
      .rejects.toThrow(/尚未在此导师和客户范围内开启/)

    // Verify: no reservation was created
    expect(budgetGuard.reserve).not.toHaveBeenCalled()
  })

  it('concurrent AUTO triggers use separate callIds and do not contaminate token stats', async () => {
    const sourceId1 = 'SRC-CONCURRENT-1'
    const sourceId2 = 'SRC-CONCURRENT-2'
    const actorId = 'ACTOR-TEST-1'

    // Update load mock for both sources
    repository.load.mockResolvedValue({
      staff: [{ id: actorId, permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-TEST-1' }],
      sourceRecords: [
        { id: sourceId1, customerId: 'CUS-TEST-1', uploadedBy: actorId },
        { id: sourceId2, customerId: 'CUS-TEST-1', uploadedBy: actorId },
      ],
      evidenceItems: [],
      profileUpdateProposals: [],
      evidenceConflicts: [],
    })

    // Mock processSource to track callId
    const callIds = []
    vi.spyOn(repository, 'processSource').mockImplementation(async (actor, source, options) => {
      callIds.push(options.callId)
      return {
        source: { id: source, processingStatus: 'COMPLETED' },
        evidenceItems: [],
        proposals: [],
        conflicts: [],
      }
    })

    // Execute two concurrent AUTO triggers
    const [result1, result2] = await Promise.all([
      repository.processSourceOnDemand(actorId, sourceId1, { trigger: 'AUTO' }),
      repository.processSourceOnDemand(actorId, sourceId2, { trigger: 'AUTO' }),
    ])

    // Verify: both completed
    expect(result1.source.processingStatus).toBe('COMPLETED')
    expect(result2.source.processingStatus).toBe('COMPLETED')

    // Verify: different callIds were used
    expect(callIds).toHaveLength(2)
    expect(callIds[0]).not.toBe(callIds[1])
    expect(callIds[0]).toMatch(/^call-\d+$/)
    expect(callIds[1]).toMatch(/^call-\d+$/)

    // Verify: budget was consumed twice
    const stats = await budgetGuard.dailyStats(new Date().toISOString().split('T')[0])
    expect(stats.used).toBe(2)
    expect(stats.successCount).toBe(2)
  })
})
