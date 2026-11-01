import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FeishuRepository } from './repository.mjs'

const emptyDatabase = () => ({
  staff: [], customers: [], appointments: [], sessions: [], followups: [],
  products: [], enrollments: [], profileChanges: [], sourceRecords: [],
  evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {},
})

describe('CloudBase memory guard', () => {
  it('keeps recovery helpers available without starting process-wide scan timers', () => {
    const repository = new FeishuRepository({ authRepository: {} })

    expect(repository.startAutomaticProcessingRecovery()).toBeUndefined()
    expect(repository.startEnrollmentRecovery()).toBeUndefined()
    expect(repository.autoProcessingRecoveryTimer).toBeNull()
    expect(repository.enrollmentRecoveryTimer).toBeUndefined()
  })

  it('retains one last-known-good snapshot instead of one full snapshot per customer', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    const database = { ...emptyDatabase(), customers: Array.from({ length: 51 }, (_, index) => ({ id: `CUS-${index}` })) }
    repository.loadFresh = async () => database

    await repository.load({ force: true })

    expect(repository.lastKnownGood).toBeTruthy()
    expect(repository.lastKnownGood.customers).toHaveLength(51)
    expect(repository.lastKnownGoodByCustomer.size).toBe(0)
  })

  it('keeps the global snapshot as the readback fallback before a target write exists', () => {
    const repositorySource = fs.readFileSync(path.join(process.cwd(), 'server/repository.mjs'), 'utf8')

    expect(repositorySource).toContain('this.lastKnownGoodByCustomer.get(targetCustomerId) || this.lastKnownGood')
  })

  it('emits numeric memory phases without including request payloads', () => {
    const indexSource = fs.readFileSync(path.join(process.cwd(), 'server/index.mjs'), 'utf8')

    expect(indexSource).toContain("memorySnapshot('startup_before_repository', 'module')")
    expect(indexSource).toContain("memorySnapshot('startup_after_repository', 'module')")
    expect(indexSource).toContain("memorySnapshot('request_start', requestId")
    expect(indexSource).toContain("memorySnapshot('request_end', requestId")
    expect(indexSource).not.toContain('rawText:')
    expect(indexSource).not.toContain('body:')
  })
})
