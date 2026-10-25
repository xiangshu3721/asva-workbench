// The model may describe the same business fact with different field names.
// This resolver is deliberately small: it maps only fields already present in
// the customer schema and never invents a new profile field.

const CITY_WORDS = /北京|上海|天津|重庆|深圳|广州|杭州|南京|苏州|成都|武汉|西安|厦门|青岛|大连|宁波|郑州|长沙|合肥|济南|福州|昆明|无锡|佛山|东莞|珠海|惠州|香港|澳门|台北/
const CURRENT_WORDS = /目前|现在|当前|现居|居住|住在|长期住|搬到|所在城市|生活在|定居/
const RESIDENCE_CURRENT_WORDS = /现居|居住|住在|生活在|定居|搬到|所在城市|(?:在|于)[^，。；]{0,8}(?:生活|居住|定居)/
const FUTURE_WORDS = /计划|打算|准备|考虑|未来|以后|将来|明年|下个月|之后|后面|想去|想搬|希望.*(?:去|搬|生活|居住|辞职|成为)/
const HISTORY_WORDS = /曾经|以前|原来|三年前|几年前|过去|历史上|曾在|曾住|离开.*(?:之前|以后)?/
const RESIDENCE_STATE_WORDS = /一个人|独居|同住|合租|和父母住|和家人住|居住状态|生活状态|居住比较稳定/
const EMPLOYMENT_CURRENT_WORDS = /目前|现在|当前|已经|已从|离职|在职|自由职业|失业|工作中/

const FIELD_REGISTRY = {
  current_city: { storageFieldKey: 'city', aliases: ['current_city', 'city', 'current_location', 'current_residence', 'residence', 'residence_city', 'living_city', 'living_location', 'living_status'] },
  occupation: { storageFieldKey: 'occupation', aliases: ['occupation', 'current_occupation', 'profession', 'job_title'] },
  employment_status: { storageFieldKey: 'job_status', aliases: ['employment_status', 'job_status', 'work_status', 'employment_state'] },
  relationship_status: { storageFieldKey: 'relationship_status', aliases: ['relationship_status', 'relationship_state'] },
  marital_status: { storageFieldKey: 'marital_status', aliases: ['marital_status', 'marriage_status'] },
  age: { storageFieldKey: 'age', aliases: ['age'] },
  gender: { storageFieldKey: 'gender', aliases: ['gender', 'sex'] },
  sleep_status: { storageFieldKey: 'sleep', aliases: ['sleep_status', 'sleep'] },
  income: { storageFieldKey: 'income_range', aliases: ['income', 'income_range'] },
  current_goal: { storageFieldKey: 'current_goal', aliases: ['current_goal', 'goal'] },
  current_core_issue: { storageFieldKey: 'current_core_issue', aliases: ['current_core_issue', 'core_issue'] },
}

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
  const canonical = ALIAS_TO_CANONICAL.get(rawField)
  if (!canonical) return { canonicalFieldKey: 'UNKNOWN', storageFieldKey: null, reason: '未找到现有档案字段映射' }
  if (canonical === 'current_city') {
    // living_status is ambiguous. Only a location quote may promote it to
    // the city field; “一个人居住/状态稳定” remains living_status.
    if (rawField === 'living_status' && !isCityLike(value, `${sourceExcerpt} ${displayText}`)) {
      return { canonicalFieldKey: 'living_status', storageFieldKey: 'living_status', reason: '居住状态语义不是城市' }
    }
    if (isResidenceStateOnly(value, `${sourceExcerpt} ${displayText}`)) {
      return { canonicalFieldKey: 'living_status', storageFieldKey: 'living_status', reason: '原文只表达居住状态' }
    }
    if (!isCityLike(value, `${sourceExcerpt} ${displayText}`)) return { canonicalFieldKey: 'UNKNOWN', storageFieldKey: null, reason: '城市字段缺少城市或居住地点语义' }
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
  if (futureNearValue && !currentNearValue) return 'FUTURE_PLAN'
  if (canonicalField === 'employment_status' && EMPLOYMENT_CURRENT_WORDS.test(quote) && !/考虑|准备|计划|以后|未来/.test(quote)) return 'CURRENT'
  if (historyNearValue && !currentNearValue) return 'HISTORICAL'
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
