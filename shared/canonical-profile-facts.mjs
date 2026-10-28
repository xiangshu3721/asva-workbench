// The model may describe the same business fact with different field names.
// This resolver accepts the complete writable Customers profile schema, while
// keeping a small alias layer for common model wording. It never invents a
// storage field outside that schema.

const CITY_WORDS = /北京|上海|天津|重庆|深圳|广州|杭州|南京|苏州|成都|武汉|西安|厦门|青岛|大连|宁波|郑州|长沙|合肥|济南|福州|昆明|无锡|佛山|东莞|珠海|惠州|香港|澳门|台北/
const CURRENT_WORDS = /目前|现在|当前|现居|居住|住在|长期住|搬到|所在城市|生活在|定居/
const RESIDENCE_CURRENT_WORDS = /现居|居住|住在|生活在|定居|搬到|所在城市|(?:在|于)[^，。；]{0,8}(?:生活|居住|定居)/
const FUTURE_WORDS = /计划|打算|准备|考虑|未来|以后|将来|明年|下个月|之后|后面|想去|想搬|想做|想从事|希望.*(?:去|搬|生活|居住|辞职|成为|从事)/
const HISTORY_WORDS = /曾经|以前|原来|三年前|几年前|过去|历史上|曾在|曾住|离开.*(?:之前|以后)?/
const RESIDENCE_STATE_WORDS = /一个人|独居|同住|合租|和父母住|和家人住|居住状态|生活状态|居住比较稳定/
const EMPLOYMENT_CURRENT_WORDS = /目前|现在|当前|已经|已从|离职|在职|自由职业|失业|工作中/
const GOAL_FIELDS = new Set(['career_goal', 'relationship_goal', 'current_goal', 'current_expectation'])

const DIRECT_PROFILE_FIELDS = `
gender birth_date age birth_year hometown marital_status education living_status children_summary
industry position work_years career_stage career_satisfaction career_problem career_goal entrepreneurship_experience
family_summary parents_relationship father_summary mother_summary relationship_with_father relationship_with_mother siblings family_events family_support_level
relationship_status partner_summary marriage_years relationship_satisfaction relationship_conflicts communication_pattern conflict_pattern relationship_goal
children_detail parent_child_relationship parenting_problem parenting_values
hobbies sports reading travel art_preferences social_preference diet routine life_satisfaction
self_description personality_traits communication_style decision_style emotion_expression stress_response conflict_style action_style strengths common_blocks
core_values family_values career_values money_values relationship_values success_definition happiness_definition freedom_definition growth_attitude
current_core_issue secondary_issues current_stressors current_goal current_expectation current_resources support_system current_barriers energy_state recent_major_changes
`.trim().split(/\s+/)

const FIELD_REGISTRY = Object.fromEntries(DIRECT_PROFILE_FIELDS.map((key) => [key, { storageFieldKey: key, aliases: [key] }]))
Object.assign(FIELD_REGISTRY, {
  current_city: { storageFieldKey: 'city', aliases: ['current_city', 'city', 'current_location', 'current_residence', 'residence', 'residence_city', 'living_city', 'living_location'] },
  occupation: { storageFieldKey: 'occupation', aliases: ['occupation', 'current_occupation', 'profession', 'job_title', 'current_job'] },
  employment_status: { storageFieldKey: 'job_status', aliases: ['employment_status', 'job_status', 'work_status', 'employment_state'] },
  sleep_status: { storageFieldKey: 'sleep', aliases: ['sleep_status', 'sleep', 'sleep_quality'] },
  income: { storageFieldKey: 'income_range', aliases: ['income', 'income_range'] },
})

const EXTRA_ALIASES = {
  birth_date: ['date_of_birth', 'birthday'],
  birth_year: ['year_of_birth'],
  hometown: ['birth_place', 'origin_place'],
  marital_status: ['marriage_status'],
  education: ['education_background'],
  children_summary: ['children'],
  industry: ['sector'],
  position: ['job_position', 'role_title'],
  work_years: ['years_of_experience'],
  career_problem: ['career_issue'],
  career_goal: ['career_plan', 'career_aspiration'],
  relationship_status: ['relationship_state'],
  relationship_conflicts: ['relationship_problem'],
  current_core_issue: ['core_issue', 'current_issue'],
  secondary_issues: ['other_issues'],
  current_stressors: ['stressors'],
  current_goal: ['goal'],
  current_expectation: ['expectation', 'help_expectation'],
  current_resources: ['resources'],
  support_system: ['support_network'],
  current_barriers: ['barriers'],
  recent_major_changes: ['major_changes'],
}
for (const [key, aliases] of Object.entries(EXTRA_ALIASES)) FIELD_REGISTRY[key].aliases.push(...aliases)

