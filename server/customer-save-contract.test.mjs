import { describe, expect, it } from 'vitest'
import { customerIdForOperation, partialEnrollmentFailureMessage } from './repository.mjs'

describe('customer save contracts', () => {
  it('keeps the same operation idempotent across retries', () => {
    expect(customerIdForOperation('save-operation-1')).toBe(customerIdForOperation('save-operation-1'))
    expect(customerIdForOperation('save-operation-1')).not.toBe(customerIdForOperation('save-operation-2'))
  })

  it('explains an enrollment partial failure without pretending the customer was lost', () => {
    expect(partialEnrollmentFailureMessage()).toContain('客户已保存')
    expect(partialEnrollmentFailureMessage()).toContain('请重试')
  })
})
