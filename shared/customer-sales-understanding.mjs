import { buildCustomerUnderstandingContext } from './customer-understanding.mjs'

export const CUSTOMER_SALES_UNDERSTANDING_VERSION = 'customer-sales-understanding-v1'
export const CUSTOMER_SALES_UNDERSTANDING_PROMPT_VERSION = 'sales-understanding-v1'
export const SALES_STRATEGIES = new Set(['STABILIZE_BEFORE_SALE', 'DISCOVER_BEFORE_SALE', 'EXPERIENCE_NURTURE', 'COGNITIVE_GROWTH_READY', 'LONG_TERM_SERVICE_EXPLORABLE'])
export const SALES_TIMINGS = new Set(['PAUSE', 'NURTURE', 'READY', 'HIGH_READINESS'])
export const COMMERCIAL_LEVELS = new Set(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'])
export const SALES_CONFIDENCE = new Set(['LOW', 'MEDIUM', 'HIGH'])

const DIAGNOSIS_PATTERN = /(人格障碍|抑郁症|焦虑症|双相|精神病|依恋障碍|PTSD|依恋类型)/i
const EXPLOITATIVE_TERMS = ['趁着', '抓住痛点成交', '制造焦虑', '逼单', '高客单', '收割', '稳赚', '必须购买', '不买就会', '痛点营销']
const EXPLOITATIVE_PATTERN = new RegExp(`(?:${EXPLOITATIVE_TERMS.join('|')})`, 'gi')
const SAFE_GUIDANCE_CLAUSE_PATTERN = /(^|[，。；;]\s*)(?:不|不要|禁止|避免|不得|不能|严禁|不应|无需|不进行|不使用|不用|不做|不要用)[^。；;]*/g
const UNSUPPORTED_DEEP_FEAR_PATTERN = /(被抛弃|抛弃恐惧|童年创伤|原生家庭创伤|深层创伤|依恋创伤)/i
const WILLINGNESS_HIGH_PATTERN = /(主动询问(?:价格|费用|收费|报价|报名|付款|购买)|价格(?:多少|怎么付|如何付)|费用(?:多少|怎么付|如何付)|报名(?:方式|流程)|怎么(?:报名|付款)|如何(?:报名|付款)|主动报名|明确(?:表示)?愿意(?:购买|付费|付款)|准备(?:购买|付款)|我(?:要|想)购买|主动购买|续费|升级服务|已(?:经)?支付|已付款|已付费|已购买)/i
const WILLINGNESS_MEDIUM_PATTERN = /(愿意(?:为|投入|花费|付费|支付)|准备(?:为|投入|花费|付费)|可以(?:为|投入|花费)|(?:有|可接受|能接受)(?:一定)?预算|投入费用|花钱解决|付费解决|愿意进一步投入)/i
const SERVICE_BEHAVIOR_PATTERN = /(主动预约|预约咨询|主动咨询|参加服务|参与服务|持续参加|持续沟通|再次咨询|多次沟通|进一步帮助|如何获得(?:进一步)?帮助|了解服务内容|咨询服务|报名课程)/i
const WILLINGNESS_LOW_PATTERN = /(不愿(?:意)?(?:付费|花钱|购买|投入)|不想(?:付费|花钱|购买|投入)|只接受免费|只想免费|免费才考虑|不会(?:再)?投入费用|当前不会投入|不考虑付费|拒绝(?:购买|付费|报名)|不(?:想|会|要)(?:购买|报名|付费)|不报名|不购买)/i
const present = (value) => value !== null && value !== undefined && value !== ''
const text = (value, limit = 320) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
const unique = (items) => [...new Set((items || []).filter(Boolean).map(String))]
const list = (value, limit) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').slice(0, limit) : []
const stringList = (value, limit) => Array.isArray(value) ? value.map((item) => text(item, 240)).filter(Boolean).slice(0, limit) : []

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}

function hash(value) {
  let hashValue = 2166136261
  for (const character of JSON.stringify(stable(value))) { hashValue ^= character.codePointAt(0); hashValue = Math.imul(hashValue, 16777619) }
  return (hashValue >>> 0).toString(16).padStart(8, '0')
}

