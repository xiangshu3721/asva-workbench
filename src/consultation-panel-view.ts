import type { UnderstandingInsight } from './domain'
import type { ConsultationTopicsResponse, ConsultationTopicSignal } from './clientApi'

export type ConsultationPanelState = 'HAS_SIGNALS' | 'INSUFFICIENT_INFORMATION' | 'UNAVAILABLE'

export interface ConsultationIssueCard {
  title: string
  kind: 'EXPLICIT_CONCERN' | 'PROVISIONAL_DIRECTION'
  sourceLabel: string
  verificationLabel: string
  excerpt: string
  evidenceIds: string[]
}

export interface ConsultationPanelView {
  state: ConsultationPanelState
  issues: ConsultationIssueCard[]
  entryPoints: UnderstandingInsight[]
}

// "Human verified" refers to the source record, not an independently proven
// psychological claim. The view never upgrades a direction to a confirmed issue.
const SOURCE_LABELS: Record<string, string> = {
  PROFILE_FIELD: '客户档案',
  RECORDED_FIELD: '客户诉求记录',
  NOTES: '客户备注',
  SUPPLEMENTARY: '补充资料',
  EVIDENCE: '原始资料依据',
}

function safeText(value: unknown, limit = 120): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}
function topicEntry(topic: ConsultationTopicSignal): UnderstandingInsight {
  const subject = safeText(topic.title.replace(/方面的咨询方向$/, ''), 40)
  const excerpt = safeText(topic.excerpt || topic.title, 52)
  const explicit = topic.kind === 'EXPLICIT_CONCERN'
  return {
    text: explicit ? `了解“${safeText(topic.title, 55)}”的具体处境` : `了解${subject}的具体咨询需求`,
    focus: explicit ? `围绕已记录的困扰，确认客户当下最希望处理的部分` : `确认${subject}方面最想讨论的具体事情`,
    why_now: explicit ? '资料记录了相关困扰，当前影响及处理顺序仍需与客户确认。' : '资料只记录了咨询方向，尚未明确具体困扰。',
    suggested_entry: explicit
      ? `之前记录里提到“${excerpt}”，这件事最近最让你在意的是什么？`
      : `之前资料里提到了${subject}方面的咨询，你最近最想先谈哪件事？`,
    evidence_ids: [...(topic.evidence_ids || [])],
    confidence: 'LOW',
    type: 'SYNTHESIS',
  }
}
function genericEntry(unavailable: boolean): UnderstandingInsight {
  return {
    text: '先了解客户当前最希望获得的支持',
    focus: '确认最近最想谈的一件事',
    why_now: unavailable ? '统一咨询线索尚未读取，先核对客户当前资料。' : '现有资料尚未明确客户当前的咨询困扰或方向。',
    suggested_entry: '最近有什么事情，是你最希望先聊一聊的？',
    evidence_ids: [],
    confidence: 'LOW',
    type: 'SYNTHESIS',
  }
}

/** One source for both core issues and matching entry points; no model call. */
export function buildConsultationPanelView(customerId: string, signals?: ConsultationTopicsResponse | null): ConsultationPanelView {
  if (!signals || signals.customer_id !== customerId || !['HAS_SIGNALS', 'INSUFFICIENT_INFORMATION'].includes(signals.status)) {
    return { state: 'UNAVAILABLE', issues: [], entryPoints: [genericEntry(true)] }
  }
  const topics = (Array.isArray(signals.topics) ? signals.topics : [])
    .filter((item) => item && ['EXPLICIT_CONCERN', 'PROVISIONAL_DIRECTION'].includes(item.kind) && item.temporal_status === 'CURRENT' && safeText(item.title))
    .slice(0, 3)
  if (!topics.length) return { state: 'INSUFFICIENT_INFORMATION', issues: [], entryPoints: [genericEntry(false)] }
  const issues = topics.map((topic) => ({
    title: safeText(topic.title, 110),
    kind: topic.kind,
    sourceLabel: SOURCE_LABELS[topic.source] || '已有资料',
    verificationLabel: topic.verification_status === 'HUMAN_VERIFIED' ? '资料已人工核实' : '具体内容待确认',
    excerpt: safeText(topic.excerpt, 160),
    evidenceIds: Array.isArray(topic.evidence_ids) ? [...topic.evidence_ids] : [],
  }))
  return { state: 'HAS_SIGNALS', issues, entryPoints: topics.slice(0, 2).map(topicEntry) }
}
