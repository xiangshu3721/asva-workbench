import { config } from './config.mjs'
import { createRecord, listRecords, updateRecord, FeishuUnavailableError, FeishuWriteConfirmedReadbackError, isRetryableFeishuError } from './feishu.mjs'
import { createEvidenceCandidates, createProfileDraft } from './deepseek.mjs'
import { queryAssistant } from './assistant.mjs'
import { field as mapField, fields as mapFields, read as readField } from './field-mapping.mjs'
import { parseDateFromFeishu, serializeDateForFeishu } from './date-contract.mjs'
import crypto from 'node:crypto'
import { LoginRateLimiter } from './login-rate-limit.mjs'
import { contactRequired, normalizePhone as foundationNormalizePhone, normalizeWechat, provenance, resolveCustomerIdentity } from '../shared/customer-foundation.mjs'
import { customerHistoryPolicy } from './schema-contract.mjs'
import { AuthCredentialStoreNotConfiguredError, FeishuAuthCredentialRepository, dummyPasswordHash, hashPassword, validatePassword, verifyPassword } from './password-auth.mjs'
import { documentFileRef, extractDocument, parseDocumentFileRef } from './document-extractor.mjs'
import { CHANGE_TYPES, CONFLICT_RESOLUTIONS, CONFLICT_STATUSES, CONFLICT_TYPES, EVIDENCE_REVIEW_STATUSES, EVIDENCE_TYPES, PROPOSAL_ACTIONS, SEMANTIC_KINDS, SOURCE_STATUSES, SOURCE_TYPES, classifyEvidenceChange, conflictId, contentHash, dedupeEvidence, normalizeEvidenceCandidate, normalizeText, proposalId, stableId, chunkText, sourcePerspectiveFromRole } from '../shared/evidence-contract.mjs'
import { isSnapshotEvidence, materializeCustomerProfile, shouldAutoConfirmEvidence } from '../shared/profile-materialization.mjs'
import { isStaleProcessing, processingErrorCode } from '../shared/processing-contract.mjs'

const statusMap = { 待分配: 'WAIT_ASSIGN', 已分配: 'WAIT_FOLLOW_UP', 已联系: 'WAIT_FOLLOW_UP', 待联系: 'WAIT_FOLLOW_UP', 待跟进: 'WAIT_FOLLOW_UP', 已接待: 'WAIT_FEEDBACK', 已完成: 'COMPLETED', FOLLOWING: 'WAIT_FOLLOW_UP' }
const text = (value) => Array.isArray(value) ? value.map(text).filter(Boolean).join('、') : typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const boolean = (value) => value === true || value === 'true' || value === '是'
const date = (value) => parseDateFromFeishu(value)
const normalizePhone = foundationNormalizePhone
const validPhone = (value) => /^1\d{10}$/.test(normalizePhone(value))
const now = () => new Date().toISOString()
const stableOperationId = (value, prefix) => `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`
export const customerIdForOperation = (operationId) => stableOperationId(operationId, 'CUS')
export const partialEnrollmentFailureMessage = () => '客户已保存，但课程报名保存未完成，请重试。'
const loginRateLimiter = new LoginRateLimiter()
const invalidLogin = () => Object.assign(new Error('登录信息验证失败'), { code: 'AUTH_INVALID', status: 401 })
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}
// The server calls Feishu's REST API directly; datetime cells require Unix milliseconds.
const feishuDate = () => serializeDateForFeishu(now())
const get = (table, recordFields, key) => readField(table, recordFields, key)
const PROFILE_FIELD_KEYS = new Set('phone wechat gender birth_date age birth_year city hometown marital_status education living_status children_summary occupation industry position work_years job_status income_range career_stage career_satisfaction career_problem career_goal entrepreneurship_experience family_summary parents_relationship father_summary mother_summary relationship_with_father relationship_with_mother siblings family_events family_support_level relationship_status partner_summary marriage_years relationship_satisfaction relationship_conflicts communication_pattern conflict_pattern relationship_goal children_detail parent_child_relationship parenting_problem parenting_values hobbies sports reading travel art_preferences social_preference sleep diet routine life_satisfaction self_description personality_traits communication_style decision_style emotion_expression stress_response conflict_style action_style strengths common_blocks core_values family_values career_values money_values relationship_values success_definition happiness_definition freedom_definition growth_attitude current_core_issue secondary_issues current_stressors current_goal current_expectation current_resources support_system current_barriers energy_state recent_major_changes ai_customer_summary'.split(' '))
const IMPORTANT_PROFILE_FIELDS = new Set(['phone', 'wechat', 'birth_date', 'age', 'city', 'occupation', 'job_status', 'marital_status', 'relationship_status', 'current_core_issue', 'current_goal', 'current_expectation', 'current_mentor_id', 'mentor_id', 'grade', 'paid', 'intended_course'])
const CUSTOMER_PROFILE_SCHEMA_VERSION = 'v1.0'

function appointment(row) {
  const f = row.fields || {}
  const rawStatus = text(get('appointments', f, 'status'))
  const status = statusMap[rawStatus] || rawStatus || statusMap[text(get('appointments', f, 'display_status'))] || 'WAIT_ASSIGN'
  const caseSource = text(get('appointments', f, 'case_source')) || 'JIEYOU_APPOINTMENT'
  return { id: text(get('appointments', f, 'appointment_id')) || row.record_id, customerId: text(get('appointments', f, 'customer_id')), topic: text(get('appointments', f, 'expectation')) || '首次沟通', submittedAt: date(get('appointments', f, 'submitted_at')), description: text(get('appointments', f, 'current_issue_description')), expectation: text(get('appointments', f, 'expectation')), status, mentorId: text(get('appointments', f, 'assigned_mentor_id')) || null, assignedMentorId: text(get('appointments', f, 'assigned_mentor_id')) || null, followupHandled: boolean(get('appointments', f, 'followup_handled')), followupInfoCompleted: boolean(get('appointments', f, 'followup_info_completed')), createdAt: date(get('appointments', f, 'created_at')) || date(get('appointments', f, 'submitted_at')), completedAt: date(get('appointments', f, 'completed_at')) || null, source: caseSource, caseSource, _recordId: row.record_id }
}

function customer(row) {
  const f = row.fields || {}
  const name = text(get('customers', f, 'nickname')) || '未命名客户'
  let profileFieldMeta = {}
  let profileVersion = 0
  try {
    const storedMeta = JSON.parse(text(get('customers', f, 'profile_field_meta_json')) || '{}')
    profileVersion = Number(storedMeta._profile_version || 0)
    profileFieldMeta = storedMeta._fields || Object.fromEntries(Object.entries(storedMeta).filter(([key]) => !key.startsWith('_')))
  } catch { profileFieldMeta = {} }
  const profileFields = {}
  for (const key of PROFILE_FIELD_KEYS) {
    const rawValue = get('customers', f, key)
    const value = key === 'birth_date' ? date(rawValue) : rawValue
    if (value !== '' && value !== null && value !== undefined) profileFields[key] = profileCell(value)
  }
  profileFields.current_core_issue ||= text(get('customers', f, 'current_issue')) || null
  profileFields.current_expectation ||= text(get('customers', f, 'help_expectation')) || null
  profileFields.current_goal ||= text(get('customers', f, 'current_goal')) || null
  profileFields.phone ||= normalizePhone(get('customers', f, 'phone')) || null
  profileFields.wechat ||= text(get('customers', f, 'wechat')) || null
  profileFields.grade = text(get('customers', f, 'sabc')) || 'C'
  profileFields.paid = boolean(get('customers', f, 'is_paid'))
  profileFields.current_mentor_id = profileFields.current_mentor_id ?? profileFields.mentor_id ?? (text(get('customers', f, 'current_mentor_id')) || null)
  profileFields.mentor_id = profileFields.current_mentor_id
  const birthDate = profileFields.birth_date || null
  const legacyAge = Number(get('customers', f, 'age'))
  const legacyBirthYear = Number(get('customers', f, 'birth_year'))
  if (birthDate) {
    const birth = new Date(String(birthDate))
    const today = new Date()
    let derivedAge = today.getUTCFullYear() - birth.getUTCFullYear()
    const monthDelta = today.getUTCMonth() - birth.getUTCMonth()
    if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < birth.getUTCDate())) derivedAge -= 1
    profileFields.birth_year = birth.getUTCFullYear()
    profileFields.age = derivedAge
  } else {
    if (Number.isFinite(legacyBirthYear) && legacyBirthYear > 0) profileFields.birth_year = legacyBirthYear
    if (Number.isFinite(legacyAge) && legacyAge > 0) profileFields.age = legacyAge
  }
  return { id: text(get('customers', f, 'customer_id')) || row.record_id, createdAt: date(get('customers', f, 'created_at')) || date(get('customers', f, 'submitted_at')), name, initials: name.slice(0, 1), phone: normalizePhone(get('customers', f, 'phone')), wechat: text(get('customers', f, 'wechat')), source: text(get('customers', f, 'source')) || '历史数据导入', status: '活跃', grade: text(get('customers', f, 'sabc')) || 'C', gradeSource: '导师确认', mentorId: text(get('customers', f, 'current_mentor_id')) || null, referrerName: text(get('customers', f, 'referrer_name')), need: text(get('customers', f, 'current_issue')), helpExpectation: text(get('customers', f, 'help_expectation')), goal: text(get('customers', f, 'current_goal')), brief: text(get('customers', f, 'brief')), intendedCourse: text(get('customers', f, 'intended_course')) || null, confirmedFacts: [], aiQuestions: [], paid: boolean(get('customers', f, 'is_paid')), lastActivity: '', nextFollowup: null, lastFollowupAt: null, nextFollowupAt: null, followupStatus: '待跟进', notes: text(get('customers', f, 'notes')), profileFields, profileFieldMeta, profileUpdatedAt: date(get('customers', f, 'profile_updated_at')) || null, profileSchemaVersion: text(get('customers', f, 'profile_schema_version')) || CUSTOMER_PROFILE_SCHEMA_VERSION, profileVersion, _recordId: row.record_id }
}

function staff(row) {
  const f = row.fields || {}
  const rawRole = text(get('staff', f, 'role')) || text(get('staff', f, 'permission_role'))
  const permissionRole = ['MENTOR', '导师'].includes(rawRole) ? 'MENTOR' : 'ADMIN'
  const rawStatus = text(get('staff', f, 'status')) || text(get('staff', f, 'display_status'))
  const status = ['INACTIVE', '停用', '已停用'].includes(rawStatus) ? 'INACTIVE' : 'ACTIVE'
  const name = text(get('staff', f, 'nickname')) || text(get('staff', f, 'name')) || '未命名人员'
  const phone = normalizePhone(get('staff', f, 'phone') || get('staff', f, 'login_phone'))
  const rawLoginEnabled = get('staff', f, 'login_enabled')
  const loginEnabled = permissionRole === 'ADMIN' ? rawLoginEnabled === '' || rawLoginEnabled === undefined || rawLoginEnabled === null ? true : boolean(rawLoginEnabled) : false
  return { id: text(get('staff', f, 'staff_id')) || row.record_id, name, role: permissionRole, permissionRole, status, loginEnabled, displayRole: permissionRole === 'MENTOR' ? '导师' : '管理员', title: permissionRole === 'MENTOR' ? '导师' : '管理员', phone, specialty: text(get('staff', f, 'specialty')), avatar: name.slice(0, 1), _recordId: row.record_id }
}

function product(row) {
  const f = row.fields || {}
  const rawStatus = text(get('products', f, 'status'))
  const active = !['停用', 'INACTIVE', 'DISABLED'].includes(rawStatus)
  return { id: text(get('products', f, 'product_id')) || row.record_id, name: text(get('products', f, 'product_name')), system: '', audience: '', cycle: '', format: '', status: active ? '在售' : '筹备中', active, summary: text(get('products', f, 'description')), fit: [], _recordId: row.record_id }
}

