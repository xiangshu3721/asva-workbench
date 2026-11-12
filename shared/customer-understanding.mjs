import { materializeCustomerProfile, summaryInputFingerprint } from './profile-materialization.mjs'

export const CUSTOMER_UNDERSTANDING_VERSION = 'customer-understanding-v1'
export const CUSTOMER_UNDERSTANDING_PROMPT_VERSION = 'understanding-v4-provisional-context-cache'
export const CONTEXT_DENSITY_POLICY_VERSION = 'DENSITY_V1'
export const UNDERSTANDING_STATUSES = new Set(['FRESH', 'STALE', 'PROCESSING', 'FAILED'])
export const UNDERSTANDING_CONFIDENCE = new Set(['LOW', 'MEDIUM', 'HIGH'])
export const UNDERSTANDING_TYPES = new Set(['FACT_BASED', 'SELF_MEANING_BASED', 'SYNTHESIS', 'WORKING_HYPOTHESIS'])
export const DIAGNOSIS_PATTERN = /(人格障碍|抑郁症|焦虑症|双相|精神病|依恋障碍|PTSD|MBTI|大五人格|依恋类型)/i

const SENSITIVE_FIELDS = new Set(['phone', 'wechat', 'current_mentor_id', 'mentor_id'])
const EVIDENCE_ORDER = { FACT: 4, SELF_MEANING: 3, OBSERVATION: 2, HYPOTHESIS: 1 }
const CURRENT_ISSUE_FIELDS = new Set(['current_core_issue', 'current_goal', 'current_expectation', 'current_barriers'])
const RESOLVED_ISSUE_PATTERN = /(已(?:经)?(?:解决|缓解|恢复|过去)|不再(?:困扰|需要|影响)|曾经.*(?:已解决|已恢复))/
const EXPLICIT_ISSUE_PATTERN = /(困扰|压力|冲突|困难|卡住|拖延|失眠|痛苦|负担|危机|中断|问题|无法|影响)/
const CURRENT_IMPACT_PATTERN = /(影响|导致|无法|反复|持续|下降|中断|冲突|困难|拖延|失眠)/
const CONSULTATION_TOPIC_PATTERN = /(咨询|想谈|想聊|需要帮助).{0,24}(情感|关系|婚姻|伴侣|家庭|亲子|职业|工作|睡眠|压力)|(?:关于|对于|围绕).{0,15}(?:目前|未来|现在)?(?:工作|职业|发展|情感|关系|家庭|亲子).{0,18}(?:探讨|讨论|交流|咨询)|(?:工作|职业|情感|关系).{0,12}(?:发展|方向).{0,12}(?:探讨|讨论|交流|咨询)/
const CONCRETE_CURRENT_ISSUE_PATTERN = /(困扰|压力|冲突|困难|卡住|拖延|失眠|痛苦|负担|危机|中断|无法|影响)/
const PROVISIONAL_DIRECTION_DETAIL = '原始资料已提及该咨询主题，具体情况待客户确认。'
const AI_SUMMARY_PREFIX_PATTERN = /^(?:AI|人工智能)\s*(?:总结|推测|分析|理解|生成|判断)\s*[：:]/i
const AI_DERIVED_EVIDENCE_TYPES = new Set(['HYPOTHESIS', 'AI_INFERENCE'])
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
    source_perspective: item.sourcePerspective || source?.sourcePerspective || (item.sourceRole === 'CUSTOMER' ? 'CUSTOMER_FIRST_PARTY' : 'STAFF_REPORTED'),
    content_source: item.contentSource || null,
    information_nature: item.informationNature || null,
    verification_status: item.verificationStatus || null,
    provenance_status: item.provenanceStatus || (item.contentSource || item.informationNature || item.verificationStatus ? 'EXPLICIT' : 'LEGACY_MISSING'),
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

function isCurrentIssueEvidence(item) {
  const text = safeText(item?.displayText || item?.standardValue)
  if (item?.semanticKind === 'EVENT' || RESOLVED_ISSUE_PATTERN.test(text) || ['STAFF_REPORTED', 'MENTOR_OBSERVATION'].includes(item?.sourcePerspective)) return false
  if (CONSULTATION_TOPIC_PATTERN.test(text) && !CONCRETE_CURRENT_ISSUE_PATTERN.test(text)) return false
  const explicitIssue = item?.fieldKey === 'current_core_issue' || (item?.semanticKind === 'NEED' && EXPLICIT_ISSUE_PATTERN.test(text))
  const impactSupportingFact = item?.evidenceType === 'FACT' && (item?.semanticKind === 'CURRENT_STATE' || item?.fieldKey === 'current_barriers') && CURRENT_IMPACT_PATTERN.test(text)
  return explicitIssue || impactSupportingFact
}

