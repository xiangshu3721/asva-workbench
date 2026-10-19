import { describe, expect, it } from 'vitest'
import { CONTENT_SOURCES, INFORMATION_NATURES, VERIFICATION_STATUSES, normalizeEvidenceCandidate, sourcePerspectiveFromRole } from './evidence-contract.mjs'
import { shouldAutoConfirmEvidence } from './profile-materialization.mjs'

const base = (overrides = {}) => ({
  evidence_type: 'FACT',
  semantic_kind: 'CURRENT_STATE',
  field_key: 'city',
  value: '杭州',
  display_text: '当前城市为杭州',
  source_excerpt: '我目前住在杭州',
  confidence: 0.9,
  locator: { char_start: 0, char_end: 7, paragraph_index: 0 },
  ...overrides,
})

describe('stage 2B evidence provenance contract', () => {
  it('defines the approved source, nature and verification enums', () => {
    expect([...CONTENT_SOURCES]).toEqual(expect.arrayContaining(['CUSTOMER_DIRECT', 'STAFF_TRANSCRIBED_CUSTOMER', 'MENTOR_REPORTED', 'MENTOR_OBSERVATION', 'THIRD_PARTY_REPORTED', 'UNKNOWN', 'MIXED']))
    expect([...INFORMATION_NATURES]).toEqual(expect.arrayContaining(['OBJECTIVE_RECORD', 'PERSONAL_STATEMENT', 'REPORTED_SPEECH', 'BEHAVIOR_OBSERVATION', 'SUBJECTIVE_JUDGMENT', 'AI_INFERENCE', 'UNKNOWN']))
    expect([...VERIFICATION_STATUSES]).toEqual(expect.arrayContaining(['UNKNOWN', 'SOURCE_SUPPORTED', 'HUMAN_VERIFIED', 'CONFLICTED']))
  })

  it('normalizes valid atomized provenance and never lets AI assign HUMAN_VERIFIED', () => {
    const result = normalizeEvidenceCandidate(base({ content_source: 'CUSTOMER_DIRECT', information_nature: 'PERSONAL_STATEMENT', verification_status: 'HUMAN_VERIFIED' }), { sourceId: 'SRC-1', extractionBatchId: 'EXT-1', trustedCustomerSubmission: true })
    expect(result).toMatchObject({ contentSource: 'CUSTOMER_DIRECT', informationNature: 'PERSONAL_STATEMENT', verificationStatus: 'SOURCE_SUPPORTED' })
  })

  it('degrades invalid provenance safely and preserves an unsplittable MIXED clue as unverified', () => {
    const invalid = normalizeEvidenceCandidate(base({ content_source: 'uploaded_by_customer', information_nature: 'made_up', verification_status: 'made_up' }), { sourceId: 'SRC-1', extractionBatchId: 'EXT-1' })
    const mixed = normalizeEvidenceCandidate(base({ content_source: 'MIXED', information_nature: 'REPORTED_SPEECH', verification_status: 'SOURCE_SUPPORTED' }), { sourceId: 'SRC-1', extractionBatchId: 'EXT-1' })
    expect(invalid).toMatchObject({ contentSource: 'UNKNOWN', informationNature: 'UNKNOWN', verificationStatus: 'SOURCE_SUPPORTED' })
    expect(mixed).toMatchObject({ contentSource: 'MIXED', verificationStatus: 'UNKNOWN' })
  })

  it('requires authenticated customer-submission provenance, not first-person or quotes', () => {
    const firstPerson = normalizeEvidenceCandidate(base({ content_source: 'CUSTOMER_DIRECT', information_nature: 'PERSONAL_STATEMENT', source_excerpt: '我目前住在杭州' }), { sourceId: 'SRC-1', extractionBatchId: 'EXT-1' })
    const quoted = normalizeEvidenceCandidate(base({ content_source: 'CUSTOMER_DIRECT', information_nature: 'PERSONAL_STATEMENT', source_excerpt: '“我目前住在杭州”' }), { sourceId: 'SRC-1', extractionBatchId: 'EXT-1' })
    const trusted = normalizeEvidenceCandidate(base({ content_source: 'CUSTOMER_DIRECT', information_nature: 'PERSONAL_STATEMENT', source_excerpt: '我目前住在杭州' }), { sourceId: 'SRC-1', extractionBatchId: 'EXT-1', trustedCustomerSubmission: true })
    expect(firstPerson.contentSource).toBe('UNKNOWN')
    expect(quoted.contentSource).toBe('UNKNOWN')
    expect(trusted.contentSource).toBe('CUSTOMER_DIRECT')
  })

  it('does not auto-confirm explicit unknown or AI-inferred evidence while retaining legacy compatibility', () => {
    expect(shouldAutoConfirmEvidence({ evidenceType: 'FACT', semanticKind: 'EVENT', confidence: 0.9, contentSource: 'UNKNOWN', informationNature: 'OBJECTIVE_RECORD', verificationStatus: 'SOURCE_SUPPORTED' })).toBe(false)
    expect(shouldAutoConfirmEvidence({ evidenceType: 'FACT', semanticKind: 'EVENT', confidence: 0.9, contentSource: 'CUSTOMER_DIRECT', informationNature: 'AI_INFERENCE', verificationStatus: 'SOURCE_SUPPORTED' })).toBe(false)
    expect(shouldAutoConfirmEvidence({ evidenceType: 'FACT', semanticKind: 'EVENT', confidence: 0.9 })).toBe(true)
  })

  it('keeps missing legacy source role distinct from customer direct', () => {
    expect(sourcePerspectiveFromRole('UNKNOWN')).toBe('UNKNOWN')
    expect(sourcePerspectiveFromRole('CUSTOMER')).toBe('CUSTOMER_FIRST_PARTY')
  })

  it('covers the 12 source/nature combinations used by the synthetic acceptance matrix', () => {
    const cases = [
      ['customer direct', 'CUSTOMER_DIRECT', 'PERSONAL_STATEMENT'],
      ['staff transcription', 'STAFF_TRANSCRIBED_CUSTOMER', 'REPORTED_SPEECH'],
      ['mentor report', 'MENTOR_REPORTED', 'REPORTED_SPEECH'],
      ['mentor observation', 'MENTOR_OBSERVATION', 'BEHAVIOR_OBSERVATION'],
      ['third party', 'THIRD_PARTY_REPORTED', 'REPORTED_SPEECH'],
      ['unknown speaker', 'UNKNOWN', 'UNKNOWN'],
      ['mixed note', 'MIXED', 'REPORTED_SPEECH'],
      ['objective record', 'UNKNOWN', 'OBJECTIVE_RECORD'],
      ['subjective judgment', 'MENTOR_REPORTED', 'SUBJECTIVE_JUDGMENT'],
      ['AI hypothesis', 'UNKNOWN', 'AI_INFERENCE'],
      ['customer goal', 'CUSTOMER_DIRECT', 'PERSONAL_STATEMENT'],
      ['event history', 'STAFF_TRANSCRIBED_CUSTOMER', 'REPORTED_SPEECH'],
    ]
    for (const [label, contentSource, informationNature] of cases) {
      const excerpt = contentSource === 'CUSTOMER_DIRECT' ? `我说：${label}` : label
      const result = normalizeEvidenceCandidate(base({ display_text: label, source_excerpt: excerpt, content_source: contentSource, information_nature: informationNature, verification_status: 'SOURCE_SUPPORTED' }), { sourceId: 'SRC-SYNTH', extractionBatchId: 'EXT-SYNTH' })
      expect(result, label).toMatchObject({ contentSource: contentSource === 'CUSTOMER_DIRECT' ? 'UNKNOWN' : contentSource, informationNature })
      expect(result.verificationStatus).toBe(contentSource === 'MIXED' ? 'UNKNOWN' : 'SOURCE_SUPPORTED')
    }
  })
})
