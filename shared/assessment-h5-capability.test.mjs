import { describe, expect, it } from 'vitest'
import { hasH5ShareCapability, H5_CAPABLE_ASSESSMENT_IDS } from './assessment-h5-capability.mjs'

describe('V1.3 — H5 share capability', () => {
  it('star has H5 share capability', () => {
    expect(hasH5ShareCapability('star')).toBe(true)
  })

  it('all 6 beattie assessments have H5 share capability', () => {
    const beattieIds = [
      'beattie-emotional-health',
      'beattie-anger',
      'beattie-fear',
      'beattie-drama',
      'beattie-guilt',
      'beattie-grief',
    ]
    for (const id of beattieIds) {
      expect(hasH5ShareCapability(id)).toBe(true)
    }
  })

  it('exactly 8 assessments have H5 capability', () => {
    expect(H5_CAPABLE_ASSESSMENT_IDS.size).toBe(8)
  })

  it('scl90 does NOT have H5 share capability', () => {
    expect(hasH5ShareCapability('scl90')).toBe(false)
  })

  it('pdq4 does NOT have H5 share capability', () => {
    expect(hasH5ShareCapability('pdq4')).toBe(false)
  })

  it('ecr does NOT have H5 share capability', () => {
    expect(hasH5ShareCapability('ecr')).toBe(false)
  })

  it('sefs has H5 share capability (real H5 report exists)', () => {
    expect(hasH5ShareCapability('sefs')).toBe(true)
  })

  it('unknown assessment IDs do NOT have H5 share capability', () => {
    expect(hasH5ShareCapability('unknown-assessment')).toBe(false)
    expect(hasH5ShareCapability('')).toBe(false)
  })
})
