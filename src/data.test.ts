import { describe, expect, it } from 'vitest'
import { seedDatabase } from './data'

describe('ASVA demo data', () => {
  it('keeps every appointment connected to an existing customer', () => {
    const customerIds = new Set(seedDatabase.customers.map((customer) => customer.id))
    expect(seedDatabase.appointments.every((appointment) => customerIds.has(appointment.customerId))).toBe(true)
  })

  it('keeps every enrollment connected to a known customer and product', () => {
    const customerIds = new Set(seedDatabase.customers.map((customer) => customer.id))
    const productIds = new Set(seedDatabase.products.map((product) => product.id))
    expect(seedDatabase.enrollments.every((item) => customerIds.has(item.customerId) && productIds.has(item.productId))).toBe(true)
  })

  it('gives every customer the V0.1 follow-up fields used by the inbox', () => {
    expect(seedDatabase.customers.every((customer) => 'lastFollowupAt' in customer && 'nextFollowupAt' in customer && 'followupStatus' in customer)).toBe(true)
  })

  it('gives every customer a string referrer field', () => {
    expect(seedDatabase.customers.every((customer) => typeof customer.referrerName === 'string')).toBe(true)
  })
})
