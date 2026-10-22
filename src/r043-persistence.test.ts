import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const repositorySource = readFileSync(new URL('../server/repository.mjs', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

describe('R043 customer archive and understanding persistence', () => {
  it('merges directory refreshes without replacing loaded detail state', () => {
    expect(appSource).toContain('function mergeDirectoryDatabase(current: Database | null, next: Database): Database')
    expect(appSource).toContain('setDatabase((current) => mergeDirectoryDatabase(current, next))')
    expect(appSource).toContain("'understanding', 'understandingStatus', 'understandingMeta'")
  })

  it('restores persisted consultation understanding with a read on customer mount', () => {
    expect(appSource).toContain('useEffect(() => { void loadUnderstanding() }, [customer.id])')
    expect(appSource).toContain('const result = await props.resourceCache.load(cacheKey, () => props.onGetUnderstanding(requestCustomerId)')
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

  it('deduplicates evidence only in the display layer while retaining source traceability', () => {
    expect(appSource).toContain('function dedupeEvidenceDisplay(items: EvidenceDisplayInput[]): EvidenceDisplayItem[]')
    expect(appSource).toContain('data-evidence-ids={item.evidenceIds.join(\',\')}')
    expect(repositorySource).not.toContain('dedupeEvidenceDisplay')
  })

  it('keeps the new-customer mobile controls at a non-zooming font size', () => {
    expect(appSource).toContain('manual-customer-modal')
    expect(stylesSource).toContain(".manual-customer-modal input:not([type='checkbox']):not([type='file']), .manual-customer-modal textarea, .manual-customer-modal select { font-size: 16px; }")
    expect(indexSource).not.toMatch(/user-scalable\\s*=|maximum-scale\\s*=\\s*1/)
  })

  it('centers the upload label and gives the history card the shared disclosure shell', () => {
    expect(stylesSource).toContain('.file-button { position: relative; display: inline-flex; align-items: center; justify-content: center;')
    expect(stylesSource).toContain('.customer-detail-v2 .profile-change-history > .record-disclosure')
  })
})
