import { materializeCustomerProfile, summaryInputFingerprint } from './profile-materialization.mjs'

export const CUSTOMER_UNDERSTANDING_VERSION = 'customer-understanding-v1'
export const CUSTOMER_UNDERSTANDING_PROMPT_VERSION = 'understanding-v1'
export const UNDERSTANDING_STATUSES = new Set(['FRESH', 'STALE', 'PROCESSING', 'FAILED'])
export const UNDERSTANDING_CONFIDENCE = new Set(['LOW', 'MEDIUM', 'HIGH'])
export const UNDERSTANDING_TYPES = new Set(['FACT_BASED', 'SELF_MEANING_BASED', 'SYNTHESIS', 'WORKING_HYPOTHESIS'])
export const DIAGNOSIS_PATTERN = /(人格障碍|抑郁症|焦虑症|双相|精神病|依恋障碍|PTSD|MBTI|大五人格|依恋类型)/i

const SENSITIVE_FIELDS = new Set(['phone', 'wechat', 'current_mentor_id', 'mentor_id'])
const EVIDENCE_ORDER = { FACT: 4, SELF_MEANING: 3, OBSERVATION: 2, HYPOTHESIS: 1 }
const present = (value) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
const valueText = (value) => Array.isArray(value) ? value.join('、') : present(value) ? String(value) : ''
const safeText = (value, limit = 240) => valueText(value).replace(/\s+/g, ' ').trim().slice(0, limit)
const unique = (items) => [...new Set(items.filter(Boolean))]

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]))
  return value
}

function hashText(value) {
  let hash = 2166136261
  for (const character of String(value)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function evidenceRef(item, sourceRecords) {
  const source = sourceRecords.find((record) => record.id === item.sourceId)
  return {
    evidence_id: item.id,
    source_id: item.sourceId,
    source_title: safeText(source?.title || '资料记录', 80),
    display_text: safeText(item.displayText || '已记录信息', 180),
    excerpt: safeText(item.sourceExcerpt || item.displayText, 220),
    occurred_at: item.occurredAt || null,
    evidence_type: item.evidenceType,
    source_perspective: item.sourcePerspective || (item.sourceRole === 'CUSTOMER' ? 'CUSTOMER_FIRST_PARTY' : 'STAFF_REPORTED'),
  }
}

function scoreEvidence(item, { current = false } = {}) {
  const typeScore = EVIDENCE_ORDER[item.evidenceType] || 0
  const confidenceScore = Number(item.confidence || 0) * 2
  const currentScore = current && ['CURRENT_STATE', 'NEED', 'GOAL', 'RESOURCE', 'PREFERENCE'].includes(item.semanticKind) ? 2 : 0
  return typeScore + confidenceScore + currentScore
}

function sortedEvidence(items, options = {}) {
  return [...items].sort((a, b) => scoreEvidence(b, options) - scoreEvidence(a, options) || String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')) || a.id.localeCompare(b.id))
}

function profileDomains(customer) {
  const fields = customer?.profileFields || {}
  return Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => !SENSITIVE_FIELDS.has(key) && present(value))
    .map(([key, value]) => [key, valueText(value).slice(0, 300)]))
}

export function understandingInputFingerprint({ customer = {}, evidenceItems = [], conflicts = [] } = {}) {
  const confirmed = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS').map((item) => ({ id: item.id, type: item.evidenceType, kind: item.semanticKind, field: item.fieldKey || '', value: stableValue(item.standardValue), occurredAt: item.occurredAt || '' })).sort((a, b) => a.id.localeCompare(b.id))
  const openConflicts = conflicts.filter((item) => item.status === 'OPEN').map((item) => ({ field: item.fieldKey, current: stableValue(item.currentValue), proposed: stableValue(item.newValue) })).sort((a, b) => a.field.localeCompare(b.field))
  return hashText(JSON.stringify({ base: summaryInputFingerprint({ customer, evidenceItems }), profileVersion: customer.profileVersion || 0, confirmed, openConflicts }))
}

export function buildCustomerUnderstandingContext({ customer = {}, evidenceItems = [], sourceRecords = [], conflicts = [], now = new Date().toISOString() } = {}) {
  const confirmed = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS')
  const hypotheses = evidenceItems.filter((item) => item.evidenceType === 'HYPOTHESIS' || item.reviewStatus !== 'CONFIRMED')
  const renderer = materializeCustomerProfile({ customer, evidenceItems })
  const currentEvidence = sortedEvidence(confirmed.filter((item) => item.semanticKind !== 'EVENT'), { current: true }).slice(0, 18)
  const events = sortedEvidence(confirmed.filter((item) => item.semanticKind === 'EVENT')).slice(0, 12)
  const needs = sortedEvidence(confirmed.filter((item) => ['NEED', 'GOAL'].includes(item.semanticKind) || ['current_core_issue', 'current_goal', 'current_expectation', 'current_barriers'].includes(item.fieldKey)), { current: true }).slice(0, 8)
  const selfMeanings = sortedEvidence(confirmed.filter((item) => item.evidenceType === 'SELF_MEANING')).slice(0, 8)
  const observations = sortedEvidence(confirmed.filter((item) => item.evidenceType === 'OBSERVATION')).slice(0, 8)
  const resources = sortedEvidence(confirmed.filter((item) => item.semanticKind === 'RESOURCE' || ['strengths', 'current_resources', 'support_system'].includes(item.fieldKey)), { current: true }).slice(0, 8)
  const evidenceRefs = [...currentEvidence, ...events, ...needs, ...selfMeanings, ...observations, ...resources, ...hypotheses.slice(0, 5)].filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index).map((item) => evidenceRef(item, sourceRecords))
  const knownIds = new Set(confirmed.map((item) => item.id))
  const openConflictRefs = conflicts.filter((item) => item.status === 'OPEN').slice(0, 8).map((item) => ({ field_key: item.fieldKey, current_value: valueText(item.currentValue), proposed_value: valueText(item.newValue), evidence_ids: unique([item.currentEvidenceId, item.newEvidenceId]).filter((id) => knownIds.has(id)) }))
  return {
    schema_version: CUSTOMER_UNDERSTANDING_VERSION,
    generated_at: now,
    current_snapshot: profileDomains(customer),
    profile_domains: renderer.coverage.domains,
    top_life_events: events.map((item) => ({ text: safeText(item.displayText), occurred_at: item.occurredAt || null, evidence_ids: [item.id] })),
    current_goals: needs.filter((item) => item.semanticKind === 'GOAL' || item.fieldKey === 'current_goal').map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    current_needs: needs.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    recent_self_meanings: selfMeanings.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    important_observations: observations.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    resources: resources.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    open_conflicts: openConflictRefs,
    coverage_gaps: renderer.coverage.domains.filter((item) => item.status !== 'KNOWN').map((item) => item.name),
    evidence_refs: evidenceRefs,
    working_hypotheses: hypotheses.filter((item) => item.evidenceType === 'HYPOTHESIS').slice(0, 5).map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    input_fingerprint: understandingInputFingerprint({ customer, evidenceItems, conflicts }),
  }
}

