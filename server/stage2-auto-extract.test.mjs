import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from './config.mjs'
import { FeishuRepository } from './repository.mjs'
import { contentHash } from '../shared/evidence-contract.mjs'

describe('stage 2 customer extract orchestration', () => {
  const originalEnabled = config.features.automaticProfileArchiving
  const originalMode = config.features.automaticProfileArchivingMode
  const originalCanary = config.features.automaticProfileArchivingCanary
  const originalAllowlist = config.features.automaticProfileCanaryCustomerIds

  beforeEach(() => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    config.features.automaticProfileArchivingCanary = false
    config.features.automaticProfileCanaryCustomerIds = new Set()
  })

  afterEach(() => {
    config.features.automaticProfileArchiving = originalEnabled
    config.features.automaticProfileArchivingMode = originalMode
    config.features.automaticProfileArchivingCanary = originalCanary
    config.features.automaticProfileCanaryCustomerIds = originalAllowlist
  })

  function database(source, evidenceItems = []) {
    return {
      customers: [{ id: 'CUS-STAGE2-1', notes: '客户正在准备职业转型。', need: '', helpExpectation: '', goal: '', automaticProfilePending: { contentHash: contentHash('客户正在准备职业转型。'), reason: 'CUSTOMER_SAVE', actorId: 'ADMIN-1' } }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: source ? [source] : [],
      evidenceItems,
      profileUpdateProposals: [],
      evidenceConflicts: [],
    }
  }

  it('creates one stable Source, calls Extract only, and reuses persisted Evidence on retry', async () => {
    const source = { id: 'SRC-STAGE2-1', customerId: 'CUS-STAGE2-1', contentHash: contentHash('客户正在准备职业转型。'), notes: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE', processingStatus: 'UPLOADED', _recordId: 'rec-source-1' }
    const evidence = { id: 'EVD-STAGE2-1', sourceId: source.id, reviewStatus: 'UNREVIEWED', displayText: '客户正在准备职业转型。' }
    let extracted = false
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => extracted ? database({ ...source, processingStatus: 'COMPLETED' }, [evidence]) : database(source))
    repository.createAutomaticProfileSource = vi.fn(async () => ({ status: extracted ? 'SOURCE_REUSED' : 'SOURCE_CREATED', source: { ...source, processingStatus: extracted ? 'COMPLETED' : 'UPLOADED' }, reused: extracted }))
    repository.processSource = vi.fn(async (_actorId, _sourceId, options) => { expect(options).toEqual({ stage: 'extract' }); extracted = true; return { source: { ...source, processingStatus: 'COMPLETED' } } })

    const first = await repository.runCustomerAutoArchive('ADMIN-1', 'CUS-STAGE2-1')
    const second = await repository.runCustomerAutoArchive('ADMIN-1', 'CUS-STAGE2-1')

    expect(first).toMatchObject({ status: 'EXTRACT_READY', sourceId: source.id, evidenceCount: 1, proposalCount: 0, conflictCount: 0 })
    expect(second).toMatchObject({ status: 'EXTRACT_READY', sourceId: source.id, reused: true, evidenceCount: 1 })
    expect(repository.createAutomaticProfileSource).toHaveBeenCalledTimes(2)
    expect(repository.processSource).toHaveBeenCalledTimes(1)
  })

  it('uses the customer-and-content hash as a stable Source identity', async () => {
    let source = null
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => database(source))
    repository.createSource = vi.fn(async (_actorId, input) => {
      source = { id: 'SRC-STAGE2-IDEMPOTENT', customerId: input.customerId, contentHash: contentHash(input.rawText), notes: input.notes, processingStatus: 'UPLOADED' }
      return source
    })

    const first = await repository.createAutomaticProfileSource('ADMIN-1', 'CUS-STAGE2-1', '客户正在准备职业转型。', 'CUSTOMER_SAVE')
    const second = await repository.createAutomaticProfileSource('ADMIN-1', 'CUS-STAGE2-1', '客户正在准备职业转型。', 'CUSTOMER_SAVE')

    expect(first.status).toBe('SOURCE_CREATED')
    expect(second).toMatchObject({ status: 'SOURCE_REUSED', reused: true, source: { id: source.id } })
    expect(repository.createSource).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the feature gate is disabled without calling Source or model work', async () => {
    config.features.automaticProfileArchiving = false
    const repository = new FeishuRepository({ authRepository: {} })
    repository.createAutomaticProfileSource = vi.fn()
    repository.processSource = vi.fn()

    const result = await repository.runCustomerAutoArchive('ADMIN-1', 'CUS-STAGE2-1')

    expect(result).toMatchObject({ status: 'DISABLED', errorCode: 'FEATURE_GATE' })
    expect(repository.createAutomaticProfileSource).not.toHaveBeenCalled()
    expect(repository.processSource).not.toHaveBeenCalled()
  })

  it('does not run Extract for a customer without the persisted CUSTOMER_SAVE marker', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => ({ ...database(null), customers: [{ id: 'CUS-STAGE2-1', notes: '普通历史资料', need: '', helpExpectation: '', goal: '' }] }))
    repository.createAutomaticProfileSource = vi.fn()
    repository.processSource = vi.fn()

    const result = await repository.runCustomerAutoArchive('ADMIN-1', 'CUS-STAGE2-1')

    expect(result).toMatchObject({ status: 'NOT_REQUIRED', phase: 'CREATE_ONLY', errorCode: 'CREATE_ONLY' })
    expect(repository.createAutomaticProfileSource).not.toHaveBeenCalled()
    expect(repository.processSource).not.toHaveBeenCalled()
  })
})
