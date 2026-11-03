import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from './config.mjs'
import { FeishuRepository } from './repository.mjs'

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

  const customerRow = (customerId, actorId, notes = '客户希望调整工作节奏') => ({ record_id: 'rec-customer', fields: {
    客户ID: customerId, 客户昵称: '系统演练客户', 备注: notes,
    '档案字段元数据': JSON.stringify({ _automatic_profile_pending: { contentHash: 'pending-hash', actorId, reason: 'CUSTOMER_SAVE', createdAt: new Date().toISOString() } }),
  } })
  const staffRow = { record_id: 'rec-staff', fields: { 人员ID: 'ADMIN-1', 姓名: '测试管理员', 角色: 'ADMIN', 状态: 'ACTIVE', 允许登录: true } }

  it('creates the durable Source task without invoking DeepSeek in the save process', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-WORKER-1'
    const search = vi.fn(async (tableId) => tableId === config.feishu.tables.customers ? [customerRow(customerId, 'ADMIN-1')] : tableId === config.feishu.tables.staff ? [staffRow] : [])
    const repository = new FeishuRepository({ authRepository: {}, archiveSearch: search })
    repository.createAutomaticProfileSource = vi.fn(async () => ({ status: 'SOURCE_CREATED', source: { id: 'SRC-WORKER-1' }, reused: false }))
    repository.processSource = vi.fn()

    const result = await repository.runAutomaticArchiveWorkerTick()

    expect(result).toMatchObject({ status: 'SOURCE_CREATED', customerId, sourceId: 'SRC-WORKER-1' })
    expect(repository.createAutomaticProfileSource).toHaveBeenCalledWith('ADMIN-1', customerId, '客户希望调整工作节奏', 'CUSTOMER_SAVE')
    expect(repository.processSource).not.toHaveBeenCalled()
    expect(search.mock.calls.every(([, filter]) => filter?.conditions?.length)).toBe(true)
  })

  it('advances EXTRACT_READY to Finalize without scanning unrelated tables', async () => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    const customerId = 'CUS-WORKER-2'
    const sourceRow = { record_id: 'rec-source', fields: {
      资料ID: 'SRC-WORKER-2', 客户ID: customerId, 上传人: 'ADMIN-1', 备注: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE',
      处理状态: 'EXTRACT_READY', 原始文本: '客户希望调整工作节奏', 创建时间: new Date().toISOString(), 上传时间: new Date().toISOString(),
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
    expect(repository.runCustomerAutoArchive).toHaveBeenCalledWith('ADMIN-1', customerId, { stage: 'finalize' })
    expect(search).not.toHaveBeenCalledWith(config.feishu.tables.appointments, expect.anything(), expect.anything())
  })
})