function enrollment(row) {
  const f = row.fields || {}
  const rawAmount = Number(get('enrollments', f, 'amount') ?? NaN)
  const paymentStatus = text(get('enrollments', f, 'payment_status'))
  const enrolledAt = date(get('enrollments', f, 'enrolled_at')) || date(get('enrollments', f, 'created_at'))
  const paidAt = date(get('enrollments', f, 'paid_at')) || null
  const rawStatus = text(get('enrollments', f, 'status'))
  const status = rawStatus === 'CANCELLED' ? 'CANCELLED' : rawStatus === 'INACTIVE' ? 'CANCELLED' : '学习中'
  return { id: text(get('enrollments', f, 'enrollment_id')) || row.record_id, customerId: text(get('enrollments', f, 'customer_id')), productId: text(get('enrollments', f, 'product_id')) || text(get('enrollments', f, 'product_name')), paid: paymentStatus === 'PAID' || boolean(get('enrollments', f, 'paid')), amount: Number.isFinite(rawAmount) ? rawAmount : Number.NaN, date: paidAt || enrolledAt, status, paymentStatus: ['PAID', 'UNPAID', 'UNRECORDED'].includes(paymentStatus) ? paymentStatus : boolean(get('enrollments', f, 'paid')) ? 'PAID' : 'UNRECORDED', enrollmentSource: text(get('enrollments', f, 'enrollment_source')), enrolledAt, paidAt, operatorId: text(get('enrollments', f, 'operator_id')), _recordId: row.record_id }
}

function service(row) {
  const f = row.fields || {}
  let profileUpdates = []
  try { profileUpdates = JSON.parse(text(get('serviceRecords', f, 'profile_updates_json')) || '[]') } catch { profileUpdates = [] }
  return { id: text(get('serviceRecords', f, 'service_record_id')) || row.record_id, customerId: text(get('serviceRecords', f, 'customer_id')), mentorId: text(get('serviceRecords', f, 'mentor_id')), operatorId: text(get('serviceRecords', f, 'operator_id')), type: '跟进反馈', date: date(get('serviceRecords', f, 'created_at')), duration: 0, topic: text(get('serviceRecords', f, 'topic')), note: text(get('serviceRecords', f, 'notes')) || text(get('serviceRecords', f, 'current_core_need')), result: text(get('serviceRecords', f, 'result')), nextStep: text(get('serviceRecords', f, 'ai_next_step')), followupDate: null, aiSummary: text(get('serviceRecords', f, 'ai_summary')), profileText: text(get('serviceRecords', f, 'profile_text')), profileUpdates, _recordId: row.record_id }
}

function jsonValue(value) {
  if (value === null || value === undefined || value === '') return null
  if (Array.isArray(value) || typeof value === 'object') return value
  return value
}

function profileCell(value) {
  if (typeof value === 'string' && (/^\s*\[/.test(value) || /^\s*\{/.test(value))) {
    try { return jsonValue(JSON.parse(value)) } catch { return value }
  }
  return jsonValue(value)
}

function profileChange(row) {
  const f = row.fields || {}
  let oldValue = null
  let newValue = null
  try { oldValue = JSON.parse(text(get('profileChanges', f, 'old_value')) || 'null') } catch { oldValue = text(get('profileChanges', f, 'old_value')) || null }
  try { newValue = JSON.parse(text(get('profileChanges', f, 'new_value')) || 'null') } catch { newValue = text(get('profileChanges', f, 'new_value')) || null }
  const source = ['STRUCTURED_INPUT', 'USER_EXPLICIT', 'ADMIN_CONFIRMED', 'MENTOR_FACTUAL_INPUT', 'MENTOR_CONFIRMED', 'MENTOR_OBSERVATION', 'AI_EXTRACTED_CONFIRMED', 'AI_INFERENCE', 'IMPORTED_HISTORY', 'LEGACY_MIGRATION'].includes(text(get('profileChanges', f, 'source'))) ? text(get('profileChanges', f, 'source')) : 'MENTOR_OBSERVATION'
  return { id: text(get('profileChanges', f, 'change_id')) || row.record_id, customerId: text(get('profileChanges', f, 'customer_id')), field: text(get('profileChanges', f, 'field_key')) || text(get('profileChanges', f, 'field')), fieldName: text(get('profileChanges', f, 'field_name')) || text(get('profileChanges', f, 'field_key')) || text(get('profileChanges', f, 'field')), oldValue, newValue, source, confidence: Number(get('profileChanges', f, 'confidence') ?? 0.9), confirmed: boolean(get('profileChanges', f, 'confirmed')), updatedAt: date(get('profileChanges', f, 'changed_at')) || date(get('profileChanges', f, 'updated_at')), operatorId: text(get('profileChanges', f, 'operator_id')) || undefined, serviceRecordId: text(get('profileChanges', f, 'service_record_id')) || undefined, sourceRecordId: text(get('profileChanges', f, 'source_record_id')) || undefined, evidenceId: text(get('profileChanges', f, 'evidence_id')) || undefined, updateBatchId: text(get('profileChanges', f, 'update_batch_id')) || undefined, _recordId: row.record_id }
}

function parsedJson(value, fallback = null) { try { return JSON.parse(text(value) || '') } catch { return fallback } }
function sourceRecord(row) {
  const f = row.fields || {}
  const sourceRole = text(get('sourceRecords', f, 'source_role')) || 'CUSTOMER'
  return { id: text(get('sourceRecords', f, 'source_id')) || row.record_id, subjectType: text(get('sourceRecords', f, 'subject_type')) || 'PERSON', subjectId: text(get('sourceRecords', f, 'subject_id')), customerId: text(get('sourceRecords', f, 'customer_id')), sourceType: text(get('sourceRecords', f, 'source_type')), title: text(get('sourceRecords', f, 'title')), rawText: text(get('sourceRecords', f, 'raw_text')), fileRef: text(get('sourceRecords', f, 'file_ref')), occurredAt: date(get('sourceRecords', f, 'occurred_at')) || null, uploadedAt: date(get('sourceRecords', f, 'uploaded_at')) || null, uploadedBy: text(get('sourceRecords', f, 'uploaded_by')), sourceRole, sourcePerspective: sourcePerspectiveFromRole(sourceRole), serviceRecordId: text(get('sourceRecords', f, 'service_record_id')), contentHash: text(get('sourceRecords', f, 'content_hash')), processingStatus: text(get('sourceRecords', f, 'processing_status')) || 'UPLOADED', processingVersion: Number(get('sourceRecords', f, 'processing_version') || 1), sensitivityLevel: text(get('sourceRecords', f, 'sensitivity_level')) || 'HIGH', notes: text(get('sourceRecords', f, 'notes')), sourceVersion: Number(get('sourceRecords', f, 'source_version') || 1), extractorVersion: text(get('sourceRecords', f, 'extractor_version')), lastBatchId: text(get('sourceRecords', f, 'last_batch_id')), processingStartedAt: date(get('sourceRecords', f, 'processing_started_at')) || null, lastProcessingAt: date(get('sourceRecords', f, 'last_processing_at')) || null, processingError: text(get('sourceRecords', f, 'processing_error')) || null, createdAt: date(get('sourceRecords', f, 'created_at')) || null, updatedAt: date(get('sourceRecords', f, 'updated_at')) || null, _recordId: row.record_id }
}
function evidenceItem(row) {
  const f = row.fields || {}
  return { id: text(get('evidenceItems', f, 'evidence_id')) || row.record_id, subjectType: text(get('evidenceItems', f, 'subject_type')) || 'PERSON', subjectId: text(get('evidenceItems', f, 'subject_id')), customerId: text(get('evidenceItems', f, 'customer_id')), sourceId: text(get('evidenceItems', f, 'source_id')), evidenceType: text(get('evidenceItems', f, 'evidence_type')), semanticKind: text(get('evidenceItems', f, 'semantic_kind')), fieldKey: text(get('evidenceItems', f, 'field_key')), standardValue: parsedJson(get('evidenceItems', f, 'standard_value'), text(get('evidenceItems', f, 'standard_value'))), displayText: text(get('evidenceItems', f, 'display_text')), sourceExcerpt: text(get('evidenceItems', f, 'source_excerpt')), locator: parsedJson(get('evidenceItems', f, 'locator_json'), {}), occurredAt: date(get('evidenceItems', f, 'occurred_at')) || null, sourceRole: text(get('evidenceItems', f, 'source_role')), confidence: Number(get('evidenceItems', f, 'confidence') || 0), reviewStatus: text(get('evidenceItems', f, 'review_status')) || 'PENDING_REVIEW', extractionBatchId: text(get('evidenceItems', f, 'extraction_batch_id')), provider: text(get('evidenceItems', f, 'provider')) || 'DEEPSEEK', model: text(get('evidenceItems', f, 'model')), modelVersion: text(get('evidenceItems', f, 'model_version')), promptVersion: text(get('evidenceItems', f, 'prompt_version')), createdAt: date(get('evidenceItems', f, 'created_at')) || null, updatedAt: date(get('evidenceItems', f, 'updated_at')) || null, _recordId: row.record_id }
}
function proposalRecord(row) {
  const f = row.fields || {}
  return { id: text(get('profileUpdateProposals', f, 'proposal_id')) || row.record_id, customerId: text(get('profileUpdateProposals', f, 'customer_id')), subjectId: text(get('profileUpdateProposals', f, 'subject_id')), evidenceId: text(get('profileUpdateProposals', f, 'evidence_id')), sourceId: text(get('profileUpdateProposals', f, 'source_id')), fieldKey: text(get('profileUpdateProposals', f, 'field_key')), fieldName: text(get('profileUpdateProposals', f, 'field_name')), currentValue: parsedJson(get('profileUpdateProposals', f, 'current_value'), text(get('profileUpdateProposals', f, 'current_value'))), proposedValue: parsedJson(get('profileUpdateProposals', f, 'proposed_value'), text(get('profileUpdateProposals', f, 'proposed_value'))), action: text(get('profileUpdateProposals', f, 'action')), changeType: text(get('profileUpdateProposals', f, 'change_type')), reviewStatus: text(get('profileUpdateProposals', f, 'review_status')) || 'PENDING_REVIEW', reason: text(get('profileUpdateProposals', f, 'reason')), confidence: Number(get('profileUpdateProposals', f, 'confidence') || 0), extractionBatchId: text(get('profileUpdateProposals', f, 'extraction_batch_id')), reviewerId: text(get('profileUpdateProposals', f, 'reviewer_id')), reviewedAt: date(get('profileUpdateProposals', f, 'reviewed_at')) || null, createdAt: date(get('profileUpdateProposals', f, 'created_at')) || null, updatedAt: date(get('profileUpdateProposals', f, 'updated_at')) || null, _recordId: row.record_id }
}
function conflictRecord(row) {
  const f = row.fields || {}
  return { id: text(get('evidenceConflicts', f, 'conflict_id')) || row.record_id, subjectId: text(get('evidenceConflicts', f, 'subject_id')), customerId: text(get('evidenceConflicts', f, 'customer_id')), fieldKey: text(get('evidenceConflicts', f, 'field_key')), conflictType: text(get('evidenceConflicts', f, 'conflict_type')), currentValue: parsedJson(get('evidenceConflicts', f, 'current_value'), text(get('evidenceConflicts', f, 'current_value'))), newValue: parsedJson(get('evidenceConflicts', f, 'new_value'), text(get('evidenceConflicts', f, 'new_value'))), currentEvidenceId: text(get('evidenceConflicts', f, 'current_evidence_id')), newEvidenceId: text(get('evidenceConflicts', f, 'new_evidence_id')), status: text(get('evidenceConflicts', f, 'status')) || 'OPEN', suggestedResolution: text(get('evidenceConflicts', f, 'suggested_resolution')), resolution: text(get('evidenceConflicts', f, 'resolution')), reviewerId: text(get('evidenceConflicts', f, 'reviewer_id')), resolvedAt: date(get('evidenceConflicts', f, 'resolved_at')) || null, createdAt: date(get('evidenceConflicts', f, 'created_at')) || null, updatedAt: date(get('evidenceConflicts', f, 'updated_at')) || null, _recordId: row.record_id }
}

function scope(database, actorId) {
  const actor = database.staff.find((item) => item.id === actorId)
  if (!actor) throw new Error('账号不存在')
  if (actor.status !== 'ACTIVE') throw new Error('该账户已停用，请联系管理员。')
  if (actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
  return database
}

function sameProfileValue(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) }
function derivedAge(birthDate) {
  if (!birthDate) return null
  const birth = new Date(String(birthDate))
  if (Number.isNaN(birth.getTime())) return null
  const today = new Date()
  let age = today.getUTCFullYear() - birth.getUTCFullYear()
  const monthDelta = today.getUTCMonth() - birth.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < birth.getUTCDate())) age -= 1
  return age >= 0 ? age : null
}
function derivedBirthYear(birthDate) {
  if (!birthDate) return null
  const year = new Date(String(birthDate)).getUTCFullYear()
  return Number.isFinite(year) ? year : null
}
function normalizeProfileUpdates(updates, profileRecord, confirmed = false) {
  if (!Array.isArray(updates)) return []
  return updates.filter((item) => item && typeof item.field === 'string' && (PROFILE_FIELD_KEYS.has(item.field) || ['grade', 'paid', 'mentor_id', 'current_mentor_id', 'intended_course'].includes(item.field))).map((item) => {
    const field = item.field === 'mentor_id' ? 'current_mentor_id' : item.field
    const previousValue = profileRecord?.profileFields?.[item.field] ?? null
    const source = confirmed ? provenance(item.source || 'MENTOR_OBSERVATION', true) : item.source === 'AI_INFERENCE' ? 'AI_INFERENCE' : item.source || 'MENTOR_OBSERVATION'
    return { field, value: jsonValue(item.value), previousValue, source, confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.9))), confirmed: confirmed && source !== 'AI_INFERENCE', conflict: previousValue !== null && !sameProfileValue(previousValue, item.value) }
  }).filter((item) => item.value !== null)
}

