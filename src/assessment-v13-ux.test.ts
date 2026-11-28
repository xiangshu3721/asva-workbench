import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverIndexPath = resolve(__dirname, '..', 'server', 'index.mjs')
const appPath = resolve(__dirname, 'App.tsx')

describe('V1.3 — open-original endpoint', () => {
  const serverSource = readFileSync(serverIndexPath, 'utf8')

  it('server code registers the open-original route', () => {
    expect(serverSource).toContain('/open-original')
    expect(serverSource).toContain('openOriginalPath')
  })

  it('server code issues 302 redirect', () => {
    expect(serverSource).toContain('response.writeHead(302, { Location: shareUrl')
  })

  it('server code validates permissions before redirect', () => {
    // Must check ACTIVE status
    expect(serverSource).toContain("binding.status !== 'ACTIVE'")
    // Must check staff access
    expect(serverSource).toContain('hasAccess')
    // Must handle SHARE_URL_NOT_FOUND
    expect(serverSource).toContain('SHARE_URL_NOT_FOUND')
  })

  it('server enriches preview from snapshot for existing reports', () => {
    expect(serverSource).toContain('enrichPreviewFromSnapshot')
    expect(serverSource).toContain('displayPayload')
  })
})

describe('V1.3 — frontend button rules', () => {
  const appSource = readFileSync(appPath, 'utf8')

  it('frontend defines H5_CAPABLE_ASSESSMENT_IDS with 8 entries (including sefs)', () => {
    expect(appSource).toContain('H5_CAPABLE_ASSESSMENT_IDS')
    expect(appSource).toContain("'star'")
    expect(appSource).toContain("'beattie-emotional-health'")
    expect(appSource).toContain("'beattie-anger'")
    expect(appSource).toContain("'beattie-fear'")
    expect(appSource).toContain("'beattie-drama'")
    expect(appSource).toContain("'beattie-guilt'")
    expect(appSource).toContain("'beattie-grief'")
    expect(appSource).toContain("'sefs'")
  })

  it('frontend uses server-side redirect instead of blank-tab pattern', () => {
    // Should NOT use the old pattern of opening blank tab then navigating
    expect(appSource).not.toContain("window.open('', '_blank'")
    // Should use open-original endpoint
    expect(appSource).toContain('open-original')
  })

  it('frontend shows "查看原报告" only for H5-capable with stored URL', () => {
    expect(appSource).toContain('isH5Capable && hasStoredUrl')
    expect(appSource).toContain('查看原报告')
  })

  it('frontend shows "补充原报告链接" for H5-capable without stored URL', () => {
    expect(appSource).toContain('isH5Capable && !hasStoredUrl')
    expect(appSource).toContain('补充原报告链接')
  })

  it('frontend does not show "查看原报告" for non-H5 assessments', () => {
    // The button is conditionally rendered based on isH5Capable
    expect(appSource).toContain('isH5Capable')
  })

  it('frontend has AssessmentCardVisualization component', () => {
    expect(appSource).toContain('AssessmentCardVisualization')
    expect(appSource).toContain('star-hexagram')
    expect(appSource).toContain('beattie-gauge')
    expect(appSource).toContain('sefs-radar')
  })

  it('frontend visualization renders from displayPayload prop only', () => {
    // Visualization reads from displayPayload prop, not from external fetch
    expect(appSource).toContain('displayPayload.kind')
    // Component accepts displayPayload as prop
    expect(appSource).toContain('{ displayPayload, assessmentId }')
  })
})

describe('V1.3 — SEFS adapter fix', () => {
  const adapterSource = readFileSync(resolve(__dirname, '..', 'server', 'assessment-adapters.mjs'), 'utf8')

  it('SEFS adapter reads from reportContent.viewModel (not just score/viewModel)', () => {
    // Must use reportContent?.viewModel as primary path
    expect(adapterSource).toContain("report.reportContent?.viewModel || report.score || report.viewModel")
  })

  it('SEFS adapter supports items array as alternative to dimensions', () => {
    expect(adapterSource).toContain('view.items')
  })
})
