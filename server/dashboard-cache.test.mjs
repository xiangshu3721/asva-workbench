import { describe, expect, it } from 'vitest'
import { FeishuRepository } from './repository.mjs'

describe('dashboard read cache', () => {
  it('shares an in-flight database read and reuses its short TTL', async () => {
    const repository = new FeishuRepository()
    let reads = 0
    repository.loadFresh = async () => {
      reads += 1
      await Promise.resolve()
      return { staff: [], customers: [], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {} }
    }
    const [first, second] = await Promise.all([repository.load(), repository.load()])
    expect(first).toEqual(second)
    await repository.load()
    expect(reads).toBe(1)
  })

  it('invalidates the cache after a write boundary', async () => {
    const repository = new FeishuRepository()
    let reads = 0
    repository.loadFresh = async () => { reads += 1; return { staff: [], customers: [], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {} } }
    await repository.load()
    repository.invalidateDatabaseCache()
    await repository.load()
    expect(reads).toBe(2)
  })
})