function consultationDirectionTitle(text) {
  if (/(情感|关系|婚姻|伴侣)/.test(text)) return '情感关系方面的咨询需求'
  if (/(家庭|亲子)/.test(text)) return '家庭关系方面的咨询需求'
  if (/(职业|工作)/.test(text)) return '职业发展方面的咨询需求'
  if (/(睡眠|压力)/.test(text)) return '身心状态方面的咨询需求'
  return safeText(text, 120)
}

function consultationDirection(text, evidenceIds = [], sourcePerspective = null) {
  const sourceText = safeText(text, 320)
  if (AI_SUMMARY_PREFIX_PATTERN.test(sourceText) || !CONSULTATION_TOPIC_PATTERN.test(sourceText) || RESOLVED_ISSUE_PATTERN.test(sourceText)) return null
  const title = consultationDirectionTitle(sourceText)
  // Unsourced or unverified notes supply a topic label, not a raw personal narrative.
  return { text: evidenceIds.length ? sourceText : title, title, evidence_ids: evidenceIds, source_perspective: sourcePerspective, provisional: true }
}

function currentIssuePriority(item) {
  const explicitNeed = item?.semanticKind === 'NEED' || item?.fieldKey === 'current_core_issue'
  const customerStatement = item?.sourcePerspective === 'CUSTOMER_FIRST_PARTY' || item?.evidenceType === 'SELF_MEANING'
  return (explicitNeed ? 8 : 2) + (customerStatement ? 3 : 0) + scoreEvidence(item, { current: true })
}

function sortedCurrentIssueEvidence(items) {
  return [...items].sort((a, b) => currentIssuePriority(b) - currentIssuePriority(a) || String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')) || a.id.localeCompare(b.id))
}

function normalizeIssueText(value) {
  return safeText(value, 280).toLowerCase().replace(/[\s，。、“”‘’：；、,.!?！？()（）\-]/g, '')
}

function issueTerms(value) {
  const text = normalizeIssueText(value)
  const terms = new Set()
  for (let index = 0; index < text.length - 1; index += 1) terms.add(text.slice(index, index + 2))
  return terms
}

function isSimilarIssue(left, right) {
  const a = normalizeIssueText(left)
  const b = normalizeIssueText(right)
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const aTerms = issueTerms(a)
  const bTerms = issueTerms(b)
  const shared = [...aTerms].filter((term) => bTerms.has(term)).length
  return shared / Math.max(aTerms.size, bTerms.size, 1) >= 0.72 || (shared >= 3 && shared / Math.min(aTerms.size, bTerms.size, 1) >= 0.5)
}

function profileDomains(customer) {
  const fields = customer?.profileFields || {}
  const fieldMeta = customer?.profileFieldMeta || {}
  return Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => !SENSITIVE_FIELDS.has(key) && present(value) && fieldMeta[key]?.confirmed !== false)
    .map(([key, value]) => [key, valueText(value).slice(0, 300)]))
}

export function classifyUnderstandingContextDensity({ profileCoverage = 0, confirmedEvidenceCount = 0, sourceCount = 0, knownDomainCount = 0, lifeEventCount = 0 } = {}) {
  const sparseSignals = [profileCoverage < 40, confirmedEvidenceCount < 12, sourceCount <= 1, knownDomainCount <= 3, lifeEventCount <= 2].filter(Boolean).length
  const richSignals = [profileCoverage >= 70, confirmedEvidenceCount >= 24, sourceCount >= 3, knownDomainCount >= 7, lifeEventCount >= 3].filter(Boolean).length
  const classification = sparseSignals >= 2 ? 'SPARSE' : profileCoverage >= 90 && richSignals >= 4 ? 'RICH' : 'MEDIUM'
  return { policy_version: CONTEXT_DENSITY_POLICY_VERSION, classification, profile_coverage: profileCoverage, confirmed_evidence_count: confirmedEvidenceCount, source_count: sourceCount, known_domain_count: knownDomainCount, life_event_count: lifeEventCount, sparse_signal_count: sparseSignals, rich_signal_count: richSignals }
}

