import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const workspaceSource = appSource.slice(appSource.indexOf('function EvidenceWorkspace'), appSource.indexOf('function EvidenceGroup'))

describe('stage 3 unified archive entry', () => {
  it('marks updates semantically and keeps source idempotency in the existing save path', () => {
    expect(workspaceSource).toContain("archiveIntent: 'CUSTOMER_UPDATE'")
    expect(workspaceSource).toContain('pendingSaveRef.current')
    expect(workspaceSource).toContain('onProcess')
  })

  it('does not poll or revive a background worker after save', () => {
    expect(workspaceSource).not.toContain('startArchiveStatusPolling')
    expect(workspaceSource).not.toContain('archivePollTimersRef')
    expect(workspaceSource).not.toContain('window.setTimeout')
    expect(workspaceSource).toContain("if (!onDemandAiAutoAvailable)")
    expect(workspaceSource).toContain("onProcess(source.id, 'AUTO')")
    expect(workspaceSource).toContain("onProcess(sourceId, 'MANUAL')")
  })

  it('only exposes automatic processing when the server reports every durable canary gate', () => {
    const applicationSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(applicationSource).toContain('flags.onDemandAiAutoTriggerCanaryConfigured === true')
  })
})
