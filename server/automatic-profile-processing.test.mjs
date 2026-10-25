import { describe, expect, it, vi } from 'vitest'
import { FeishuRepository } from './repository.mjs'

describe('automatic customer profile processing', () => {
  it('queues saved customer text with a stable content operation and schedules background processing', async () => {
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
    expect(repository.scheduleAutomaticProcessing).toHaveBeenCalledTimes(2)
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
})