export function applyUnderstandingDensityPolicy(value, density = {}) {
  if (density.classification !== 'SPARSE') return value
  return {
    ...value,
    top_issues: (value.top_issues || []).slice(0, 2),
    current_needs: (value.current_needs || []).slice(0, 3),
    core_blocks: (value.core_blocks || []).slice(0, 1),
    resources_and_strengths: (value.resources_and_strengths || []).slice(0, 2),
    key_tensions: [],
    knowledge_gaps: (value.knowledge_gaps || []).slice(0, 5),
    next_conversation: (value.next_conversation || []).slice(0, 2),
    working_hypotheses: (value.working_hypotheses || []).slice(0, 1),
    meta: { ...(value.meta || {}), context_density: 'SPARSE' },
  }
}

export function understandingInputFingerprint({ customer = {}, evidenceItems = [], conflicts = [] } = {}) {
  const confirmed = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS').map((item) => ({ id: item.id, type: item.evidenceType, kind: item.semanticKind, field: item.fieldKey || '', value: stableValue(item.standardValue), occurredAt: item.occurredAt || '' })).sort((a, b) => a.id.localeCompare(b.id))
  const openConflicts = conflicts.filter((item) => item.status === 'OPEN').map((item) => ({ field: item.fieldKey, current: stableValue(item.currentValue), proposed: stableValue(item.newValue) })).sort((a, b) => a.field.localeCompare(b.field))
  const recordedContext = {
    notes: safeText(customer.notes, 1200),
    supplementaryTopics: (customer.supplementaryItems || []).filter((item) => item?.status !== 'REJECTED' && item?.reviewStatus !== 'REJECTED').map((item) => ({ id: item.id || '', text: safeText(item.text, 320), source: item.source || '', status: item.status || '', verificationStatus: item.verificationStatus || '' })).sort((a, b) => `${a.id}:${a.text}`.localeCompare(`${b.id}:${b.text}`)),
    need: safeText(customer.need, 300),
    goal: safeText(customer.goal, 300),
    helpExpectation: safeText(customer.helpExpectation, 300),
    source: safeText(customer.source, 160),
  }
  return hashText(JSON.stringify({ base: summaryInputFingerprint({ customer, evidenceItems }), profileVersion: customer.profileVersion || 0, recordedContext, confirmed, openConflicts }))
}