const blankInsight = (text = '待进一步确认') => ({ text, evidence_ids: [], confidence: 'LOW', type: 'SYNTHESIS' })
const asList = (value, limit) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').slice(0, limit) : []
const cleanInsight = (item, fallback = '待进一步确认') => {
  const evidenceValues = item?.evidence_ids ?? item?.evidence_refs ?? item?.evidenceIds
  const sideA = safeText(item?.side_a || '', 180)
  const sideB = safeText(item?.side_b || '', 180)
  const tensionTitle = [sideA, sideB].filter(Boolean).join(' ↔ ')
  const rawText = safeText(item?.text || '', 280)
  const placeholderText = new Set(['待进一步确认', '待确认事项']).has(rawText)
  const text = tensionTitle && placeholderText ? tensionTitle : rawText || safeText(item?.title || item?.pattern || item?.need || item?.resource || item?.caution || item?.focus || tensionTitle || fallback, 280)
  return {
    text: text || fallback,
    detail: safeText(item?.detail || item?.description || item?.why_it_matters || item?.why || item?.current_cost || item?.why_now || '', 360),
    title: safeText(item?.title || '', 180),
    why_it_matters: safeText(item?.why_it_matters || item?.why || '', 300),
    pattern: safeText(item?.pattern || '', 220),
    trigger: safeText(item?.trigger || '', 220),
    current_cost: safeText(item?.current_cost || '', 220),
    resource: safeText(item?.resource || '', 220),
    side_a: sideA,
    side_b: sideB,
    description: safeText(item?.description || '', 300),
    focus: safeText(item?.focus || '', 220),
    why_now: safeText(item?.why_now || '', 260),
    suggested_entry: safeText(item?.suggested_entry || item?.prompt || '', 300),
    caution: safeText(item?.caution || '', 220),
    avoid: safeText(item?.avoid || '', 220),
    prefer: safeText(item?.prefer || '', 220),
    level: ['EXPLICIT', 'INFERRED'].includes(item?.level) ? item.level : undefined,
    supporting_events: Array.isArray(item?.supporting_events) ? item.supporting_events.map((event) => safeText(event, 180)).filter(Boolean).slice(0, 6) : [],
    evidence_ids: unique(Array.isArray(evidenceValues) ? evidenceValues.map((entry) => typeof entry === 'object' ? entry.evidence_ref || entry.evidence_id : entry).filter(Boolean).map(String) : []),
    confidence: UNDERSTANDING_CONFIDENCE.has(item?.confidence) ? item.confidence : 'LOW',
    type: UNDERSTANDING_TYPES.has(item?.type) ? item.type : 'SYNTHESIS',
  }
}

