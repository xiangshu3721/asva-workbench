import crypto from 'node:crypto'
import { scanImmediateSafety, assessSafetyRules, normalizeSafetyAssessment, qualityCheckSafetyAssessment, safetyEvidenceFingerprint, SAFETY_ASSESSMENT_VERSION, SAFETY_PROMPT_VERSION } from '../shared/safety-contract.mjs'
import { buildCustomerUnderstandingContext, CONTEXT_DENSITY_POLICY_VERSION } from '../shared/customer-understanding.mjs'

const SENSITIVE_FIELDS = new Set(['phone', 'wechat', 'current_mentor_id', 'mentor_id'])
const SAFETY_PROFILE_FIELDS = new Set(['current_core_issue', 'current_goal', 'current_expectation', 'current_barriers', 'current_resources', 'support_system', 'sleep', 'routine', 'energy_state', 'job_status', 'relationship_status'])
const HIGH_RISK_SIGNAL_TYPES = new Set(['SELF_HARM_IDEATION', 'SUICIDAL_INTENT_OR_PLAN', 'RECENT_SELF_HARM_BEHAVIOR', 'HARM_TO_OTHERS_IDEATION', 'BASIC_SELF_CARE_FAILURE', 'REALITY_TESTING_CONCERN'])
const text = (value, limit = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
const present = (value) => value !== null && value !== undefined && value !== ''
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const redact = (value, customer) => {
  const identifiers = [customer?.name, customer?.phone, customer?.wechat].filter(Boolean).map(String)
  return identifiers.reduce((result, identifier) => result.split(identifier).join('[REDACTED]'), String(value || ''))
}

function evidenceRef(item, sourceRecords, index) {
  const source = sourceRecords.find((record) => record.id === item.sourceId)
  return {
    evidence_id: item.id,
    evidence_ref: `E${index + 1}`,
    source_id: item.sourceId,
    source_title: text(source?.title || '资料记录', 80),
    display_text: text(item.displayText || '已记录信息', 180),
    excerpt: text(item.sourceExcerpt || item.displayText || '', 240),
    evidence_type: item.evidenceType,
    semantic_kind: item.semanticKind,
    field_key: item.fieldKey || '',
    occurred_at: item.occurredAt || null,
    source_perspective: item.sourcePerspective || (item.sourceRole === 'CUSTOMER' ? 'CUSTOMER_FIRST_PARTY' : 'STAFF_REPORTED'),
  }
}

function safetySnapshot(customer) {
  const fields = customer?.profileFields || {}
  return Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => SAFETY_PROFILE_FIELDS.has(key) && !SENSITIVE_FIELDS.has(key) && present(value))
    .map(([key, value]) => [key, text(Array.isArray(value) ? value.join('、') : value, 300)]))
}

function classifySufficiency({ evidence, snapshot }) {
  const safetyRelevant = evidence.filter((item) => ['CURRENT_STATE', 'NEED', 'GOAL', 'RESOURCE', 'EVENT'].includes(item.semanticKind) || ['sleep', 'routine', 'energy_state', 'current_core_issue', 'current_barriers'].includes(item.fieldKey))
  const hasCurrentState = safetyRelevant.some((item) => item.occurredAt || ['CURRENT_STATE', 'NEED'].includes(item.semanticKind))
  const hasFunction = safetyRelevant.some((item) => ['sleep', 'routine', 'energy_state', 'SEVERE_FUNCTIONAL_IMPAIRMENT'].includes(item.fieldKey || item.semanticKind)) || ['sleep', 'routine', 'energy_state'].some((key) => present(snapshot[key]))
  const hasSafetyMarker = safetyRelevant.some((item) => /安全|自伤|自杀|想死|伤害|暴力|不想活/.test(`${item.displayText || ''} ${item.sourceExcerpt || ''}`))
  if (safetyRelevant.length === 0 && Object.keys(snapshot).length === 0) return 'INSUFFICIENT'
  if (hasCurrentState && hasFunction && hasSafetyMarker) return 'ADEQUATE'
  return 'LIMITED'
}

