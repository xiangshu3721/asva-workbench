import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repositorySource = readFileSync(new URL('../server/repository.mjs', import.meta.url), 'utf8')

describe('R043 customer archive and understanding persistence', () => {
  it('merges directory refreshes without replacing loaded detail state', () => {
    expect(appSource).toContain('function mergeDirectoryDatabase(current: Database | null, next: Database): Database')
    expect(appSource).toContain('setDatabase((current) => mergeDirectoryDatabase(current, next))')
    expect(appSource).toContain("'understanding', 'understandingStatus', 'understandingMeta'")
  })

  it('restores persisted consultation understanding with a read on customer mount', () => {
    expect(appSource).toContain('useEffect(() => { void loadUnderstanding() }, [customer.id])')
    expect(appSource).toContain('const result = await props.onGetUnderstanding(requestCustomerId)')
    expect(appSource).not.toContain("setUnderstandingByCustomerId((current) => ({ ...current, [requestCustomerId]: { ...current[requestCustomerId], value: undefined")
  })

  it('serializes derived metadata writes per customer to prevent lost updates', () => {
    expect(repositorySource).toContain("return this.customerWriteQueue.run(customerId, () => this.refreshCustomerUnderstandingUnsafe(actorId, customerId, { force }))")
    expect(repositorySource).toContain("return this.customerWriteQueue.run(customerId, () => this.refreshCustomerSalesUnderstandingUnsafe(actorId, customerId, { force }))")
    expect(repositorySource).toContain("return this.customerWriteQueue.run(customerId, () => this.refreshCustomerSafetyAssessmentUnsafe(actorId, customerId, { force }))")
  })

  it('does not automatically retry a stale processing source after remount', () => {
    expect(appSource).toContain("if (source.processingStatus === 'UPLOADED')")
    expect(appSource).toContain('const stale = isStaleProcessing(source)')
    expect(appSource).toContain("sourceProcessingPresentation(source.processingStatus, source.processingError || '', stale)")
  })

  it('hides duplicate evidence body text without changing stored evidence', () => {
    expect(appSource).toContain("const showExcerpt = sourceExcerpt && sourceExcerpt.replace(/\\s+/g, '') !== displayText.replace(/\\s+/g, '')")
  })
})