export function buildCustomerUnderstandingContext({ customer = {}, evidenceItems = [], sourceRecords = [], conflicts = [], now = new Date().toISOString() } = {}) {
  const confirmed = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS')
  const hypotheses = evidenceItems.filter((item) => item.evidenceType === 'HYPOTHESIS' || item.reviewStatus !== 'CONFIRMED')
  const renderer = materializeCustomerProfile({ customer, evidenceItems })
  const knownIds = new Set(confirmed.map((item) => item.id))
  const conflictingEvidenceIds = new Set(conflicts.filter((item) => item.status === 'OPEN').flatMap((item) => [item.currentEvidenceId, item.newEvidenceId]).filter((id) => knownIds.has(id)))
  const openConflictEvidenceIds = new Set(conflicts.filter((item) => item.status === 'OPEN').flatMap((item) => [item.currentEvidenceId, item.newEvidenceId]).filter(Boolean))
  const currentEvidence = sortedEvidence(confirmed.filter((item) => item.semanticKind !== 'EVENT'), { current: true }).slice(0, 18)
  const events = sortedEvidence(confirmed.filter((item) => item.semanticKind === 'EVENT')).slice(0, 12)
  const currentIssueEvidence = sortedCurrentIssueEvidence(confirmed.filter((item) => isCurrentIssueEvidence(item) && !conflictingEvidenceIds.has(item.id))).slice(0, 24)
  const provisionalTopicEvidence = sortedEvidence(confirmed.filter((item) => !AI_DERIVED_EVIDENCE_TYPES.has(item.evidenceType) && !openConflictEvidenceIds.has(item.id) && item.semanticKind !== 'EVENT' && consultationDirection(item.displayText || item.standardValue, [item.id], item.sourcePerspective || null))).slice(0, 12)
  const needs = sortedCurrentIssueEvidence(confirmed.filter((item) => (item.semanticKind === 'NEED' || item.semanticKind === 'GOAL' || CURRENT_ISSUE_FIELDS.has(item.fieldKey)) && !conflictingEvidenceIds.has(item.id))).slice(0, 24)
  const selfMeanings = sortedEvidence(confirmed.filter((item) => item.evidenceType === 'SELF_MEANING')).slice(0, 8)
  const observations = sortedEvidence(confirmed.filter((item) => item.evidenceType === 'OBSERVATION')).slice(0, 8)
  const resources = sortedEvidence(confirmed.filter((item) => item.semanticKind === 'RESOURCE' || ['strengths', 'current_resources', 'support_system'].includes(item.fieldKey)), { current: true }).slice(0, 8)
  const density = classifyUnderstandingContextDensity({ profileCoverage: renderer.coverage.percentage, confirmedEvidenceCount: confirmed.length, sourceCount: sourceRecords.filter((item) => item.customerId === customer.id).length, knownDomainCount: renderer.coverage.domains.filter((item) => item.status === 'KNOWN').length, lifeEventCount: events.length })
  const evidenceRefs = [...currentIssueEvidence, ...provisionalTopicEvidence, ...currentEvidence, ...events, ...needs, ...selfMeanings, ...observations, ...resources, ...hypotheses.slice(0, 5)].filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index).map((item) => evidenceRef(item, sourceRecords))
  const openConflictRefs = conflicts.filter((item) => item.status === 'OPEN').slice(0, 8).map((item) => ({ field_key: item.fieldKey, current_value: valueText(item.currentValue), proposed_value: valueText(item.newValue), evidence_ids: unique([item.currentEvidenceId, item.newEvidenceId]).filter((id) => knownIds.has(id)) }))
  const recordedContext = {
    notes: safeText(customer.notes, 1200),
    current_need: safeText(customer.need, 300),
    current_goal: safeText(customer.goal, 300),
    help_expectation: safeText(customer.helpExpectation, 300),
  }
  const contextNeeds = [
    recordedContext.current_need ? { text: recordedContext.current_need, evidence_ids: [] } : null,
    recordedContext.current_goal ? { text: recordedContext.current_goal, evidence_ids: [] } : null,
    ...needs.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
  ].filter(Boolean).slice(0, 8)
  const provisionalDirections = [
    ...provisionalTopicEvidence.map((item) => consultationDirection(item.displayText || item.standardValue, [item.id], item.sourcePerspective || null)),
    ...[recordedContext.current_need, recordedContext.help_expectation, recordedContext.notes].map((text) => consultationDirection(text)),
    ...(customer.supplementaryItems || []).filter((item) => item?.status !== 'REJECTED' && item?.reviewStatus !== 'REJECTED' && item?.informationNature !== 'AI_INFERENCE' && item?.source !== 'AI_INFERENCE').map((item) => consultationDirection(item.text, [], 'UNVERIFIED_RECORDED_CONTEXT')),
  ].filter(Boolean).filter((item, index, list) => list.findIndex((candidate) => candidate.title === item.title) === index).slice(0, 4)
  return {
    schema_version: CUSTOMER_UNDERSTANDING_VERSION,
    generated_at: now,
    current_snapshot: { ...profileDomains(customer), ...recordedContext },
    profile_domains: renderer.coverage.domains,
    top_life_events: events.map((item) => ({ text: safeText(item.displayText), occurred_at: item.occurredAt || null, evidence_ids: [item.id] })),
    current_goals: needs.filter((item) => item.semanticKind === 'GOAL' || item.fieldKey === 'current_goal').map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    current_needs: contextNeeds,
    current_issue_candidates: {
      evidence: currentIssueEvidence.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id], source_perspective: item.sourcePerspective || null, provisional: false })),
      provisional: provisionalDirections,
      excluded_conflict_evidence_ids: [...conflictingEvidenceIds],
    },
    recent_self_meanings: selfMeanings.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    important_observations: observations.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    resources: resources.map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    open_conflicts: openConflictRefs,
    coverage_gaps: renderer.coverage.domains.filter((item) => item.status !== 'KNOWN').map((item) => item.name),
    evidence_refs: evidenceRefs,
    recorded_context: recordedContext,
    source_summaries: sourceRecords.filter((item) => item.customerId === customer.id).slice(0, 8).map((item) => ({ source_id: item.id, title: safeText(item.title || '资料记录', 80), source_type: safeText(item.sourceType, 80), occurred_at: item.occurredAt || null })),
    working_hypotheses: hypotheses.filter((item) => item.evidenceType === 'HYPOTHESIS').slice(0, 5).map((item) => ({ text: safeText(item.displayText), evidence_ids: [item.id] })),
    context_density: density,
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

