/**
 * R048.17 – onDemandTrigger propagation through processSource chain.
 * 
 * Verifies that when processSourceOnDemand is called with trigger='AUTO',
 * the trigger is propagated through processSource to processSourceUnsafe,
 * allowing automaticMode to be true even when legacy auto-archive is disabled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from './config.mjs'
import { FeishuRepository } from './repository.mjs'

const original = { ...config.features }

function budgetGuard() {
  const reservation = { _id: 'op-1', operationId: 'source:SRC-1:hash:evidence-v1', day: '2026-11-20', status: 'RESERVED' }
  return {
    reserve: vi.fn(async () => ({ duplicate: false, reservation })),
    markAttempted: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    control: vi.fn(async () => ({ mode: 'ENABLED' })),
  }
}

function databaseFor(source) {
  return {
    staff: [{ id: 'staff-admin-owner-001', permissionRole: 'ADMIN', role: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
    customers: [{ id: 'CUS-TEST-001', createdByStaffId: 'staff-admin-owner-001', profileFields: {} }],
    sourceRecords: [source],
  }
}

describe('R048.17 onDemandTrigger propagation', () => {
  beforeEach(() => {
    Object.assign(config.features, original, {
      onDemandAiProcessing: true,
      onDemandAiAutoTrigger: true,
      onDemandAiDailyLimit: 100,
      onDemandAiMaxConcurrent: 2,
      onDemandAiAutoTriggerActorIds: new Set(['staff-admin-owner-001']),
      onDemandAiAutoTriggerCustomerIds: new Set(['CUS-TEST-001']),
      onDemandAiTestScopeEnabled: false,
    })
  })
  
  afterEach(() => {
    Object.assign(config.features, original)
  })
  
  it('propagates trigger=AUTO through processSource to processSourceUnsafe', async () => {
    const source = {
      id: 'SRC-AUTO-001',
      customerId: 'CUS-TEST-001',
      uploadedBy: 'staff-admin-owner-001',
      rawText: 'test',
      processingStatus: 'UPLOADED',
      notes: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_UPDATE',
      uploadedAt: new Date().toISOString(),
      contentHash: 'hash',
    }
    const guard = budgetGuard()
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(source))
    
    // Capture the options passed to processSource
    let capturedOptions = null
    repository.processSource = vi.fn(async (actorId, sourceId, options) => {
      capturedOptions = options
      return { 
        source: { ...source, id: sourceId, processingStatus: 'COMPLETED' },
        evidenceItems: [],
        proposals: [],
        conflicts: [],
      }
    })
    
    await repository.processSourceOnDemand('staff-admin-owner-001', 'SRC-AUTO-001', { trigger: 'AUTO' })
    
    // Verify trigger was propagated
    expect(capturedOptions).toMatchObject({
      onDemand: true,
      onDemandTrigger: 'AUTO',
    })
  })
  
  it('propagates trigger=MANUAL through processSource to processSourceUnsafe', async () => {
    const source = {
      id: 'SRC-MANUAL-001',
      customerId: 'CUS-TEST-001',
      uploadedBy: 'staff-admin-owner-001',
      rawText: 'test',
      processingStatus: 'UPLOADED',
      notes: '',
      uploadedAt: new Date().toISOString(),
      contentHash: 'hash',
    }
    const guard = budgetGuard()
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: guard })
    repository.load = vi.fn(async () => databaseFor(source))
    
    let capturedOptions = null
    repository.processSource = vi.fn(async (actorId, sourceId, options) => {
      capturedOptions = options
      return { 
        source: { ...source, id: sourceId, processingStatus: 'COMPLETED' },
        evidenceItems: [],
        proposals: [],
        conflicts: [],
      }
    })
    
    await repository.processSourceOnDemand('staff-admin-owner-001', 'SRC-MANUAL-001', { trigger: 'MANUAL' })
    
    expect(capturedOptions).toMatchObject({
      onDemand: true,
      onDemandTrigger: 'MANUAL',
    })
  })
  
  it('processSource passes onDemandTrigger to processSourceUnsafe', async () => {
    const source = {
      id: 'SRC-CHAIN-001',
      customerId: 'CUS-TEST-001',
      uploadedBy: 'staff-admin-owner-001',
      rawText: 'test',
      processingStatus: 'UPLOADED',
      notes: '',
      uploadedAt: new Date().toISOString(),
      contentHash: 'hash',
    }
    const repository = new FeishuRepository({ authRepository: {}, aiBudgetGuard: budgetGuard() })
    repository.load = vi.fn(async () => databaseFor(source))
    
    let capturedOptions = null
    repository.processSourceUnsafe = vi.fn(async (actorId, sourceId, options) => {
      capturedOptions = options
      return { 
        source: { ...source, id: sourceId, processingStatus: 'COMPLETED' },
        evidenceItems: [],
        proposals: [],
        conflicts: [],
      }
    })
    
    await repository.processSource('staff-001', 'SRC-CHAIN-001', { onDemand: true, onDemandTrigger: 'AUTO' })
    
    expect(capturedOptions).toMatchObject({
      onDemand: true,
      onDemandTrigger: 'AUTO',
    })
  })
})
