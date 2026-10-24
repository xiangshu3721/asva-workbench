import { describe, expect, it } from 'vitest'
import { CustomerWriteQueue } from './customer-write-queue.mjs'
import { customerIdForOperation } from './repository.mjs'
import { resolveCustomerIdentity } from '../shared/customer-foundation.mjs'

describe('01D concurrency audit', () => {
  it('keeps the same operation identity stable but does not make different identities equal', () => {
    expect(customerIdForOperation('op-same')).toBe(customerIdForOperation('op-same'))
    expect(customerIdForOperation('op-same')).not.toBe(customerIdForOperation('op-other'))
  })

  it('shows that the existing customer write queue is instance-local', async () => {
    const queueA = new CustomerWriteQueue()
    const queueB = new CustomerWriteQueue()
    let active = 0
    let maxActive = 0
    const operation = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    }

    await Promise.all([queueA.run('CUS-SAME', operation), queueB.run('CUS-SAME', operation)])

    expect(maxActive).toBe(2)
  })

  it('does not treat the same nickname as a reliable identity', () => {
    const result = resolveCustomerIdentity([
      { id: 'CUS-A', name: '同名客户', phone: '13800000001', wechat: '' },
      { id: 'CUS-B', name: '同名客户', phone: '13800000002', wechat: '' },
    ], { nickname: '同名客户', phone: '13800000003', wechat: '' })

    expect(result.result).toBe('POSSIBLE_MATCH')
    expect(result.matched_customer_id).toBeNull()
    expect(result.matches.map((item) => item.id)).toEqual(['CUS-A', 'CUS-B'])
  })

  it('fails closed when phone and wechat point to different customers', () => {
    const result = resolveCustomerIdentity([
      { id: 'CUS-PHONE', name: '客户A', phone: '13800000001', wechat: '' },
      { id: 'CUS-WECHAT', name: '客户B', phone: '', wechat: 'wechat_b' },
    ], { nickname: '新录入', phone: '13800000001', wechat: 'wechat_b' })

    expect(result.result).toBe('CONFLICT')
    expect(result.matched_customer_id).toBeNull()
  })
})