const ALIAS_TO_CANONICAL = new Map(Object.entries(FIELD_REGISTRY).flatMap(([canonical, definition]) => definition.aliases.map((alias) => [alias, canonical])))

function compact(value) { return String(value || '').replace(/\s+/g, '') }
function text(value) { return String(value || '').trim() }
function valueText(value) { return Array.isArray(value) ? value.map(valueText).join('、') : text(value) }

function nearby(textValue, pattern, value) {
  const quote = text(textValue)
  const candidate = text(value)
  if (!candidate) return pattern.test(quote)
  const index = quote.indexOf(candidate)
  if (index < 0) return pattern.test(quote)
  return pattern.test(quote.slice(Math.max(0, index - 18), Math.min(quote.length, index + candidate.length + 18)))
}

function isCityLike(value, quote) {
  const candidate = valueText(value)
  return Boolean(candidate && CITY_WORDS.test(candidate) && (RESIDENCE_CURRENT_WORDS.test(quote) || FUTURE_WORDS.test(quote) || HISTORY_WORDS.test(quote)))
}

function isResidenceStateOnly(value, quote) {
  return RESIDENCE_STATE_WORDS.test(`${valueText(value)} ${quote}`) && !CITY_WORDS.test(valueText(value))
}

export function resolveCanonicalField({ fieldKey = '', value = '', sourceExcerpt = '', displayText = '' } = {}) {
  const rawField = text(fieldKey).toLowerCase()
  // Only the original excerpt is evidence. A model-generated display label
  // may explain ambiguity but must never add residence, timing, or identity
  // semantics that are absent from the customer's source material.
  const quote = text(sourceExcerpt)
  const canonical = rawField === 'living_status' && isCityLike(value, quote)
    ? 'current_city'
    : ALIAS_TO_CANONICAL.get(rawField)
  if (!canonical) return { canonicalFieldKey: 'UNKNOWN', storageFieldKey: null, reason: '未找到现有档案字段映射' }
  if (canonical === 'occupation' && nearby(quote, FUTURE_WORDS, value) && !nearby(quote, CURRENT_WORDS, value)) {
    return { canonicalFieldKey: 'career_goal', storageFieldKey: 'career_goal', reason: '未来职业意向归入职业目标而不是当前职业' }
  }
  if (canonical === 'current_city') {
    if (isResidenceStateOnly(value, quote)) {
      return { canonicalFieldKey: 'living_status', storageFieldKey: 'living_status', reason: '原文只表达居住状态' }
    }
    if (!isCityLike(value, quote)) return { canonicalFieldKey: 'UNKNOWN', storageFieldKey: null, reason: '城市字段缺少城市或居住地点语义' }
  }
  return { canonicalFieldKey: canonical, storageFieldKey: FIELD_REGISTRY[canonical].storageFieldKey, reason: `归一到现有字段 ${FIELD_REGISTRY[canonical].storageFieldKey}` }
}

export function classifyTemporalFact({ fieldKey = '', value = '', sourceExcerpt = '', semanticKind = '' } = {}) {
  const quote = text(sourceExcerpt)
  const canonicalField = text(fieldKey).toLowerCase()
  const candidate = valueText(value)
  const futureNearValue = nearby(quote, FUTURE_WORDS, candidate)
  const historyNearValue = nearby(quote, HISTORY_WORDS, candidate)
  const currentNearValue = nearby(quote, CURRENT_WORDS, candidate)
  if (historyNearValue && !currentNearValue) return 'HISTORICAL'
  if (GOAL_FIELDS.has(canonicalField) && futureNearValue) return 'CURRENT'
  if (futureNearValue && !currentNearValue) return 'FUTURE_PLAN'
  if (canonicalField === 'employment_status' && EMPLOYMENT_CURRENT_WORDS.test(quote) && !/考虑|准备|计划|以后|未来/.test(quote)) return 'CURRENT'
  if (currentNearValue || (canonicalField === 'employment_status' && /离职|在职|自由职业/.test(quote))) return 'CURRENT'
  if (semanticKind === 'EVENT') return 'HISTORICAL'
  return 'CURRENT'
}