export function buildCustomerSafetyContext({ customer = {}, evidenceItems = [], sourceRecords = [], conflicts = [], stage4 = customer.understanding || {} } = {}) {
  if (!Array.isArray(evidenceItems) || !Array.isArray(sourceRecords) || !Array.isArray(conflicts)) throw Object.assign(new Error('安全上下文构建失败'), { code: 'CONTEXT_BUILD_FAILED', status: 502, cause: 'INVALID_CONTEXT_INPUT' })
  const confirmed = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS')
  let densityContext
  try {
    densityContext = buildCustomerUnderstandingContext({ customer, evidenceItems, sourceRecords, conflicts }).context_density
  } catch (error) {
    throw Object.assign(new Error('安全上下文密度计算失败'), { code: 'CONTEXT_BUILD_FAILED', status: 502, cause: error?.code || 'DENSITY_POLICY_FAILED' })
  }
  if (!densityContext || !['RICH', 'MEDIUM', 'SPARSE'].includes(densityContext.classification)) throw Object.assign(new Error('安全上下文密度无法确定'), { code: 'CONTEXT_BUILD_FAILED', status: 502 })
  const persistedDensity = stage4?.meta?.context_density || customer.understandingMeta?.payload?.meta?.context_density || null
  if (persistedDensity && persistedDensity !== densityContext.classification) {
    console.warn('[ASVA_AUDIT]', JSON.stringify({ operation: 'CONTEXT_DENSITY_DRIFT', customer_id: customer.id || 'unknown', persisted_density: persistedDensity, computed_density: densityContext.classification, policy_version: CONTEXT_DENSITY_POLICY_VERSION }))
  }
  const refs = confirmed.slice(0, 28).map((item, index) => {
    const ref = evidenceRef(item, sourceRecords, index)
    return { ...ref, source_title: redact(ref.source_title, customer), display_text: redact(ref.display_text, customer), excerpt: redact(ref.excerpt, customer) }
  })
  const snapshot = Object.fromEntries(Object.entries(safetySnapshot(customer)).map(([key, value]) => [key, redact(value, customer)]))
  const sourceTextForScan = [
    ...confirmed.slice(0, 24).map((item) => item.sourceExcerpt || item.displayText),
    ...Object.values(snapshot),
  ].filter(Boolean).join('\n')
  const immediateFlags = scanImmediateSafety(sourceTextForScan)
  const safeImmediateFlags = immediateFlags.map(({ matched_phrase: _matched, source_excerpt: excerpt, ...safe }) => ({ ...safe, evidence_refs: [refs.find((item) => excerpt && `${item.display_text} ${item.excerpt}`.includes(excerpt))?.evidence_id || refs[0]?.evidence_id].filter(Boolean) }))
  const safetyDataSufficiency = classifySufficiency({ evidence: confirmed, snapshot })
  const openConflicts = conflicts.filter((item) => item.status === 'OPEN').slice(0, 8).map((item) => ({ field_key: item.fieldKey, current_value: text(item.currentValue), proposed_value: text(item.newValue) }))
  const contextDensity = densityContext.classification
  const knowledgeGaps = Array.isArray(stage4?.knowledge_gaps) ? stage4.knowledge_gaps.map((item) => text(item.question || item.text || item, 240)).filter(Boolean).slice(0, 6) : []
  const safetyFingerprint = safetyEvidenceFingerprint({ customer, evidenceItems: confirmed, conflicts, stage4: { current_issues: stage4?.top_issues || [], knowledge_gaps: knowledgeGaps } })
  return {
    schema_version: SAFETY_ASSESSMENT_VERSION,
    prompt_version: SAFETY_PROMPT_VERSION,
    customer_id: customer.id,
    current_snapshot: snapshot,
    evidence_refs: refs,
    open_conflicts: openConflicts,
    stage4_current_issues: Array.isArray(stage4?.top_issues) ? stage4.top_issues.slice(0, 4).map((item) => redact(text(item.title || item.text || item, 240), customer)).filter(Boolean) : [],
    knowledge_gaps: knowledgeGaps.map((item) => redact(item, customer)),
    context_density: contextDensity,
    context_density_source: 'DERIVED_BY_POLICY',
    context_density_policy_version: densityContext.policy_version || CONTEXT_DENSITY_POLICY_VERSION,
    context_density_metrics: {
      profile_coverage: densityContext.profile_coverage,
      confirmed_evidence_count: densityContext.confirmed_evidence_count,
      source_count: densityContext.source_count,
      known_domain_count: densityContext.known_domain_count,
      life_event_count: densityContext.life_event_count,
    },
    safety_data_sufficiency: safetyDataSufficiency,
    immediate_safety_flags: safeImmediateFlags,
    input_fingerprint: hash({ safetyFingerprint, immediateFlags, snapshot, refs: refs.map(({ evidence_id, evidence_type, semantic_kind, field_key, occurred_at }) => ({ evidence_id, evidence_type, semantic_kind, field_key, occurred_at })) }),
  }
}

