import crypto from 'node:crypto'

export const SAFETY_ASSESSMENT_VERSION = 'safety-assessment-v1'
export const SAFETY_PROMPT_VERSION = 'safety-v1'
export const SAFETY_STATUSES = new Set(['FRESH', 'STALE', 'PROCESSING', 'FAILED'])
export const SAFETY_SIGNAL_TYPES = new Set([
  'SELF_HARM_IDEATION', 'SUICIDAL_INTENT_OR_PLAN', 'RECENT_SELF_HARM_BEHAVIOR',
  'HARM_TO_OTHERS_IDEATION', 'VIOLENCE_OR_COERCION', 'SEVERE_FUNCTIONAL_IMPAIRMENT',
  'SEVERE_SLEEP_DEPRIVATION_OR_ACTIVATION', 'REALITY_TESTING_CONCERN',
  'SUBSTANCE_RELATED_SAFETY', 'ABUSE_OR_EXPLOITATION', 'ACUTE_TRAUMA_OR_BEREAVEMENT',
  'BASIC_SELF_CARE_FAILURE', 'OTHER_SAFETY_CONCERN',
])
export const SAFETY_SCOPES = new Set(['SELF', 'OTHER', 'UNKNOWN'])
export const SAFETY_POLARITIES = new Set(['PRESENT', 'NEGATED', 'UNCERTAIN'])
export const SAFETY_EXPLICITNESS = new Set(['EXPLICIT', 'IMPLICIT'])
export const SAFETY_RECENCY = new Set(['CURRENT', 'RECENT', 'HISTORICAL', 'UNKNOWN'])
export const RISK_LEVELS = new Set(['UNKNOWN', 'R0', 'R1', 'R2', 'R3', 'R4'])
export const RISK_CONFIDENCE = new Set(['LOW', 'MEDIUM', 'HIGH'])
export const SERVICE_GATES = new Set(['SAFETY_FIRST', 'STABILIZE_FIRST', 'ONE_TO_ONE', 'CONTINUITY', 'COURSE_READY'])
export const COMMERCIAL_BLOCKS = new Set(['NONE', 'SOFT_BLOCK', 'HARD_BLOCK'])
export const ESCALATIONS = new Set(['NONE', 'ASVA_HUMAN', 'LICENSED_MENTAL_HEALTH', 'MEDICAL', 'EMERGENCY'])
export const ALLOWED_ACTIONS = new Set(['LISTEN_SUPPORT', 'CLARIFY_CURRENT_STATE', 'CHECK_BASIC_FUNCTION', 'CHECK_SAFETY_INFORMATION', 'HUMAN_ONE_TO_ONE', 'CONTINUE_EXISTING_SUPPORT', 'PROFESSIONAL_REFERRAL', 'EMERGENCY_SUPPORT'])
export const AVOID_ACTIONS = new Set(['NO_HIGH_PRESSURE_SALES', 'NO_DEEP_TRAUMA_EXPLORATION', 'NO_STRONG_PSYCHOLOGICAL_LABEL', 'NO_UNSUPPORTED_DIAGNOSIS', 'NO_GROUP_FIRST', 'NO_AUTOMATED_COMMERCIAL_RECOMMENDATION', 'NO_INTENSE_EXPERIENTIAL_WORK'])