export function normalizeCustomerUnderstanding(raw, { evidenceIds = [], now = new Date().toISOString() } = {}) {
  const allowed = new Set(evidenceIds)
  const refs = (item) => cleanInsight(item)
  const normalized = {
    schema_version: CUSTOMER_UNDERSTANDING_VERSION,
    generated_at: typeof raw?.generated_at === 'string' ? raw.generated_at : now,
    one_line_understanding: refs(raw?.one_line_understanding),
    top_issues: asList(raw?.top_issues, 5).map((item) => refs(item)),
    current_life_phase: raw?.current_life_phase ? refs(raw.current_life_phase) : null,
    current_needs: asList(raw?.current_needs, 5).map((item) => refs(item)),
    core_blocks: asList(raw?.core_blocks, 5).map((item) => refs(item)),
    resources_and_strengths: asList(raw?.resources_and_strengths, 5).map((item) => refs(item)),
    key_tensions: asList(raw?.key_tensions, 5).map((item) => refs(item)),
    knowledge_gaps: (Array.isArray(raw?.knowledge_gaps) ? raw.knowledge_gaps : []).slice(0, 5).map((item) => typeof item === 'string' ? ({ text: safeText(item, 240), question: safeText(item, 240), detail: '', why_it_matters: '', related_issue: '', priority: 'MEDIUM', evidence_ids: [] }) : ({ text: safeText(item?.text || item?.question || '待确认事项', 240), question: safeText(item?.question || item?.text || '待确认事项', 240), detail: safeText(item?.detail || item?.why_it_matters || '', 320), why_it_matters: safeText(item?.why_it_matters || '', 300), related_issue: safeText(item?.related_issue || '', 180), priority: ['HIGH', 'MEDIUM', 'LOW'].includes(item?.priority) ? item.priority : 'MEDIUM', evidence_ids: unique(Array.isArray(item?.evidence_ids || item?.evidence_refs) ? (item.evidence_ids || item.evidence_refs).map((entry) => typeof entry === 'object' ? entry.evidence_ref || entry.evidence_id : entry).filter(Boolean).map(String) : []) })),
    next_conversation: asList(raw?.next_conversation, 5).map((item) => ({ ...refs(item), prompt: safeText(item?.prompt || item?.suggested_entry || '', 260) })),
    service_cautions: asList(raw?.service_cautions, 5).map((item) => ({ ...refs(item), avoid: safeText(item?.avoid || '', 260), prefer: safeText(item?.prefer || '', 260) })),
    working_hypotheses: asList(raw?.working_hypotheses, 5).map((item) => refs(item)).filter((item) => item.type === 'WORKING_HYPOTHESIS' || item.evidence_ids.length),
    meta: { overall_confidence: UNDERSTANDING_CONFIDENCE.has(raw?.meta?.overall_confidence) ? raw.meta.overall_confidence : 'LOW', evidence_count: Number(raw?.meta?.evidence_count || evidenceIds.length) || 0 },
  }
  const invalidEvidenceRefs = []
  const filterRefs = (item) => ({ ...item, evidence_ids: item.evidence_ids.filter((id) => { if (!allowed.has(id)) invalidEvidenceRefs.push(id); return allowed.has(id) }) })
  normalized.one_line_understanding = filterRefs(normalized.one_line_understanding)
  for (const key of ['top_issues', 'current_needs', 'core_blocks', 'resources_and_strengths', 'key_tensions', 'next_conversation', 'service_cautions', 'working_hypotheses']) normalized[key] = normalized[key].map(filterRefs)
  if (normalized.current_life_phase) normalized.current_life_phase = filterRefs(normalized.current_life_phase)
  normalized.knowledge_gaps = normalized.knowledge_gaps.map(filterRefs)
  normalized.meta.invalid_evidence_refs = unique(invalidEvidenceRefs)
  return normalized
}

