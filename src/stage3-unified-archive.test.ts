import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const workspaceSource = appSource.slice(appSource.indexOf('function EvidenceWorkspace'), appSource.indexOf('function EvidenceGroup'))

describe('stage 3 unified archive entry', () => {
  it('marks updates semantically and keeps source idempotency in the existing save path', () => {
    expect(workspaceSource).toContain("archiveIntent: 'CUSTOMER_UPDATE'")
    expect(workspaceSource).toContain('pendingSaveRef.current')
    expect(workspaceSource).not.toContain('onProcess')
  })

  it('polls a specific Source with bounded independent timers', () => {
    expect(workspaceSource).toContain('startArchiveStatusPolling')
    expect(workspaceSource).toContain("onSourceStatus(customer.id, '', sourceId)")
    expect(workspaceSource).toContain('archivePollTimersRef')
    expect(workspaceSource).toContain('archivePollTimersRef.current.clear()')
    expect(workspaceSource).toContain('ARCHIVE_STATUS_POLL_MAX_ATTEMPTS')
    expect(workspaceSource).toContain('window.setTimeout')
    expect(workspaceSource).toContain('onRefreshProfile')
    expect(workspaceSource).toContain("['COMPLETED', 'REVIEW_REQUIRED', 'FAILED']")
  })
})
