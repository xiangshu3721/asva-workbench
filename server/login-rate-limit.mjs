import crypto from 'node:crypto'

export class LoginRateLimiter {
  constructor({ windowMs = 15 * 60 * 1000, maxAttempts = 5, now = () => Date.now() } = {}) {
    this.windowMs = windowMs
    this.maxAttempts = maxAttempts
    this.now = now
    this.attempts = new Map()
  }

  key(phone, ip) {
    return crypto.createHash('sha256').update(`${String(phone || '').trim()}|${String(ip || 'unknown').trim()}`).digest('hex')
  }

  activeAttempts(key, timestamp = this.now()) {
    const active = (this.attempts.get(key) || []).filter((item) => timestamp - item < this.windowMs)
    if (active.length) this.attempts.set(key, active)
    else this.attempts.delete(key)
    return active
  }

  isBlocked(phone, ip) {
    return this.activeAttempts(this.key(phone, ip)).length >= this.maxAttempts
  }

  recordFailure(phone, ip) {
    const key = this.key(phone, ip)
    const active = this.activeAttempts(key)
    if (active.length >= this.maxAttempts) return false
    active.push(this.now())
    this.attempts.set(key, active)
    return true
  }

  clear(phone, ip) {
    this.attempts.delete(this.key(phone, ip))
  }
}
