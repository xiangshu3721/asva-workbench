// Stage 2: a conservative, deterministic semantic bridge. It does not call AI,
// mutate customer data, or replace the existing v4 understanding cache.
export const CONSULTATION_TOPICS_VERSION = 'consultation-topics-v1'
const ISSUE_FIELDS = new Set(['current_core_issue', 'current_stressors', 'current_barriers', 'career_problem', 'relationship_conflicts', 'parenting_problem'])
const RECORDED_FIELDS = new Set(['need', 'help_expectation'])
const CONCERN = /(困扰|压力(?:大|很大|增加|沉重)?|焦虑|难受|痛苦|烦恼|冲突|争吵|吵架|失眠|睡不着|担心|害怕|不安|疲惫|迷茫|困惑|纠结|卡住|矛盾|困难|难以|无法|影响|委屈|不知所措|不知道(?:如何|怎么)|不清楚(?:如何|怎么))/
const REQUEST = /(想|希望|需要|计划|更多|优先|打算|准备|考虑|对于|关于|围绕|寻求).{0,24}(?:咨询|聊|谈|探讨|讨论|交流|理清|改善|处理|解决|帮助)|(?:咨询|聊聊|探讨|讨论|交流).{0,20}(?:情感|关系|婚姻|家庭|亲子|工作|职业|发展|生活|自己|未来)/
const NO_REQUEST = /(不想|并不想|没有想|不需要|无需|没有必要).{0,12}(咨询|聊|谈|帮助)|(?:没有|并无|不存在|不觉得|并不)(?:.{0,5})(?:困扰|问题|压力|冲突|困难)/
const RESOLVED = /(已(?:经)?(?:解决|缓解|恢复|过去|走出)|不再(?:困扰|需要|影响|焦虑|难受|痛苦|担心|害怕|不安|疲惫|迷茫|困惑|纠结|失眠|睡不着)|已经没事|现在(?:已经)?没问题|(?:已经|现在|目前).{0,6}不(?:再)?(?:感到|觉得)?(?:焦虑|难受|痛苦|担心|害怕|不安|疲惫|迷茫|困惑|纠结|失眠|睡不着))/
const HISTORICAL = /^(?:以前|过去|曾经|多年前|去年|前年|上(?:个)?月|当时|那时|此前|[一二三四五六七八九十\d]+年前)/
const THIRD_PARTY_HYPOTHESIS = /^(?:导师|咨询师|朋友|家人|我觉得她|我认为她|我猜|猜测|推测|可能|估计|似乎).{0,20}(?:认为|觉得|推测|存在|缺乏|压力|关系)/
const AI_CLAIM = /^(?:AI|人工智能)\s*(?:总结|推测|分析|理解|生成|判断)\s*[：:]/
const DOMAINS = [
  ['亲密关系', /(情感|感情|伴侣|婚姻|夫妻|恋爱|亲密关系|恋人|男朋友|女朋友)/],
  ['家庭与亲子', /(亲子|孩子|子女|父母|家庭|育儿|养育)/],
  ['职业与发展', /(工作|职业|事业|转型|发展|创业|求职|就业|职场)/],
  ['身心状态', /(睡眠|失眠|焦虑|情绪|精神状态|身心|身体)/],
  ['生活与成长', /(生活|自我|成长|方向感|人生)/],
]
const clean = (value, length = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length)
const pieces = (value) => clean(value, 1400).split(/[。；;！？!?\n，,]+/).map((item) => clean(item, 180)).filter(Boolean).slice(0, 20)
const hasHumanVerification = (status) => status === 'HUMAN_VERIFIED'
function safeSource(candidate) {
  const marker = String(candidate.information_nature || candidate.source || '').toUpperCase()
  return !['AI_INFERENCE', 'MENTOR_OBSERVATION', 'MENTOR_REPORTED', 'THIRD_PARTY_REPORTED', 'STAFF_REPORTED'].includes(marker) && candidate.evidence_type !== 'HYPOTHESIS' && candidate.evidence_type !== 'AI_INFERENCE' && candidate.review_status !== 'REJECTED' && candidate.verification_status !== 'REJECTED'
}
function concerns(text) {
  return CONCERN.test(text) && !NO_REQUEST.test(text) && !RESOLVED.test(text) && !HISTORICAL.test(text)
}
function directs(text) {
  return REQUEST.test(text) && !NO_REQUEST.test(text) && !RESOLVED.test(text) && !HISTORICAL.test(text)
}
function classifyText(text, candidate) {
  if (!text || AI_CLAIM.test(text) || THIRD_PARTY_HYPOTHESIS.test(text) || !safeSource(candidate)) return []
  if (!concerns(text) && !directs(text)) return []
  const domains = DOMAINS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  // Concerns are not split by topic words: "work pressure affects sleep" is one
  // reported difficulty, not two independently established difficulties.
  const kind = concerns(text) ? 'EXPLICIT_CONCERN' : 'PROVISIONAL_DIRECTION'
  const titles = kind === 'EXPLICIT_CONCERN' ? [clean(text, 100)] :
    domains.length ? domains.map((domain) => `${domain}方面的咨询方向`) : [clean(text, 100)]
  return titles.map((title) => ({
    title,
    kind,
    verification_status: candidate.verification_status || 'UNKNOWN',
    source: candidate.source,
    source_ref: candidate.source_ref || null,
    evidence_ids: candidate.evidence_id ? [candidate.evidence_id] : [],
    excerpt: clean(candidate.source_text || text, 180),
    recorded_at: candidate.recorded_at || null,
    temporal_status: 'CURRENT',
    specific_problem_known: kind === 'EXPLICIT_CONCERN',
    // This is an explicit uncertainty, not a model-generated psychological claim.
    unknowns: kind === 'PROVISIONAL_DIRECTION' ? ['具体困扰与现实影响尚待确认'] : [],
  }))
}
function candidateRecords(snapshot) {
  const current = snapshot?.current || {}
  const candidates = []
  const profileRecords = new Map((current.profile_field_records || []).map((item) => [item.field, item]))
  for (const item of current.profile_field_records || []) {
    if (!ISSUE_FIELDS.has(item.field)) continue
    candidates.push({ source: 'PROFILE_FIELD', source_ref: item.source_record_id || item.field, verification_status: item.verification_status, recorded_at: item.recorded_at, issue_field: true, information_nature: item.source, text: item.value })
  }
  for (const item of current.recorded_fields || []) {
    if (!RECORDED_FIELDS.has(item.field)) continue
    const fallbackProfileField = item.field === 'need' ? 'current_core_issue' : item.field === 'help_expectation' ? 'current_expectation' : null
    const inheritedProfileRecord = fallbackProfileField && profileRecords.get(fallbackProfileField)
    const inheritsProfileSource = inheritedProfileRecord && String(inheritedProfileRecord.value) === String(item.value)
    candidates.push({ source: 'RECORDED_FIELD', source_ref: item.field, verification_status: item.verification_status, information_nature: inheritsProfileSource ? inheritedProfileRecord.source : 'CUSTOMER_FIELD', recorded_at: item.recorded_at, issue_field: item.field === 'need', text: item.value })
  }
  if (current.notes?.text) candidates.push({ source: 'NOTES', source_ref: current.notes.source_record_id || 'notes', verification_status: current.notes.verification_status, recorded_at: current.notes.recorded_at, text: current.notes.text })
  for (const item of current.supplementary || []) candidates.push({ source: 'SUPPLEMENTARY', source_ref: item.supplementary_id || item.source_record_id, verification_status: item.verification_status, information_nature: item.source, recorded_at: item.recorded_at, text: item.text })
  const openConflicts = snapshot?.open_conflicts || []
  for (const item of current.evidence || []) {
    if (openConflicts.some((conflict) => conflict.current_evidence_id === item.evidence_id || conflict.new_evidence_id === item.evidence_id || (conflict.field_key && conflict.field_key === item.field_key))) continue
    if (item.review_status !== 'CONFIRMED' && !['CUSTOMER_DIRECT', 'STAFF_TRANSCRIBED_CUSTOMER'].includes(item.content_source)) continue
    if (['MENTOR_OBSERVATION', 'THIRD_PARTY_REPORTED'].includes(item.content_source) || ['STAFF_REPORTED', 'MENTOR_OBSERVATION'].includes(item.source_perspective)) continue
    candidates.push({ source: 'EVIDENCE', source_ref: item.source_id || null, evidence_id: item.evidence_id, verification_status: item.verification_status, review_status: item.review_status, evidence_type: item.evidence_type, information_nature: item.information_nature, recorded_at: item.occurred_at, issue_field: ISSUE_FIELDS.has(item.field_key), explicit_direct: item.content_source === 'CUSTOMER_DIRECT', source_text: item.source_excerpt, text: item.display_text })
  }
  return candidates
}
export function buildConsultationTopics(snapshot = {}) {
  const topics = []
  const seen = new Set()
  for (const candidate of candidateRecords(snapshot)) {
    for (const clause of pieces(candidate.text)) {
      for (const topic of classifyText(clause, candidate)) {
        const key = `${topic.kind}:${topic.title}`
        if (seen.has(key)) continue
        seen.add(key)
        topics.push(topic)
      }
    }
  }
  topics.sort((a, b) => (a.kind === 'EXPLICIT_CONCERN' ? -1 : 1) - (b.kind === 'EXPLICIT_CONCERN' ? -1 : 1) || (hasHumanVerification(b.verification_status) ? 1 : 0) - (hasHumanVerification(a.verification_status) ? 1 : 0) || String(b.recorded_at || '').localeCompare(String(a.recorded_at || '')))
  return {
    schema_version: CONSULTATION_TOPICS_VERSION,
    customer_id: snapshot.customer_id || null,
    source_fingerprint: snapshot.input_fingerprint || null,
    status: topics.length ? 'HAS_SIGNALS' : 'INSUFFICIENT_INFORMATION',
    topics: topics.slice(0, 5),
  }
}
