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

  it('compares the complete release for patch versions', () => {
    expect(releasesMatch({ release: 'R047.1', releaseCounter: 47, releasePatch: 1 }, { release: 'R047.1', releaseCounter: 47, releasePatch: 1 })).toBe(true)
    expect(releasesMatch({ release: 'R047.1', releaseCounter: 47, releasePatch: 1 }, { release: 'R047', releaseCounter: 47, releasePatch: 0 })).toBe(false)
  })
})