function normalizeHistory({ enrollments = [], products = [], sessions = [] } = {}) {
  const productName = new Map(products.map((item) => [item.id, item.name || item.id]))
  const enrollmentHistory = enrollments
    .filter((item) => item && item.status !== 'CANCELLED')
    .sort((a, b) => String(b.enrolledAt || b.date || '').localeCompare(String(a.enrolledAt || a.date || '')))
    .map((item) => ({
      name: productName.get(item.productId) || item.productId || '未命名服务',
      type: '课程/服务',
      status: item.status === '已完成' ? 'COMPLETED' : item.paymentStatus === 'PAID' ? 'ONGOING' : 'ENROLLED_PENDING',
      enrolled_at: item.enrolledAt || item.date || null,
      paid_at: item.paidAt || null,
      payment_status: item.paymentStatus || (item.paid ? 'PAID' : 'UNRECORDED'),
      amount_recorded: Number.isFinite(item.amount) ? item.amount : null,
    }))
  const serviceHistory = sessions
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 20)
    .map((item) => ({ name: item.topic || '服务记录', type: item.type || '服务记录', status: 'COMPLETED', occurred_at: item.date || null, summary: text(item.aiSummary || item.result || item.note || '', 260) }))
  return { enrollmentHistory, serviceHistory }
}

function commercialSignals(evidenceItems = [], enrollments = []) {
  const evidence = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS')
  const paymentEvidence = evidence.filter((item) => /(付费|支付|付款|价格|费用|预算|报名|购买|续费|升级|金额|开始学习|什么时候开始)/.test(`${item.displayText || ''} ${item.sourceExcerpt || ''} ${item.fieldKey || ''}`))
  const paidHistory = enrollments.filter((item) => item.paymentStatus === 'PAID' || item.paid)
  return { paymentEvidence, paidHistory, hasStrongPaymentSignal: paymentEvidence.length > 0 || paidHistory.length > 0 }
}