function profileFieldsForWrite(customerRecord, updates) {
  const values = { profile_field_meta_json: JSON.stringify({ _profile_version: customerRecord.profileVersion || 0, _fields: customerRecord.profileFieldMeta || {} }), profile_schema_version: customerRecord.profileSchemaVersion || CUSTOMER_PROFILE_SCHEMA_VERSION, profile_updated_at: customerRecord.profileUpdatedAt || now() }
  for (const update of updates) {
    if (['paid', 'grade', 'mentor_id', 'current_mentor_id', 'intended_course'].includes(update.field)) continue
    values[update.field] = Array.isArray(update.value) ? JSON.stringify(update.value) : typeof update.value === 'number' || typeof update.value === 'boolean' ? String(update.value) : update.value ?? ''
    if (update.field === 'birth_date') {
      const year = derivedBirthYear(update.value)
      const age = derivedAge(update.value)
      if (year !== null) values.birth_year = String(year)
      if (age !== null) values.age = String(age)
    }
  }
  if (customerRecord.need !== undefined) values.current_issue = customerRecord.need
  if (customerRecord.helpExpectation !== undefined) values.help_expectation = customerRecord.helpExpectation
  if (customerRecord.goal !== undefined) values.current_goal = customerRecord.goal
  values.sabc = customerRecord.grade
  values.is_paid = customerRecord.paid
  values.intended_course = customerRecord.intendedCourse || ''
  values.current_mentor_id = customerRecord.mentorId || ''
  return mapFields('customers', values)
}

function validateManualCustomer(input) {
  const nickname = text(input?.nickname).trim()
  const phone = normalizePhone(input?.phone)
  const wechat = text(input?.wechat).trim()
  if (!nickname) throw new Error('客户昵称不能为空')
  if (phone && !/^1\d{10}$/.test(phone) && !phone.startsWith('+')) throw new Error('请输入有效手机号')
  if (!contactRequired({ phone, wechat })) throw Object.assign(new Error('手机号或微信号至少填写一个'), { code: 'CUSTOMER_CONTACT_REQUIRED', status: 400 })
  return { nickname, phone, wechat, situation: text(input?.situation).trim() }
}

function duplicateMatches(database, input) {
  const { nickname, phone, wechat } = validateManualCustomer(input)
  const identity = resolveCustomerIdentity(database.customers, { nickname, phone, wechat })
  return identity.matches.map((item) => ({ customer: item, matchedBy: identity.match_reasons.includes('PHONE_EXACT') ? 'phone' : identity.match_reasons.includes('WECHAT_EXACT') ? 'wechat' : identity.match_reasons.includes('NICKNAME_EXACT') ? 'nickname_exact' : 'nickname_fuzzy' }))
}

function activeProduct(database, productId) {
  return database.products.find((item) => item.id === productId && item.active !== false && item.status === '在售')
}

function validateEnrollmentDrafts(database, drafts) {
  if (!drafts?.length) return
  for (const draft of new Map(drafts.map((item) => [item.productId, item])).values()) {
    if (!activeProduct(database, draft.productId)) throw new Error('只能选择 ASVA 产品中的有效课程')
  }
}

async function mergeEnrollments(database, customerId, drafts, operatorId, operationId, { replace = false } = {}) {
  if (!Array.isArray(drafts)) return
  if (!config.feishu.tables.enrollments) throw new Error('报名记录表尚未配置，暂时不能保存已报名课程')
  validateEnrollmentDrafts(database, drafts)
  const uniqueDrafts = new Map(drafts.map((draft) => [draft.productId, draft]))
  for (const draft of uniqueDrafts.values()) {
    const product = activeProduct(database, draft.productId)
    if (!product) throw new Error('只能选择 ASVA 产品中的有效课程')
    const existing = database.enrollments.find((item) => item.customerId === customerId && item.productId === product.id && item.status !== 'CANCELLED')
    const cancelled = database.enrollments.find((item) => item.customerId === customerId && item.productId === product.id && item.status === 'CANCELLED')
    const paymentStatus = draft.paymentStatus || existing?.paymentStatus || 'UNRECORDED'
    const fields = { payment_status: paymentStatus, paid: paymentStatus === 'PAID' }
    if (draft.amount !== undefined && draft.amount !== null) fields.amount = draft.amount
    if (draft.enrolledAt) fields.enrolled_at = draft.enrolledAt
    if (draft.paidAt) fields.paid_at = draft.paidAt
    if (existing?._recordId) {
      await updateRecord(config.feishu.tables.enrollments, existing._recordId, mapFields('enrollments', fields))
      continue
    }
    if (cancelled?._recordId) {
      await updateRecord(config.feishu.tables.enrollments, cancelled._recordId, mapFields('enrollments', { ...fields, status: 'ACTIVE' }))
      continue
    }
    const enrolledAt = draft.enrolledAt || now()
    await createRecord(config.feishu.tables.enrollments, mapFields('enrollments', { enrollment_id: operationId ? stableOperationId(`${operationId}:${product.id}`, 'ENR') : `E-${Date.now()}-${Math.floor(Math.random() * 1000)}`, customer_id: customerId, product_id: product.id, product_name: product.name, enrollment_source: 'MANUAL', payment_status: paymentStatus, paid: paymentStatus === 'PAID', amount: draft.amount ?? null, enrolled_at: enrolledAt, paid_at: draft.paidAt || null, operator_id: operatorId, created_at: now(), status: 'ACTIVE' }))
  }
  if (replace) {
    const selected = new Set(uniqueDrafts.keys())
    for (const current of database.enrollments.filter((item) => item.customerId === customerId && item.status !== 'CANCELLED' && !selected.has(item.productId))) {
      if (current._recordId) await updateRecord(config.feishu.tables.enrollments, current._recordId, mapFields('enrollments', { status: 'CANCELLED' }))
    }
  }
}

async function persistCustomerProfile(database, customerId, updates, serviceRecordId, operatorId, provenanceContext = {}) {
  const customerRecord = database.customers.find((item) => item.id === customerId)
  const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
  if (!customerRecord || !row) throw new Error('客户不存在')
  customerRecord.profileFields = { ...(customerRecord.profileFields || {}) }
  customerRecord.profileFieldMeta = { ...(customerRecord.profileFieldMeta || {}) }
  customerRecord.profileVersion = Number(customerRecord.profileVersion || 0)
  const changed = []
  const updatedAt = now()
  const changedAt = feishuDate()
  for (const update of updates) {
    const field = update.field === 'mentor_id' ? 'current_mentor_id' : update.field
    const oldValue = customerRecord.profileFields[field] ?? null
    customerRecord.profileFields[field] = update.value
    customerRecord.profileFieldMeta[field] = { source: update.source, confidence: update.confidence, confirmed: update.confirmed, updatedAt, ...(provenanceContext.sourceRecordId ? { sourceRecordId: provenanceContext.sourceRecordId } : {}), ...(provenanceContext.evidenceId ? { evidenceId: provenanceContext.evidenceId } : {}), ...(provenanceContext.updateBatchId ? { extractionBatchId: provenanceContext.updateBatchId } : {}) }
    if (field === 'current_core_issue' && typeof update.value === 'string') customerRecord.need = update.value
    if (field === 'current_expectation' && typeof update.value === 'string') customerRecord.helpExpectation = update.value
    if (field === 'current_goal' && typeof update.value === 'string') customerRecord.goal = update.value
    if (field === 'intended_course') customerRecord.intendedCourse = typeof update.value === 'string' ? update.value : null
    if (field === 'paid' && typeof update.value === 'boolean') customerRecord.paid = update.value
    if (field === 'grade' && typeof update.value === 'string') customerRecord.grade = update.value
    if (field === 'current_mentor_id' && typeof update.value === 'string') customerRecord.mentorId = update.value
    if (field === 'birth_date') {
      const year = derivedBirthYear(update.value)
      const age = derivedAge(update.value)
      if (year !== null) customerRecord.profileFields.birth_year = year
      if (age !== null) customerRecord.profileFields.age = age
    }
    if ((field === 'age' || field === 'birth_year') && customerRecord.profileFields.birth_date) continue
    if (!sameProfileValue(oldValue, update.value)) changed.push({ ...update, field, oldValue, updatedAt })
  }
  if (changed.length) customerRecord.profileVersion += 1
  customerRecord.profileUpdatedAt = updatedAt
  customerRecord.profileSchemaVersion = CUSTOMER_PROFILE_SCHEMA_VERSION
  await updateRecord(config.feishu.tables.customers, row.record_id, profileFieldsForWrite(customerRecord, changed))
  for (const change of changed.filter((item) => customerHistoryPolicy(item.field) === 'TRACK' || (item.field === 'age' && !customerRecord.profileFields.birth_date))) {
    await createMappedRecord('profileChanges', 'profile-change.provenance', { customer_id: customerId, field: change.field, field_key: change.field, field_name: mapField('customers', change.field), old_value: JSON.stringify(change.oldValue ?? null), new_value: JSON.stringify(change.value ?? null), source: change.source, confidence: change.confidence, confirmed: change.confirmed, updated_at: changedAt, changed_at: changedAt, operator_id: operatorId || '', service_record_id: serviceRecordId || '', source_record_id: provenanceContext.sourceRecordId || '', evidence_id: provenanceContext.evidenceId || '', update_batch_id: provenanceContext.updateBatchId || '' })
  }
  return customerRecord
}

