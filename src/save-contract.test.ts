import { describe, expect, it } from 'vitest'
import { canStartCustomerSave } from './save-contract'

describe('customer save interaction contract', () => {
  it('blocks a second submission while the first save is in flight', () => {
    expect(canStartCustomerSave(false)).toBe(true)
    expect(canStartCustomerSave(true)).toBe(false)
  })
})
