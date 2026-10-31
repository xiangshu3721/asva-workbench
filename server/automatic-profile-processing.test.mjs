import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from './config.mjs'
import { FeishuRepository } from './repository.mjs'
import { contentHash } from '../shared/evidence-contract.mjs'

describe('automatic customer profile processing', () => {
  const originalAppEnv = config.appEnv
  const originalEnabled = config.features.automaticProfileArchiving
  const originalMode = config.features.automaticProfileArchivingMode
  const originalEnabledAt = config.features.automaticProfileArchivingEnabledAt
  const originalCanary = config.features.automaticProfileArchivingCanary
  const originalAllowlist = config.features.automaticProfileCanaryCustomerIds

  beforeEach(() => { config.features.automaticProfileArchiving = true; config.features.automaticProfileArchivingMode = 'off'; config.features.automaticProfileArchivingEnabledAt = ''; config.features.automaticProfileArchivingCanary = false; config.features.automaticProfileCanaryCustomerIds = new Set() })
  afterEach(() => { config.appEnv = originalAppEnv; config.features.automaticProfileArchiving = originalEnabled; config.features.automaticProfileArchivingMode = originalMode; config.features.automaticProfileArchivingEnabledAt = originalEnabledAt; config.features.automaticProfileArchivingCanary = originalCanary; config.features.automaticProfileCanaryCustomerIds = originalAllowlist })

  it('does not create a source or start recovery when automatic archiving is disabled', async () => {
    config.features.automaticProfileArchiving = false
    const repository = new FeishuRepository({ authRepository: {} })
    repository.createSource = vi.fn()
    repository.startAutomaticProcessingRecovery = vi.fn()

    await expect(repository.queueAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-OFF', '客户资料', 'CUSTOMER_SAVE')).resolves.toEqual({ status: 'DISABLED' })
    await expect(repository.recoverAutomaticProcessing()).resolves.toEqual({ status: 'DISABLED', scheduledCustomers: 0, scheduledSources: 0 })
    expect(repository.createSource).not.toHaveBeenCalled()
    expect(repository.startAutomaticProcessingRecovery).not.toHaveBeenCalled()
  })

  it('queues saved customer text with a stable content operation without a second Event(process)', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    const created = []
    repository.createSource = vi.fn(async (_actorId, input) => {
      created.push(input)
      return { id: 'SRC-AUTO-1', ...input, processingStatus: 'UPLOADED' }
    })
    repository.scheduleAutomaticProcessing = vi.fn()

    const first = await repository.queueAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-1', '客户最近在考虑职业转型。', 'CUSTOMER_SAVE')
    const second = await repository.queueAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-1', '客户最近在考虑职业转型。', 'CUSTOMER_UPDATE')

    expect(first).toEqual({ status: 'QUEUED', sourceId: 'SRC-AUTO-1' })
    expect(second).toEqual({ status: 'QUEUED', sourceId: 'SRC-AUTO-1' })
    expect(created).toHaveLength(2)
    expect(created[0]).toMatchObject({ customerId: 'CUS-AUTO-1', sourceType: 'TEXT_INPUT', sourcePerspective: 'STAFF_REPORTED' })
    expect(created[0].operationId).toBe(created[1].operationId)
    expect(created[0].notes).toContain('AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE')
    // Authoritative recover Event owns processSource; queue must not fire Event(process).
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalled()
  })

  it('keeps the original save successful when automatic source queuing is unavailable', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.createSource = vi.fn(async () => { throw Object.assign(new Error('synthetic source unavailable'), { code: 'FEISHU_UNAVAILABLE' }) })

    await expect(repository.queueAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-2', '客户资料', 'CUSTOMER_SAVE')).resolves.toMatchObject({ status: 'PENDING', errorCode: 'FEISHU_UNAVAILABLE' })
  })

  it('does not queue empty automatic input', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.createSource = vi.fn()

    await expect(repository.queueAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-3', '   ', 'CUSTOMER_SAVE')).resolves.toEqual({ status: 'NOT_REQUIRED' })
    expect(repository.createSource).not.toHaveBeenCalled()
  })

  it('fails closed for customers outside the Canary allowlist', async () => {
    config.features.automaticProfileArchivingMode = 'canary'
    config.features.automaticProfileArchivingCanary = true
    config.features.automaticProfileCanaryCustomerIds = new Set(['CUS-AUTO-ALLOWED'])
    const repository = new FeishuRepository({ authRepository: {} })
    repository.createSource = vi.fn()
    repository.scheduleAutomaticProcessing = vi.fn()

    await expect(repository.queueAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-BLOCKED', '客户资料', 'CUSTOMER_SAVE')).resolves.toEqual({ status: 'DISABLED' })
    expect(repository.scheduleAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-BLOCKED', '客户资料', 'CUSTOMER_SAVE')).toEqual({ status: 'DISABLED' })
    expect(repository.scheduleAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-ALLOWED', '客户资料', 'CUSTOMER_SAVE')).toMatchObject({ status: 'QUEUED', workerScheduled: true })
    expect(repository.createSource).not.toHaveBeenCalled()
  })

  it('recovers only allowlisted pending customers and sources in Canary mode', async () => {
    config.features.automaticProfileArchivingMode = 'canary'
    config.features.automaticProfileArchivingCanary = true
    config.features.automaticProfileCanaryCustomerIds = new Set(['CUS-AUTO-ALLOWED'])
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => ({
      customers: [
        { id: 'CUS-AUTO-ALLOWED', notes: '允许恢复', need: '', helpExpectation: '', goal: '', automaticProfilePending: { contentHash: contentHash('允许恢复'), actorId: 'ADMIN-1', reason: 'RECOVERY' } },
        { id: 'CUS-AUTO-BLOCKED', notes: '禁止恢复', need: '', helpExpectation: '', goal: '', automaticProfilePending: { contentHash: contentHash('禁止恢复'), actorId: 'ADMIN-1', reason: 'RECOVERY' } },
      ],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [
        { id: 'SRC-ALLOWED', customerId: 'CUS-AUTO-ALLOWED', processingStatus: 'UPLOADED', uploadedBy: 'ADMIN-1' },
        { id: 'SRC-BLOCKED', customerId: 'CUS-AUTO-BLOCKED', processingStatus: 'UPLOADED', uploadedBy: 'ADMIN-1' },
      ],
    }))
    repository.scheduleAutomaticCustomerProfile = vi.fn()
    repository.scheduleAutomaticProcessing = vi.fn()

    await repository.recoverAutomaticProcessing()

    expect(repository.scheduleAutomaticCustomerProfile).toHaveBeenCalledWith('ADMIN-1', 'CUS-AUTO-ALLOWED', '允许恢复', 'RECOVERY')
    expect(repository.scheduleAutomaticCustomerProfile).not.toHaveBeenCalledWith('ADMIN-1', 'CUS-AUTO-BLOCKED', expect.anything(), expect.anything())
    expect(repository.scheduleAutomaticProcessing).toHaveBeenCalledWith('ADMIN-1', 'SRC-ALLOWED')
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalledWith('ADMIN-1', 'SRC-BLOCKED')
  })

  it('returns before automatic source work starts, avoiding nested customer-queue waits', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    let release
    repository.queueAutomaticCustomerProfile = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const result = repository.scheduleAutomaticCustomerProfile('ADMIN-1', 'CUS-AUTO-4', '客户新增资料', 'CUSTOMER_UPDATE')
    expect(result).toMatchObject({ status: 'QUEUED', workerScheduled: true })
    expect(repository.queueAutomaticCustomerProfile).not.toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(repository.queueAutomaticCustomerProfile).toHaveBeenCalledWith('ADMIN-1', 'CUS-AUTO-4', '客户新增资料', 'CUSTOMER_UPDATE')
    release({ status: 'QUEUED', sourceId: 'SRC-AUTO-4' })
  })

  it('recovers a long pending text from stable customer fields without storing raw text in metadata', async () => {
    const longText = `${'客户长期资料。'.repeat(2500)}\n当前困扰：职业方向需要进一步确认。`
    const pending = {
      contentHash: contentHash(longText),
      actorId: 'ADMIN-1',
      reason: 'CUSTOMER_SAVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceReference: { kind: 'CUSTOMER_FIELDS', fields: ['notes', 'current_issue', 'help_expectation', 'current_goal'] },
    }
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => ({
      customers: [{ id: 'CUS-AUTO-LONG', notes: longText, need: '', helpExpectation: '', goal: '', automaticProfilePending: pending }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [],
    }))
    repository.scheduleAutomaticCustomerProfile = vi.fn()

    await repository.recoverAutomaticProcessing()

    expect(repository.scheduleAutomaticCustomerProfile).toHaveBeenCalledWith('ADMIN-1', 'CUS-AUTO-LONG', longText, 'CUSTOMER_SAVE')
    expect(JSON.stringify(pending)).not.toContain(longText)
  })

  it('does not recover pending automatic work created before formal enable time', async () => {
    config.appEnv = 'production'
    config.features.automaticProfileArchivingMode = 'production'
    config.features.automaticProfileArchivingEnabledAt = '2026-10-26T15:00:00.000Z'
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => ({
      customers: [{ id: 'CUS-AUTO-OLD', notes: '旧资料', need: '', helpExpectation: '', goal: '', automaticProfilePending: { contentHash: contentHash('旧资料'), actorId: 'ADMIN-1', reason: 'RECOVERY', createdAt: '2026-10-26T14:59:59.000Z' } }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [{ id: 'SRC-AUTO-OLD', customerId: 'CUS-AUTO-OLD', processingStatus: 'UPLOADED', uploadedBy: 'ADMIN-1', createdAt: '2026-10-26T14:59:59.000Z' }],
    }))
    repository.scheduleAutomaticCustomerProfile = vi.fn()
    repository.scheduleAutomaticProcessing = vi.fn()

    await repository.recoverAutomaticProcessing()

    expect(repository.scheduleAutomaticCustomerProfile).not.toHaveBeenCalled()
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalled()
  })

  it('does not auto-recover FAILED sources past the processing_version cap or with truncation errors', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => ({
      customers: [],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [
        { id: 'SRC-CAP', customerId: 'CUS-AUTO-1', processingStatus: 'FAILED', processingVersion: 191, processingError: 'DEEPSEEK_TIMEOUT', uploadedBy: 'ADMIN-1', _recordId: 'rec-cap' },
        { id: 'SRC-TRUNC', customerId: 'CUS-AUTO-1', processingStatus: 'FAILED', processingVersion: 2, processingError: 'DEEPSEEK_OUTPUT_TRUNCATED', uploadedBy: 'ADMIN-1', _recordId: 'rec-trunc' },
        { id: 'SRC-OK', customerId: 'CUS-AUTO-1', processingStatus: 'FAILED', processingVersion: 2, processingError: 'DEEPSEEK_TIMEOUT', uploadedBy: 'ADMIN-1', _recordId: 'rec-ok' },
        { id: 'SRC-UPLOADED', customerId: 'CUS-AUTO-1', processingStatus: 'UPLOADED', processingVersion: 1, uploadedBy: 'ADMIN-1', _recordId: 'rec-up' },
      ],
    }))
    repository.scheduleAutomaticProcessing = vi.fn()
    repository.stampAutoRetryCapReached = vi.fn(async () => true)

    await repository.recoverAutomaticProcessing()

    expect(repository.scheduleAutomaticProcessing).toHaveBeenCalledWith('ADMIN-1', 'SRC-OK')
    expect(repository.scheduleAutomaticProcessing).toHaveBeenCalledWith('ADMIN-1', 'SRC-UPLOADED')
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalledWith('ADMIN-1', 'SRC-CAP')
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalledWith('ADMIN-1', 'SRC-TRUNC')
    expect(repository.stampAutoRetryCapReached).toHaveBeenCalledWith(expect.objectContaining({ id: 'SRC-CAP' }))
    expect(repository.stampAutoRetryCapReached).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'SRC-TRUNC' }))
  })

  it('pauses further auto recovery once the daily circuit breaker opens', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.autoRecoveryCircuit = { day: new Date().toISOString().slice(0, 10), count: 81, paused: true }
    repository.load = vi.fn()
    repository.scheduleAutomaticProcessing = vi.fn()

    await expect(repository.recoverAutomaticProcessing()).resolves.toEqual({ status: 'CIRCUIT_OPEN', scheduledCustomers: 0, scheduledSources: 0 })
    expect(repository.load).not.toHaveBeenCalled()
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalled()
  })


  it('does not create a periodic recovery timer from start or schedule paths', async () => {
    vi.useFakeTimers()
    const repository = new FeishuRepository({ authRepository: {} })
    repository.processSource = vi.fn(async () => ({ id: 'SRC-1' }))
    const recoverSpy = vi.spyOn(repository, 'recoverAutomaticProcessing')

    repository.startAutomaticProcessingRecovery()
    const scheduled = repository.scheduleAutomaticProcessing('ADMIN-1', 'SRC-TIMER-1')
    expect(repository.autoProcessingRecoveryTimer).toBeNull()
    expect(scheduled.status).toBe('QUEUED')
    // Worker invoke owns processing — same-instance processSource must not be scheduled via timers.
    await vi.runOnlyPendingTimersAsync()
    expect(repository.processSource).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(recoverSpy).not.toHaveBeenCalled()
    expect(repository.autoProcessingRecoveryTimer).toBeNull()
    recoverSpy.mockRestore()
    vi.useRealTimers()
  })

  it('returns scheduled counts when on-demand recovery finds pending work', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => ({
      customers: [{ id: 'CUS-AUTO-1', notes: '待恢复资料', need: '', helpExpectation: '', goal: '', automaticProfilePending: { contentHash: contentHash('待恢复资料'), actorId: 'ADMIN-1', reason: 'RECOVERY' } }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [{ id: 'SRC-AUTO-1', customerId: 'CUS-AUTO-1', processingStatus: 'UPLOADED', uploadedBy: 'ADMIN-1' }],
    }))
    repository.scheduleAutomaticCustomerProfile = vi.fn()
    repository.scheduleAutomaticProcessing = vi.fn()

    await expect(repository.recoverAutomaticProcessing()).resolves.toEqual({ status: 'OK', scheduledCustomers: 1, scheduledSources: 1 })
    expect(repository.scheduleAutomaticCustomerProfile).toHaveBeenCalledWith('ADMIN-1', 'CUS-AUTO-1', '待恢复资料', 'RECOVERY')
    expect(repository.scheduleAutomaticProcessing).toHaveBeenCalledWith('ADMIN-1', 'SRC-AUTO-1')
  })


  it('recoverAutomaticCustomerProfile returns NOT_REQUIRED when notes are empty', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => ({
      customers: [{ id: 'CUS-EMPTY', notes: '', need: '', helpExpectation: '', goal: '', automaticProfilePending: null }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [],
    }))
    await expect(repository.recoverAutomaticCustomerProfile('ADMIN-1', 'CUS-EMPTY')).resolves.toEqual({ status: 'NOT_REQUIRED', customerId: 'CUS-EMPTY' })
  })

  it('recoverAutomaticCustomerProfile reuses an existing Source and awaits processSource', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    const notes = '已有 Source 可复用'
    const hash = contentHash(notes)
    repository.load = vi.fn(async () => ({
      customers: [{ id: 'CUS-EXIST', notes, need: '', helpExpectation: '', goal: '', automaticProfilePending: { contentHash: hash, actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE' }, createdAt: '2026-10-30T00:00:00.000Z' }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [{ id: 'SRC-EXIST', customerId: 'CUS-EXIST', contentHash: hash, notes: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE', processingStatus: 'UPLOADED', uploadedBy: 'ADMIN-1' }],
    }))
    repository.clearAutomaticProfilePending = vi.fn(async () => true)
    repository.scheduleAutomaticProcessing = vi.fn()
    repository.queueAutomaticCustomerProfile = vi.fn()
    repository.processSource = vi.fn(async () => ({
      source: { id: 'SRC-EXIST', processingStatus: 'REVIEW_REQUIRED', customerId: 'CUS-EXIST' },
      evidenceItems: [{ id: 'EVD-1', sourceId: 'SRC-EXIST' }],
      proposals: [],
      conflicts: [],
    }))

    await expect(repository.recoverAutomaticCustomerProfile('ADMIN-1', 'CUS-EXIST')).resolves.toMatchObject({
      status: 'REVIEW_REQUIRED',
      customerId: 'CUS-EXIST',
      sourceId: 'SRC-EXIST',
      reused: true,
      processed: true,
      scheduledProcessing: false,
    })
    expect(repository.queueAutomaticCustomerProfile).not.toHaveBeenCalled()
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalled()
    expect(repository.processSource).toHaveBeenCalledWith('ADMIN-1', 'SRC-EXIST')
  })

  it('recoverAutomaticCustomerProfile rebuilds pending and awaits process when Source is missing', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    const notes = '无 Source 时按原文重建'
    repository.load = vi.fn(async () => ({
      customers: [{ id: 'CUS-MISS', notes, need: '', helpExpectation: '', goal: '', automaticProfilePending: null, createdAt: '2026-10-30T00:00:00.000Z' }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [],
      _rows: { customers: [{ record_id: 'rec-miss', fields: {} }] },
    }))
    repository.ensureAutomaticProfilePending = vi.fn(async () => true)
    repository.queueAutomaticCustomerProfile = vi.fn(async () => ({ status: 'QUEUED', sourceId: 'SRC-NEW' }))
    repository.processSource = vi.fn(async () => ({
      source: { id: 'SRC-NEW', processingStatus: 'COMPLETED', customerId: 'CUS-MISS' },
      evidenceItems: [{ id: 'EVD-NEW' }],
      proposals: [],
      conflicts: [],
    }))

    await expect(repository.recoverAutomaticCustomerProfile('ADMIN-1', 'CUS-MISS')).resolves.toMatchObject({
      status: 'COMPLETED',
      customerId: 'CUS-MISS',
      sourceId: 'SRC-NEW',
      reused: false,
      processed: true,
      scheduledProcessing: false,
    })
    expect(repository.ensureAutomaticProfilePending).toHaveBeenCalled()
    expect(repository.queueAutomaticCustomerProfile).toHaveBeenCalledWith('ADMIN-1', 'CUS-MISS', notes, 'RECOVERY')
    expect(repository.processSource).toHaveBeenCalledWith('ADMIN-1', 'SRC-NEW')
  })


  it('recoverAutomaticCustomerProfile does not queue when ensure pending fails', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    const notes = 'ensure 失败须阻断 queue'
    repository.load = vi.fn(async () => ({
      customers: [{ id: 'CUS-ENSURE-FAIL', notes, need: '', helpExpectation: '', goal: '', automaticProfilePending: null, createdAt: '2026-10-30T00:00:00.000Z' }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [],
      _rows: { customers: [{ record_id: 'rec-ensure-fail', fields: {} }] },
    }))
    repository.ensureAutomaticProfilePending = vi.fn(async () => false)
    repository.queueAutomaticCustomerProfile = vi.fn(async () => ({ status: 'QUEUED', sourceId: 'SRC-SHOULD-NOT' }))

    await expect(repository.recoverAutomaticCustomerProfile('ADMIN-1', 'CUS-ENSURE-FAIL')).resolves.toEqual({
      status: 'PENDING',
      customerId: 'CUS-ENSURE-FAIL',
      errorCode: 'AUTO_PENDING_ENSURE_FAILED',
    })
    expect(repository.ensureAutomaticProfilePending).toHaveBeenCalled()
    expect(repository.queueAutomaticCustomerProfile).not.toHaveBeenCalled()
  })


})
