import { describe, expect, it } from 'vitest'
import { canonicalProfileFieldRegistry, classifyTemporalFact, normalizeCanonicalFact, resolveCanonicalField } from './canonical-profile-facts.mjs'

describe('R037 canonical profile fact normalization', () => {
  it('maps living_status location wording to the existing city field', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'living_status', value: '深圳', sourceExcerpt: '她目前已经长期住在深圳。', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'current_city', storageFieldKey: 'city', temporalType: 'CURRENT', semanticKind: 'CURRENT_STATE', grounded: true })
  })

  it('does not turn living alone into a city', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'living_status', value: '一个人居住', sourceExcerpt: '她目前一个人居住。', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'living_status', storageFieldKey: 'living_status' })
  })

  it('classifies future city plans without creating a current fact', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'living_status', value: '深圳', sourceExcerpt: '她计划下个月去深圳看看。', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'current_city', temporalType: 'FUTURE_PLAN', semanticKind: 'EVENT', grounded: true })
  })

  it('classifies historical residence as an event', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'residence', value: '深圳', sourceExcerpt: '她三年前在深圳工作生活。', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'current_city', temporalType: 'HISTORICAL', semanticKind: 'EVENT', grounded: true })
  })

  it('maps employment aliases to the real job_status schema field', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'employment_status', value: '已离职', sourceExcerpt: '她已经从原公司离职半年。', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'employment_status', storageFieldKey: 'job_status', temporalType: 'CURRENT', grounded: true })
  })

  it('keeps resignation intent out of current employment', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'job_status', value: '已离职', sourceExcerpt: '她正在考虑辞职。', semanticKind: 'CURRENT_STATE' })
    expect(fact.temporalType).toBe('FUTURE_PLAN')
    expect(fact.semanticKind).toBe('EVENT')
  })

  it('supports stable synonyms but does not guess unknown fields', () => {
    expect(resolveCanonicalField({ fieldKey: 'current_location', value: '深圳', sourceExcerpt: '现在住在深圳' })).toMatchObject({ canonicalFieldKey: 'current_city', storageFieldKey: 'city' })
    expect(resolveCanonicalField({ fieldKey: 'mood_level', value: '稳定', sourceExcerpt: '最近状态稳定' })).toMatchObject({ canonicalFieldKey: 'UNKNOWN', storageFieldKey: null })
  })

  it('rejects canonical values whose quote does not support them', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'city', value: '深圳', sourceExcerpt: '她目前住在杭州。', semanticKind: 'CURRENT_STATE' })
    expect(fact.grounded).toBe(false)
  })

  it('does not turn a work location into a current residence', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'city', value: '杭州', sourceExcerpt: '她在杭州工作。', semanticKind: 'EVENT' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'UNKNOWN', storageFieldKey: null })
  })

  it('does not treat a future marker as a current fact', () => {
    expect(classifyTemporalFact({ fieldKey: 'current_city', value: '广州', sourceExcerpt: '她计划以后去广州生活一段时间。', semanticKind: 'CURRENT_STATE' })).toBe('FUTURE_PLAN')
  })

  it('exposes only the minimum registry for existing profile fields', () => {
    expect(canonicalProfileFieldRegistry()).toMatchObject({ current_city: { storageFieldKey: 'city' }, occupation: { storageFieldKey: 'occupation' }, employment_status: { storageFieldKey: 'job_status' } })
  })
})
