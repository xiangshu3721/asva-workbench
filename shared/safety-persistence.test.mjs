import { describe, expect, it } from 'vitest'
import { buildSafetyFailureMeta, resolveSafetyStatus, safetyEvidenceFingerprint } from './safety-contract.mjs'

describe('Safety V1 persistence contract', () => {
  it.each([
    ['FRESH', { status: 'FRESH', inputFingerprint: 'fp-1', promptVersion: 'safety-v1' }, 'fp-1'],
    ['STALE', { status: 'FRESH', inputFingerprint: 'fp-old', promptVersion: 'safety-v1' }, 'fp-1'],
    ['PROCESSING', { status: 'PROCESSING', inputFingerprint: 'fp-1', promptVersion: 'safety-v1' }, 'fp-1'],
    ['FAILED', { status: 'FAILED', inputFingerprint: 'fp-1', promptVersion: 'safety-v1' }, 'fp-1'],
  ])('resolves %s state without collapsing it into a fallback', (expected, storedMeta, inputFingerprint) => {
    expect(resolveSafetyStatus({ storedMeta, inputFingerprint })).toBe(expected)
  })

  it('keeps the last payload when a refresh fails', () => {
    const failed = buildSafetyFailureMeta({ status: 'PROCESSING', inputFingerprint: 'fp-2', payload: { risk_level: 'UNKNOWN' } }, { errorCode: 'DEEPSEEK_UNAVAILABLE', updatedAt: '2026-10-09T00:00:00.000Z' })
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'DEEPSEEK_UNAVAILABLE', payload: { risk_level: 'UNKNOWN' } })
  })

  it('keeps identical input fingerprints idempotent and changes them when evidence changes', () => {
    const base = { customer: { id: 'CUS-CONTROLLED', profileVersion: 1 }, evidenceItems: [{ id: 'E1', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', standardValue: 'x', reviewStatus: 'CONFIRMED' }] }
    const reordered = { ...base, evidenceItems: [...base.evidenceItems].reverse() }
    const changed = { ...base, evidenceItems: [{ ...base.evidenceItems[0], standardValue: 'y' }] }
    expect(safetyEvidenceFingerprint(base)).toBe(safetyEvidenceFingerprint(reordered))
    expect(safetyEvidenceFingerprint(base)).not.toBe(safetyEvidenceFingerprint(changed))
  })
})
