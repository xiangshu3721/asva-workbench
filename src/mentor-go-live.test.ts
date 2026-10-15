import { beforeEach, describe, expect, it } from 'vitest'
import { createLocalApi } from './api'
import { createLocalRepository } from './repositories'

function setupStorage() {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } },
  })
}

beforeEach(() => setupStorage())

describe('R032 mentor ownership and scope', () => {
  it('forces mentor-created customers to the current mentor', () => {
    const api = createLocalApi(createLocalRepository())
    const database = api.createCustomer('mentor-zhang', { nickname: 'R032导师归属测试', phone: '13900009901', mentorId: 'mentor-li', situation: '只用于权限回归。', needsFollowup: false })
    const customer = database.customers.find((item) => item.name === 'R032导师归属测试')
    expect(customer?.createdByStaffId).toBe('mentor-zhang')
    expect(customer?.mentorId).toBe('mentor-zhang')
  })

  it('allows an admin assignment to move access from A to B without changing creator history', () => {
    const api = createLocalApi(createLocalRepository())
    const created = api.createCustomer('staff-admin', { nickname: 'R032重新分配测试', phone: '13900009902', mentorId: 'mentor-zhang', situation: '只用于权限回归。', needsFollowup: false })
    const customer = created.customers.find((item) => item.name === 'R032重新分配测试')!
    api.createAppointment({ customerId: customer.id, topic: 'R032重新分配', submittedAt: '2026-10-15', description: '权限回归', expectation: '权限回归', source: 'R032_TEST', createdAt: '2026-10-15' })
    const appointment = api.dashboard('staff-admin').appointments.find((item) => item.customerId === customer.id)!
    api.assignAppointment('staff-admin', appointment.id, 'mentor-li')
    expect(api.customer('mentor-zhang', customer.id)).toBeUndefined()
    expect(api.customer('mentor-li', customer.id)?.mentorId).toBe('mentor-li')
    expect(api.customer('staff-admin', customer.id)?.createdByStaffId).toBe('staff-admin')
  })

  it('does not let a mentor change the current mentor assignment through profile updates', () => {
    const api = createLocalApi(createLocalRepository())
    const created = api.createCustomer('mentor-zhang', { nickname: 'R032归属字段保护', phone: '13900009903', situation: '只用于权限回归。', needsFollowup: false })
    const customer = created.customers.find((item) => item.name === 'R032归属字段保护')!
    expect(() => api.confirmProfile('mentor-zhang', customer.id, [{ field: 'current_mentor_id', value: 'mentor-li', source: 'USER_EXPLICIT', confidence: 1 }])).toThrow('只有 ADMIN 可以重新分配导师')
  })
})
