import { describe, expect, it } from 'vitest'
import { CHANGE_TYPES, EVIDENCE_TYPES, SEMANTIC_KINDS, classifyEvidenceChange, chunkText, contentHash, dedupeEvidence, normalizeEvidenceCandidate } from './evidence-contract.mjs'

describe('Stage 2 evidence contract', () => {
  it('keeps the strict evidence enums and stable content hash', () => {
    expect(EVIDENCE_TYPES.has('FACT')).toBe(true)
    expect(SEMANTIC_KINDS.has('EVENT')).toBe(true)
    expect(contentHash(' a\n')).toBe(contentHash('a'))
  })

  it('chunks long text with source locators', () => {
    const chunks = chunkText('第一段\n\n' + '长'.repeat(20), 10)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].charStart).toBe(0)
    expect(chunks.every((chunk) => chunk.charEnd > chunk.charStart)).toBe(true)
  })

  it('rejects malformed candidates and deduplicates atomic evidence', () => {
    const valid = normalizeEvidenceCandidate({ evidence_type: 'FACT', semantic_kind: 'PROFILE_FIELD', field_key: 'current_city', value: '杭州', display_text: '当前城市：杭州', source_excerpt: '我已经搬到杭州了', confidence: .9 }, { sourceId: 'SRC1', chunk: { charStart: 1, charEnd: 9, paragraphIndex: 0 }, extractionBatchId: 'EXT1' })
    expect(valid.fieldKey).toBe('city')
    expect(normalizeEvidenceCandidate({ evidence_type: 'UNKNOWN', semantic_kind: 'OTHER', value: 'x', display_text: 'x', source_excerpt: 'x', confidence: .9 })).toBeNull()
    expect(dedupeEvidence([valid, { ...valid }])).toHaveLength(1)
  })

  it('distinguishes state change, stable conflict, cumulative and subjective evidence', () => {
    expect(classifyEvidenceChange({ fieldKey: 'city', semanticKind: 'CURRENT_STATE', evidenceType: 'FACT' }, '南京')).toMatchObject({ changeType: 'STATE_CHANGE', conflictType: 'POSSIBLE_STATE_CHANGE' })
    expect(classifyEvidenceChange({ fieldKey: 'birth_date', semanticKind: 'PROFILE_FIELD', evidenceType: 'FACT' }, '1990-01-01').changeType).toBe('FACT_CONTRADICTION')
    expect(classifyEvidenceChange({ fieldKey: 'hobbies', semanticKind: 'PREFERENCE', evidenceType: 'FACT' }, '瑜伽').action).toBe('APPEND')
    expect(classifyEvidenceChange({ fieldKey: 'self_description', semanticKind: 'PROFILE_FIELD', evidenceType: 'SELF_MEANING' }, '旧描述').changeType).toBe('SUBJECTIVE_DIFFERENCE')
    expect(CHANGE_TYPES.has('NO_CHANGE')).toBe(true)
  })
})
