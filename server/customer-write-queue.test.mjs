import { describe, expect, it } from 'vitest'
import { CustomerWriteQueue } from './customer-write-queue.mjs'

describe('per-customer write queue', () => {
  it('serializes one customer without serializing other customers', async () => {
    const queue = new CustomerWriteQueue()
    const events = []
    let releaseA
    const blockedA = new Promise((resolve) => { releaseA = resolve })
    const first = queue.run('CUS-A', async () => { events.push('A:start'); await blockedA; events.push('A:end') })
    const second = queue.run('CUS-A', async () => { events.push('A2:start'); events.push('A2:end') })
    const other = queue.run('CUS-B', async () => { events.push('B:start'); events.push('B:end') })
    await other
    expect(events).toEqual(['A:start', 'B:start', 'B:end'])
    releaseA()
    await Promise.all([first, second])
    expect(events).toEqual(['A:start', 'B:start', 'B:end', 'A:end', 'A2:start', 'A2:end'])
  })
})
