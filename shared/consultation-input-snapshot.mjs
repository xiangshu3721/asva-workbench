const SENSITIVE_FIELDS = new Set(['phone', 'wechat', 'current_mentor_id', 'mentor_id'])
const CURRENT_EVIDENCE_KINDS = new Set(['PROFILE_FIELD', 'CURRENT_STATE', 'RELATIONSHIP', 'RESOURCE', 'NEED', 'PREFERENCE'])

export const CONSULTATION_INPUT_SNAPSHOT_VERSION = 'consultation-input-v1'

const present = (value) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
const valueText = (value) => Array.isArray(value) ? value.join('、') : present(value) ? String(value) : ''
const safeText = (value, limit = 1200) => valueText(value).replace(/\s+/g, ' ').trim().slice(0, limit)

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]))
  return value
}

function hashText(value) {
  let hash = 2166136261
  for (const character of String(value)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function verificationStatus({ confirmed, reviewStatus, verificationStatus, source }) {
  if (confirmed === true || reviewStatus === 'CONFIRMED' || verificationStatus === 'HUMAN_VERIFIED') return 'HUMAN_VERIFIED'
  if (confirmed === false || reviewStatus === 'PENDING_REVIEW' || verificationStatus === 'UNVERIFIED' || source === 'AI_INFERENCE') return 'UNVERIFIED'
  if (reviewStatus === 'REJECTED' || verificationStatus === 'REJECTED') return 'REJECTED'
  return verificationStatus || 'UNKNOWN'
}

function temporalStatus(item = {}) {
  if (item.temporalType === 'HISTORICAL') return 'HISTORICAL'
  if (item.temporalType === 'CURRENT' || item.temporalType === 'RECENT') return 'CURRENT'
  if (item.temporalType === 'FUTURE_PLAN') return 'FUTURE'
  if (item.semanticKind === 'EVENT') return 'HISTORICAL'
  if (item.semanticKind === 'GOAL') return 'FUTURE'
  if (CURRENT_EVIDENCE_KINDS.has(item.semanticKind)) return 'CURRENT'
  return 'UNKNOWN'
}

function fieldRecord(field, value, meta = {}) {
  return {
    field,
    value: stableValue(value),
    source: meta.source || 'CUSTOMER_FIELD',
    source_record_id: meta.sourceRecordId || null,
    evidence_id: meta.evidenceId || null,
    recorded_at: meta.updatedAt || null,
    temporal_status: 'CURRENT',
    verification_status: verificationStatus(meta),
  }
}

function sourceRecord(source) {
  return {
    source_id: source.id,
    source_type: safeText(source.sourceType, 80),
    title: safeText(source.title || '资料记录', 120),
    occurred_at: source.occurredAt || null,
    uploaded_at: source.uploadedAt || null,
    processing_status: source.processingStatus || 'UNKNOWN',
    source_role: source.sourceRole || null,
    service_record_id: source.serviceRecordId || null,
    verification_status: source.verificationStatus || source.privacyMeta?.verification || 'UNKNOWN',
  }
}

function evidenceRecord(evidence, sourceById) {
  const source = sourceById.get(evidence.sourceId)
  return {
    evidence_id: evidence.id,
    source_id: evidence.sourceId || null,
    source_title: safeText(source?.title || '资料记录', 120),
    display_text: safeText(evidence.displayText || evidence.standardValue, 360),
    source_excerpt: safeText(evidence.sourceExcerpt || evidence.displayText || evidence.standardValue, 500),
    evidence_type: evidence.evidenceType || null,
    semantic_kind: evidence.semanticKind || null,
    field_key: evidence.fieldKey || null,
    occurred_at: evidence.occurredAt || source?.occurredAt || null,
    temporal_status: temporalStatus({ ...evidence, temporalType: evidence.temporalType || source?.temporalType }),
    source_perspective: evidence.sourcePerspective || source?.sourcePerspective || null,
    content_source: evidence.contentSource || null,
    information_nature: evidence.informationNature || null,
    review_status: evidence.reviewStatus || null,
    verification_status: verificationStatus(evidence),
    provenance_status: evidence.provenanceStatus || 'EXPLICIT',
  }
}

function communicationRecord(session) {
  const sourceText = [session.topic, session.note, session.profileText].map((value) => safeText(value, 600)).filter(Boolean).join('。')
  return {
    service_record_id: session.id,
    source: 'SERVICE_RECORD',
    source_text: sourceText,
    topic: safeText(session.topic, 240),
    note: safeText(session.note, 1200),
    profile_text: safeText(session.profileText, 1200),
    result: safeText(session.result, 240),
    next_step: safeText(session.nextStep, 360),
    recorded_at: session.date || null,
    temporal_status: 'HISTORICAL',
    verification_status: session.mentorConfirmed === true ? 'HUMAN_VERIFIED' : 'UNKNOWN',
  }
}

function supplementaryRecord(item) {
  return {
    supplementary_id: item.id || null,
    source: item.source || 'SUPPLEMENTARY_INFO',
    text: safeText(item.text, 500),
    source_record_id: item.sourceRecordId || null,
    recorded_at: item.updatedAt || item.createdAt || null,
    temporal_status: 'CURRENT',
    verification_status: verificationStatus(item),
    review_status: item.reviewStatus || item.status || null,
  }
}

export function buildConsultationInputSnapshot({ customer = {}, sessions = [], sourceRecords = [], evidenceItems = [], conflicts = [], now = new Date().toISOString() } = {}) {
  const customerId = customer.id || null
  const scopedSources = sourceRecords.filter((item) => item?.customerId === customerId)
  const scopedEvidence = evidenceItems.filter((item) => item?.customerId === customerId)
  const scopedSessions = sessions.filter((item) => item?.customerId === customerId)
  const sourceById = new Map(scopedSources.map((item) => [item.id, item]))
  const profileFields = { ...(customer.profileFields && typeof customer.profileFields === 'object' ? customer.profileFields : {}) }
  if (!present(profileFields.current_core_issue) && present(customer.need)) profileFields.current_core_issue = customer.need
  if (!present(profileFields.current_goal) && present(customer.goal)) profileFields.current_goal = customer.goal
  if (!present(profileFields.current_expectation) && present(customer.helpExpectation)) profileFields.current_expectation = customer.helpExpectation
  const fieldMeta = customer.profileFieldMeta && typeof customer.profileFieldMeta === 'object' ? customer.profileFieldMeta : {}
  const profileFieldRecords = Object.entries(profileFields)
    .filter(([field, value]) => !SENSITIVE_FIELDS.has(field) && present(value))
    .map(([field, value]) => fieldRecord(field, value, fieldMeta[field]))
  const recordedFields = [
    ['need', customer.need || profileFields.current_core_issue],
    ['goal', customer.goal || profileFields.current_goal],
    ['help_expectation', customer.helpExpectation || profileFields.current_expectation],
  ].filter(([, value]) => present(value)).map(([field, value]) => fieldRecord(field, value))
  const notes = present(customer.notes) ? { field: 'notes', text: safeText(customer.notes), source: 'CUSTOMER_NOTES', source_record_id: null, recorded_at: customer.profileUpdatedAt || null, temporal_status: 'CURRENT', verification_status: 'UNKNOWN' } : null
  const supplementary = (customer.supplementaryItems || []).filter((item) => item && item.status !== 'REJECTED' && item.reviewStatus !== 'REJECTED').map(supplementaryRecord).filter((item) => item.text)
  const evidence = scopedEvidence.map((item) => evidenceRecord(item, sourceById))
  const currentEvidence = evidence.filter((item) => item.temporal_status === 'CURRENT')
  const historicalEvidence = evidence.filter((item) => item.temporal_status === 'HISTORICAL')
  const futureEvidence = evidence.filter((item) => item.temporal_status === 'FUTURE')
  const communications = scopedSessions.sort((left, right) => String(right.date || '').localeCompare(String(left.date || ''))).map(communicationRecord)
  const snapshot = {
    schema_version: CONSULTATION_INPUT_SNAPSHOT_VERSION,
    customer_id: customerId,
    profile_version: customer.profileVersion || 0,
    generated_at: now,
    current: {
      profile_fields: Object.fromEntries(profileFieldRecords.map((item) => [item.field, item.value])),
      profile_field_records: profileFieldRecords,
      recorded_fields: recordedFields,
      notes,
      supplementary,
      evidence: currentEvidence,
    },
    historical: {
      communications,
      evidence: historicalEvidence,
    },
    future: {
      evidence: futureEvidence,
    },
    sources: scopedSources.map(sourceRecord),
    all_evidence: evidence,
    open_conflicts: conflicts.filter((item) => item?.customerId === customerId && item.status === 'OPEN').map((item) => ({ field_key: item.fieldKey || null, current_value: stableValue(item.currentValue), proposed_value: stableValue(item.newValue), current_evidence_id: item.currentEvidenceId || null, new_evidence_id: item.newEvidenceId || null })),
  }
  const fingerprintInput = {
    customer_id: customerId,
    profile_version: snapshot.profile_version,
    current: snapshot.current,
    historical: snapshot.historical,
    future: snapshot.future,
    sources: snapshot.sources,
    open_conflicts: snapshot.open_conflicts,
  }
  return { ...snapshot, input_fingerprint: hashText(JSON.stringify(stableValue(fingerprintInput))) }
}
