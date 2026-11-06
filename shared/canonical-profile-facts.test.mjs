import { describe, expect, it } from 'vitest'
import { canonicalProfileFieldCatalog, canonicalProfileFieldRegistry, classifyTemporalFact, isExplicitCustomerAcquisitionSource, normalizeCanonicalFact, resolveCanonicalField } from './canonical-profile-facts.mjs'
import { FIELD_MAPPING } from '../server/field-mapping.mjs'

describe('R037 canonical profile fact normalization', () => {
  it('maps living_status location wording to the existing city field', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'living_status', value: '深圳', sourceExcerpt: '她目前已经长期住在深圳。', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'current_city', storageFieldKey: 'city', temporalType: 'CURRENT', semanticKind: 'CURRENT_STATE', grounded: true })
  })

  it('recovers a missing model field key only when the source explicitly names an existing field', () => {
    expect(normalizeCanonicalFact({ fieldKey: '', value: '上海', sourceExcerpt: '客户现居上海。', semanticKind: 'CURRENT_STATE' })).toMatchObject({ canonicalFieldKey: 'current_city', storageFieldKey: 'city', temporalType: 'CURRENT', grounded: true })
    expect(normalizeCanonicalFact({ fieldKey: '', value: '女性', sourceExcerpt: '客户性别为女性。', semanticKind: 'PROFILE_FIELD' })).toMatchObject({ canonicalFieldKey: 'gender', storageFieldKey: 'gender', grounded: true })
    expect(normalizeCanonicalFact({ fieldKey: '', value: '参加过探索营', sourceExcerpt: '客户曾参加过探索营。', semanticKind: 'EVENT' }).storageFieldKey).toBeNull()
  })

  it('maps colloquial current location into the existing city field', () => {
    for (const excerpt of ['目前人在深圳，上过好几次探索营', '现在人在深圳', '当前人在深圳']) {
      const fact = normalizeCanonicalFact({ fieldKey: '', value: '深圳', sourceExcerpt: excerpt, semanticKind: 'CURRENT_STATE' })
      expect(fact).toMatchObject({ canonicalFieldKey: 'current_city', storageFieldKey: 'city', temporalType: 'CURRENT', grounded: true })
    }
  })

  it('does not promote a work location or an activity into current city', () => {
    const work = normalizeCanonicalFact({ fieldKey: '', value: '杭州', sourceExcerpt: '目前在杭州工作', semanticKind: 'CURRENT_STATE' })
    const activity = normalizeCanonicalFact({ fieldKey: '', value: '上过好几次探索营', sourceExcerpt: '目前人在深圳，上过好几次探索营', semanticKind: 'EVENT' })
    expect(work.storageFieldKey).toBeNull()
    expect(activity.storageFieldKey).toBeNull()
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

  it('maps only explicit customer acquisition language to the existing source field', () => {
    expect(normalizeCanonicalFact({ fieldKey: 'customer_source', value: '女性成长读书会', sourceExcerpt: '通过女性成长读书会认识', semanticKind: 'CURRENT_STATE' })).toMatchObject({ canonicalFieldKey: 'customer_source', storageFieldKey: 'source', canonicalValue: '女性成长读书会', grounded: true })
    expect(normalizeCanonicalFact({ fieldKey: 'customer_source', value: '解忧小屋微信群', sourceExcerpt: '来自解忧小屋微信群', semanticKind: 'CURRENT_STATE' }).canonicalValue).toBe('解忧小屋微信群')
    expect(normalizeCanonicalFact({ fieldKey: 'customer_source', value: '张老师转介绍', sourceExcerpt: '经张老师介绍认识', semanticKind: 'CURRENT_STATE' }).canonicalValue).toBe('张老师转介绍')
    expect(normalizeCanonicalFact({ fieldKey: 'customer_source', value: '小红书', sourceExcerpt: '在小红书看到活动后主动咨询', semanticKind: 'CURRENT_STATE' }).canonicalValue).toBe('小红书')
    expect(normalizeCanonicalFact({ fieldKey: 'customer_source', value: '杭州', sourceExcerpt: '客户来自杭州', semanticKind: 'CURRENT_STATE' }).storageFieldKey).toBeNull()
    expect(normalizeCanonicalFact({ fieldKey: 'customer_source', value: '女性成长读书会', sourceExcerpt: '参加过女性成长读书会', semanticKind: 'EVENT' }).storageFieldKey).toBeNull()
    expect(normalizeCanonicalFact({ fieldKey: 'customer_source', value: '女性成长读书会', sourceExcerpt: '通过女性成长读书会认识，也参加过其他活动', semanticKind: 'CURRENT_STATE' }).canonicalValue).toBe('女性成长读书会')
    expect(isExplicitCustomerAcquisitionSource({ value: '张老师转介绍', sourceExcerpt: '经张老师介绍认识' })).toBe(true)
    expect(isExplicitCustomerAcquisitionSource({ value: '女性成长读书会', sourceExcerpt: '参加过女性成长读书会' })).toBe(false)
  })

  it('rejects canonical values whose quote does not support them', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'city', value: '深圳', sourceExcerpt: '她目前住在杭州。', semanticKind: 'CURRENT_STATE' })
    expect(fact.grounded).toBe(false)
  })

  it('does not turn a work location into a current residence', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'city', value: '杭州', sourceExcerpt: '她在杭州工作。', semanticKind: 'EVENT' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'UNKNOWN', storageFieldKey: null })
  })

  it('does not trust a model display label to turn a work location into residence', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'city', value: '杭州', sourceExcerpt: '在杭州工作', displayText: '在杭州工作（现居城市待确认）', semanticKind: 'CURRENT_STATE' })
    expect(fact.storageFieldKey).toBeNull()
  })

  it('grounds a relationship status from an explicitly named partner', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'relationship_status', value: '有男朋友', sourceExcerpt: '最近经常和男朋友吵架', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ storageFieldKey: 'relationship_status', grounded: true })
  })

  it('does not treat a future marker as a current fact', () => {
    expect(classifyTemporalFact({ fieldKey: 'current_city', value: '广州', sourceExcerpt: '她计划以后去广州生活一段时间。', semanticKind: 'CURRENT_STATE' })).toBe('FUTURE_PLAN')
  })

  it('exposes only the minimum registry for existing profile fields', () => {
    expect(canonicalProfileFieldRegistry()).toMatchObject({ current_city: { storageFieldKey: 'city' }, occupation: { storageFieldKey: 'occupation' }, employment_status: { storageFieldKey: 'job_status' } })
  })

  it('recognizes the complete writable Customers profile schema directly', () => {
    for (const key of ['sleep', 'relationship_conflicts', 'emotion_expression', 'current_stressors', 'support_system', 'career_goal']) {
      const resolved = resolveCanonicalField({ fieldKey: key, value: '原文值', sourceExcerpt: '原文值' })
      expect(resolved.storageFieldKey).toBe(key)
      expect(FIELD_MAPPING.customers[key]).toBeTruthy()
    }
  })

  it('keeps every model-exposed field aligned with the Customers schema', () => {
    const catalog = canonicalProfileFieldCatalog()
    expect(catalog.length).toBeGreaterThan(70)
    for (const item of catalog) expect(FIELD_MAPPING.customers[item.storageFieldKey]).toBeTruthy()
  })

  it('keeps future career intent out of current occupation', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'occupation', value: '自己感兴趣的事业', sourceExcerpt: '她想做自己感兴趣的事业。', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ canonicalFieldKey: 'career_goal', storageFieldKey: 'career_goal', temporalType: 'CURRENT', semanticKind: 'CURRENT_STATE', grounded: true })
  })

  it('keeps historical city, occupation and employment facts out of current fields', () => {
    expect(normalizeCanonicalFact({ fieldKey: 'city', value: '上海', sourceExcerpt: '客户曾在上海生活。', semanticKind: 'CURRENT_STATE' })).toMatchObject({ temporalType: 'HISTORICAL', storageFieldKey: null })
    expect(normalizeCanonicalFact({ fieldKey: 'occupation', value: '教练技术咨询', sourceExcerpt: '客户过去从事教练技术咨询。', semanticKind: 'CURRENT_STATE' })).toMatchObject({ temporalType: 'HISTORICAL', storageFieldKey: null })
    expect(normalizeCanonicalFact({ fieldKey: 'job_status', value: '失业', sourceExcerpt: '客户曾失业一段时间。', semanticKind: 'CURRENT_STATE' })).toMatchObject({ temporalType: 'HISTORICAL', storageFieldKey: null })
  })

  it('separates historical and current occupation clauses in one source', () => {
    const historical = normalizeCanonicalFact({ fieldKey: 'occupation', value: '金融分析', sourceExcerpt: '客户之前从事金融分析，目前从事AI产品顾问。', semanticKind: 'CURRENT_STATE' })
    const current = normalizeCanonicalFact({ fieldKey: 'occupation', value: 'AI产品顾问', sourceExcerpt: '客户之前从事金融分析，目前从事AI产品顾问。', semanticKind: 'CURRENT_STATE' })
    expect(historical).toMatchObject({ temporalType: 'HISTORICAL', storageFieldKey: null })
    expect(current).toMatchObject({ temporalType: 'CURRENT', storageFieldKey: 'occupation' })
  })

  it('only recovers gender when the candidate is explicitly the customer gender', () => {
    const female = normalizeCanonicalFact({ fieldKey: '', value: '女性', sourceExcerpt: '客户性别为女性，曾提到一位男性导师。', semanticKind: 'PROFILE_FIELD' })
    const male = normalizeCanonicalFact({ fieldKey: '', value: '男性', sourceExcerpt: '客户性别为女性，曾提到一位男性导师。', semanticKind: 'PROFILE_FIELD' })
    expect(female).toMatchObject({ canonicalFieldKey: 'gender', storageFieldKey: 'gender', grounded: true })
    expect(male).toMatchObject({ canonicalFieldKey: 'UNKNOWN', storageFieldKey: null })
  })

  it('allows a normal structured field when its value is directly grounded', () => {
    const fact = normalizeCanonicalFact({ fieldKey: 'sleep', value: '一般', sourceExcerpt: '她最近睡眠一般。', semanticKind: 'CURRENT_STATE' })
    expect(fact).toMatchObject({ storageFieldKey: 'sleep', grounded: true, semanticKind: 'CURRENT_STATE' })
  })
})
