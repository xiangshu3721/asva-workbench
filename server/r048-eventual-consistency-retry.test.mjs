import { describe, expect, it, vi } from 'vitest'

// Set up environment variables BEFORE importing repository/config modules
process.env.FEATURE_ON_DEMAND_AI_PROCESSING = 'true'
process.env.FEATURE_ON_DEMAND_AI_AUTO_TRIGGER = 'true'
process.env.ON_DEMAND_AI_DAILY_LIMIT = '10'
process.env.ON_DEMAND_AI_MAX_CONCURRENT = '2'

const { FeishuRepository } = await import('./repository.mjs')

/**
 * R048.17 — Feishu eventual consistency retry test.
 *
 * Background: When a source is created via POST /api/sources, the AUTO trigger
 * calls processSourceOnDemand() immediately after createSource() returns.
 * createSource() invalidates the database cache, and processSourceOnDemand()
 * reloads from Feishu. However, Feishu's API has eventual consistency — the
 * newly written record may not be immediately visible.
 *
 * This test verifies that processSourceOnDemand() retries the load up to 3 times
 * with exponential backoff (1s, 2s) when the source is not yet visible.
 */

describe('R048.17 — Feishu eventual consistency retry', () => {
  it('retries loading the source when not found on first attempt due to Feishu eventual consistency', async () => {
    const testSource = {
      id: 'SRC-TEST-1',
      customerId: 'CUS-TEST-1',
      rawText: '测试原文',
      processingStatus: 'UPLOADED',
      uploadedBy: 'staff-admin-001',
      contentHash: 'abc123',
      createdAt: '2026-11-24T00:00:00.000Z',
    }

    const testCustomer = { id: 'CUS-TEST-1', name: '测试客户' }
    const testStaff = { id: 'staff-admin-001', permissionRole: 'ADMIN', loginEnabled: true, status: 'ACTIVE' }

    let loadCallCount = 0
    const repository = new FeishuRepository({
      aiBudgetGuard: {
        reserve: vi.fn(async () => ({ reservation: { status: 'RESERVED' }, duplicate: false })),
        markAttempted: vi.fn(async () => ({})),
        complete: vi.fn(async () => ({})),
        release: vi.fn(async () => ({})),
      },
    })

    // Mock the load method to simulate Feishu eventual consistency
    repository.load = async function () {
      loadCallCount++
      let data
      // First 2 calls: source not yet visible (Feishu eventual consistency)
      // 3rd call: source becomes visible
      if (loadCallCount <= 2) {
        data = {
          sourceRecords: [],
          evidenceItems: [],
          profileUpdateProposals: [],
          customers: [testCustomer],
          profileChanges: [],
          staff: [testStaff],
        }
      } else {
        data = {
          sourceRecords: [testSource],
          evidenceItems: [],
          profileUpdateProposals: [],
          customers: [testCustomer],
          profileChanges: [],
          staff: [testStaff],
        }
      }
      repository.databaseCache.data = data
      repository.databaseCache.savedAt = Date.now()
      return data
    }

    // Mock processSource to avoid actual AI processing
    repository.processSource = vi.fn(async () => ({
      status: 'COMPLETED',
      sourceId: testSource.id,
    }))

    // Use fake timers to avoid actual delays
    vi.useFakeTimers()

    const processPromise = repository.processSourceOnDemand('staff-admin-001', 'SRC-TEST-1', { trigger: 'MANUAL' })

    // Advance timers for the retry delays (1s, 2s)
    // First attempt: load fails (loadCallCount=1)
    // Wait 1s
    await vi.advanceTimersByTimeAsync(1000)
    // Second attempt: load fails (loadCallCount=2)
    // Wait 2s
    await vi.advanceTimersByTimeAsync(2000)
    // Third attempt: load succeeds (loadCallCount=3)
    // processSource is called

    const result = await processPromise

    vi.useRealTimers()

    // Verify: the source was found after 3 load attempts
    expect(loadCallCount).toBe(3)
    expect(result).toBeDefined()
  })

  it('throws SOURCE_NOT_FOUND after exhausting all retries', async () => {
    const testCustomer = { id: 'CUS-TEST-1', name: '测试客户' }
    const testStaff = { id: 'staff-admin-001', permissionRole: 'ADMIN', loginEnabled: true, status: 'ACTIVE' }

    let loadCallCount = 0
    const repository = new FeishuRepository({
      aiBudgetGuard: {
        reserve: vi.fn(async () => ({ reservation: { status: 'RESERVED' }, duplicate: false })),
        markAttempted: vi.fn(async () => ({})),
        complete: vi.fn(async () => ({})),
        release: vi.fn(async () => ({})),
      },
    })

    repository.load = async function () {
      loadCallCount++
      // Source is never visible (simulating a real missing source)
      const data = {
        sourceRecords: [],
        evidenceItems: [],
        profileUpdateProposals: [],
        customers: [testCustomer],
        profileChanges: [],
        staff: [testStaff],
      }
      repository.databaseCache.data = data
      repository.databaseCache.savedAt = Date.now()
      return data
    }

    vi.useFakeTimers()

    const processPromise = repository.processSourceOnDemand('staff-admin-001', 'SRC-NOT-EXIST', { trigger: 'MANUAL' })

    // Attach rejection handler immediately to prevent unhandled rejection warnings
    const caughtPromise = processPromise.catch(error => error)

    // Advance timers through all 3 retry attempts (1s + 2s delays)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)

    const error = await caughtPromise
    vi.useRealTimers()

    // Verify: exactly 3 load attempts were made (initial + 2 retries)
    expect(loadCallCount).toBe(3)
    expect(error.code).toBe('SOURCE_NOT_FOUND')
  })

  it('finds the source on the first attempt when Feishu is consistent', async () => {
    const testSource = {
      id: 'SRC-TEST-1',
      customerId: 'CUS-TEST-1',
      rawText: '测试原文',
      processingStatus: 'UPLOADED',
      uploadedBy: 'staff-admin-001',
      contentHash: 'abc123',
    }

    const testCustomer = { id: 'CUS-TEST-1', name: '测试客户' }
    const testStaff = { id: 'staff-admin-001', permissionRole: 'ADMIN', loginEnabled: true, status: 'ACTIVE' }

    let loadCallCount = 0
    const repository = new FeishuRepository({
      aiBudgetGuard: {
        reserve: vi.fn(async () => ({ reservation: { status: 'RESERVED' }, duplicate: false })),
        markAttempted: vi.fn(async () => ({})),
        complete: vi.fn(async () => ({})),
        release: vi.fn(async () => ({})),
      },
    })

    repository.load = async function () {
      loadCallCount++
      // Source is immediately visible (normal case)
      const data = {
        sourceRecords: [testSource],
        evidenceItems: [],
        profileUpdateProposals: [],
        customers: [testCustomer],
        profileChanges: [],
        staff: [testStaff],
      }
      repository.databaseCache.data = data
      repository.databaseCache.savedAt = Date.now()
      return data
    }

    repository.processSource = vi.fn(async () => ({
      status: 'COMPLETED',
      sourceId: testSource.id,
    }))

    const result = await repository.processSourceOnDemand('staff-admin-001', 'SRC-TEST-1', { trigger: 'MANUAL' })

    // Verify: only 1 load attempt was made (no retries needed)
    expect(loadCallCount).toBe(1)
    expect(result).toBeDefined()
  })
})