function canonicalValueMatchesQuote(fieldKey, value, quote) {
  const candidate = compact(valueText(value))
  const source = compact(quote)
  if (!candidate || !source) return false
  if (source.includes(candidate)) return true
  if (fieldKey === 'current_city' && CITY_WORDS.test(candidate)) return source.includes(candidate) && (CURRENT_WORDS.test(quote) || FUTURE_WORDS.test(quote) || HISTORY_WORDS.test(quote))
  if (fieldKey === 'employment_status') return /离职|在职|自由职业|失业|工作中/.test(`${valueText(value)} ${quote}`) && EMPLOYMENT_CURRENT_WORDS.test(quote)
  if (fieldKey === 'occupation') return /职业|工作|从事|做|职位|岗位/.test(quote)
  if (fieldKey === 'gender') return /男|女/.test(candidate) && source.includes(candidate.slice(0, 1))
  if (fieldKey === 'relationship_status') {
    if (/恋爱|有伴侣/.test(candidate)) return /恋爱|男朋友|女朋友|对象|伴侣/.test(quote)
    if (/有(?:男|女)朋友/.test(candidate)) return /男朋友|女朋友/.test(quote)
    if (/单身/.test(candidate)) return /单身|没有(?:男|女)朋友|无伴侣/.test(quote)
    if (/已婚|婚姻/.test(candidate)) return /已婚|结婚|丈夫|妻子|爱人/.test(quote)
  }
  if (fieldKey === 'marital_status') {
    if (/已婚/.test(candidate)) return /已婚|结婚|丈夫|妻子/.test(quote)
    if (/未婚|单身/.test(candidate)) return /未婚|单身/.test(quote)
    if (/离异|离婚/.test(candidate)) return /离异|离婚/.test(quote)
  }
  if (fieldKey === 'birth_date') {
    const digits = candidate.replace(/\D/g, '')
    const quoteDigits = source.replace(/\D/g, '')
    return digits.length >= 6 && quoteDigits.includes(digits)
  }
  return false
}

export function normalizeCanonicalFact({ fieldKey = '', value = '', sourceExcerpt = '', displayText = '', semanticKind = '', occurredAt = '' } = {}) {
  const resolved = resolveCanonicalField({ fieldKey, value, sourceExcerpt, displayText })
  if (resolved.canonicalFieldKey === 'UNKNOWN') return { ...resolved, canonicalValue: value, temporalType: classifyTemporalFact({ fieldKey, value, sourceExcerpt, semanticKind }), grounded: true, semanticKind }
  const temporalType = classifyTemporalFact({ fieldKey: resolved.canonicalFieldKey, value, sourceExcerpt, semanticKind })
  const grounded = canonicalValueMatchesQuote(resolved.canonicalFieldKey, value, sourceExcerpt)
  const effectiveSemanticKind = temporalType === 'CURRENT' ? (resolved.storageFieldKey ? 'CURRENT_STATE' : semanticKind) : 'EVENT'
  return {
    ...resolved,
    canonicalValue: value,
    temporalType,
    grounded,
    semanticKind: effectiveSemanticKind,
    occurredAt: text(occurredAt),
  }
}

export function canonicalProfileFieldRegistry() {
  return Object.fromEntries(Object.entries(FIELD_REGISTRY).map(([key, value]) => [key, { ...value, aliases: [...value.aliases] }]))
}

export function canonicalProfileFieldCatalog() {
  const seen = new Set()
  return Object.entries(FIELD_REGISTRY).flatMap(([canonicalFieldKey, definition]) => {
    if (seen.has(definition.storageFieldKey)) return []
    seen.add(definition.storageFieldKey)
    return [{ canonicalFieldKey, storageFieldKey: definition.storageFieldKey, aliases: [...definition.aliases] }]
  })
}