export function buildSafetyAssessment({ context, candidates = {}, now = new Date().toISOString() } = {}) {
  const evidenceRefs = context?.evidence_refs || []
  const candidateSignals = [...(candidates.signals || []), ...(context?.immediate_safety_flags || [])]
  const normalizedCandidates = candidateSignals.map((item) => {
    const evidence_refs = (item.evidence_refs || []).map((ref) => evidenceRefs.find((candidate) => candidate.evidence_id === ref || candidate.evidence_ref === ref)?.evidence_id).filter(Boolean)
    const scannerOverride = (context?.immediate_safety_flags || []).find((flag) => HIGH_RISK_SIGNAL_TYPES.has(flag.signal_type) && HIGH_RISK_SIGNAL_TYPES.has(item.signal_type) && flag.evidence_refs?.some((ref) => evidence_refs.includes(ref)))
    return scannerOverride ? { ...item, subject_scope: scannerOverride.subject_scope, polarity: scannerOverride.polarity, recency: scannerOverride.recency, explicitness: scannerOverride.explicitness, evidence_refs } : { ...item, evidence_refs }
  })
  const signals = normalizedCandidates.filter((item) => item.evidence_refs?.length)
  const rules = assessSafetyRules({ signals, safetyDataSufficiency: context?.safety_data_sufficiency, contextDensity: context?.context_density, openConflict: (context?.open_conflicts || []).length > 0 })
  const raw = {
    assessment_id: `SAFETY-${context?.customer_id || 'CUSTOMER'}`,
    status: 'FRESH',
    context_density: context?.context_density,
    safety_data_sufficiency: context?.safety_data_sufficiency,
    safety_signals: signals,
    critical_unknowns: candidates.critical_unknowns || [],
    support_resources: [],
    service_cautions: rules.risk_level === 'UNKNOWN' ? ['当前安全信息不足，先确认当前状态和基本生活功能。'] : [],
    next_action: rules.risk_level === 'R4' ? '立即由人工确认当前安全与紧急支持需求。' : rules.risk_level === 'R3' ? '先暂停商业流程，由人工确认当前安全状态并考虑专业转介。' : rules.risk_level === 'R2' ? '先稳定和确认当前状态，再决定是否进入常规服务。' : '先从客户最近最在意的一件具体事情开始确认。',
    ...rules,
    generated_at: now,
    updated_at: now,
  }
  const assessment = normalizeSafetyAssessment(raw, { evidenceRefs, now })
  const quality = qualityCheckSafetyAssessment(assessment, { evidenceRefs })
  if (!quality.ok) return { assessment, quality }
  return { assessment, quality }
}
