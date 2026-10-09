import { describe, expect, it } from 'vitest'
import { buildCustomerSafetyContext } from './safety.mjs'

const evidence = (index, overrides = {}) => ({
  id: `E${index}`,
  sourceId: `S${Math.min(index, 5)}`,
  customerId: 'C-DENSITY',
  evidenceType: 'FACT',
  semanticKind: 'CURRENT_STATE',
  fieldKey: 'current_core_issue',
  standardValue: `value-${index}`,
  displayText: `状态${index}`,
  sourceExcerpt: `状态${index}`,
  confidence: 0.9,
  reviewStatus: 'CONFIRMED',
  ...overrides,
})

const build = ({ profileFields, evidenceItems, sourceRecords, stage4 } = {}) => buildCustomerSafetyContext({
  customer: { id: 'C-DENSITY', profileFields },
  evidenceItems,
  sourceRecords,
  conflicts: [],
  stage4,
})

const richFields = Object.fromEntries([
  'birth_date', 'age', 'gender', 'city', 'hometown', 'family_summary', 'parents_relationship', 'siblings', 'family_events', 'education',
  'relationship_status', 'relationship_conflicts', 'support_system', 'partner_summary', 'occupation', 'industry', 'position', 'career_stage',
  'career_problem', 'career_goal', 'hobbies', 'sports', 'reading', 'travel', 'art_preferences', 'strengths', 'self_description',
  'personality_traits', 'communication_style', 'decision_style', 'common_blocks', 'core_values', 'family_values', 'career_values',
  'growth_attitude', 'current_resources', 'current_core_issue', 'current_goal', 'current_expectation', 'current_barriers', 'energy_state',
  'recent_major_changes',
].map((key) => [key, '有记录']))

const mediumFields = Object.fromEntries([
  'birth_date', 'age', 'gender', 'city', 'hometown', 'family_summary', 'parents_relationship', 'occupation', 'industry', 'position',
  'hobbies', 'sports', 'current_core_issue', 'current_goal', 'current_expectation',
].map((key) => [key, '有记录']))

describe('Stage 5 context density compatibility', () => {
  it.each([
    ['LEGACY_STAGE4_NO_DENSITY_RICH', richFields, Array.from({ length: 30 }, (_, index) => evidence(index + 1, { semanticKind: index < 5 ? 'EVENT' : 'CURRENT_STATE', fieldKey: index < 5 ? 'career_stage' : 'current_core_issue' })), 5, 'RICH'],
    ['LEGACY_STAGE4_NO_DENSITY_MEDIUM', mediumFields, Array.from({ length: 16 }, (_, index) => evidence(index + 1, { fieldKey: index < 4 ? 'occupation' : 'current_core_issue' })), 2, 'MEDIUM'],
    ['LEGACY_STAGE4_NO_DENSITY_SPARSE', { current_core_issue: '最近有点累' }, [evidence(1)], 1, 'SPARSE'],
  ])('%s derives density from current metrics', (_name, profileFields, evidenceItems, sourceCount, expected) => {
    const context = build({ profileFields, evidenceItems, sourceRecords: Array.from({ length: sourceCount }, (_, index) => ({ id: `S${index + 1}`, customerId: 'C-DENSITY' })), stage4: { meta: { status: 'FRESH' } } })
    expect(context.context_density).toBe(expected)
    expect(context.context_density_source).toBe('DERIVED_BY_POLICY')
    expect(context.context_density_policy_version).toBe('DENSITY_V1')
  })

  it('ignores a stale persisted density instead of falling back to SPARSE', () => {
    const context = build({ profileFields: richFields, evidenceItems: Array.from({ length: 30 }, (_, index) => evidence(index + 1, { semanticKind: index < 5 ? 'EVENT' : 'CURRENT_STATE', fieldKey: index < 5 ? 'career_stage' : 'current_core_issue' })), sourceRecords: Array.from({ length: 5 }, (_, index) => ({ id: `S${index + 1}`, customerId: 'C-DENSITY' })), stage4: { meta: { status: 'FRESH', context_density: 'SPARSE' } } })
    expect(context.context_density).toBe('RICH')
  })

  it('fails closed when density metrics cannot be built', () => {
    expect(() => buildCustomerSafetyContext({ customer: { id: 'C-DENSITY', profileFields: {} }, evidenceItems: null, sourceRecords: [], conflicts: [] })).toThrowError(expect.objectContaining({ code: 'CONTEXT_BUILD_FAILED' }))
  })
})
