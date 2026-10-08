import { describe, expect, it } from 'vitest'
import { CHANGE_TYPES, EVIDENCE_TYPES, SEMANTIC_KINDS, classifyEvidenceChange, chunkText, contentHash, dedupeEvidence, evidenceEquivalent, normalizeEvidenceCandidate, sourcePerspectiveFromRole } from './evidence-contract.mjs'

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
    expect(classifyEvidenceChange({ fieldKey: 'birth_date', standardValue: '1990-01-01', semanticKind: 'PROFILE_FIELD', evidenceType: 'FACT' }, '1990-01-01')).toMatchObject({ action: 'KEEP_CURRENT', changeType: 'NO_CHANGE', conflictType: null })
    expect(classifyEvidenceChange({ fieldKey: 'birth_date', standardValue: '1990-01-01', semanticKind: 'PROFILE_FIELD', evidenceType: 'FACT' }, '1990-01-01T00:00:00.000Z').changeType).toBe('NO_CHANGE')
    expect(classifyEvidenceChange({ fieldKey: 'city', standardValue: '南京', semanticKind: 'CURRENT_STATE', evidenceType: 'FACT' }, '南京').changeType).toBe('NO_CHANGE')
    expect(classifyEvidenceChange({ fieldKey: 'hobbies', semanticKind: 'PREFERENCE', evidenceType: 'FACT' }, '瑜伽').action).toBe('APPEND')
    expect(classifyEvidenceChange({ fieldKey: 'self_description', semanticKind: 'PROFILE_FIELD', evidenceType: 'SELF_MEANING' }, '旧描述').changeType).toBe('SUBJECTIVE_DIFFERENCE')
    expect(CHANGE_TYPES.has('NO_CHANGE')).toBe(true)
  })

  it('maps the simplified source perspective without changing legacy roles', () => {
    expect(sourcePerspectiveFromRole('ADMIN')).toBe('STAFF_REPORTED')
    expect(sourcePerspectiveFromRole('CUSTOMER')).toBe('CUSTOMER_FIRST_PARTY')
    expect(sourcePerspectiveFromRole('MENTOR')).toBe('MENTOR_OBSERVATION')
  })

  it('treats equivalent evidence with model-shifted nearby locators as duplicates', () => {
    const left = normalizeEvidenceCandidate({ evidence_type: 'FACT', semantic_kind: 'EVENT', value: '房地产销售', display_text: '房地产销售', source_excerpt: '房地产销售', occurred_at: '约20岁', confidence: .9, locator: { char_start: 44, char_end: 70, paragraph_index: 3 } }, { sourceId: 'SRC-1', chunk: { charStart: 0, charEnd: 100, paragraphIndex: 3 }, extractionBatchId: 'EXT1' })
    const right = normalizeEvidenceCandidate({ evidence_type: 'FACT', semantic_kind: 'EVENT', value: '房地产销售', display_text: '房地产销售', source_excerpt: '房地产销售', occurred_at: '约20岁', confidence: .9, locator: { char_start: 37, char_end: 55, paragraph_index: 3 } }, { sourceId: 'SRC-1', chunk: { charStart: 0, charEnd: 100, paragraphIndex: 3 }, extractionBatchId: 'EXT2' })
    expect(evidenceEquivalent(left, right)).toBe(true)
    expect(evidenceEquivalent(left, { ...right, standardValue: '另一个值' })).toBe(false)
    expect(evidenceEquivalent(left, { ...right, occurredAt: '约21岁' })).toBe(false)
  })
})