export function applyCurrentIssuePolicy(value, { currentIssueEvidenceIds = [], currentIssueCandidates = [] } = {}) {
  const allowed = new Set(currentIssueEvidenceIds)
  const provisional = currentIssueCandidates.filter((item) => item?.provisional)
  const confirmed = []
  const directions = []
  for (const issue of value?.top_issues || []) {
    const title = issue?.title || issue?.text || ''
    if (!normalizeIssueText(title) || RESOLVED_ISSUE_PATTERN.test(title)) continue
    if (issue?.confidence === 'LOW') {
      const direction = provisional.find((candidate) => isSimilarIssue(title, candidate.title) || isSimilarIssue(issue?.text || '', candidate.title))
      if (!direction || directions.some((existing) => isSimilarIssue(existing.title || existing.text, direction.title))) continue
      const evidenceIds = (issue?.evidence_ids || []).filter((id) => direction.evidence_ids?.includes(id))
      directions.push(cleanInsight({ title: direction.title, detail: PROVISIONAL_DIRECTION_DETAIL, evidence_ids: evidenceIds, confidence: 'LOW', type: 'SYNTHESIS' }))
      continue
    }
    const evidenceIds = (issue?.evidence_ids || []).filter((id) => allowed.has(id))
    if (issue?.type === 'WORKING_HYPOTHESIS' || !evidenceIds.length || confirmed.some((existing) => isSimilarIssue(existing.title || existing.text, title))) continue
    confirmed.push({ ...issue, evidence_ids: evidenceIds })
  }
  // Never drop an explicitly recorded consultation direction simply because
  // the model omitted it. It remains LOW / pending verification, never a fact.
  for (const candidate of provisional) {
    if (confirmed.length + directions.length >= 3) break
    if (confirmed.some((issue) => isSimilarIssue(issue.title || issue.text, candidate.title)) || directions.some((issue) => isSimilarIssue(issue.title || issue.text, candidate.title))) continue
    directions.push(cleanInsight({ title: candidate.title, detail: PROVISIONAL_DIRECTION_DETAIL, evidence_ids: candidate.evidence_ids || [], confidence: 'LOW', type: 'SYNTHESIS' }))
  }
  const topIssues = [...confirmed, ...directions].slice(0, 3)
  const lead = topIssues[0]
  const entryPoints = [...(value?.next_conversation || [])]
  if (lead && !confirmed.length) {
    const topic = lead.title || lead.text
    const topicWords = /(情感|关系)/.test(topic) ? /(情感|关系|伴侣|恋爱)/ : /(职业|工作|发展)/.test(topic) ? /(职业|工作|发展|方向)/ : /(家庭|亲子)/.test(topic) ? /(家庭|亲子|孩子)/ : /(睡眠|压力|身心)/.test(topic) ? /(睡眠|压力|状态|身心)/ : null
    const alreadySpecific = entryPoints.some((item) => { const candidate = [item.focus, item.text, item.suggested_entry].join(' '); return topicWords ? topicWords.test(candidate) : normalizeIssueText(candidate).includes(normalizeIssueText(topic).slice(0, 5)) })
    if (!alreadySpecific) {
      entryPoints.unshift(cleanInsight({
        text: `先确认${topic}的具体情境`, focus: `围绕${topic}了解客户最想优先处理的事情`,
        why_now: '档案中已有咨询方向，但具体经历与影响尚未得到客户确认。',
        suggested_entry: `你提到想聊${topic.replace('方面的咨询需求', '')}，现在最希望先谈的是哪件事？`,
        evidence_ids: lead.evidence_ids || [], confidence: 'LOW', type: 'SYNTHESIS',
      }))
    }
  }
  return { ...value, top_issues: topIssues, next_conversation: entryPoints.slice(0, 3) }
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
  const refsFor = (items) => items.slice(0, 3).map((item) => ({ text: item.text, evidence_ids: item.evidence_ids || [], confidence: item.evidence_ids?.length ? 'HIGH' : 'LOW', type: item.evidence_ids?.length ? 'FACT_BASED' : 'SYNTHESIS' }))
  const needs = refsFor(context.current_needs || [])
  const recorded = context.recorded_context || context.current_snapshot || {}
  const recordedNeeds = [recorded.current_need, recorded.current_goal, recorded.help_expectation].filter(Boolean).map((text) => ({ text: safeText(text), evidence_ids: [], confidence: 'LOW', type: 'SYNTHESIS' }))
  const noteSignal = recorded.notes ? { text: `已录入资料：${safeText(recorded.notes, 220)}`, evidence_ids: [], confidence: 'LOW', type: 'SYNTHESIS' } : null
  const usableNeeds = [...needs, ...recordedNeeds.filter((item) => !needs.some((need) => need.text === item.text))].slice(0, 3)
  const issueCandidates = refsFor(context.current_issue_candidates?.evidence || [])
  const provisionalDirections = (context.current_issue_candidates?.provisional || []).map((item) => ({ text: item.title, title: item.title, detail: PROVISIONAL_DIRECTION_DETAIL, evidence_ids: item.evidence_ids || [], confidence: 'LOW', type: 'SYNTHESIS' }))
  const oneLineSignals = [...usableNeeds, ...(noteSignal ? [noteSignal] : [])]
  const resources = refsFor(context.resources || [])
  const events = refsFor(context.top_life_events || [])
  const gaps = (context.coverage_gaps || []).slice(0, 4).map((text) => ({ text: `还需要了解${text}`, detail: '当前资料尚不足以形成稳定判断。', priority: 'MEDIUM', evidence_ids: [] }))
  const firstDirection = provisionalDirections[0]
  const firstConfirmedIssue = issueCandidates[0]
  const nextConversation = firstDirection ? { text: `确认${firstDirection.title}的具体情境`, focus: `围绕${firstDirection.title}了解客户最想优先谈的事情`, why_now: '客户资料已提及该咨询主题，尚待确认具体问题。', suggested_entry: `你提到想咨询${firstDirection.title.replace('方面的咨询需求', '')}，最近最想先谈的是哪件事？`, evidence_ids: firstDirection.evidence_ids, confidence: 'LOW', type: 'SYNTHESIS' } : firstConfirmedIssue ? { text: `了解${firstConfirmedIssue.text}的具体情境`, focus: `围绕${firstConfirmedIssue.text}了解最需要优先处理的部分`, why_now: '客户已明确提及当前困扰。', suggested_entry: `你提到${firstConfirmedIssue.text}，最近在哪些时候最明显？`, evidence_ids: firstConfirmedIssue.evidence_ids, confidence: firstConfirmedIssue.confidence, type: firstConfirmedIssue.type } : { text: '先确认客户最近最希望解决的一件具体事情', prompt: '最近最让你想优先处理的是什么？', evidence_ids: [] }
  const normalized = normalizeCustomerUnderstanding({ generated_at: context.generated_at, one_line_understanding: { text: oneLineSignals[0]?.text || '当前资料有限，先建立对客户处境的基本理解。', evidence_ids: oneLineSignals[0]?.evidence_ids || [], confidence: oneLineSignals[0]?.evidence_ids?.length ? 'HIGH' : 'LOW', type: oneLineSignals[0]?.evidence_ids?.length ? 'FACT_BASED' : 'SYNTHESIS' }, top_issues: [...issueCandidates, ...provisionalDirections], current_life_phase: events[0] || null, current_needs: usableNeeds, core_blocks: [], resources_and_strengths: resources, key_tensions: [], knowledge_gaps: gaps, next_conversation: [nextConversation], service_cautions: [{ text: '先确认再解释', detail: '资料不足时不把推测当成事实。', evidence_ids: [] }], meta: { overall_confidence: issueCandidates.length ? 'MEDIUM' : 'LOW', evidence_count: context.evidence_refs?.length || 0 } }, { evidenceIds: (context.evidence_refs || []).map((item) => item.evidence_id), now: context.generated_at })
  return applyCurrentIssuePolicy(normalized, {
    currentIssueEvidenceIds: (context.current_issue_candidates?.evidence || context.current_needs || []).flatMap((item) => item.evidence_ids || []),
    currentIssueCandidates: context.current_issue_candidates?.provisional || [],
  })
}