function walkStrings(value, callback) {
  if (typeof value === 'string') callback(value)
  else if (Array.isArray(value)) value.forEach((item) => walkStrings(item, callback))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => walkStrings(item, callback))
}

export function qualityCheckCustomerUnderstanding(value, { evidenceIds = [], openConflictFields = [] } = {}) {
  const errors = []
  const allowed = new Set(evidenceIds)
  const groundingCandidates = []
  for (const key of ['one_line_understanding', 'top_issues', 'current_life_phase', 'current_needs', 'core_blocks', 'resources_and_strengths', 'key_tensions', 'next_conversation', 'service_cautions']) {
    const list = key === 'one_line_understanding' || key === 'current_life_phase' ? [value?.[key]].filter(Boolean) : (value?.[key] || [])
    groundingCandidates.push(...list)
  }
  const ungrounded = groundingCandidates.filter((item) => !item.evidence_ids?.length && item.confidence !== 'LOW').length
  const total = groundingCandidates.length || 1
  walkStrings(value, (text) => { if (DIAGNOSIS_PATTERN.test(text)) errors.push('UNSUPPORTED_DIAGNOSIS') })
  if (value?.meta?.invalid_evidence_refs?.length) errors.push('UNKNOWN_EVIDENCE_REF')
  for (const item of groundingCandidates) for (const id of item.evidence_ids || []) if (!allowed.has(id)) errors.push('UNKNOWN_EVIDENCE_REF')
  for (const conflictField of openConflictFields) {
    const conflictText = JSON.stringify(value || {})
    if (conflictText.includes(`"${conflictField}"`) || conflictText.includes(conflictField)) errors.push('OPEN_CONFLICT_USED_AS_FACT')
  }
  if (!value?.knowledge_gaps?.length) errors.push('MISSING_KNOWLEDGE_GAPS')
  return { ok: errors.length === 0, errors: [...new Set(errors)], ungroundedClaimRate: ungrounded / total, unsupportedDiagnosis: errors.includes('UNSUPPORTED_DIAGNOSIS'), unknownHandling: Boolean(value?.knowledge_gaps?.length), contradictionHandling: !errors.includes('OPEN_CONFLICT_USED_AS_FACT') }
}

export function createLocalCustomerUnderstanding(context) {
  const refsFor = (items) => items.slice(0, 3).map((item) => ({ text: item.text, evidence_ids: item.evidence_ids, confidence: 'HIGH', type: 'FACT_BASED' }))
  const needs = refsFor(context.current_needs || [])
  const resources = refsFor(context.resources || [])
  const events = refsFor(context.top_life_events || [])
  const gaps = (context.coverage_gaps || []).slice(0, 4).map((text) => ({ text: `还需要了解${text}`, detail: '当前资料尚不足以形成稳定判断。', priority: 'MEDIUM', evidence_ids: [] }))
  return normalizeCustomerUnderstanding({ generated_at: context.generated_at, one_line_understanding: { text: needs[0]?.text || '当前资料有限，先建立对客户处境的基本理解。', evidence_ids: needs[0]?.evidence_ids || [], confidence: needs[0] ? 'HIGH' : 'LOW', type: needs[0] ? 'FACT_BASED' : 'SYNTHESIS' }, top_issues: needs, current_life_phase: events[0] || null, current_needs: needs, core_blocks: [], resources_and_strengths: resources, key_tensions: [], knowledge_gaps: gaps, next_conversation: [{ text: '先确认客户最近最希望解决的一件具体事情', prompt: '最近最让你想优先处理的是什么？', evidence_ids: [] }], service_cautions: [{ text: '先确认再解释', detail: '资料不足时不把推测当成事实。', evidence_ids: [] }], meta: { overall_confidence: needs.length ? 'MEDIUM' : 'LOW', evidence_count: context.evidence_refs?.length || 0 } }, { evidenceIds: (context.evidence_refs || []).map((item) => item.evidence_id), now: context.generated_at })
}
