import { describe, expect, it } from 'vitest'
import { boundedReadAfterWrite, READ_AFTER_WRITE_DELAYS_MS } from './read-after-write.mjs'

describe('bounded read-after-write', () => {
  it('waits through two not-found reads and returns the third visible record', async () => {
    const reads = [null, null, { id: 'CUS-1' }]
    const result = await boundedReadAfterWrite(async () => reads.shift())
    expect(result.value).toEqual({ id: 'CUS-1' })
    expect(result.attempts).toBe(3)
  })

  it('does not turn a permanent missing record into a success', async () => {
    const result = await boundedReadAfterWrite(async () => null, { delays: [0] })
    expect(result.value).toBeNull()
    expect(result.attempts).toBe(1)
  })

  it('uses a finite bounded retry schedule', () => {
    expect(READ_AFTER_WRITE_DELAYS_MS).toEqual([0, 400, 800, 1500, 2500])
  })
})
