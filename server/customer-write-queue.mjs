export class CustomerWriteQueue {
  constructor() { this.pending = new Map() }

  async run(customerId, operation) {
    const key = String(customerId || '').trim()
    if (!key) return operation()
    const previous = this.pending.get(key) || Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    this.pending.set(key, current)
    await previous.catch(() => {})
    try { return await operation() } finally {
      release()
      if (this.pending.get(key) === current) this.pending.delete(key)
    }
  }
}