const stage2Table = (name) => config.feishu.tables[name]
const stage2RequiredTables = ['sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']
function requireStage2Tables() { const missing = stage2RequiredTables.filter((name) => !stage2Table(name)); if (missing.length) throw Object.assign(new Error('Stage 2 资料表尚未配置'), { code: 'STAGE2_TABLES_NOT_CONFIGURED', status: 503, missing }) }
function stage2Json(value) { return JSON.stringify(value ?? null) }
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
async function waitForSourceVisibility(sourceId) {
  for (const delay of [0, 1000, 2500]) {
    if (delay) await wait(delay)
    const rows = await listRecords(stage2Table('sourceRecords'))
    const row = rows.find((item) => text(get('sourceRecords', item.fields, 'source_id')) === sourceId)
    if (row) return sourceRecord(row)
  }
  return null
}
function attachFeishuWriteContext(error, tableKey, operation, values) {
  error.integrationContext = {
    operation,
    table_key: tableKey,
    table_id: stage2Table(tableKey) || config.feishu.tables[tableKey] || '',
    internal_keys: Object.keys(values),
    feishu_field_names: Object.keys(values).map((key) => mapField(tableKey, key)),
  }
  return error
}
async function createMappedRecord(tableKey, operation, values) {
  const mapped = mapFields(tableKey, values)
  try {
    return await createRecord(config.feishu.tables[tableKey], mapped)
  } catch (error) {
    throw attachFeishuWriteContext(error, tableKey, operation, values)
  }
}
async function updateMappedRecord(tableKey, operation, recordId, values) {
  const mapped = mapFields(tableKey, values)
  try {
    return await updateRecord(config.feishu.tables[tableKey], recordId, mapped)
  } catch (error) {
    throw attachFeishuWriteContext(error, tableKey, operation, values)
  }
}
function sourceInput(input, actorId) {
  const sourceType = String(input?.sourceType || '').trim().toUpperCase()
  const rawText = normalizeText(input?.rawText, 500_000)
  if (!SOURCE_TYPES.has(sourceType)) throw Object.assign(new Error('不支持的资料类型'), { code: 'INVALID_SOURCE_TYPE', status: 400 })
  if (!rawText && sourceType !== 'FILE_UPLOAD') throw Object.assign(new Error('原始资料不能为空'), { code: 'SOURCE_TEXT_REQUIRED', status: 400 })
  const customerId = text(input?.customerId).trim()
  if (!customerId) throw Object.assign(new Error('客户ID不能为空'), { code: 'SOURCE_CUSTOMER_REQUIRED', status: 400 })
  const legacyRole = text(input?.sourceRole)
  const sourcePerspective = input?.sourcePerspective === 'CUSTOMER_FIRST_PARTY' ? 'CUSTOMER_FIRST_PARTY' : input?.sourcePerspective === 'STAFF_REPORTED' ? 'STAFF_REPORTED' : legacyRole ? sourcePerspectiveFromRole(legacyRole) : 'STAFF_REPORTED'
  const sourceRole = legacyRole === 'MENTOR' ? 'MENTOR' : sourcePerspective === 'CUSTOMER_FIRST_PARTY' ? 'CUSTOMER' : 'ADMIN'
  return { sourceType, rawText, customerId, subjectType: text(input?.subjectType) || 'PERSON', subjectId: text(input?.subjectId) || customerId, title: normalizeText(input?.title, 200) || '客户补充资料', occurredAt: null, sourceRole, sourcePerspective, serviceRecordId: text(input?.serviceRecordId), notes: normalizeText(input?.notes, 1000), uploadedBy: actorId, contentHash: text(input?.contentHash) || contentHash(rawText), fileRef: normalizeText(input?.fileRef, 2000) }
}
function evidenceWriteFields(item, source, sourceId) {
  return mapFields('evidenceItems', { evidence_id: item.id || stableId('EVD', `${sourceId}:${item.extractionBatchId}:${item.sourceExcerpt}:${item.displayText}`), subject_type: source.subjectType, subject_id: source.subjectId, customer_id: source.customerId, source_id: sourceId, evidence_type: item.evidenceType, semantic_kind: item.semanticKind, field_key: item.fieldKey || '', standard_value: stage2Json(item.standardValue), display_text: item.displayText, source_excerpt: item.sourceExcerpt, locator_json: stage2Json(item.locator), occurred_at: item.occurredAt || source.occurredAt || '', source_role: source.sourceRole, confidence: item.confidence, review_status: item.reviewStatus, reviewer_id: '', reviewed_at: '', extraction_batch_id: item.extractionBatchId, provider: 'DEEPSEEK', model: item.model, model_version: item.modelVersion, prompt_version: item.promptVersion, created_at: now(), updated_at: now() })
}

export class FeishuRepository {
  constructor({ authRepository = new FeishuAuthCredentialRepository(), evidenceExtractor = createEvidenceCandidates } = {}) { this.queryLogs = []; this.auditLogs = []; this.saveTraces = []; this.evidenceTraces = []; this.sourceSaveTimes = new Map(); this.authRepository = authRepository; this.evidenceExtractor = evidenceExtractor }
  audit(operation, targetId, operatorId, result = 'SUCCESS', error = '') {
    const entry = { operation, target_id: targetId || '', operator_id: operatorId || '', result, error_code: error ? 'OPERATION_FAILED' : undefined, timestamp: now() }
    this.auditLogs.unshift(entry)
    if (this.auditLogs.length > 200) this.auditLogs.length = 200
    console.info('[ASVA_AUDIT]', JSON.stringify(entry))
  }
  async load() {
    const entries = [['appointments', config.feishu.tables.appointments], ['customers', config.feishu.tables.customers], ['serviceRecords', config.feishu.tables.serviceRecords], ['staff', config.feishu.tables.staff], ['products', config.feishu.tables.products], ['enrollments', config.feishu.tables.enrollments], ['profileChanges', config.feishu.tables.profileChanges], ['sourceRecords', config.feishu.tables.sourceRecords], ['evidenceItems', config.feishu.tables.evidenceItems], ['profileUpdateProposals', config.feishu.tables.profileUpdateProposals], ['evidenceConflicts', config.feishu.tables.evidenceConflicts]]
    const rows = await Promise.all(entries.map(([, tableId]) => tableId ? listRecords(tableId) : Promise.resolve([])))
    const [appointmentRows, customerRows, serviceRows, staffRows, productRows, enrollmentRows, profileChangeRows, sourceRows, evidenceRows, proposalRows, conflictRows] = rows
    const customers = customerRows.map(customer)
    const evidenceItems = evidenceRows.map(evidenceItem)
    for (const item of customers) item.profileMaterialization = materializeCustomerProfile({ customer: item, evidenceItems: evidenceItems.filter((evidence) => evidence.customerId === item.id) })
    return {
      staff: staffRows.map(staff), customers, appointments: appointmentRows.map(appointment), sessions: serviceRows.map(service), followups: [], products: productRows.map(product), enrollments: enrollmentRows.map(enrollment), profileChanges: profileChangeRows.map(profileChange), sourceRecords: sourceRows.map(sourceRecord), evidenceItems, profileUpdateProposals: proposalRows.map(proposalRecord), evidenceConflicts: conflictRows.map(conflictRecord),
      _missingRepositories: config.feishu.tables.enrollments ? [] : ['EnrollmentRepository'],
      _rows: { appointments: appointmentRows, customers: customerRows, services: serviceRows, staff: staffRows, products: productRows, enrollments: enrollmentRows, profileChanges: profileChangeRows, sourceRecords: sourceRows, evidenceItems: evidenceRows, profileUpdateProposals: proposalRows, evidenceConflicts: conflictRows },
    }
  }

  async loadAfterWrite(writeResult, targetCustomerId) {
    const writeRecordId = writeResult?.record?.record_id || writeResult?.record_id || writeResult?.record?.id
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const database = await this.load()
        if (targetCustomerId && !database.customers.some((item) => item.id === targetCustomerId)) {
          throw new FeishuUnavailableError('写入后暂未读到目标记录', { retryable: true, operation: 'readback_customer' })
        }
        console.info('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: writeRecordId, target_customer_id: targetCustomerId, readback_status: 'READBACK_SUCCESS', retry_count: attempt, final_result: 'SUCCESS' }))
        return database
      } catch (error) {
        if (!isRetryableFeishuError(error) || attempt === 2) {
          console.error('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: writeRecordId, target_customer_id: targetCustomerId, readback_status: 'READBACK_FAILED', retry_count: attempt, final_result: 'FAIL', provider_code: error?.providerCode, provider_request_id: error?.providerRequestId }))
          throw new FeishuWriteConfirmedReadbackError('写入已确认，但回读暂时失败，请保留请求编号后重试。', {
            writeRecordId,
            providerCode: error?.providerCode,
            providerMessage: error?.providerMessage,
            providerRequestId: error?.providerRequestId,
            httpStatus: error?.httpStatus,
            retryable: false,
            operation: 'readback_after_write',
          })
        }
        await new Promise((resolve) => setTimeout(resolve, [300, 800][attempt]))
      }
    }
    throw new FeishuWriteConfirmedReadbackError('写入已确认，但回读暂时失败，请保留请求编号后重试。', { writeRecordId, operation: 'readback_after_write' })
  }