const DIAGNOSIS_PATTERN = /(抑郁症|焦虑症|双相|PTSD|人格障碍|精神分裂|精神病|焦虑型依恋|回避型人格|依恋障碍)/i
const present = (value) => value !== null && value !== undefined && value !== ''
const text = (value, limit = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
const unique = (items) => [...new Set((items || []).filter(Boolean))]

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

export function resolveSafetyStatus({ storedMeta = {}, inputFingerprint = '', promptVersion = SAFETY_PROMPT_VERSION } = {}) {
  const fresh = storedMeta.status === 'FRESH' && storedMeta.inputFingerprint === inputFingerprint && storedMeta.promptVersion === promptVersion
  if (fresh) return 'FRESH'
  if (storedMeta.status === 'PROCESSING') return 'PROCESSING'
  if (storedMeta.status === 'FAILED') return 'FAILED'
  return 'STALE'
}

export function buildSafetyFailureMeta(processingMeta = {}, { errorCode = 'SAFETY_REFRESH_FAILED', updatedAt = new Date().toISOString() } = {}) {
  return { ...processingMeta, status: 'FAILED', updatedAt, errorCode, payload: processingMeta.payload || null }
}

export function safetyEvidenceFingerprint({ customer = {}, evidenceItems = [], conflicts = [], stage4 = {} } = {}) {
  const relevant = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS').map((item) => ({
    id: item.id, type: item.evidenceType, kind: item.semanticKind, field: item.fieldKey || '', value: item.standardValue, occurredAt: item.occurredAt || '', perspective: item.sourcePerspective || '',
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const openConflicts = conflicts.filter((item) => item.status === 'OPEN').map((item) => ({ field: item.fieldKey, current: item.currentValue, proposed: item.newValue })).sort((a, b) => String(a.field).localeCompare(String(b.field)))
  return hash({ customerId: customer.id, profileVersion: customer.profileVersion || 0, relevant, openConflicts, stage4: { issues: stage4.current_issues || [], gaps: stage4.knowledge_gaps || [] } })
}

function sentenceParts(rawText) {
  return text(rawText, 5000).split(/(?<=[。！？!?；;\n])/u).map((item) => item.trim()).filter(Boolean)
}

function isNegated(sentence, index) {
  const prefix = sentence.slice(Math.max(0, index - 12), index)
  return /(没有|没想过|从来没有|不曾|并没有|不会|否认|未曾)/.test(prefix)
}

function isThirdParty(sentence, index) {
  const prefix = sentence.slice(0, index)
  if (/(我朋友|我的朋友|他朋友|她朋友|朋友|男朋友|女朋友|同事|家人|父亲|母亲|妈妈|爸爸|哥哥|姐姐)/.test(prefix)) return true
  return /^(他|她|朋友|同事|家人)/.test(sentence)
}

function recencyFor(sentence, negated) {
  if (/(十年前|多年以前|很久以前|小时候|过去|以前|曾经|当时)/.test(sentence)) return 'HISTORICAL'
  if (/(现在|目前|此刻|今天|今晚|正在|仍然|依然|最近|这几天|近期)/.test(sentence)) return /(现在|目前|此刻|今天|今晚|正在|仍然|依然)/.test(sentence) ? 'CURRENT' : 'RECENT'
  if (negated) return 'UNKNOWN'
  return 'UNKNOWN'
}

const SCANNER_PATTERNS = [
  { signal_type: 'SELF_HARM_IDEATION', pattern: /不想活|不想再活|想死|自杀|结束生命|伤害自己|自伤|割腕|跳楼|吞药/, label: '出现自伤或死亡相关表达' },
  { signal_type: 'HARM_TO_OTHERS_IDEATION', pattern: /杀了他|杀了她|想杀|伤害他人|伤害别人|拿刀/, label: '出现伤害他人相关表达' },
  { signal_type: 'VIOLENCE_OR_COERCION', pattern: /被打|家暴|暴力|威胁|控制|不让.*离开|限制自由/, label: '出现暴力或控制相关表达' },
  { signal_type: 'SEVERE_SLEEP_DEPRIVATION_OR_ACTIVATION', pattern: /几天没睡|连续.*没睡|好几天.*睡不着|彻夜不眠/, label: '出现严重睡眠缺失相关表达' },
  { signal_type: 'REALITY_TESTING_CONCERN', pattern: /有人监视|听到声音.*伤害|看到不存在|现实.*不真实/, label: '出现需要进一步了解的现实体验' },
]

export function scanImmediateSafety(rawText) {
  const flags = []
  for (const sentence of sentenceParts(rawText)) {
    for (const item of SCANNER_PATTERNS) {
      const match = sentence.match(item.pattern)
      if (!match) continue
      const index = match.index || 0
      const negated = isNegated(sentence, index)
      const other = isThirdParty(sentence, index)
      const recency = recencyFor(sentence, negated)
      flags.push({
        immediate_safety_flag: 'POSSIBLE', signal_type: item.signal_type,
        subject_scope: other ? 'OTHER' : 'SELF', polarity: negated ? 'NEGATED' : recency === 'HISTORICAL' ? 'UNCERTAIN' : 'PRESENT',
        explicitness: item.signal_type === 'SELF_HARM_IDEATION' && /想死|自杀|割腕|跳楼|吞药|伤害自己|不想活/.test(match[0]) ? 'EXPLICIT' : 'IMPLICIT',
        recency, short_description: item.label, matched_phrase: text(match[0], 80), source_excerpt: text(sentence, 220),
      })
    }
  }
  return flags.filter((item, index, list) => list.findIndex((candidate) => candidate.signal_type === item.signal_type && candidate.source_excerpt === item.source_excerpt) === index)
}

function normalizeSignal(item = {}) {
  const signalType = SAFETY_SIGNAL_TYPES.has(item.signal_type) ? item.signal_type : 'OTHER_SAFETY_CONCERN'
  const scope = SAFETY_SCOPES.has(item.subject_scope) ? item.subject_scope : 'UNKNOWN'
  const polarity = SAFETY_POLARITIES.has(item.polarity) ? item.polarity : 'UNCERTAIN'
  const explicitness = SAFETY_EXPLICITNESS.has(item.explicitness) ? item.explicitness : 'IMPLICIT'
  const recency = SAFETY_RECENCY.has(item.recency) ? item.recency : 'UNKNOWN'
  return {
    signal_type: signalType, subject_scope: scope, polarity, explicitness, recency,
    severity: ['LOW', 'MEDIUM', 'HIGH'].includes(item.severity) ? item.severity : 'MEDIUM',
    confidence: RISK_CONFIDENCE.has(item.confidence) ? item.confidence : 'LOW',
    evidence_refs: unique(item.evidence_refs || item.evidence_ids),
    short_description: text(item.short_description || item.description || '需要进一步确认的安全相关信息'),
    current_status: text(item.current_status || ''),
    details: text(item.details || '', 800),
  }
}

export function normalizeSafetySignal(item) { return normalizeSignal(item) }

export function validateSafetySignals(signals, evidenceRefs = []) {
  const allowed = new Set(evidenceRefs.map((item) => item.evidence_id || item))
  const normalized = (Array.isArray(signals) ? signals : []).map(normalizeSignal)
  const grounded = normalized.filter((item) => item.evidence_refs.length && item.evidence_refs.every((id) => allowed.has(id)))
  return { signals: grounded, invalidCount: normalized.length - grounded.length, ungroundedCount: normalized.filter((item) => !item.evidence_refs.length || item.evidence_refs.some((id) => !allowed.has(id))).length }
}

function currentPresent(signal) { return signal.polarity === 'PRESENT' && ['CURRENT', 'RECENT'].includes(signal.recency) && signal.subject_scope === 'SELF' }
function explicitCurrent(signal) { return currentPresent(signal) && signal.explicitness === 'EXPLICIT' }
function ambiguousCurrentSelfHarm(signal) { return ['SELF_HARM_IDEATION', 'SUICIDAL_INTENT_OR_PLAN'].includes(signal.signal_type) && signal.subject_scope === 'SELF' && signal.polarity !== 'NEGATED' && signal.recency !== 'HISTORICAL' }
function hasType(signals, types, predicate = () => true) { return signals.some((item) => types.has(item.signal_type) && predicate(item)) }

export function assessSafetyRules({ signals = [], safetyDataSufficiency = 'INSUFFICIENT', contextDensity = 'SPARSE', openConflict = false, existingService = false } = {}) {
  const currentSignals = signals.filter((item) => item.polarity !== 'NEGATED' && item.subject_scope !== 'OTHER' && ['CURRENT', 'RECENT'].includes(item.recency))
  const hardRuleHits = []
  let riskLevel = 'UNKNOWN'
  let riskConfidence = 'LOW'
  if (hasType(currentSignals, new Set(['SUICIDAL_INTENT_OR_PLAN']), (item) => currentPresent(item) && /(计划|意图|手段|工具|正在|立即|今晚|今天)/.test(`${item.details} ${item.current_status}`))) {
    riskLevel = 'R4'; riskConfidence = 'HIGH'; hardRuleHits.push('CURRENT_PLAN_INTENT_IMMEDIACY')
  } else if (hasType(currentSignals, new Set(['SELF_HARM_IDEATION', 'RECENT_SELF_HARM_BEHAVIOR', 'HARM_TO_OTHERS_IDEATION', 'BASIC_SELF_CARE_FAILURE', 'REALITY_TESTING_CONCERN']), explicitCurrent)) {
    riskLevel = 'R3'; riskConfidence = 'HIGH'; hardRuleHits.push('CURRENT_EXPLICIT_OR_ACUTE_SIGNAL')
  } else if (signals.some(ambiguousCurrentSelfHarm)) {
    riskLevel = 'R2'; riskConfidence = 'MEDIUM'; hardRuleHits.push('AMBIGUOUS_CURRENT_SELF_HARM_SIGNAL')
  } else if (hasType(currentSignals, new Set(['SEVERE_FUNCTIONAL_IMPAIRMENT', 'SEVERE_SLEEP_DEPRIVATION_OR_ACTIVATION', 'VIOLENCE_OR_COERCION', 'REALITY_TESTING_CONCERN', 'SUBSTANCE_RELATED_SAFETY', 'ABUSE_OR_EXPLOITATION', 'ACUTE_TRAUMA_OR_BEREAVEMENT']), (item) => currentPresent(item)) || openConflict) {
    riskLevel = 'R2'; riskConfidence = 'MEDIUM'; hardRuleHits.push(openConflict ? 'OPEN_SAFETY_CONFLICT' : 'REQUIRES_HUMAN_CONFIRMATION')
  } else if (safetyDataSufficiency === 'INSUFFICIENT' || safetyDataSufficiency === 'LIMITED') {
    riskLevel = 'UNKNOWN'; riskConfidence = 'LOW'
  } else if (currentSignals.length === 0) {
    riskLevel = 'R0'; riskConfidence = 'MEDIUM'
  } else {
    riskLevel = 'R1'; riskConfidence = 'MEDIUM'
  }

  let serviceGate = 'ONE_TO_ONE'
  let commercialBlock = 'SOFT_BLOCK'
  let recommendedEscalation = 'ASVA_HUMAN'
  let requiresHumanReview = false
  let requiresSafetyCheck = false
  if (riskLevel === 'R4' || riskLevel === 'R3') { serviceGate = 'SAFETY_FIRST'; commercialBlock = 'HARD_BLOCK'; recommendedEscalation = riskLevel === 'R4' ? 'EMERGENCY' : 'LICENSED_MENTAL_HEALTH'; requiresHumanReview = true; requiresSafetyCheck = true }
  else if (riskLevel === 'R2') { serviceGate = 'STABILIZE_FIRST'; commercialBlock = 'HARD_BLOCK'; recommendedEscalation = 'ASVA_HUMAN'; requiresHumanReview = true; requiresSafetyCheck = true }
  else if (riskLevel === 'R1') { serviceGate = existingService ? 'CONTINUITY' : contextDensity === 'SPARSE' ? 'ONE_TO_ONE' : 'COURSE_READY'; commercialBlock = 'NONE'; recommendedEscalation = 'NONE'; requiresSafetyCheck = riskConfidence === 'LOW' }
  else if (riskLevel === 'R0') { serviceGate = existingService ? 'CONTINUITY' : 'COURSE_READY'; commercialBlock = 'NONE'; recommendedEscalation = 'NONE' }
  else { serviceGate = 'ONE_TO_ONE'; commercialBlock = 'SOFT_BLOCK'; recommendedEscalation = 'ASVA_HUMAN'; requiresSafetyCheck = true }

  const allowedActions = riskLevel === 'R4' || riskLevel === 'R3'
    ? ['LISTEN_SUPPORT', 'CHECK_SAFETY_INFORMATION', 'PROFESSIONAL_REFERRAL', 'EMERGENCY_SUPPORT']
    : riskLevel === 'R2'
      ? ['LISTEN_SUPPORT', 'CLARIFY_CURRENT_STATE', 'CHECK_BASIC_FUNCTION', 'CHECK_SAFETY_INFORMATION', 'HUMAN_ONE_TO_ONE']
      : riskLevel === 'UNKNOWN'
        ? ['LISTEN_SUPPORT', 'CLARIFY_CURRENT_STATE', 'CHECK_BASIC_FUNCTION', 'CHECK_SAFETY_INFORMATION', 'HUMAN_ONE_TO_ONE']
        : existingService ? ['LISTEN_SUPPORT', 'CONTINUE_EXISTING_SUPPORT'] : ['LISTEN_SUPPORT', 'CLARIFY_CURRENT_STATE', 'HUMAN_ONE_TO_ONE']
  const avoidActions = riskLevel === 'R4' || riskLevel === 'R3'
    ? [...AVOID_ACTIONS]
    : riskLevel === 'R2' ? ['NO_HIGH_PRESSURE_SALES', 'NO_DEEP_TRAUMA_EXPLORATION', 'NO_STRONG_PSYCHOLOGICAL_LABEL', 'NO_UNSUPPORTED_DIAGNOSIS', 'NO_GROUP_FIRST', 'NO_AUTOMATED_COMMERCIAL_RECOMMENDATION']
      : ['NO_STRONG_PSYCHOLOGICAL_LABEL', 'NO_UNSUPPORTED_DIAGNOSIS']
  return { risk_level: riskLevel, risk_confidence: riskConfidence, service_gate: serviceGate, commercial_block: commercialBlock, requires_human_review: requiresHumanReview, requires_safety_check: requiresSafetyCheck, recommended_escalation: recommendedEscalation, allowed_actions: allowedActions, avoid_actions: avoidActions, hard_rule_hits: hardRuleHits }
}

export function qualityCheckSafetyAssessment(assessment, { evidenceRefs = [] } = {}) {
  const grounded = validateSafetySignals(assessment?.safety_signals, evidenceRefs)
  const textValues = JSON.stringify(assessment || {})
  const quality = {
    ungroundedSafetySignal: grounded.ungroundedCount,
    unsupportedDiagnosis: DIAGNOSIS_PATTERN.test(textValues) ? 1 : 0,
    negationError: (assessment?.safety_signals || []).filter((item) => item.polarity === 'NEGATED' && ['R3', 'R4'].includes(assessment?.risk_level)).length,
    thirdPartyAttributionError: (assessment?.safety_signals || []).filter((item) => item.subject_scope === 'OTHER' && item.polarity === 'PRESENT' && ['SELF_HARM_IDEATION', 'SUICIDAL_INTENT_OR_PLAN', 'RECENT_SELF_HARM_BEHAVIOR', 'BASIC_SELF_CARE_FAILURE'].includes(item.signal_type)).length,
    commercialOverrideSafety: ['R2', 'R3', 'R4'].includes(assessment?.risk_level) && !['HARD_BLOCK'].includes(assessment?.commercial_block) ? 1 : 0,
  }
  return { ok: Object.values(quality).every((value) => value === 0), quality, signals: grounded.signals }
}

export function normalizeSafetyAssessment(raw = {}, { evidenceRefs = [], now = new Date().toISOString() } = {}) {
  const validated = validateSafetySignals(raw.safety_signals || raw.signals, evidenceRefs)
  const normalized = {
    assessment_id: text(raw.assessment_id || ''), version: SAFETY_ASSESSMENT_VERSION, status: SAFETY_STATUSES.has(raw.status) ? raw.status : 'FRESH',
    context_density: text(raw.context_density || 'SPARSE'), safety_data_sufficiency: text(raw.safety_data_sufficiency || 'INSUFFICIENT'),
    risk_level: RISK_LEVELS.has(raw.risk_level) ? raw.risk_level : 'UNKNOWN', risk_confidence: RISK_CONFIDENCE.has(raw.risk_confidence) ? raw.risk_confidence : 'LOW',
    service_gate: SERVICE_GATES.has(raw.service_gate) ? raw.service_gate : 'ONE_TO_ONE', commercial_block: COMMERCIAL_BLOCKS.has(raw.commercial_block) ? raw.commercial_block : 'SOFT_BLOCK',
    requires_human_review: raw.requires_human_review === true, requires_safety_check: raw.requires_safety_check !== false, recommended_escalation: ESCALATIONS.has(raw.recommended_escalation) ? raw.recommended_escalation : 'ASVA_HUMAN',
    safety_signals: validated.signals, critical_unknowns: Array.isArray(raw.critical_unknowns) ? raw.critical_unknowns.map((item) => text(item, 300)).filter(Boolean).slice(0, 5) : [],
    support_resources: Array.isArray(raw.support_resources) ? raw.support_resources.map((item) => text(item, 300)).filter(Boolean).slice(0, 5) : [],
    allowed_actions: unique(raw.allowed_actions).filter((item) => ALLOWED_ACTIONS.has(item)), avoid_actions: unique(raw.avoid_actions).filter((item) => AVOID_ACTIONS.has(item)),
    service_cautions: Array.isArray(raw.service_cautions) ? raw.service_cautions.map((item) => text(item, 400)).filter(Boolean).slice(0, 5) : [],
    next_action: text(raw.next_action || '先确认当前安全状态和基本生活功能。', 500), conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.slice(0, 5) : [], hard_rule_hits: unique(raw.hard_rule_hits),
    generated_at: raw.generated_at || now, updated_at: raw.updated_at || now,
  }
  return normalized
}
