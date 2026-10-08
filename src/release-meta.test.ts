import { describe, expect, it } from 'vitest'
import { releaseVersion, releasesMatch } from './release-meta'

describe('release metadata indicator', () => {
  it('compares frontend and backend counters without hardcoded release values', () => {
    expect(releasesMatch({ release: 'R002', releaseCounter: 2 }, { release: 'R002', releaseCounter: 2 })).toBe(true)
    expect(releasesMatch({ release: 'R002', releaseCounter: 2 }, { release: 'R003', releaseCounter: 3 })).toBe(false)
    expect(releasesMatch({}, {})).toBeNull()
    expect(releaseVersion({ release: 'R002' })).toBe('R002')
    expect(releaseVersion({})).toBe('UNKNOWN')
  })
})
