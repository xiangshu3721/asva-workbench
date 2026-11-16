import { describe, expect, it, vi } from 'vitest'
import { createConsultationRefreshFlight } from './consultation-refresh-flight'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('consultation refresh in-flight deduplication', () => {
  it('shares one POST between auto refresh and rapid manual clicks on identical current data', async () => {
    const gate = createConsultationRefreshFlight<string>()
    const pending = deferred<string>()
    const request = vi.fn(() => pending.promise)
    const auto = gate.run('CUS-A:source-1', request)
    const manual = gate.run('CUS-A:source-1', request)
    const rapidClick = gate.run('CUS-A:source-1', request)
    expect(auto).toBe(manual)
    expect(manual).toBe(rapidClick)
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve('FRESH')
    await expect(Promise.all([auto, manual, rapidClick])).resolves.toEqual(['FRESH', 'FRESH', 'FRESH'])
  })

  it('permits another explicit refresh once the earlier request has settled', async () => {
    const gate = createConsultationRefreshFlight<number>()
    const request = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    expect(await gate.run('CUS-A:source-1', request)).toBe(1)
    expect(await gate.run('CUS-A:source-1', request)).toBe(2)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('clears failed requests and makes retry possible without leaking an unhandled secondary rejection', async () => {
    const gate = createConsultationRefreshFlight<string>()
    const pending = deferred<string>()
    const request = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce('FRESH')
    const first = gate.run('CUS-A:source-1', request)
    const duplicate = gate.run('CUS-A:source-1', request)
    expect(first).toBe(duplicate)
    pending.reject(new Error('DeepSeek unavailable'))
    await expect(first).rejects.toThrow('DeepSeek unavailable')
    await expect(duplicate).rejects.toThrow('DeepSeek unavailable')
    await expect(gate.run('CUS-A:source-1', request)).resolves.toBe('FRESH')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('never shares a pending promise between customers or changed input snapshots', async () => {
    const gate = createConsultationRefreshFlight<string>()
    const pending = deferred<string>()
    const requestA = vi.fn(() => pending.promise)
    const requestB = vi.fn().mockResolvedValue('OTHER')
    const one = gate.run('CUS-A:source-1', requestA)
    const changed = gate.run('CUS-A:source-2', requestB)
    const other = gate.run('CUS-B:source-1', requestB)
    await expect(changed).resolves.toBe('OTHER')
    await expect(other).resolves.toBe('OTHER')
    expect(requestB).toHaveBeenCalledTimes(2)
    pending.resolve('A')
    await expect(one).resolves.toBe('A')
  })
})