  async dashboard(staffId) { return scope(await this.load(), staffId) }
  async assistantQuery(actorId, question, context) {
    try {
      const database = await this.load()
      scope(database, actorId)
      const result = await queryAssistant(database, question, context, actorId)
      this.queryLogs.unshift(result.debug)
      this.queryLogs = this.queryLogs.filter(Boolean).slice(0, 100)
      return result
    } catch (error) {
      this.queryLogs.unshift({ user_id: actorId, role: 'ADMIN', query_plan: { query_type: 'UNSUPPORTED', entity: null, filters: {}, metrics: [], time_range: null, joins: [], result_mode: 'SUMMARY' }, resolved_entities: {}, repositories_used: [], row_count: 0, executed_at: new Date().toISOString(), status: 'DATA_SOURCE_ERROR', error_reason: error instanceof Error ? error.message : '数据查询出现异常' })
      this.queryLogs = this.queryLogs.slice(0, 100)
      throw error
    }
  }
  async assistantQueryLogs(actorId) { await this.dashboard(actorId); return this.queryLogs }
  async savePerformanceTraces(actorId) { await this.dashboard(actorId); return [...this.saveTraces] }
  async evidenceDebug(actorId) { await this.staff(actorId); return [...this.evidenceTraces] }
  async staff(staffId) {
    const record = (await this.load()).staff.find((item) => item.id === staffId)
    if (!record) throw new Error('账号不存在')
    if (record.status !== 'ACTIVE') throw new Error('该账户已停用，请联系管理员。')
    if (record.permissionRole !== 'ADMIN' || record.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
    return record
  }
  async validateSession(staffId, authVersion, sessionAuthMode = '') {
    const account = await this.staff(staffId)
    let credential = null
    if (config.authMode === 'PASSWORD') {
      if (sessionAuthMode !== 'PASSWORD') throw invalidLogin()
      credential = await this.authRepository.findByStaffId(staffId)
      if (!credential || credential.credentialStatus === 'DISABLED' || Number(credential.authVersion || 0) !== Number(authVersion || 0)) throw invalidLogin()
    }
    return { account, credential }
  }
  async authenticate(phone, secret, ip = 'unknown') {
    if (loginRateLimiter.isBlocked(phone, ip)) throw Object.assign(new Error('登录尝试过于频繁，请稍后再试'), { code: 'AUTH_RATE_LIMITED', status: 429 })
    const database = await this.load()
    const normalized = normalizePhone(phone)
    const account = database.staff.find((item) => normalizePhone(item.phone) === normalized)
    const validStaff = account?.permissionRole === 'ADMIN' && account.status === 'ACTIVE' && account.loginEnabled === true
    if (config.authMode === 'PASSWORD') {
      if (config.dataMode === 'production' && !config.feishu.tables.authCredentials) throw new AuthCredentialStoreNotConfiguredError('生产密码凭据表尚未配置')
      const credential = await this.authRepository.findByPhone(normalized)
      const passwordMatches = await verifyPassword(secret, credential?.passwordHash || dummyPasswordHash)
      const credentialMatches = Boolean(credential && credential.staffId === account?.id && credential.loginPhone === normalized && credential.credentialStatus !== 'DISABLED')
      if (!validStaff || !credentialMatches || !passwordMatches) {
        loginRateLimiter.recordFailure(phone, ip)
        throw invalidLogin()
      }
      loginRateLimiter.clear(phone, ip)
      await this.authRepository.recordSuccessfulLogin(account.id)
      return { ...account, authVersion: Number(credential.authVersion || 0), mustChangePassword: credential.mustChangePassword === true, authMode: 'PASSWORD' }
    }
    if (config.dataMode === 'production' && !config.adminLoginCode) throw Object.assign(new Error('生产认证未配置'), { code: 'AUTH_NOT_CONFIGURED', status: 503 })
    const controlledProductionCode = config.dataMode === 'production' && config.authMode === 'ADMIN_CODE' && safeEqual(secret, config.adminLoginCode)
    const controlledDemoCode = config.dataMode !== 'production' && config.allowDevOtp && safeEqual(secret, '888888')
    if ((!controlledProductionCode && !controlledDemoCode) || !validStaff) { loginRateLimiter.recordFailure(phone, ip); throw invalidLogin() }
    loginRateLimiter.clear(phone, ip)
    return { ...account, authVersion: 0, mustChangePassword: false, authMode: config.authMode }
  }
  async setInitialPassword(staffId, password, { mustChangePassword = true } = {}) {
    const account = (await this.load()).staff.find((item) => item.id === staffId)
    if (!account) throw new Error('账号不存在')
    if (account.status !== 'ACTIVE' || account.loginEnabled !== true) throw new Error('账号当前不可登录')
    validatePassword(password, { phone: account.phone })
    const passwordHash = await hashPassword(password)
    const current = await this.authRepository.findByStaffId(staffId)
    const timestamp = now()
    if (current) {
      await this.authRepository.updatePassword(current, passwordHash, { password_algorithm: 'scrypt', must_change_password: mustChangePassword, password_changed_at: mustChangePassword ? null : timestamp, auth_version: Number(current.authVersion || 0) + 1, credential_status: 'ACTIVE', updated_at: timestamp })
    } else {
      await this.authRepository.createCredential({ staffId, loginPhone: account.phone, passwordHash, passwordAlgorithm: 'scrypt', mustChangePassword, passwordChangedAt: mustChangePassword ? null : timestamp, authVersion: 1, credentialStatus: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp, lastLoginAt: null })
    }
    return { staffId, mustChangePassword }
  }
  async changePassword(staffId, currentPassword, nextPassword) {
    const account = await this.staff(staffId)
    const credential = await this.authRepository.findByStaffId(staffId)
    const hasCurrentPassword = typeof currentPassword === 'string' && currentPassword.length > 0
    const currentMatches = await verifyPassword(currentPassword, credential?.passwordHash || dummyPasswordHash)
    const firstChangeGuard = credential?.mustChangePassword === true && !hasCurrentPassword
    if (!credential || (!currentMatches && !firstChangeGuard)) throw Object.assign(new Error('当前密码不正确'), { code: 'PASSWORD_INVALID', status: 401 })
    validatePassword(nextPassword, { phone: account.phone })
    if (await verifyPassword(nextPassword, credential.passwordHash)) throw Object.assign(new Error('新密码不能与当前密码相同'), { code: 'PASSWORD_REUSE_NOT_ALLOWED', status: 400 })
    const timestamp = now()
    await this.authRepository.updatePassword(credential, await hashPassword(nextPassword), { password_algorithm: 'scrypt', must_change_password: false, password_changed_at: timestamp, auth_version: Number(credential.authVersion || 0) + 1, credential_status: 'ACTIVE', updated_at: timestamp })
    return { ok: true, mustChangePassword: false, authVersion: Number(credential.authVersion || 0) + 1 }
  }
  async resetPassword(actorId, targetStaffId, nextPassword) {
    const actor = await this.staff(actorId)
    if (actor.permissionRole !== 'ADMIN') throw new Error('只有 ADMIN 可以重置密码')
    const target = (await this.load()).staff.find((item) => item.id === targetStaffId)
    if (!target) throw new Error('账号不存在')
    validatePassword(nextPassword, { phone: target.phone })
    const current = await this.authRepository.findByStaffId(targetStaffId)
    const timestamp = now()
    const nextVersion = Number(current?.authVersion || 0) + 1
    if (current) await this.authRepository.updatePassword(current, await hashPassword(nextPassword), { password_algorithm: 'scrypt', must_change_password: true, password_changed_at: null, auth_version: nextVersion, credential_status: 'ACTIVE', updated_at: timestamp })
    else await this.authRepository.createCredential({ staffId: targetStaffId, loginPhone: target.phone, passwordHash: await hashPassword(nextPassword), passwordAlgorithm: 'scrypt', mustChangePassword: true, passwordChangedAt: null, authVersion: nextVersion, credentialStatus: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp, lastLoginAt: null })
    this.audit('RESET_PASSWORD', targetStaffId, actorId)
    return { ok: true, staffId: targetStaffId, mustChangePassword: true, authVersion: nextVersion }
  }
  async syncCredentialPhone(staffId, phone) {
    const credential = await this.authRepository.findByStaffId(staffId)
    if (credential) await this.authRepository.updateLoginPhone(staffId, normalizePhone(phone))
  }
  async customer(actorId, customerId) { return (await this.dashboard(actorId)).customers.find((item) => item.id === customerId) }
  async profileDraft(actorId, customerId, textInput) {
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const current = database.customers.find((item) => item.id === customerId)
    if (!current) throw new Error('客户不存在')
    return createProfileDraft({ text: textInput, existing: current.profileFields || {} })
  }
  async previewCustomer(actorId, input) {
    const database = await this.load()
    scope(database, actorId)
    const normalized = validateManualCustomer(input)
    const identity = resolveCustomerIdentity(database.customers, normalized)
    // Preview only resolves identity and duplicates. AI extraction must stay outside the customer save critical path.
    return { duplicates: duplicateMatches(database, input), identity: { result: identity.result, matched_customer_id: identity.matched_customer_id, match_reasons: identity.match_reasons, confidence: identity.confidence }, updates: [] }
  }
  async createCustomer(actorId, input, requestId = '') {
    const startedAt = Date.now()
    const timings = { identity_resolution_ms: 0, customer_write_ms: 0, enrollment_write_ms: 0, profile_change_ms: 0, ai_ms: 0 }
    const operationId = text(input?.operationId).trim()
    const traceOperationId = operationId || `customer-save-${crypto.randomUUID()}`
    let result = 'ERROR'
    try {
      const identityStartedAt = Date.now()
      const database = await this.load()
      scope(database, actorId)
      const normalized = validateManualCustomer(input)
      const existingId = operationId ? customerIdForOperation(operationId) : ''
      const existing = existingId ? database.customers.find((item) => item.id === existingId) : null
      if (!existing) {
        const identity = resolveCustomerIdentity(database.customers, normalized)
        const duplicates = duplicateMatches(database, input)
        if (identity.result === 'CONFLICT') throw Object.assign(new Error('手机号和微信号分别匹配到了不同客户，请人工确认。'), { status: 409, code: 'IDENTITY_CONFLICT', matches: duplicates })
        if (identity.result === 'EXACT_MATCH') throw Object.assign(new Error('该联系方式已匹配到现有客户，请打开原档案更新。'), { status: 409, code: 'CUSTOMER_DUPLICATE', matches: duplicates })
        if (identity.result === 'POSSIBLE_MATCH' && !input.confirmedNotSame) throw Object.assign(new Error('检测到可能重复的客户，请先确认是否为同一人'), { status: 409, code: 'CUSTOMER_POSSIBLE_MATCH', matches: duplicates })
      }
      validateEnrollmentDrafts(database, input.enrollments)
      timings.identity_resolution_ms = Date.now() - identityStartedAt
      const customerId = existing?.id || existingId || `CUS-${Date.now()}`
      let current = database
      if (!existing) {
        const customerWriteStartedAt = Date.now()
        const createdAt = now()
        const initialFields = { phone: { source: 'STRUCTURED_INPUT', confidence: 1, confirmed: true, updatedAt: createdAt }, ...(normalized.wechat ? { wechat: { source: 'STRUCTURED_INPUT', confidence: 1, confirmed: true, updatedAt: createdAt } } : {}) }
        const writeValues = { customer_id: customerId, nickname: normalized.nickname, source: input.source || '管理员手动录入', notes: normalized.situation, current_issue: '', help_expectation: '', current_goal: '', sabc: 'C', is_paid: false, created_at: createdAt, profile_field_meta_json: JSON.stringify({ _profile_version: 1, _fields: initialFields }), profile_schema_version: CUSTOMER_PROFILE_SCHEMA_VERSION, profile_updated_at: createdAt }
        if (normalized.phone) writeValues.phone = normalized.phone
        if (normalized.wechat) writeValues.wechat = normalized.wechat
        const writeResult = await createRecord(config.feishu.tables.customers, mapFields('customers', writeValues))
        current = await this.loadAfterWrite(writeResult, customerId)
        timings.customer_write_ms = Date.now() - customerWriteStartedAt
      }
      if (input.profileUpdates?.length) {
        const profileStartedAt = Date.now()
        await persistCustomerProfile(current, customerId, normalizeProfileUpdates(input.profileUpdates, current.customers.find((item) => item.id === customerId), true), undefined, actorId)
        current = await this.loadAfterWrite(undefined, customerId)
        timings.profile_change_ms = Date.now() - profileStartedAt
      }
      const enrollmentStartedAt = Date.now()
      try {
        await mergeEnrollments(current, customerId, input.enrollments, actorId, operationId)
      } catch (error) {
        throw Object.assign(new Error(partialEnrollmentFailureMessage()), { code: 'CUSTOMER_ENROLLMENT_PARTIAL_FAILURE', status: 502, cause: error })
      }
      timings.enrollment_write_ms = Date.now() - enrollmentStartedAt
      result = 'SUCCESS'
      // Stage 1 keeps Customer creation separate from Appointment/ServiceCase. The old follow-up fields remain compatibility-only.
      return scope(await this.loadAfterWrite(undefined, customerId), actorId)
    } finally {
      const total = Date.now() - startedAt
      const measured = timings.identity_resolution_ms + timings.customer_write_ms + timings.enrollment_write_ms + timings.profile_change_ms + timings.ai_ms
      this.saveTraces.unshift({ request_id: requestId || undefined, operation_id: traceOperationId, result, customer_save_total_ms: total, ...timings, other_ms: Math.max(0, total - measured) })
      this.saveTraces = this.saveTraces.slice(0, 50)
    }
  }
  async updateCustomer(actorId, customerId, input) {
    const database = await this.load()
    scope(database, actorId)
    const current = database.customers.find((item) => item.id === customerId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!current || !row) throw new Error('客户不存在')
    validateEnrollmentDrafts(database, input.enrollments)
    const normalized = validateManualCustomer({ ...input, nickname: input.nickname || current.name, phone: input.phone || current.phone, wechat: input.wechat || current.wechat })
    const identity = resolveCustomerIdentity(database.customers.filter((item) => item.id !== customerId), normalized)
    if (identity.result === 'CONFLICT') throw Object.assign(new Error('手机号和微信号分别匹配到了不同客户，请人工确认。'), { status: 409, code: 'IDENTITY_CONFLICT' })
    if (identity.result === 'EXACT_MATCH') throw Object.assign(new Error('该联系方式已绑定其他客户，不能覆盖。'), { status: 409, code: 'CUSTOMER_DUPLICATE' })
    const identityUpdates = []
    if (normalizePhone(current.phone) !== normalized.phone) identityUpdates.push({ field: 'phone', value: normalized.phone, source: 'USER_EXPLICIT', confidence: 1, confirmed: true })
    if (normalizeWechat(current.wechat) !== normalizeWechat(normalized.wechat)) identityUpdates.push({ field: 'wechat', value: normalized.wechat, source: 'USER_EXPLICIT', confidence: 1, confirmed: true })
    if (identityUpdates.length) await persistCustomerProfile(database, customerId, normalizeProfileUpdates(identityUpdates, current, true), undefined, actorId)
    await updateRecord(config.feishu.tables.customers, row.record_id, mapFields('customers', { nickname: normalized.nickname, source: input.source || current.source, notes: normalized.situation || current.notes }))
    let latest = await this.loadAfterWrite(undefined, customerId)
    if (input.profileUpdates?.length) await persistCustomerProfile(latest, customerId, normalizeProfileUpdates(input.profileUpdates, latest.customers.find((item) => item.id === customerId), true), undefined, actorId)
    latest = await this.loadAfterWrite(undefined, customerId)
    await mergeEnrollments(latest, customerId, input.enrollments, actorId, text(input?.operationId).trim(), { replace: Array.isArray(input.enrollments) })
    // Customer updates do not create or mutate Appointment in Stage 1.
    return scope(await this.loadAfterWrite(undefined, customerId), actorId)
  }

  async updateCustomerEnrollments(actorId, customerId, drafts, operationId = '') {
    const database = await this.load()
    scope(database, actorId)
    if (!database.customers.some((item) => item.id === customerId)) throw new Error('客户不存在')
    await mergeEnrollments(database, customerId, Array.isArray(drafts) ? drafts : [], actorId, text(operationId).trim(), { replace: true })
    return scope(await this.loadAfterWrite(undefined, customerId), actorId)
  }
  async confirmProfile(actorId, customerId, updates) {
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const current = database.customers.find((item) => item.id === customerId)
    if (!current) throw new Error('客户不存在')
    await persistCustomerProfile(database, customerId, normalizeProfileUpdates(updates, current, true), undefined, actorId)
    return (await this.load()).customers.find((item) => item.id === customerId)
  }
  async extractDocument(actorId, input) {
    await this.staff(actorId)
    const document = input?.document || input || {}
    const buffer = Buffer.from(String(document.base64 || ''), 'base64')
    const extracted = await extractDocument({ filename: document.filename, mimeType: document.mimeType, extension: document.extension, buffer, maxDocumentSizeMb: config.maxDocumentSizeMb })
    if (!extracted.extracted_text) throw Object.assign(new Error('资料读取失败，请检查文件后重新上传。'), { code: 'DOCUMENT_TEXT_EMPTY', status: 422 })
    return extracted
  }
  async createSource(actorId, input) {
    requireStage2Tables()
    const startedAt = Date.now()
    const database = await this.load()
    await this.staff(actorId)
    const requestedCustomerId = text(input?.customerId).trim()
    if (!database.customers.some((item) => item.id === requestedCustomerId)) throw new Error('客户不存在')
    let sourceInputValue = input
    if (String(input?.sourceType || '').trim().toUpperCase() === 'FILE_UPLOAD') {
      const document = input?.document || {}
      const fileHash = text(document.fileHash || document.file_hash)
      const extractedText = normalizeText(document.extractedText || document.extracted_text, 500_000)
      if (!fileHash || !extractedText) throw Object.assign(new Error('资料读取失败，请检查文件后重新上传。'), { code: 'DOCUMENT_TEXT_EMPTY', status: 422 })
      const duplicate = database.sourceRecords.find((item) => item.customerId === requestedCustomerId && parseDocumentFileRef(item.fileRef)?.file_hash === fileHash)
      if (duplicate) throw Object.assign(new Error('这份资料已经记录过了'), { code: 'SOURCE_DUPLICATE', status: 409, sourceId: duplicate.id })
      const fileRef = documentFileRef({ filename: document.filename, mimeType: document.mimeType, extension: document.extension, size: document.size, fileHash, charCount: document.charCount || Array.from(extractedText).length })
      sourceInputValue = { ...input, rawText: extractedText, contentHash: contentHash(extractedText), fileRef }
    }
    const normalized = sourceInput(sourceInputValue, actorId)
    if (!database.customers.some((item) => item.id === normalized.customerId)) throw new Error('客户不存在')
    const duplicate = database.sourceRecords.find((item) => item.customerId === normalized.customerId && item.contentHash === normalized.contentHash)
    if (duplicate) throw Object.assign(new Error('这份资料已经记录过了'), { code: 'SOURCE_DUPLICATE', status: 409, sourceId: duplicate.id })
    const sourceId = text(input?.sourceId) || stableId('SRC', `${normalized.customerId}:${normalized.contentHash}:${Date.now()}`)
    const timestamp = now()
    await createMappedRecord('sourceRecords', 'source.create', { source_id: sourceId, subject_type: normalized.subjectType, subject_id: normalized.subjectId, customer_id: normalized.customerId, source_type: normalized.sourceType, title: normalized.title, raw_text: normalized.rawText, file_ref: normalized.fileRef, occurred_at: '', uploaded_at: timestamp, uploaded_by: normalized.uploadedBy, source_role: normalized.sourceRole, service_record_id: normalized.serviceRecordId, content_hash: normalized.contentHash, processing_status: 'UPLOADED', processing_version: 1, sensitivity_level: 'HIGH', notes: normalized.notes, source_version: 1, extractor_version: 'evidence-v1', last_batch_id: '', processing_started_at: '', last_processing_at: '', processing_error: '', created_at: timestamp, updated_at: timestamp })
    this.sourceSaveTimes.set(sourceId, Date.now() - startedAt)
    const result = (await waitForSourceVisibility(sourceId)) || { ...normalized, id: sourceId, processingStatus: 'UPLOADED', sensitivityLevel: 'HIGH', sourceVersion: 1 }
    return result
  }
  async sourceWorkspace(actorId, customerId) {
    requireStage2Tables()
    const database = await this.load()
    await this.staff(actorId)
    if (!database.customers.some((item) => item.id === customerId)) throw new Error('客户不存在')
    return { sources: database.sourceRecords.filter((item) => item.customerId === customerId).map(({ rawText: _rawText, ...safe }) => safe), evidenceItems: database.evidenceItems.filter((item) => item.customerId === customerId), proposals: database.profileUpdateProposals.filter((item) => item.customerId === customerId), conflicts: database.evidenceConflicts.filter((item) => item.customerId === customerId), profileMaterialization: database.customers.find((item) => item.id === customerId)?.profileMaterialization }
  }
  async sourceDetail(actorId, sourceId) {
    requireStage2Tables()
    const database = await this.load()
    await this.staff(actorId)
    const source = database.sourceRecords.find((item) => item.id === sourceId)
    if (!source) throw new Error('资料不存在')
    return { source, evidenceItems: database.evidenceItems.filter((item) => item.sourceId === sourceId), proposals: database.profileUpdateProposals.filter((item) => item.sourceId === sourceId), conflicts: database.evidenceConflicts.filter((item) => item.newEvidenceId && database.evidenceItems.find((evidence) => evidence.id === item.newEvidenceId)?.sourceId === sourceId), profileMaterialization: database.customers.find((item) => item.id === source.customerId)?.profileMaterialization }
  }
  async processSource(actorId, sourceId, { force = false } = {}) {
    requireStage2Tables()
    const startedAt = Date.now()
    const database = await this.load()
    await this.staff(actorId)
    let source = database.sourceRecords.find((item) => item.id === sourceId)
    const sourceRow = database._rows.sourceRecords.find((item) => item.record_id === source?._recordId)
    if (!source || !sourceRow) throw new Error('资料不存在')
    const existingEvidence = database.evidenceItems.filter((item) => item.sourceId === sourceId)
    if (!force && source.processingStatus === 'COMPLETED' && existingEvidence.length) return this.sourceDetail(actorId, sourceId)
    if (!force && source.processingStatus === 'PROCESSING' && !isStaleProcessing(source)) return this.sourceDetail(actorId, sourceId)
    const resumeExistingEvidence = existingEvidence.length > 0 && ['PROCESSING', 'FAILED'].includes(source.processingStatus)
    const batchId = stableId('EXT', `${sourceId}:${source.contentHash}:${source.extractorVersion || 'evidence-v1'}`)
    const processingStartedAt = now()
    const processingVersion = Number(source.processingVersion || 1) + 1
    await updateMappedRecord('sourceRecords', 'source.processing.start', sourceRow.record_id, { processing_status: 'PROCESSING', processing_version: processingVersion, last_batch_id: batchId, processing_started_at: processingStartedAt, last_processing_at: processingStartedAt, processing_error: '', updated_at: processingStartedAt })
    try {
      if (!source.rawText) throw Object.assign(new Error('原始资料不能为空'), { code: 'SOURCE_TEXT_REQUIRED', status: 400 })
      const candidates = []
      if (!resumeExistingEvidence) {
        const chunks = chunkText(source.rawText)
        for (const chunk of chunks) {
          const rawItems = await this.evidenceExtractor({ text: chunk.text, sourceRole: source.sourceRole, sourcePerspective: source.sourcePerspective, current: database.customers.find((item) => item.id === source.customerId)?.profileFields || {} })
          for (const rawItem of rawItems) {
            if (String(rawItem?.evidence_type || '').toUpperCase() === 'OBSERVATION' && source.sourceRole !== 'MENTOR') continue
            const normalized = normalizeEvidenceCandidate(rawItem, { sourceId, chunk, extractionBatchId: batchId, model: config.deepseek.model, modelVersion: 'v1', promptVersion: 'evidence-v1' })
            if (normalized) candidates.push(normalized)
          }
        }
      }
      const unique = dedupeEvidence(candidates)
      const customer = database.customers.find((item) => item.id === source.customerId)
      const createdEvidence = []
      for (const item of unique) {
        const id = stableId('EVD', `${sourceId}:${batchId}:${item.evidenceType}:${item.fieldKey}:${JSON.stringify(item.standardValue)}:${item.sourceExcerpt}`)
        const evidence = { ...item, id }
        if (!database.evidenceItems.some((existing) => existing.id === id)) { await createMappedRecord('evidenceItems', 'evidence.create', { evidence_id: evidence.id, subject_type: source.subjectType, subject_id: source.subjectId, customer_id: source.customerId, source_id: sourceId, evidence_type: evidence.evidenceType, semantic_kind: evidence.semanticKind, field_key: evidence.fieldKey || '', standard_value: stage2Json(evidence.standardValue), display_text: evidence.displayText, source_excerpt: evidence.sourceExcerpt, locator_json: stage2Json(evidence.locator), occurred_at: evidence.occurredAt || source.occurredAt || '', source_role: source.sourceRole, confidence: evidence.confidence, review_status: evidence.reviewStatus, reviewer_id: '', reviewed_at: '', extraction_batch_id: evidence.extractionBatchId, provider: 'DEEPSEEK', model: evidence.model, model_version: evidence.modelVersion, prompt_version: evidence.promptVersion, created_at: now(), updated_at: now() }); createdEvidence.push(evidence) }
      }
      const refreshed = await this.load()
      const allEvidence = refreshed.evidenceItems.filter((item) => item.sourceId === sourceId)
      if (!customer) throw Object.assign(new Error('客户不存在'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
      const itemErrors = []
      for (const evidence of allEvidence) {
        try {
          const currentValue = database.customers.find((item) => item.id === source.customerId)?.profileFields?.[evidence.fieldKey] ?? null
          const change = classifyEvidenceChange(evidence, currentValue)
          const existingProposal = refreshed.profileUpdateProposals.find((item) => item.evidenceId === evidence.id)
          if (existingProposal || evidence.evidenceType !== 'FACT') continue
          const timestamp = now()
          if (change.changeType === 'NO_CHANGE') {
            if (evidence.reviewStatus !== 'CONFIRMED') await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
            continue
          }
          if (shouldAutoConfirmEvidence(evidence) && evidence.reviewStatus !== 'CONFIRMED') await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
          if (!evidence.fieldKey) continue
          const requiresReview = Boolean(change.conflictType === 'FACT_CONTRADICTION')
          const autoApply = !requiresReview && isSnapshotEvidence(evidence) && ['ADD', 'UPDATE', 'APPEND'].includes(change.action) && PROFILE_FIELD_KEYS.has(evidence.fieldKey)
          if (autoApply) {
            const update = normalizeProfileUpdates([{ field: evidence.fieldKey, value: evidence.standardValue, source: 'AI_INFERENCE', confidence: evidence.confidence }], database.customers.find((item) => item.id === source.customerId), true)[0]
            if (update) {
              await persistCustomerProfile(database, source.customerId, [update], undefined, actorId, { sourceRecordId: sourceId, evidenceId: evidence.id, updateBatchId: evidence.extractionBatchId })
              await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
            }
          }
          const reviewStatus = autoApply || shouldAutoConfirmEvidence(evidence) ? 'CONFIRMED' : 'PENDING_REVIEW'
          if (evidence.fieldKey && isSnapshotEvidence(evidence)) {
            const proposal = { id: proposalId(evidence.id, evidence.fieldKey), customerId: source.customerId, subjectId: source.subjectId, evidenceId: evidence.id, sourceId, fieldKey: evidence.fieldKey, fieldName: mapField('customers', evidence.fieldKey), currentValue, proposedValue: evidence.standardValue, action: PROPOSAL_ACTIONS.has(change.action) ? change.action : 'REVIEW_REQUIRED', changeType: change.changeType, reviewStatus, reason: evidence.displayText, confidence: evidence.confidence, extractionBatchId: evidence.extractionBatchId, reviewerId: autoApply ? actorId : '', reviewedAt: autoApply ? timestamp : null, createdAt: timestamp, updatedAt: timestamp }
            if (!refreshed.profileUpdateProposals.some((item) => item.id === proposal.id)) await createMappedRecord('profileUpdateProposals', 'proposal.create', { proposal_id: proposal.id, customer_id: proposal.customerId, subject_id: proposal.subjectId, evidence_id: proposal.evidenceId, source_id: proposal.sourceId, field_key: proposal.fieldKey, field_name: proposal.fieldName, current_value: stage2Json(proposal.currentValue), proposed_value: stage2Json(proposal.proposedValue), action: proposal.action, change_type: proposal.changeType, review_status: proposal.reviewStatus, reason: proposal.reason, confidence: proposal.confidence, extraction_batch_id: proposal.extractionBatchId, reviewer_id: proposal.reviewerId, reviewed_at: proposal.reviewedAt || '', created_at: proposal.createdAt, updated_at: proposal.updatedAt })
          }
          if (change.conflictType === 'FACT_CONTRADICTION') {
            const conflict = { id: conflictId(evidence.fieldKey, '', evidence.id), subjectId: source.subjectId, customerId: source.customerId, fieldKey: evidence.fieldKey, conflictType: change.conflictType, currentValue, newValue: evidence.standardValue, currentEvidenceId: '', newEvidenceId: evidence.id, status: 'OPEN', suggestedResolution: '人工核验稳定事实', resolution: '', reviewerId: '', resolvedAt: null, createdAt: timestamp, updatedAt: timestamp }
            if (!refreshed.evidenceConflicts.some((item) => item.id === conflict.id)) await createMappedRecord('evidenceConflicts', 'conflict.create', { conflict_id: conflict.id, subject_id: conflict.subjectId, customer_id: conflict.customerId, field_key: conflict.fieldKey, conflict_type: conflict.conflictType, current_value: stage2Json(conflict.currentValue), new_value: stage2Json(conflict.newValue), current_evidence_id: '', new_evidence_id: conflict.newEvidenceId, status: 'OPEN', suggested_resolution: conflict.suggestedResolution, resolution: '', reviewer_id: '', resolved_at: '', created_at: conflict.createdAt, updated_at: conflict.updatedAt })
          }
        } catch (error) {
          itemErrors.push(processingErrorCode(error))
        }
      }
      const debugBeforeStatus = await this.load()
      const hasOpenConflict = debugBeforeStatus.evidenceConflicts.some((item) => item.newEvidenceId && debugBeforeStatus.evidenceItems.find((evidence) => evidence.id === item.newEvidenceId)?.sourceId === sourceId && item.status === 'OPEN')
      const finalStatus = hasOpenConflict ? 'REVIEW_REQUIRED' : itemErrors.length ? 'FAILED' : 'COMPLETED'
      const finishedAt = now()
      await updateMappedRecord('sourceRecords', `source.processing.${finalStatus.toLowerCase()}`, sourceRow.record_id, { processing_status: finalStatus, processing_version: processingVersion, last_batch_id: batchId, last_processing_at: finishedAt, processing_error: itemErrors.length ? [...new Set(itemErrors)].join(',').slice(0, 200) : '', updated_at: finishedAt })
      const debugDatabase = await this.load()
      this.evidenceTraces.unshift({ source_id: sourceId, processing_status: finalStatus, extraction_batch: batchId, evidence_count: unique.length, proposal_count: debugDatabase.profileUpdateProposals.filter((item) => item.sourceId === sourceId).length, conflict_count: debugDatabase.evidenceConflicts.filter((item) => item.newEvidenceId && debugDatabase.evidenceItems.find((evidence) => evidence.id === item.newEvidenceId)?.sourceId === sourceId).length, model: config.deepseek.model, prompt_version: 'evidence-v1', source_save_ms: this.sourceSaveTimes.get(sourceId), background_analysis_ms: Date.now() - startedAt, duration_ms: Date.now() - startedAt })
      this.evidenceTraces = this.evidenceTraces.slice(0, 50)
      this.audit('PROCESS_SOURCE', sourceId, actorId)
      return this.sourceDetail(actorId, sourceId)
    } catch (error) {
      const failedAt = now()
      await updateMappedRecord('sourceRecords', 'source.processing.failed', sourceRow.record_id, { processing_status: 'FAILED', processing_version: processingVersion, last_batch_id: batchId, last_processing_at: failedAt, processing_error: processingErrorCode(error), updated_at: failedAt }).catch(() => {})
      this.evidenceTraces.unshift({ source_id: sourceId, processing_status: 'FAILED', extraction_batch: batchId, evidence_count: 0, proposal_count: 0, conflict_count: 0, model: config.deepseek.model, prompt_version: 'evidence-v1', duration_ms: Date.now() - startedAt })
      this.evidenceTraces = this.evidenceTraces.slice(0, 50)
      this.audit('PROCESS_SOURCE', sourceId, actorId, 'FAIL', error instanceof Error ? error.message : 'EXTRACTION_FAILED')
      throw error
    }
  }
  async maybeCompleteSource(sourceId) {
    const database = await this.load()
    const source = database.sourceRecords.find((item) => item.id === sourceId)
    if (!source) return
    const pendingProposal = database.profileUpdateProposals.some((item) => item.sourceId === sourceId && item.reviewStatus === 'PENDING_REVIEW')
    const openConflict = database.evidenceConflicts.some((item) => item.newEvidenceId && database.evidenceItems.find((evidence) => evidence.id === item.newEvidenceId)?.sourceId === sourceId && item.status === 'OPEN')
    if (!pendingProposal && !openConflict) {
      const row = database._rows.sourceRecords.find((item) => item.record_id === source._recordId)
      if (row) await updateRecord(stage2Table('sourceRecords'), row.record_id, mapFields('sourceRecords', { processing_status: 'COMPLETED', updated_at: now() }))
    }
  }
  async reviewProposal(actorId, proposalIdValue, decision) {
    requireStage2Tables()
    const database = await this.load()
    await this.staff(actorId)
    const proposal = database.profileUpdateProposals.find((item) => item.id === proposalIdValue)
    if (!proposal) throw new Error('档案更新建议不存在')
    if (!['CONFIRM', 'REJECT'].includes(decision)) throw Object.assign(new Error('审核动作无效'), { code: 'INVALID_REVIEW_DECISION', status: 400 })
    const row = database._rows.profileUpdateProposals.find((item) => item.record_id === proposal._recordId)
    const timestamp = now()
    if (decision === 'CONFIRM') {
      const evidence = database.evidenceItems.find((item) => item.id === proposal.evidenceId)
      if (!evidence || !proposal.fieldKey) throw new Error('建议缺少可追溯证据')
      const current = database.customers.find((item) => item.id === proposal.customerId)
      const update = { field: proposal.fieldKey, value: proposal.proposedValue, source: evidence.evidenceType === 'HYPOTHESIS' ? 'AI_INFERENCE' : 'AI_EXTRACTED_CONFIRMED', confidence: proposal.confidence, confirmed: true }
      if (update.source === 'AI_INFERENCE') throw Object.assign(new Error('AI假设不能写入当前客户档案'), { code: 'HYPOTHESIS_NOT_WRITABLE', status: 400 })
      await persistCustomerProfile(database, proposal.customerId, normalizeProfileUpdates([update], current, true), undefined, actorId, { sourceRecordId: proposal.sourceId, evidenceId: proposal.evidenceId, updateBatchId: proposal.extractionBatchId })
      await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
    } else {
      const evidence = database.evidenceItems.find((item) => item.id === proposal.evidenceId)
      if (evidence) await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'REJECTED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
    }
    await updateRecord(stage2Table('profileUpdateProposals'), row.record_id, mapFields('profileUpdateProposals', { review_status: decision === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
    await this.maybeCompleteSource(proposal.sourceId)
    return this.sourceWorkspace(actorId, proposal.customerId)
  }
  async resolveConflict(actorId, conflictIdValue, resolution) {
    requireStage2Tables()
    const database = await this.load()
    await this.staff(actorId)
    if (!CONFLICT_RESOLUTIONS.has(resolution)) throw Object.assign(new Error('冲突处理方式无效'), { code: 'INVALID_CONFLICT_RESOLUTION', status: 400 })
    const conflict = database.evidenceConflicts.find((item) => item.id === conflictIdValue)
    if (!conflict) throw new Error('冲突不存在')
    const row = database._rows.evidenceConflicts.find((item) => item.record_id === conflict._recordId)
    const proposal = database.profileUpdateProposals.find((item) => item.evidenceId === conflict.newEvidenceId)
    if (resolution === 'USE_NEW' && proposal) await this.reviewProposal(actorId, proposal.id, 'CONFIRM')
    if (resolution === 'MARK_UNKNOWN') return this.sourceWorkspace(actorId, conflict.customerId)
    if (resolution === 'KEEP_CURRENT' || resolution === 'KEEP_BOTH') {
      const evidence = database.evidenceItems.find((item) => item.id === conflict.newEvidenceId)
      if (evidence) await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: resolution === 'KEEP_BOTH' ? 'CONFIRMED' : 'REJECTED', reviewer_id: actorId, reviewed_at: now(), updated_at: now() }))
      if (proposal) { const proposalRow = database._rows.profileUpdateProposals.find((item) => item.record_id === proposal._recordId); await updateRecord(stage2Table('profileUpdateProposals'), proposalRow.record_id, mapFields('profileUpdateProposals', { review_status: resolution === 'KEEP_CURRENT' ? 'REJECTED' : 'CONFIRMED', reviewer_id: actorId, reviewed_at: now(), updated_at: now() })) }
    }
    await updateRecord(stage2Table('evidenceConflicts'), row.record_id, mapFields('evidenceConflicts', { status: 'RESOLVED', resolution, reviewer_id: actorId, resolved_at: now(), updated_at: now() }))
    const newEvidence = database.evidenceItems.find((item) => item.id === conflict.newEvidenceId)
    if (newEvidence) await this.maybeCompleteSource(newEvidence.sourceId)
    return this.sourceWorkspace(actorId, conflict.customerId)
  }
  async saveBrief(actorId, customerId, brief) {
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!row) throw new Error('客户不存在')
    await updateRecord(config.feishu.tables.customers, row.record_id, mapFields('customers', { brief }))
    return (await this.dashboard(actorId)).customers.find((item) => item.id === customerId)
  }

  async createMentor(actorId, input) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以管理导师账户')
    const name = text(input?.name).trim()
    const phone = normalizePhone(input?.phone)
    if (!name) throw new Error('导师昵称不能为空')
    if (!validPhone(phone)) throw new Error('请输入有效手机号')
    const duplicate = database.staff.find((item) => normalizePhone(item.phone) === phone)
    if (duplicate?.status === 'ACTIVE') throw Object.assign(new Error('该手机号已绑定账户'), { status: 409 })
    if (duplicate?.status === 'INACTIVE') throw Object.assign(new Error('该手机号对应一个已停用导师，请编辑原导师记录，不要重复创建'), { status: 409 })
    const createdAt = feishuDate()
    let staffId = `M${Date.now()}`
    while (database.staff.some((item) => item.id === staffId)) staffId = `M${Date.now()}${Math.floor(Math.random() * 10)}`
    try {
      await createRecord(config.feishu.tables.staff, mapFields('staff', { staff_id: staffId, nickname: name, name, phone, login_phone: phone, role: 'MENTOR', permission_role: 'MENTOR', status: 'ACTIVE', display_status: '在职', login_enabled: false, created_at: createdAt, updated_at: createdAt, display_role: '导师', mentor_id: staffId, specialty: '' }))
    } catch (error) {
      this.audit('CREATE_MENTOR', staffId, actorId, 'FAILED', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.audit('CREATE_MENTOR', staffId, actorId)
    const created = (await this.load()).staff.find((item) => item.id === staffId)
    if (!created) throw new FeishuUnavailableError('导师已写入，但刷新后无法读取该人员记录')
    return created
  }

  async updateMentor(actorId, mentorId, input) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以管理导师账户')
    const mentor = database.staff.find((item) => item.id === mentorId && item.permissionRole === 'MENTOR')
    const row = database._rows.staff.find((item) => item.record_id === mentor?._recordId)
    if (!mentor || !row) throw new Error('导师不存在')
    if (mentor.status !== 'ACTIVE') throw new Error('已注销导师只能查看历史信息')
    const name = text(input?.name).trim()
    const phone = normalizePhone(input?.phone)
    if (!name) throw new Error('导师昵称不能为空')
    if (!validPhone(phone)) throw new Error('请输入有效手机号')
    const duplicate = database.staff.find((item) => item.id !== mentorId && normalizePhone(item.phone) === phone)
    if (duplicate?.status === 'ACTIVE') throw Object.assign(new Error('该手机号已绑定账户'), { status: 409 })
    if (duplicate?.status === 'INACTIVE') throw Object.assign(new Error('该手机号对应一个已停用导师，请使用未占用的手机号'), { status: 409 })
    try {
      await updateRecord(config.feishu.tables.staff, row.record_id, mapFields('staff', { nickname: name, name, phone, login_phone: phone, role: 'MENTOR', permission_role: 'MENTOR', status: 'ACTIVE', display_status: '在职', login_enabled: false, updated_at: feishuDate(), display_role: '导师' }))
      await this.syncCredentialPhone(mentorId, phone)
    } catch (error) {
      this.audit('UPDATE_MENTOR', mentorId, actorId, 'FAILED', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.audit('UPDATE_MENTOR', mentorId, actorId)
    const updated = (await this.load()).staff.find((item) => item.id === mentorId)
    if (!updated) throw new FeishuUnavailableError('导师已更新，但刷新后无法读取该人员记录')
    return updated
  }

  async deactivateMentor(actorId, mentorId) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以管理导师账户')
    const mentor = database.staff.find((item) => item.id === mentorId && item.permissionRole === 'MENTOR')
    const row = database._rows.staff.find((item) => item.record_id === mentor?._recordId)
    if (!mentor || !row) throw new Error('导师不存在')
    if (mentor.status !== 'ACTIVE') throw new Error('导师账户已注销')
    const following = database.appointments.filter((item) => item.assignedMentorId === mentorId && item.status === 'WAIT_FOLLOW_UP').length
    const waitFeedback = database.appointments.filter((item) => item.assignedMentorId === mentorId && item.status === 'WAIT_FEEDBACK').length
    if (following || waitFeedback) {
      const cases = database.appointments.filter((item) => item.assignedMentorId === mentorId && ['WAIT_FOLLOW_UP', 'WAIT_FEEDBACK'].includes(item.status)).map((item) => ({ id: item.id, customerId: item.customerId, status: item.status }))
      throw Object.assign(new Error(`该导师还有未完成客户，请先重新分配后再注销。待跟进 ${following}，待反馈 ${waitFeedback}`), { status: 409, details: { following, waitFeedback, cases } })
    }
    const deactivatedAt = feishuDate()
    try {
      await updateRecord(config.feishu.tables.staff, row.record_id, mapFields('staff', { status: 'INACTIVE', login_enabled: false, display_status: '停用', updated_at: deactivatedAt, deactivated_at: deactivatedAt }))
      const credential = await this.authRepository.findByStaffId(mentorId)
      if (credential) await this.authRepository.disableCredential(mentorId)
    } catch (error) {
      this.audit('DEACTIVATE_MENTOR', mentorId, actorId, 'FAILED', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.audit('DEACTIVATE_MENTOR', mentorId, actorId)
    const deactivated = (await this.load()).staff.find((item) => item.id === mentorId)
    if (!deactivated) throw new FeishuUnavailableError('导师已停用，但刷新后无法读取该人员记录')
    return deactivated
  }

  async updateCustomerReferrer(actorId, customerId, referrerName) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以修改介绍人')
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!row) throw new Error('客户不存在')
    const value = typeof referrerName === 'string' ? referrerName.trim() : ''
    await updateRecord(config.feishu.tables.customers, row.record_id, mapFields('customers', { referrer_name: value }))
    return (await this.dashboard(actorId)).customers.find((item) => item.id === customerId)
  }

  async assignAppointment(actorId, appointmentId, mentorId) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以分配导师')
    const appointment = database.appointments.find((item) => item.id === appointmentId)
    const mentor = database.staff.find((item) => item.id === mentorId && item.permissionRole === 'MENTOR' && item.status === 'ACTIVE')
    if (!appointment || !mentor) throw new Error('预约或导师不存在')
    if (!['WAIT_ASSIGN', 'WAIT_FOLLOW_UP', 'WAIT_FEEDBACK'].includes(appointment.status)) throw new Error('已完成的预约不能更换导师')
    const nextStatus = appointment.status === 'WAIT_ASSIGN' ? 'WAIT_FOLLOW_UP' : appointment.status
    try {
      await updateRecord(config.feishu.tables.appointments, appointment._recordId, mapFields('appointments', { assigned_mentor_id: mentorId, status: nextStatus, followup_handled: nextStatus === 'WAIT_FEEDBACK', followup_info_completed: false, mentor_name: mentor.name }))
      const customerRow = database._rows.customers.find((row) => text(get('customers', row.fields, 'customer_id')) === appointment.customerId)
      if (customerRow) {
        const currentCustomer = database.customers.find((item) => item.id === appointment.customerId)
        if (currentCustomer && currentCustomer.mentorId !== mentorId) await persistCustomerProfile(database, appointment.customerId, [{ field: 'mentor_id', value: mentorId, source: 'USER_EXPLICIT', confidence: 1, confirmed: true }], undefined, actorId)
        else await updateRecord(config.feishu.tables.customers, customerRow.record_id, mapFields('customers', { mentor_id: mentorId }))
      }
    } catch (error) {
      this.audit('ASSIGN_MENTOR', appointmentId, actorId, 'FAILED', error instanceof Error ? error.message : String(error))
      throw error
    }
    this.audit('ASSIGN_MENTOR', appointmentId, actorId)
    return scope(await this.load(), actorId)
  }

  async markFollowupDone(actorId, appointmentId) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    const appointment = database.appointments.find((item) => item.id === appointmentId)
    if (!actor || actor.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
    if (!appointment) throw new Error('预约不存在')
    if (appointment.status !== 'WAIT_FOLLOW_UP') throw new Error('只有待跟进的预约可以完成跟进')
    await updateRecord(config.feishu.tables.appointments, appointment._recordId, mapFields('appointments', { followup_handled: true, status: 'WAIT_FEEDBACK' }))
    return scope(await this.load(), actorId)
  }

  async saveFeedback(actorId, input) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    const appointment = database.appointments.find((item) => item.id === input.appointmentId)
    if (!actor || actor.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
    if (!appointment) throw new Error('预约不存在')
    if (appointment.status !== 'WAIT_FEEDBACK') throw new Error('当前预约还不能提交反馈')
    const now = new Date().toISOString()
    const operationId = text(input?.operationId).trim()
    const serviceRecordId = operationId ? stableOperationId(operationId, 'SR') : `SR-${appointment.id}-${Date.now()}`
    if (database.sessions.some((item) => item.id === serviceRecordId)) return scope(database, actorId)
    const customer = database.customers.find((item) => item.id === appointment.customerId)
    if (!customer) throw new Error('客户不存在')
    const profileUpdates = normalizeProfileUpdates(input.profileUpdates, customer, Boolean(input.profileUpdates?.length))
    let serviceRecordCreated = false
    try {
      await createRecord(config.feishu.tables.serviceRecords, mapFields('serviceRecords', { service_record_id: serviceRecordId, customer_id: appointment.customerId, appointment_id: appointment.id, mentor_id: appointment.assignedMentorId || actorId, operator_id: actorId, topic: input.topic, result: input.result, current_core_need: input.coreNeed, is_paid: input.paid, sabc: input.grade, intended_course: input.intendedCourse || '', notes: input.notes, profile_text: input.profileText || '', profile_updates_json: JSON.stringify(profileUpdates), profile_update_confirmed: profileUpdates.length > 0, ai_summary: input.aiSummary || '', ai_status: input.aiStatus || '', ai_next_step: input.aiNextStep || '', mentor_confirmed: true, created_at: now }))
      serviceRecordCreated = true
    const directUpdates = [
      input.coreNeed && input.coreNeed !== customer.need ? { field: 'current_core_issue', value: input.coreNeed, source: 'MENTOR_CONFIRMED', confidence: 1, confirmed: true } : null,
      input.paid !== customer.paid ? { field: 'paid', value: input.paid, source: 'MENTOR_CONFIRMED', confidence: 1, confirmed: true } : null,
      input.grade !== customer.grade ? { field: 'grade', value: input.grade, source: 'MENTOR_CONFIRMED', confidence: 1, confirmed: true } : null,
      input.intendedCourse !== customer.intendedCourse ? { field: 'intended_course', value: input.intendedCourse, source: 'MENTOR_CONFIRMED', confidence: 1, confirmed: true } : null,
    ].filter(Boolean)
    if (profileUpdates.length || directUpdates.length) await persistCustomerProfile(database, appointment.customerId, [...profileUpdates, ...directUpdates], serviceRecordId, actorId)
    await updateRecord(config.feishu.tables.appointments, appointment._recordId, mapFields('appointments', { followup_info_completed: true, status: 'COMPLETED', completed_at: now }))
    const customerRow = database._rows.customers.find((row) => text(get('customers', row.fields, 'customer_id')) === appointment.customerId)
    if (customerRow) await updateRecord(config.feishu.tables.customers, customerRow.record_id, mapFields('customers', { current_issue: input.coreNeed, is_paid: input.paid, sabc: input.grade, intended_course: input.intendedCourse || '', notes: input.notes, current_core_issue: input.coreNeed }))
      return scope(await this.load(), actorId)
    } catch (error) {
      if (serviceRecordCreated) Object.assign(error, { code: 'PARTIAL_WRITE', status: 500 })
      throw error
    }
  }

  async createAppointment(input) {
    let customerId = input.customerId
    const database = await this.load()
    if (!database.customers.some((item) => item.id === customerId)) {
      const normalized = validateManualCustomer({ nickname: input.nickname, phone: input.phone, wechat: input.wechat, situation: input.customerSituation || input.description })
      customerId = `CUS-${Date.now()}`
      await createRecord(config.feishu.tables.customers, mapFields('customers', { customer_id: customerId, nickname: normalized.nickname, phone: normalized.phone, wechat: normalized.wechat, source: '解忧小屋', notes: normalized.situation, created_at: input.createdAt || now(), sabc: 'C', is_paid: false, profile_schema_version: 'v0.5' }))
    }
    await createRecord(config.feishu.tables.appointments, mapFields('appointments', { appointment_id: input.requestId || `A-${Date.now()}`, customer_id: customerId, current_issue_description: input.description, expectation: input.expectation, submitted_at: input.submittedAt || new Date().toISOString(), status: 'WAIT_ASSIGN', assigned_mentor_id: '', followup_handled: false, followup_info_completed: false, created_at: input.createdAt || new Date().toISOString(), case_source: input.caseSource || input.source || 'JIEYOU_APPOINTMENT' }))
    return this.load()
  }

  async teamSnapshot(actorId, statusFilter = '') {
    const database = await this.dashboard(actorId)
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('无权查看团队数据')
    const all = await this.load()
    return all.staff.filter((item) => item.permissionRole === 'MENTOR' && (!statusFilter || item.status === statusFilter)).map((mentor) => ({ mentor, customerCount: all.customers.filter((item) => item.mentorId === mentor.id).length, waitFollowUp: all.appointments.filter((item) => item.assignedMentorId === mentor.id && item.status === 'WAIT_FOLLOW_UP').length, waitFeedback: all.appointments.filter((item) => item.assignedMentorId === mentor.id && item.status === 'WAIT_FEEDBACK').length, completed: all.appointments.filter((item) => item.assignedMentorId === mentor.id && item.status === 'COMPLETED').length }))
  }

  async dashboardSnapshot(actorId) {
    const database = await this.dashboard(actorId)
    if (database.staff.find((item) => item.id === actorId)?.permissionRole !== 'ADMIN' || database.staff.find((item) => item.id === actorId)?.loginEnabled !== true) throw new Error('无权查看数据看板')
    const all = await this.load()
    const appointments = all.appointments
    const statusCounts = Object.fromEntries(['WAIT_ASSIGN', 'WAIT_FOLLOW_UP', 'WAIT_FEEDBACK', 'COMPLETED'].map((status) => [status, appointments.filter((item) => item.status === status).length]))
    const currentMonth = new Date()
    const monthKeys = Array.from({ length: 3 }, (_, index) => {
      const month = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - (2 - index), 1))
      return month.toISOString().slice(0, 7)
    })
    const customerTrend = monthKeys.map((monthKey) => ({ label: monthKey.slice(5), value: all.customers.filter((item) => item.createdAt.startsWith(monthKey)).length }))
    const currentMonthKey = monthKeys[2]
    return { customerCount: all.customers.length, monthNewCustomers: all.customers.filter((item) => item.createdAt.startsWith(currentMonthKey)).length, monthAppointments: appointments.filter((item) => item.createdAt.startsWith(currentMonthKey)).length, monthCompleted: appointments.filter((item) => item.completedAt?.startsWith(currentMonthKey)).length, paidCustomers: all.customers.filter((item) => item.paid).length, mentorCount: all.staff.filter((item) => item.permissionRole === 'MENTOR').length, statusCounts, customerTrend, mentorLoad: all.staff.filter((item) => item.permissionRole === 'MENTOR').map((mentor) => ({ name: mentor.name, count: all.customers.filter((item) => item.mentorId === mentor.id).length })) }
  }
}
