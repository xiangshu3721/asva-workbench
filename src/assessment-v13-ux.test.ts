import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverIndexPath = resolve(__dirname, '..', 'server', 'index.mjs')
const appPath = resolve(__dirname, 'App.tsx')

describe('V1.3 — share-url based navigation', () => {
  const appSource = readFileSync(appPath, 'utf8')

  it('frontend opens blank tab without noopener for navigation', () => {
    // Must open about:blank without noopener (so we get a reference to navigate)
    expect(appSource).toContain("window.open('about:blank', '_blank')")
    // Must NOT use noopener which causes null reference
    expect(appSource).not.toContain("window.open(openUrl, '_blank', 'noopener")
  })

  it('frontend calls share-url API with Bearer token for auth', () => {
    // Uses the existing authenticated API (not a direct URL with token)
    expect(appSource).toContain('getAssessmentShareUrl')
    // Navigates the already-opened tab to the share URL
    expect(appSource).toContain('newTab.location.href = result.shareUrl')
  })

  it('frontend disconnects opener for security after navigation', () => {
    expect(appSource).toContain('newTab.opener = null')
  })

  it('frontend closes blank tab on error', () => {
    expect(appSource).toContain('newTab.close()')
  })

  it('frontend does NOT put token in URL', () => {
    // Token stays in Authorization header via the API call
    expect(appSource).not.toContain('token=')
    expect(appSource).not.toContain('access_token=')
  })

  it('frontend does NOT use server-side 302 redirect endpoint', () => {
    // The open-original endpoint was removed — auth can't be carried via 302
    expect(appSource).not.toContain('/open-original')
  })
})

describe('V1.3 — server enrichment from snapshot', () => {
  const serverSource = readFileSync(serverIndexPath, 'utf8')

  it('server enriches preview from snapshot for existing reports', () => {
    expect(serverSource).toContain('enrichPreviewFromSnapshot')
    expect(serverSource).toContain('displayPayload')
  })

  it('server strips snapshot before sending to frontend', () => {
    // snapshot must not be returned to the client
    expect(serverSource).toContain("snapshot: _omit")
  })

  it('server still uses share-url endpoint (not open-original)', () => {
    expect(serverSource).toContain('/share-url')
    // open-original was removed
    expect(serverSource).not.toContain('/open-original')
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

  it('frontend shows "查看原报告" only for H5-capable with stored URL', () => {
    expect(appSource).toContain('isH5Capable && hasStoredUrl')
    expect(appSource).toContain('查看原报告')
  })

  it('frontend shows "补充原报告链接" for H5-capable without stored URL', () => {
    expect(appSource).toContain('isH5Capable && !hasStoredUrl')
    expect(appSource).toContain('补充原报告链接')
  })

  it('frontend has AssessmentCardVisualization component', () => {
    expect(appSource).toContain('AssessmentCardVisualization')
    expect(appSource).toContain('star-hexagram')
    expect(appSource).toContain('beattie-gauge')
    expect(appSource).toContain('sefs-radar')
  })

  it('SEFS radar uses SVG with fixed max score', () => {
    expect(appSource).toContain('sefs-radar-svg')
    expect(appSource).toContain('maxScorePerDim')
    // Must NOT normalize to current max
    expect(appSource).not.toContain('axis.normalized')
  })

  it('Star uses SVG hexagram (two triangles)', () => {
    expect(appSource).toContain('star-mark')
    expect(appSource).toContain('polygon')
    expect(appSource).toContain('points="50,8 86.4,71 13.6,71"')
  })
})

describe('V1.3 — SEFS adapter fix', () => {
  const adapterSource = readFileSync(resolve(__dirname, '..', 'server', 'assessment-adapters.mjs'), 'utf8')

  it('SEFS adapter reads from reportContent.viewModel (not just score/viewModel)', () => {
    expect(adapterSource).toContain("report.reportContent?.viewModel || report.score || report.viewModel")
  })

  it('SEFS adapter supports items array as alternative to dimensions', () => {
    expect(adapterSource).toContain('view.items')
  })

  it('SEFS adapter uses fixed max score per dimension (not current max)', () => {
    expect(adapterSource).toContain('dimMax')
    expect(adapterSource).toContain('maxScorePerDim')
    // Must NOT normalize to current max
    expect(adapterSource).not.toContain('Math.max(...sortedDims')
  })

  it('SEFS adapter preserves original dimension order for radar chart', () => {
    expect(adapterSource).toContain('orderedDims')
  })
})
