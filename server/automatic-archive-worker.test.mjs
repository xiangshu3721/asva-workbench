import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from './config.mjs'
import { FeishuRepository } from './repository.mjs'
import { contentHash } from '../shared/evidence-contract.mjs'

describe('automatic archive timer worker', () => {
  const original = {
    enabled: config.features.automaticProfileArchiving,
    mode: config.features.automaticProfileArchivingMode,
    canary: config.features.automaticProfileArchivingCanary,
    allowlist: config.features.automaticProfileCanaryCustomerIds,
  }

  afterEach(() => {
    config.features.automaticProfileArchiving = original.enabled
    config.features.automaticProfileArchivingMode = original.mode
    config.features.automaticProfileArchivingCanary = original.canary
    config.features.automaticProfileCanaryCustomerIds = original.allowlist
  })

  const rich = (value) => [{ type: 'text', text: String(value) }]
  const splitRich = (value) => {
    const source = String(value)
    return [source.slice(0, 17), ...(source.slice(17).match(/.{1,23}/gs) || [])].filter(Boolean).map(rich)
  }
  const customerRow = (customerId, actorId, notes = '客户希望调整工作节奏') => ({ record_id: 'rec-customer', fields: {
    客户ID: rich(customerId), 客户昵称: rich('系统演练客户'), 备注: splitRich(notes),
    '档案字段元数据': splitRich(JSON.stringify({ _automatic_profile_pending: { contentHash: contentHash(notes), actorId, reason: 'CUSTOMER_SAVE', createdAt: new Date().toISOString() } })),
  } })
  const staffRow = { record_id: 'rec-staff', fields: { 人员ID: rich('ADMIN-1'), 姓名: rich('测试管理员'), 角色: rich('ADMIN'), 状态: rich('ACTIVE'), 允许登录: true } }

  it('creates the durable Source task without invoking DeepSeek in the save process', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-WORKER-1'
    const search = vi.fn(async (tableId) => tableId === config.feishu.tables.customers ? [customerRow(customerId, 'ADMIN-1')] : tableId === config.feishu.tables.staff ? [staffRow] : [])
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    repository.createAutomaticProfileSource = vi.fn()
    repository.processSource = vi.fn()
    const candidate = await repository.nextAutomaticArchiveCandidate()
    repository.createAutomaticProfileSource.mockResolvedValue({ status: 'SOURCE_CREATED', source: { id: candidate.sourceId }, reused: false })

    const result = await repository.runAutomaticArchiveWorkerTick()

    expect(result).toMatchObject({ status: 'SOURCE_CREATED', customerId, sourceId: candidate.sourceId })
    expect(repository.createAutomaticProfileSource).toHaveBeenCalledWith('ADMIN-1', customerId, '客户希望调整工作节奏', 'CUSTOMER_SAVE')
    expect(repository.processSource).not.toHaveBeenCalled()
    expect(search.mock.calls.every(([, filter]) => filter?.conditions?.length)).toBe(true)
  })

  it('advances EXTRACT_READY to Finalize without scanning unrelated tables', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-WORKER-2'
    const sourceRow = { record_id: 'rec-source', fields: {
      资料ID: rich('SRC-WORKER-2'), 客户ID: rich(customerId), 上传人: rich('ADMIN-1'), 备注: splitRich('AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE'),
      处理状态: rich('EXTRACT_READY'), 原始文本: splitRich('客户希望调整工作节奏'), 创建时间: new Date().toISOString(), 上传时间: new Date().toISOString(),
    } }
    const search = vi.fn(async (tableId, filter) => {
      if (tableId === config.feishu.tables.sourceRecords && filter.conditions.some((item) => item.field_name === '处理状态' && item.value[0] === 'EXTRACT_READY')) return [sourceRow]
      if (tableId === config.feishu.tables.customers) return [customerRow(customerId, 'ADMIN-1')]
      if (tableId === config.feishu.tables.staff) return [staffRow]
      return []
    })
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    repository.runCustomerAutoArchive = vi.fn(async (_actorId, requestedCustomerId, options) => ({ status: 'COMPLETED', customerId: requestedCustomerId, ...options }))

    const result = await repository.runAutomaticArchiveWorkerTick()

    expect(result).toMatchObject({ status: 'COMPLETED', customerId, workerStage: 'finalize' })
    expect(repository.runCustomerAutoArchive).toHaveBeenCalledWith('ADMIN-1', customerId, { stage: 'finalize', sourceId: 'SRC-WORKER-2' })
    expect(search).not.toHaveBeenCalledWith(config.feishu.tables.appointments, expect.anything(), expect.anything())
  })

  it('skips fresh PROCESSING and capped FAILED sources instead of blocking newer work', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const freshSource = { record_id: 'rec-processing', fields: {
      资料ID: rich('SRC-PROCESSING'), 客户ID: rich('CUS-PROCESSING'), 上传人: rich('ADMIN-1'), 备注: rich('AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE'), 处理状态: rich('PROCESSING'), 处理开始时间: new Date().toISOString(),
    } }
    const cappedSource = { record_id: 'rec-failed', fields: {
      资料ID: rich('SRC-FAILED'), 客户ID: rich('CUS-FAILED'), 上传人: rich('ADMIN-1'), 备注: rich('AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE'), 处理状态: rich('FAILED'), 处理版本: '5', 处理错误: rich('DEEPSEEK_TIMEOUT'),
    } }
    const search = vi.fn(async (tableId, filter) => {
      if (tableId !== config.feishu.tables.sourceRecords) return []
      const status = filter?.conditions?.find((item) => item.field_name === '处理状态')?.value?.[0]
      return status === 'PROCESSING' ? [freshSource] : status === 'FAILED' ? [cappedSource] : []
    })
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    await expect(repository.nextAutomaticArchiveCandidate()).resolves.toBeNull()
  })

  it('recognizes rich-text Source timestamps under the production enable-time gate', async () => {
    const originalAppEnv = config.appEnv
    const originalEnabledAt = config.features.automaticProfileArchivingEnabledAt
    config.appEnv = 'production'
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'production'
    config.features.automaticProfileArchivingEnabledAt = '2026-11-01T00:00:00.000Z'
    const sourceRow = { record_id: 'rec-timestamp-source', fields: {
      资料ID: rich('SRC-TIMESTAMP'), 客户ID: rich('CUS-TIMESTAMP'), 上传人: rich('ADMIN-1'), 备注: rich('AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE'), 处理状态: rich('UPLOADED'), 创建时间: rich('2026-11-03T00:00:00.000Z'), 上传时间: rich('2026-11-03T00:00:00.000Z'),
    } }
    const search = vi.fn(async (tableId, filter) => tableId === config.feishu.tables.sourceRecords && filter.conditions.some((item) => item.field_name === '处理状态' && item.value[0] === 'UPLOADED') ? [sourceRow] : [])
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })

    await expect(repository.nextAutomaticArchiveCandidate()).resolves.toMatchObject({ customerId: 'CUS-TIMESTAMP', sourceId: 'SRC-TIMESTAMP', stage: 'extract' })
    config.appEnv = originalAppEnv
    config.features.automaticProfileArchivingEnabledAt = originalEnabledAt
  })

  it('prioritizes the newest pending customer after terminal work is excluded', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const older = customerRow('CUS-OLDER', 'ADMIN-1')
    older.fields['档案字段元数据'] = splitRich(JSON.stringify({ _automatic_profile_pending: { contentHash: contentHash('客户希望调整工作节奏'), actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE', createdAt: '2026-11-01T00:00:00.000Z' } }))
    const newer = customerRow('CUS-NEWER', 'ADMIN-1')
    newer.fields['档案字段元数据'] = splitRich(JSON.stringify({ _automatic_profile_pending: { contentHash: contentHash('客户希望调整工作节奏'), actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE', createdAt: '2026-11-03T00:00:00.000Z' } }))
    const search = vi.fn(async (tableId, filter) => tableId === config.feishu.tables.customers ? [older, newer] : [])
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    await expect(repository.nextAutomaticArchiveCandidate()).resolves.toMatchObject({ customerId: 'CUS-NEWER', stage: 'create', sourceId: expect.stringMatching(/^SRC-/), reason: 'CUSTOMER_SAVE' })
  })

  it('clears a stale pending marker when its terminal Source is already archived', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-ALREADY-ARCHIVED'
    const archivedText = '客户希望调整工作节奏'
    const sourceRow = { record_id: 'rec-terminal-source', fields: {
      资料ID: rich('SRC-TERMINAL'), 客户ID: rich(customerId), 上传人: rich('ADMIN-1'), 备注: rich('AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE'), 内容Hash: rich(contentHash(archivedText)), 处理状态: rich('COMPLETED'), 原始文本: rich(archivedText), 创建时间: new Date().toISOString(), 上传时间: new Date().toISOString(),
    } }
    const search = vi.fn(async (tableId, filter) => {
      if (tableId === config.feishu.tables.customers) return [customerRow(customerId, 'ADMIN-1')]
      if (tableId === config.feishu.tables.staff) return [staffRow]
      if (tableId === config.feishu.tables.sourceRecords && filter?.conditions?.some((item) => item.field_name === '客户ID')) return [sourceRow]
      return []
    })
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    repository.clearAutomaticProfilePending = vi.fn(async () => true)
    const row = customerRow(customerId, 'ADMIN-1', archivedText)
    row.fields['档案字段元数据'] = splitRich(JSON.stringify({ _automatic_profile_pending: { contentHash: contentHash(archivedText), actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE', createdAt: new Date().toISOString() } }))
    search.mockImplementation(async (tableId, filter) => {
      if (tableId === config.feishu.tables.customers) return [row]
      if (tableId === config.feishu.tables.staff) return [staffRow]
      if (tableId === config.feishu.tables.sourceRecords && filter?.conditions?.some((item) => item.field_name === '客户ID')) return [sourceRow]
      return []
    })

    await expect(repository.runAutomaticArchiveWorkerTick()).resolves.toMatchObject({ status: 'SKIPPED_ALREADY_ARCHIVED', customerId, sourceId: 'SRC-TERMINAL' })
    expect(repository.clearAutomaticProfilePending).toHaveBeenCalledWith(customerId, expect.objectContaining({ reason: 'CUSTOMER_SAVE' }))
  })

  it('defers CUSTOMER_UPDATE without starting the stage 2 archive execution', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-UPDATE-1'
    const sourceRow = { record_id: 'rec-update-source', fields: {
      资料ID: rich('SRC-UPDATE-1'), 客户ID: rich(customerId), 上传人: rich('ADMIN-1'), 备注: rich('AUTO_PROFILE_ORGANIZE:CUSTOMER_UPDATE'), 处理状态: rich('UPLOADED'), 原始文本: rich('客户目前在广州'), 创建时间: new Date().toISOString(), 上传时间: new Date().toISOString(),
    } }
    const search = vi.fn(async (tableId, filter) => tableId === config.feishu.tables.sourceRecords && filter.conditions.some((item) => item.field_name === '处理状态' && item.value[0] === 'UPLOADED') ? [sourceRow] : [])
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    repository.runCustomerAutoArchive = vi.fn()

    await expect(repository.runAutomaticArchiveWorkerTick()).resolves.toMatchObject({ status: 'DEFERRED_STAGE2', customerId, sourceId: 'SRC-UPDATE-1', taskReason: 'CUSTOMER_UPDATE' })
    expect(repository.runCustomerAutoArchive).not.toHaveBeenCalled()
  })

  it('assigns a stable Source ID to a pending CUSTOMER_UPDATE without writing during discovery', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-UPDATE-2'
    const row = customerRow(customerId, 'ADMIN-1', '客户目前在广州')
    row.fields['档案字段元数据'] = splitRich(JSON.stringify({ _automatic_profile_pending: { contentHash: contentHash('客户目前在广州'), actorId: 'ADMIN-1', reason: 'CUSTOMER_UPDATE', createdAt: '2026-11-03T00:00:00.000Z' } }))
    const search = vi.fn(async (tableId) => tableId === config.feishu.tables.customers ? [row] : [])
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    repository.createAutomaticProfileSource = vi.fn()

    const candidate = await repository.nextAutomaticArchiveCandidate()

    expect(candidate).toMatchObject({ customerId, reason: 'CUSTOMER_UPDATE', stage: 'create', sourceId: expect.stringMatching(/^SRC-/) })
    expect(repository.createAutomaticProfileSource).not.toHaveBeenCalled()
  })

  it('does not let more than twenty updates hide a CUSTOMER_SAVE task', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const updateRows = Array.from({ length: 21 }, (_, index) => ({ record_id: `rec-update-${index}`, fields: {
      资料ID: rich(`SRC-UPDATE-${index}`), 客户ID: rich(`CUS-UPDATE-${index}`), 上传人: rich('ADMIN-1'), 备注: rich('AUTO_PROFILE_ORGANIZE:CUSTOMER_UPDATE'), 处理状态: rich('UPLOADED'), 原始文本: rich(`更新资料${index}`), 创建时间: new Date().toISOString(), 上传时间: new Date().toISOString(),
    } }))
    const saveRow = { record_id: 'rec-save-priority', fields: {
      资料ID: rich('SRC-SAVE-PRIORITY'), 客户ID: rich('CUS-SAVE-PRIORITY'), 上传人: rich('ADMIN-1'), 备注: rich('AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE'), 处理状态: rich('UPLOADED'), 原始文本: rich('新增资料'), 创建时间: new Date().toISOString(), 上传时间: new Date().toISOString(),
    } }
    const search = vi.fn(async (tableId, filter, options) => {
      if (tableId !== config.feishu.tables.sourceRecords) return []
      expect(options.pageSize).toBe(100)
      const status = filter.conditions.find((item) => item.field_name === '处理状态')?.value?.[0]
      return status === 'UPLOADED' ? [...updateRows, saveRow] : []
    })
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })

    await expect(repository.nextAutomaticArchiveCandidate()).resolves.toMatchObject({ customerId: 'CUS-SAVE-PRIORITY', sourceId: 'SRC-SAVE-PRIORITY', reason: 'CUSTOMER_SAVE' })
  })

  it('binds Extract to the requested Source even when a later update is pending', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-SOURCE-BIND'
    const sourceA = { id: 'SRC-A', customerId, rawText: '资料A', notes: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE', processingStatus: 'UPLOADED', uploadedBy: 'ADMIN-1', createdAt: new Date().toISOString() }
    const sourceB = { id: 'SRC-B', customerId, rawText: '资料B', notes: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_UPDATE', processingStatus: 'UPLOADED', uploadedBy: 'ADMIN-1', createdAt: new Date().toISOString() }
    const database = { staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }], customers: [{ id: customerId, notes: '最新资料B', automaticProfilePending: { contentHash: contentHash('资料B'), actorId: 'ADMIN-1', reason: 'CUSTOMER_UPDATE', createdAt: new Date().toISOString() } }], sourceRecords: [sourceA, sourceB], evidenceItems: [{ sourceId: 'SRC-A', reviewStatus: 'PENDING_REVIEW' }], profileUpdateProposals: [], evidenceConflicts: [], profileChanges: [], appointments: [], sessions: [], enrollments: [] }
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => database)
    repository.processSource = vi.fn(async (_actorId, sourceId) => ({ source: database.sourceRecords.find((item) => item.id === sourceId) }))

    const result = await repository.runCustomerAutoArchive('ADMIN-1', customerId, { stage: 'extract', sourceId: 'SRC-A' })

    expect(repository.processSource).toHaveBeenCalledWith('ADMIN-1', 'SRC-A', { stage: 'extract' })
    expect(repository.processSource).not.toHaveBeenCalledWith('ADMIN-1', 'SRC-B', expect.anything())
    expect(result).toMatchObject({ status: 'EXTRACT_READY', sourceId: 'SRC-A' })
  })

  it('fails safely for a missing requested Source without falling back to the latest Source', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-SOURCE-MISSING'
    const database = { staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }], customers: [{ id: customerId, notes: '资料B', automaticProfilePending: { contentHash: contentHash('资料B'), actorId: 'ADMIN-1', reason: 'CUSTOMER_UPDATE', createdAt: new Date().toISOString() } }], sourceRecords: [{ id: 'SRC-B', customerId, rawText: '资料B', notes: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_UPDATE', processingStatus: 'UPLOADED', uploadedBy: 'ADMIN-1', createdAt: new Date().toISOString() }], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], profileChanges: [], appointments: [], sessions: [], enrollments: [] }
    const repository = new FeishuRepository({ authRepository: {} })
    repository.load = vi.fn(async () => database)
    repository.createAutomaticProfileSource = vi.fn()
    repository.processSource = vi.fn()

    const result = await repository.runCustomerAutoArchive('ADMIN-1', customerId, { stage: 'extract', sourceId: 'SRC-A' })

    expect(result).toMatchObject({ status: 'FAILED', sourceId: 'SRC-A', errorCode: 'AUTOMATIC_SOURCE_NOT_FOUND' })
    expect(repository.createAutomaticProfileSource).not.toHaveBeenCalled()
    expect(repository.processSource).not.toHaveBeenCalled()
  })

  it('does not create a Source when Pending text reconstruction does not match its hash', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const row = customerRow('CUS-HASH-MISMATCH', 'ADMIN-1', '当前备注')
    row.fields['档案字段元数据'] = splitRich(JSON.stringify({ _automatic_profile_pending: { contentHash: contentHash('另一份资料'), actorId: 'ADMIN-1', reason: 'CUSTOMER_UPDATE', createdAt: new Date().toISOString() } }))
    const search = vi.fn(async (tableId) => tableId === config.feishu.tables.customers ? [row] : [])
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    repository.createAutomaticProfileSource = vi.fn()

    await expect(repository.nextAutomaticArchiveCandidate()).resolves.toBeNull()
    expect(repository.createAutomaticProfileSource).not.toHaveBeenCalled()
  })
})