function confirmedEvidence(evidenceItems = []) {
  return evidenceItems.filter((item) => item && item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS')
}

function evidenceText(item) { return `${item.displayText || ''} ${item.sourceExcerpt || ''} ${item.standardValue || ''} ${item.fieldKey || ''}`.replace(/\s+/g, ' ').trim() }

function directSignal(items, pattern) {
  return items.filter((item) => pattern.test(evidenceText(item))).map((item) => item.id).filter(Boolean)
}

function hasServiceBehavior({ evidenceItems = [], enrollments = [], sessions = [], appointments = [] } = {}) {
  const confirmed = confirmedEvidence(evidenceItems)
  return appointments.length > 0 || enrollments.some((item) => item && item.status !== 'CANCELLED') || sessions.length > 0 || directSignal(confirmed, SERVICE_BEHAVIOR_PATTERN).length > 0
}

export function willingnessEvidenceGate({ evidenceItems = [], enrollments = [], sessions = [], appointments = [] } = {}) {
  const confirmed = confirmedEvidence(evidenceItems)
  const highEvidenceIds = directSignal(confirmed, WILLINGNESS_HIGH_PATTERN)
  const mediumWillingnessIds = directSignal(confirmed, WILLINGNESS_MEDIUM_PATTERN)
  const lowEvidenceIds = directSignal(confirmed, WILLINGNESS_LOW_PATTERN)
  const paidHistory = enrollments.filter((item) => item && (item.paymentStatus === 'PAID' || item.paid === true))
  const serviceBehavior = hasServiceBehavior({ evidenceItems, enrollments, sessions, appointments })
  const hasHighSignal = highEvidenceIds.length > 0 || paidHistory.length > 0
  const hasMediumSignal = mediumWillingnessIds.length > 0 && serviceBehavior
  const level = hasHighSignal ? 'HIGH' : lowEvidenceIds.length > 0 ? 'LOW' : hasMediumSignal ? 'MEDIUM' : 'UNKNOWN'
  return {
    level,
    highEvidenceIds: unique(highEvidenceIds),
    mediumWillingnessIds: unique(mediumWillingnessIds),
    lowEvidenceIds: unique(lowEvidenceIds),
    paidHistoryCount: paidHistory.length,
    serviceBehavior,
    rule: level === 'HIGH' ? 'STRONG_PAYMENT_SIGNAL' : level === 'LOW' ? 'EXPLICIT_REFUSAL' : level === 'MEDIUM' ? 'WILLINGNESS_PLUS_SERVICE_BEHAVIOR' : 'INSUFFICIENT_EVIDENCE',
  }
}

export function applyWillingnessEvidenceGate(value, context = {}) {
  const gate = willingnessEvidenceGate(context)
  const current = value?.willingness_to_pay || {}
  const evidenceIds = gate.level === 'HIGH' ? unique([...gate.highEvidenceIds, ...gate.mediumWillingnessIds]) : gate.level === 'LOW' ? gate.lowEvidenceIds : gate.level === 'MEDIUM' ? unique([...gate.mediumWillingnessIds, ...gate.highEvidenceIds]) : []
  const explanations = {
    HIGH: '存在明确的询价、购买或真实支付信号，可以在人工确认后评估商业讨论。',
    MEDIUM: '存在愿意投入解决问题的明确表达，并有真实服务行为；仍需继续确认具体条件。',
    LOW: '存在明确拒绝付费或当前不投入费用的表达，暂不按付费意愿推进。',
    UNKNOWN: '当前没有足够可靠的付费意愿证据，暂不做等级判断。',
  }
  const explanation = gate.level === 'UNKNOWN' ? explanations.UNKNOWN : current.level === gate.level && text(current.explanation) ? text(current.explanation) : explanations[gate.level]
  const unknowns = gate.level === 'UNKNOWN' ? unique([...stringList(current.unknowns, 4), '是否愿意为解决当前问题投入费用']).slice(0, 4) : stringList(current.unknowns, 4)
  return {
    ...value,
    willingness_to_pay: {
      ...current,
      level: gate.level,
      explanation,
      positive_signals: gate.level === 'UNKNOWN' ? [] : stringList(current.positive_signals, 4),
      unknowns,
      evidence_ids: evidenceIds,
    },
  }
}

export function buildCustomerSalesContext({ customer = {}, evidenceItems = [], sourceRecords = [], conflicts = [], enrollments = [], products = [], sessions = [], safetyAssessment = null, now = new Date().toISOString() } = {}) {
  const understanding = buildCustomerUnderstandingContext({ customer, evidenceItems, sourceRecords, conflicts, now })
  const confirmed = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS')
  const signals = commercialSignals(confirmed, enrollments)
  const history = normalizeHistory({ enrollments, products, sessions })
  const context = {
    schema_version: CUSTOMER_SALES_UNDERSTANDING_VERSION,
    generated_at: now,
    customer_snapshot: {
      current_issue: text(customer.need || customer.profileFields?.current_core_issue),
      current_expectation: text(customer.helpExpectation || customer.profileFields?.current_expectation),
      current_goal: text(customer.goal || customer.profileFields?.current_goal),
      context_density: understanding.context_density,
    },
    current_needs: understanding.current_needs,
    current_goals: understanding.current_goals,
    evidence_refs: understanding.evidence_refs,
    coverage_gaps: understanding.coverage_gaps,
    financial_evidence: signals.paymentEvidence.map((item) => ({ display_text: text(item.displayText), excerpt: text(item.sourceExcerpt), evidence_id: item.id })),
    paid_history_count: signals.paidHistory.length,
    historical_enrollments: history.enrollmentHistory,
    service_history: history.serviceHistory,
    safety: safetyAssessment ? { service_gate: safetyAssessment.service_gate, commercial_block: safetyAssessment.commercial_block, risk_level: safetyAssessment.risk_level, next_action: safetyAssessment.next_action } : null,
  }
  context.input_fingerprint = hash({ customerId: customer.id, profileVersion: customer.profileVersion || 0, evidence: confirmed.map((item) => ({ id: item.id, kind: item.semanticKind, field: item.fieldKey, value: item.standardValue })), enrollments: enrollments.map((item) => ({ id: item.id, status: item.status, paymentStatus: item.paymentStatus, amount: item.amount })), sessions: sessions.map((item) => ({ id: item.id, date: item.date, topic: item.topic })), safety: context.safety })
  return context
}

function itemEvidence(item) { return unique(item?.evidence_ids || item?.evidenceIds || item?.evidence_refs) }
function confidence(value) { return SALES_CONFIDENCE.has(value) ? value : 'LOW' }
function level(value) { return COMMERCIAL_LEVELS.has(value) ? value : 'UNKNOWN' }

function normalizePain(item, allowed) {
  return { title: text(item?.title || item?.text || '当前需要进一步确认的困扰'), explanation: text(item?.explanation || item?.detail || item?.description), deeper_need_or_fear: text(item?.deeper_need_or_fear || item?.deeper_need || ''), severity: text(item?.severity || 'UNKNOWN', 40), frequency: text(item?.frequency || 'UNKNOWN', 40), urgency: text(item?.urgency || 'UNKNOWN', 40), confidence: confidence(item?.confidence), evidence_ids: itemEvidence(item).filter((id) => allowed.has(id)) }
}

function normalizeAspiration(item, allowed) {
  return { title: text(item?.title || item?.text || '想要的变化待确认'), explanation: text(item?.explanation || item?.detail || item?.description), gap: text(item?.gap || ''), clarity: text(item?.clarity || 'UNKNOWN', 40), confidence: confidence(item?.confidence), evidence_ids: itemEvidence(item).filter((id) => allowed.has(id)) }
}

export function normalizeCustomerSalesUnderstanding(raw, { evidenceIds = [], safetyAssessment = null, contextDensity = 'SPARSE', now = new Date().toISOString() } = {}) {
  const allowed = new Set(evidenceIds)
  const safetyOverride = ['SAFETY_FIRST', 'STABILIZE_FIRST'].includes(safetyAssessment?.service_gate) || safetyAssessment?.commercial_block === 'HARD_BLOCK' || ['R2', 'R3', 'R4'].includes(safetyAssessment?.risk_level)
  const normalized = {
    schema_version: CUSTOMER_SALES_UNDERSTANDING_VERSION,
    generated_at: typeof raw?.generated_at === 'string' ? raw.generated_at : now,
    strategy: SALES_STRATEGIES.has(raw?.strategy) ? raw.strategy : 'DISCOVER_BEFORE_SALE',
    sales_timing: SALES_TIMINGS.has(raw?.sales_timing) ? raw.sales_timing : 'NURTURE',
    summary: text(raw?.summary || '先理解客户当前处境与目标，再判断是否适合进入商业讨论。'),
    follow_up_focus: stringList(raw?.follow_up_focus, 3),
    do_not_do: stringList(raw?.do_not_do, 2),
    pain_points: list(raw?.pain_points, 3).map((item) => normalizePain(item, allowed)),
    aspirations: list(raw?.aspirations, 3).map((item) => normalizeAspiration(item, allowed)),
    willingness_to_pay: { level: level(raw?.willingness_to_pay?.level), explanation: text(raw?.willingness_to_pay?.explanation), positive_signals: stringList(raw?.willingness_to_pay?.positive_signals, 4), negative_signals: stringList(raw?.willingness_to_pay?.negative_signals, 4), unknowns: stringList(raw?.willingness_to_pay?.unknowns, 4), evidence_ids: itemEvidence(raw?.willingness_to_pay).filter((id) => allowed.has(id)) },
    ability_to_pay: { level: level(raw?.ability_to_pay?.level), explanation: text(raw?.ability_to_pay?.explanation), known_financial_signals: stringList(raw?.ability_to_pay?.known_financial_signals, 4), unknowns: stringList(raw?.ability_to_pay?.unknowns, 4), evidence_ids: itemEvidence(raw?.ability_to_pay).filter((id) => allowed.has(id)) },
    meta: { overall_confidence: confidence(raw?.meta?.overall_confidence), evidence_count: Number(raw?.meta?.evidence_count || evidenceIds.length) || 0, context_density: contextDensity },
  }
  if (safetyOverride) {
    normalized.strategy = 'STABILIZE_BEFORE_SALE'
    normalized.sales_timing = 'PAUSE'
    normalized.summary = text(safetyAssessment?.next_action || '先完成安全与稳定确认，暂不推进商业讨论。')
    normalized.follow_up_focus = ['先确认客户当前安全、基本状态与稳定性', '记录人工确认结果后再评估后续服务方式']
    normalized.do_not_do = unique(['不进行高压力销售或产品推进', ...normalized.do_not_do]).slice(0, 2)
  }
  if (!normalized.willingness_to_pay.evidence_ids.length) normalized.willingness_to_pay.level = 'UNKNOWN'
  if (!normalized.ability_to_pay.evidence_ids.length) normalized.ability_to_pay.level = 'UNKNOWN'
  if (contextDensity === 'SPARSE') {
    normalized.pain_points = normalized.pain_points.slice(0, 2)
    normalized.aspirations = normalized.aspirations.slice(0, 2)
  }
  return normalized
}

export function createLocalCustomerSalesUnderstanding(context = {}) {
  const refs = Array.isArray(context.evidence_refs) ? context.evidence_refs : []
  const allowed = new Set(refs.map((item) => item.evidence_id))
  const density = context.customer_snapshot?.context_density?.classification || context.context_density?.classification || 'SPARSE'
  const needs = (context.current_needs || []).filter((item) => item.evidence_ids?.some((id) => allowed.has(id))).slice(0, 2)
  const goals = (context.current_goals || []).filter((item) => item.evidence_ids?.some((id) => allowed.has(id))).slice(0, 2)
  const safety = context.safety
  const paid = Number(context.paid_history_count || 0) > 0
  return normalizeCustomerSalesUnderstanding({
    strategy: safety?.service_gate === 'STABILIZE_FIRST' ? 'STABILIZE_BEFORE_SALE' : paid ? 'EXPERIENCE_NURTURE' : 'DISCOVER_BEFORE_SALE',
    sales_timing: safety?.service_gate === 'STABILIZE_FIRST' ? 'PAUSE' : paid ? 'NURTURE' : 'NURTURE',
    summary: density === 'SPARSE' ? '当前资料有限，先围绕客户明确表达的困扰与期待展开探索。' : '先确认客户当前问题与想要的变化，再判断是否适合进入服务讨论。',
    follow_up_focus: ['确认客户当前最想解决的一件事', '了解客户期待的具体变化与判断标准'],
    do_not_do: ['不要把当前困扰直接等同于购买意愿'],
    pain_points: needs.map((item) => ({ title: item.text, explanation: '这是客户已表达、且需要进一步了解现实影响的当前议题。', severity: 'UNKNOWN', frequency: 'UNKNOWN', urgency: 'UNKNOWN', confidence: 'MEDIUM', evidence_ids: item.evidence_ids })),
    aspirations: goals.map((item) => ({ title: item.text, explanation: '这是客户已表达的目标，具体路径和优先级仍需确认。', gap: '具体期待与可行路径待了解', clarity: 'MEDIUM', confidence: 'MEDIUM', evidence_ids: item.evidence_ids })),
    willingness_to_pay: { level: 'UNKNOWN', explanation: '当前没有足够的明确购买或支付证据。', unknowns: ['是否愿意为解决当前问题投入费用'], evidence_ids: [] },
    ability_to_pay: { level: 'UNKNOWN', explanation: '当前没有足够的预算或经济状况证据。', unknowns: ['预算范围与实际支付条件'], evidence_ids: [] },
    meta: { overall_confidence: 'LOW', evidence_count: refs.length },
  }, { evidenceIds: [...allowed], safetyAssessment: safety, contextDensity: density })
}

export function qualityCheckCustomerSalesUnderstanding(value, { evidenceIds = [], hasStrongPaymentSignal = false } = {}) {
  const errors = []
  const allowed = new Set(evidenceIds)
  const grounded = [...(value?.pain_points || []), ...(value?.aspirations || []), value?.willingness_to_pay, value?.ability_to_pay].filter(Boolean)
  for (const item of grounded) for (const id of item.evidence_ids || []) if (!allowed.has(id)) errors.push('UNKNOWN_EVIDENCE_REF')
  for (const item of [...(value?.pain_points || []), ...(value?.aspirations || [])]) if (item.confidence !== 'LOW' && !item.evidence_ids?.length) errors.push('UNGROUNDED_COMMERCIAL_INSIGHT')
  if (!hasStrongPaymentSignal && value?.willingness_to_pay?.level === 'HIGH') errors.push('WILLINGNESS_HIGH_WITHOUT_PAYMENT_SIGNAL')
  const serialized = JSON.stringify(value || {})
  if (DIAGNOSIS_PATTERN.test(serialized)) errors.push('UNSUPPORTED_DIAGNOSIS')
  if (exploitativeSalesLanguageCount(value) > 0) errors.push('EXPLOITATIVE_LANGUAGE')
  if (UNSUPPORTED_DEEP_FEAR_PATTERN.test(serialized) && !(value?.pain_points || []).some((item) => item.evidence_ids?.length)) errors.push('UNSUPPORTED_DEEP_FEAR')
  if (['SAFETY_FIRST', 'STABILIZE_FIRST'].includes(value?.strategy) && !['PAUSE'].includes(value?.sales_timing)) errors.push('SAFETY_OVERRIDE_REQUIRED')
  return { ok: errors.length === 0, errors: unique(errors), painCommercialSeparation: !(value?.pain_points || []).some((item) => item.severity === 'HIGH') || value?.willingness_to_pay?.level !== 'HIGH' || hasStrongPaymentSignal, diagnosisGuard: !errors.includes('UNSUPPORTED_DIAGNOSIS'), exploitativeSalesGuard: !errors.includes('EXPLOITATIVE_LANGUAGE') }
}

export function exploitativeSalesLanguageCount(value) {
  const texts = []
  const collect = (item) => {
    if (Array.isArray(item)) return item.forEach(collect)
    if (item && typeof item === 'object') return Object.values(item).forEach(collect)
    if (typeof item === 'string') texts.push(item)
  }
  collect(value || {})
  return texts.reduce((count, textValue) => count + (textValue.replace(SAFE_GUIDANCE_CLAUSE_PATTERN, '').match(EXPLOITATIVE_PATTERN)?.length || 0), 0)
}

export function historicalSalesRecords({ enrollments = [], products = [], sessions = [] } = {}) { return normalizeHistory({ enrollments, products, sessions }) }
