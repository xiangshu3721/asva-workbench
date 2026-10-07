import { describe, expect, it } from 'vitest'
import { LoginRateLimiter } from './login-rate-limit.mjs'

describe('LoginRateLimiter', () => {
  it('blocks the sixth failure for the same phone and IP, then expires', () => {
    let timestamp = 0
    const limiter = new LoginRateLimiter({ now: () => timestamp, windowMs: 900000, maxAttempts: 5 })
    for (let index = 0; index < 5; index += 1) expect(limiter.recordFailure('13800000000', '203.0.113.10')).toBe(true)
    expect(limiter.isBlocked('13800000000', '203.0.113.10')).toBe(true)
    expect(limiter.recordFailure('13800000000', '203.0.113.10')).toBe(false)
    expect(limiter.isBlocked('13800000001', '203.0.113.10')).toBe(false)
    timestamp = 900001
    expect(limiter.isBlocked('13800000000', '203.0.113.10')).toBe(false)
  })

  it('clears failures after a successful login', () => {
    const limiter = new LoginRateLimiter()
    limiter.recordFailure('13800000000', '203.0.113.10')
    limiter.clear('13800000000', '203.0.113.10')
    expect(limiter.isBlocked('13800000000', '203.0.113.10')).toBe(false)
  })
})
