import { config } from './config.mjs'
import { createRecord, deleteRecord, getRecord, listRecords, searchRecords, buildSearchExactFilter, updateRecord, FeishuUnavailableError } from './feishu.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { classifyDialogue, createCustomerIntelligence, createCustomerUnderstanding, createCustomerSalesUnderstanding, createEvidenceCandidates, createProfileDraft, createSafetySignalCandidates } from './deepseek.mjs'
import { queryAssistant } from './assistant.mjs'
import { field as mapField, fields as mapFields, read as readField } from './field-mapping.mjs'
import { parseDateFromFeishu, serializeDateForFeishu } from './date-contract.mjs'
import crypto from 'node:crypto'
import { LoginRateLimiter } from './login-rate-limit.mjs'
import { contactRequired, normalizePhone as foundationNormalizePhone, normalizeWechat, provenance, resolveCustomerIdentity, validateCustomerContactField, validateCustomerContacts } from '../shared/customer-foundation.mjs'
import { customerHistoryPolicy } from './schema-contract.mjs'
import { AuthCredentialStoreNotConfiguredError, FeishuAuthCredentialRepository, PASSWORD_POLICY_CODES, dummyPasswordHash, generateInitialPassword, hashPassword, validatePassword, verifyPassword } from './password-auth.mjs'
import { documentFileRef, extractDocument, parseDocumentFileRef } from './document-extractor.mjs'
import { CHANGE_TYPES, CONFLICT_RESOLUTIONS, CONFLICT_STATUSES, CONFLICT_TYPES, EVIDENCE_REVIEW_STATUSES, EVIDENCE_TYPES, PROPOSAL_ACTIONS, SEMANTIC_KINDS, SOURCE_STATUSES, SOURCE_TYPES, classifyEvidenceChange, conflictId, contentHash, dedupeEvidence, evidenceEquivalent, evidenceLogicalKey, normalizeEvidenceCandidate, normalizeText, proposalId, stableId, chunkText, sourcePerspectiveFromRole } from '../shared/evidence-contract.mjs'
import { isSnapshotEvidence, materializeCustomerProfile, shouldAutoConfirmEvidence, summaryInputFingerprint } from '../shared/profile-materialization.mjs'
import { buildCustomerUnderstandingContext, createLocalCustomerUnderstanding, CUSTOMER_UNDERSTANDING_PROMPT_VERSION, CUSTOMER_UNDERSTANDING_VERSION, qualityCheckCustomerUnderstanding, understandingInputFingerprint } from '../shared/customer-understanding.mjs'
import { AUTO_RECOVERY_CIRCUIT_MAX_PER_DAY, AUTO_RETRY_CAP_REACHED, finalizeAutoProcessingFailureCode, hasReachedAutoRetryCap, isNonRetryableAutoProcessingError, isStaleProcessing, processingErrorCode, shouldAutoRecoverSource } from '../shared/processing-contract.mjs'
import { buildBasicDashboard } from './basic-dashboard.mjs'
import { boundedReadAfterWrite, READ_AFTER_WRITE_DELAYS_MS, RECENT_WRITE_WINDOW_MS } from './read-after-write.mjs'
import { buildCustomerSafetyContext, buildSafetyAssessment } from './safety.mjs'
import { SAFETY_ASSESSMENT_VERSION, SAFETY_PROMPT_VERSION, buildSafetyFailureMeta, resolveSafetyStatus } from '../shared/safety-contract.mjs'
import { applyAbilityEvidenceGate, applyWillingnessEvidenceGate, buildCustomerSalesContext, createLocalCustomerSalesUnderstanding, CUSTOMER_SALES_UNDERSTANDING_PROMPT_VERSION, CUSTOMER_SALES_UNDERSTANDING_VERSION, historicalSalesRecords, normalizeCustomerSalesUnderstanding, qualityCheckCustomerSalesUnderstanding } from '../shared/customer-sales-understanding.mjs'
import { CustomerWriteQueue } from './customer-write-queue.mjs'
import { processingErrorMessage } from '../shared/source-processing-state.mjs'
import { normalizeCanonicalFact } from '../shared/canonical-profile-facts.mjs'
import { applyServiceNecessityOverride, buildConsultationContext, buildSalesContext, classifyPrivacyText, combinePrivacyContext, privacySafeText, resolvePrivacyPolicy, SERVICE_NECESSITY_LEVELS } from '../shared/privacy-guard.mjs'
import { createDialogueAnalysisToken, finalizeDialogueConfirmation, normalizeDialogueAssessment, parseDialogueContext, serializeDialogueContext, stripDialogueContext, verifyDialogueConfirmation } from '../shared/dialogue-gate.mjs'

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
const CUSTOMER_MUTATION_STATE_LIMIT = 20
const CUSTOMER_MUTATION_STATUSES = new Set(['PROCESSING', 'PERSISTED', 'COMMITTED', 'UNKNOWN', 'FAILED'])
const canonicalMutationValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalMutationValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalMutationValue(value[key])]))
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}
const normalizeMutationProfileUpdates = (updates) => {
  if (!Array.isArray(updates)) return []
  const allowedFields = new Set([...PROFILE_FIELD_KEYS, 'grade', 'paid', 'mentor_id', 'current_mentor_id', 'intended_course'])
  const normalized = updates
    .filter((item) => item && typeof item.field === 'string' && allowedFields.has(item.field))
    .map((item) => {
      const rawConfidence = Number(item.confidence ?? 0.9)
      return {
        field: item.field === 'mentor_id' ? 'current_mentor_id' : item.field,
        value: canonicalMutationValue(jsonValue(item.value)),
        source: text(item.source).trim(),
        confidence: Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : null,
      }
    })
    .filter((item) => item.value !== null)
  // Distinct fields are order-independent in the save contract. Duplicate fields
  // remain ordered because the server applies the last value for that field.
  const hasDuplicateField = new Set(normalized.map((item) => item.field)).size !== normalized.length
  return hasDuplicateField ? normalized : normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
const normalizeMutationEnrollments = (enrollments) => {
  if (!Array.isArray(enrollments)) return { provided: false, items: [] }
  const effective = new Map()
  for (const item of enrollments) {
    const productId = text(item?.productId)
    if (!productId) continue
    effective.set(productId, {
      productId,
      paymentStatus: item?.paymentStatus ?? null,
      amount: item?.amount ?? null,
      enrolledAt: item?.enrolledAt ?? null,
      paidAt: item?.paidAt ?? null,
    })
  }
  return { provided: true, items: [...effective.values()].sort((a, b) => a.productId.localeCompare(b.productId)).map(canonicalMutationValue) }
}
export const mutationPayloadHash = (input = {}) => crypto.createHash('sha256').update(JSON.stringify(canonicalMutationValue({
  nickname: text(input.nickname).trim(),
  phone: normalizePhone(input.phone),
  wechat: normalizeWechat(input.wechat),
  introducer: text(input.introducer).trim(),
  situation: text(input.situation).trim(),
  mentorId: input.mentorId === null || input.mentorId === undefined ? null : text(input.mentorId).trim(),
  source: text(input.source).trim(),
  confirmedNotSame: Boolean(input.confirmedNotSame),
  enrollments: normalizeMutationEnrollments(input.enrollments),
  profileUpdates: normalizeMutationProfileUpdates(input.profileUpdates),
}))).digest('hex')
export const customerResultFingerprint = (customerRecord) => crypto.createHash('sha256').update(JSON.stringify({
  id: customerRecord?.id || '',
  name: customerRecord?.name || '',
  phone: customerRecord?.phone || '',
  wechat: customerRecord?.wechat || '',
  notes: customerRecord?.notes || '',
  need: customerRecord?.need || '',
  helpExpectation: customerRecord?.helpExpectation || '',
  goal: customerRecord?.goal || '',
  profileFields: customerRecord?.profileFields || {},
  profileFieldMeta: customerRecord?.profileFieldMeta || {},
  profileVersion: customerRecord?.profileVersion || 0,
  profileUpdatedAt: customerRecord?.profileUpdatedAt || null,
})).digest('hex')
export const sanitizeMutationStates = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value).filter(([operationId, state]) => operationId && state && typeof state === 'object' && !Array.isArray(state) && typeof state.customerId === 'string' && CUSTOMER_MUTATION_STATUSES.has(state.status)).map(([operationId, state]) => [operationId, {
    operationId,
    kind: state.kind === 'CREATE' ? 'CREATE' : 'UPDATE',
    customerId: state.customerId,
    status: state.status,
    payloadHash: typeof state.payloadHash === 'string' ? state.payloadHash : '',
    resultFingerprint: typeof state.resultFingerprint === 'string' ? state.resultFingerprint : '',
    enrollmentStatus: state.enrollmentStatus === 'PENDING' ? 'PENDING' : 'COMPLETED',
    enrollmentDrafts: Array.isArray(state.enrollmentDrafts) ? normalizeMutationEnrollments(state.enrollmentDrafts).items : [],
    enrollmentErrorCode: typeof state.enrollmentErrorCode === 'string' ? state.enrollmentErrorCode : '',
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
  }])
  const pending = entries.filter(([, state]) => state.status !== 'COMMITTED')
  const committed = entries.filter(([, state]) => state.status === 'COMMITTED').slice(-CUSTOMER_MUTATION_STATE_LIMIT)
  return Object.fromEntries([...pending, ...committed])
}
const publicMutationState = (state) => state ? { operationId: state.operationId, customerId: state.customerId, kind: state.kind, status: state.status, enrollmentStatus: state.enrollmentStatus || 'COMPLETED', updatedAt: state.updatedAt || null } : null
const incompleteMutationError = (state) => Object.assign(new Error('该保存操作尚未完成，请查询原操作状态后再继续。'), { code: 'CUSTOMER_SAVE_INCOMPLETE', status: 409, mutationStatus: state?.status || 'UNKNOWN' })
const confirmedMutationFailureError = () => Object.assign(new Error('客户保存已确认失败，不能自动重放原操作。'), { code: 'CUSTOMER_SAVE_CONFIRMED_FAILED', status: 409 })
const mentorCreateLocks = new Map()
const AUTO_PROFILE_SOURCE_PREFIX = 'AUTO_PROFILE_ORGANIZE:'
const publicSource = (source, { includeRaw = false } = {}) => {
  const { rawText, _recordId, processingError, ...safe } = source || {}
  return { ...safe, notes: stripDialogueContext(safe.notes), ...(includeRaw ? { rawText: rawText || '' } : {}), processingError: processingErrorMessage(processingError) || null }
}
const cloneDatabase = (database) => typeof structuredClone === 'function' ? structuredClone(database) : JSON.parse(JSON.stringify(database))
const scopedReadStore = new AsyncLocalStorage()
const emptyScopedRows = () => ({ appointments: [], customers: [], services: [], staff: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [] })
const emptyDatabaseShape = () => ({
  staff: [], customers: [], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [],
  sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
  _allEvidenceItems: [], _rows: emptyScopedRows(), _scoped: true, _scopedTableCount: 0, _scopedDurationMs: 0,
})
function projectCustomerDatabase(database, customerId) {
  const id = text(customerId)
  const customers = (database.customers || []).filter((item) => item.id === id)
  const sourceRecords = (database.sourceRecords || []).filter((item) => item.customerId === id)
  const evidenceItems = (database.evidenceItems || []).filter((item) => item.customerId === id)
  const allEvidenceItems = (database._allEvidenceItems || database.evidenceItems || []).filter((item) => item.customerId === id)
  const profileUpdateProposals = (database.profileUpdateProposals || []).filter((item) => item.customerId === id)
  const evidenceConflicts = (database.evidenceConflicts || []).filter((item) => item.customerId === id)
  const appointments = (database.appointments || []).filter((item) => item.customerId === id)
  const sessions = (database.sessions || []).filter((item) => item.customerId === id)
  const enrollments = (database.enrollments || []).filter((item) => item.customerId === id)
  const profileChanges = (database.profileChanges || []).filter((item) => item.customerId === id)
  const customerRecordIds = new Set(customers.map((item) => item._recordId).filter(Boolean))
  const sourceIds = new Set(sourceRecords.map((item) => item.id))
  const rows = database._rows || {}
  const filterRows = (list, predicate) => (list || []).filter(predicate)
  return {
    staff: database.staff || [],
    customers,
    appointments,
    sessions,
    followups: [],
    products: database.products || [],
    enrollments,
    profileChanges,
    sourceRecords,
    evidenceItems,
    profileUpdateProposals,
    evidenceConflicts,
    _allEvidenceItems: allEvidenceItems,
    _missingRepositories: database._missingRepositories || [],
    _scoped: true,
    _scopedCustomerId: id,
    _dataFreshness: database._dataFreshness,
    _persistenceStatus: database._persistenceStatus,
    _rows: {
      appointments: filterRows(rows.appointments, (row) => text(get('appointments', row.fields, 'customer_id')) === id),
      customers: filterRows(rows.customers, (row) => customerRecordIds.has(row.record_id) || text(get('customers', row.fields, 'customer_id')) === id),
      services: filterRows(rows.services, (row) => text(get('serviceRecords', row.fields, 'customer_id')) === id),
      staff: rows.staff || [],
      products: rows.products || [],
      enrollments: filterRows(rows.enrollments, (row) => text(get('enrollments', row.fields, 'customer_id')) === id),
      profileChanges: filterRows(rows.profileChanges, (row) => text(get('profileChanges', row.fields, 'customer_id')) === id),
      sourceRecords: filterRows(rows.sourceRecords, (row) => text(get('sourceRecords', row.fields, 'customer_id')) === id || sourceIds.has(text(get('sourceRecords', row.fields, 'source_id')))),
      evidenceItems: filterRows(rows.evidenceItems, (row) => text(get('evidenceItems', row.fields, 'customer_id')) === id),
      profileUpdateProposals: filterRows(rows.profileUpdateProposals, (row) => text(get('profileUpdateProposals', row.fields, 'customer_id')) === id),
      evidenceConflicts: filterRows(rows.evidenceConflicts, (row) => text(get('evidenceConflicts', row.fields, 'customer_id')) === id),
    },
  }
}

const pickDefined = (item, keys) => Object.fromEntries(keys.filter((key) => item?.[key] !== undefined).map((key) => [key, item[key]]))
const publicStaff = (item) => pickDefined(item, ['id', 'name', 'role', 'permissionRole', 'status', 'loginEnabled', 'displayRole', 'title', 'specialty', 'avatar'])
const publicCustomerDirectory = (item) => ({ ...pickDefined(item, ['id', 'name', 'initials', 'phone', 'wechat', 'source', 'status', 'grade', 'gradeSource', 'mentorId', 'referrerName', 'introducer', 'need', 'helpExpectation', 'goal', 'intendedCourse', 'paid', 'notes', 'createdAt', 'createdByStaffId', 'createdByName', 'profileUpdatedAt']), profileMaterialization: { coverage: item?.profileMaterialization?.coverage || materializeCustomerProfile({ customer: item, evidenceItems: [] }).coverage } })
const publicCustomerDetail = (item) => ({ ...publicCustomerDirectory(item), profileFields: item?.profileFields || {}, profileFieldMeta: item?.profileFieldMeta || {}, profileSchemaVersion: item?.profileSchemaVersion, profileVersion: item?.profileVersion, brief: item?.brief || '' })
const publicCustomerProfile = (item, profileMaterialization, autoOrganizeStatus) => ({
  customerId: item.id,
  profileFields: item?.profileFields || {},
  profileFieldMeta: item?.profileFieldMeta || {},
  profileUpdatedAt: item?.profileUpdatedAt || null,
  profileSchemaVersion: item?.profileSchemaVersion,
  profileVersion: item?.profileVersion,
  profileMaterialization,
  autoOrganizeStatus,
})
const publicProduct = (item) => pickDefined(item, ['id', 'name', 'system', 'audience', 'cycle', 'format', 'status', 'active', 'summary', 'fit'])
const publicEnrollment = (item) => pickDefined(item, ['id', 'customerId', 'productId', 'paid', 'amount', 'date', 'status', 'paymentStatus', 'enrollmentSource', 'enrolledAt', 'paidAt', 'operatorId'])
const publicAppointment = (item) => pickDefined(item, ['id', 'customerId', 'topic', 'submittedAt', 'description', 'expectation', 'status', 'mentorId', 'assignedMentorId', 'followupHandled', 'followupInfoCompleted', 'createdAt', 'completedAt', 'source', 'caseSource'])
const publicSession = (item) => pickDefined(item, ['id', 'customerId', 'mentorId', 'operatorId', 'type', 'date', 'duration', 'topic', 'note', 'result', 'nextStep', 'followupDate', 'aiSummary', 'profileText', 'profileUpdates'])
const publicProfileChange = (item) => pickDefined(item, ['id', 'customerId', 'field', 'fieldName', 'oldValue', 'newValue', 'source', 'confidence', 'confirmed', 'updatedAt', 'operatorId', 'serviceRecordId', 'sourceRecordId', 'evidenceId', 'updateBatchId'])
function publicDirectoryDto(database) {
  return {
    staff: database.staff.map(publicStaff),
    customers: database.customers.map(publicCustomerDirectory),
    appointments: [], sessions: [], followups: [],
    products: database.products.map(publicProduct),
    enrollments: database.enrollments.map(publicEnrollment),
    profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
  }
}
function publicCustomerDetailDto(database) {
  return {
    staff: database.staff.map(publicStaff),
    customers: database.customers.map(publicCustomerDetail),
    appointments: database.appointments.map(publicAppointment),
    sessions: database.sessions.map(publicSession), followups: [],
    products: database.products.map(publicProduct),
    enrollments: database.enrollments.map(publicEnrollment),
    profileChanges: database.profileChanges.map(publicProfileChange),
    sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
  }
}
export function publicCustomerMutationDto(database, actorId, customerId, customerCreated = false, operationId = '') {
  const visible = scope(database, actorId)
  const customerRecord = visible.customers.find((item) => item.id === customerId)
  if (!customerRecord) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
  const mutation = operationId ? publicMutationState(customerRecord.mutationStates?.[operationId]) : null
  const persistenceStatus = mutation?.status === 'PERSISTED' ? 'PERSISTED' : database._persistenceStatus || 'COMMITTED'
  return {
    customer: publicCustomerDetail(customerRecord),
    enrollments: visible.enrollments.filter((item) => item.customerId === customerId).map(publicEnrollment),
    profileChanges: visible.profileChanges.filter((item) => item.customerId === customerId).map(publicProfileChange),
    createdCustomerId: customerId,
    customerCreated,
    persistenceStatus,
    enrollmentStatus: mutation?.enrollmentStatus || 'COMPLETED',
    ...(mutation ? { mutation } : {}),
  }
}
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

export function classifyStructuredArchivingOutcome({
  validEvidenceCount = 0,
  mappedEvidenceCount = 0,
  mappedNoChangeCount = 0,
  physicalFieldWriteCount = 0,
  unresolvedMappedEvidenceCount = 0,
  derivedErrorCount = 0,
  hasOpenConflict = false,
} = {}) {
  if (hasOpenConflict) return { status: 'REVIEW_REQUIRED', outcome: 'REVIEW_REQUIRED', errorCode: 'OPEN_EVIDENCE_CONFLICT' }
  if (derivedErrorCount > 0) return { status: 'REVIEW_REQUIRED', outcome: 'PARTIAL', errorCode: 'DERIVED_WRITE_FAILED' }
  if (unresolvedMappedEvidenceCount > 0) return { status: 'REVIEW_REQUIRED', outcome: 'PARTIAL', errorCode: 'STRUCTURED_ARCHIVE_PARTIAL' }
  if (physicalFieldWriteCount > 0) return { status: 'COMPLETED', outcome: 'EFFECTIVE', errorCode: '' }
  if (mappedEvidenceCount > 0 && mappedNoChangeCount === mappedEvidenceCount) return { status: 'COMPLETED', outcome: 'NO_NEW_FACTS', errorCode: '' }
  if (validEvidenceCount === 0) return { status: 'REVIEW_REQUIRED', outcome: 'NO_ARCHIVABLE_FACTS', errorCode: 'NO_ARCHIVABLE_FACTS' }
  return { status: 'REVIEW_REQUIRED', outcome: 'PARTIAL', errorCode: 'STRUCTURED_ARCHIVE_PARTIAL' }
}

function appointment(row) {
  const f = row.fields || {}
  const rawStatus = text(get('appointments', f, 'status'))
  const status = statusMap[rawStatus] || rawStatus || statusMap[text(get('appointments', f, 'display_status'))] || 'WAIT_ASSIGN'
  const caseSource = text(get('appointments', f, 'case_source')) || 'JIEYOU_APPOINTMENT'
  return { id: text(get('appointments', f, 'appointment_id')) || row.record_id, customerId: text(get('appointments', f, 'customer_id')), topic: text(get('appointments', f, 'expectation')) || '首次沟通', submittedAt: date(get('appointments', f, 'submitted_at')), description: text(get('appointments', f, 'current_issue_description')), expectation: text(get('appointments', f, 'expectation')), status, mentorId: text(get('appointments', f, 'assigned_mentor_id')) || null, assignedMentorId: text(get('appointments', f, 'assigned_mentor_id')) || null, followupHandled: boolean(get('appointments', f, 'followup_handled')), followupInfoCompleted: boolean(get('appointments', f, 'followup_info_completed')), createdAt: date(get('appointments', f, 'created_at')) || date(get('appointments', f, 'submitted_at')), completedAt: date(get('appointments', f, 'completed_at')) || null, source: caseSource, caseSource, _recordId: row.record_id }
}

function parseSupplementaryField(value) {
  try {
    const parsed = JSON.parse(text(value) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object' && text(item.text)) : []
  } catch {
    return []
  }
}

function serializeSupplementaryField(items) {
  return JSON.stringify((Array.isArray(items) ? items : []).filter((item) => item && text(item.text)).map((item) => ({ id: item.id || '', text: text(item.text), source: item.source || 'AI_EXTRACTED', confirmed: item.confirmed === true, status: item.status || 'PENDING_REVIEW', confidence: item.confidence ?? null, sourceRecordId: item.sourceRecordId || '', evidenceId: item.evidenceId || '', updatedAt: item.updatedAt || '', operatorId: item.operatorId || '' })))
}

function mergeSupplementaryItems(fieldItems, metaItems) {
  const byId = new Map((Array.isArray(metaItems) ? metaItems : []).map((item) => [text(item.id), item]))
  const source = Array.isArray(fieldItems) && fieldItems.length ? fieldItems : (Array.isArray(metaItems) ? metaItems : [])
  return source.map((item) => ({ ...(byId.get(text(item.id)) || {}), ...item, text: text(item.text) })).filter((item) => item.text)
}

function customer(row) {
  const f = row.fields || {}
  const name = text(get('customers', f, 'nickname')) || '未命名客户'
  let profileFieldMeta = {}
  let profileVersion = 0
  let aiSummaryMeta = null
  let understandingMeta = null
  let salesUnderstandingMeta = null
  let safetyMeta = null
  let supplementaryItems = []
  let automaticProfilePending = null
  let mutationStates = {}
  try {
    const storedMeta = JSON.parse(text(get('customers', f, 'profile_field_meta_json')) || '{}')
    profileVersion = Number(storedMeta._profile_version || 0)
    profileFieldMeta = storedMeta._fields || Object.fromEntries(Object.entries(storedMeta).filter(([key]) => !key.startsWith('_')))
    aiSummaryMeta = storedMeta._ai_summary && typeof storedMeta._ai_summary === 'object' ? storedMeta._ai_summary : null
    understandingMeta = storedMeta._understanding && typeof storedMeta._understanding === 'object' ? storedMeta._understanding : null
    salesUnderstandingMeta = storedMeta._sales_understanding && typeof storedMeta._sales_understanding === 'object' ? storedMeta._sales_understanding : null
    safetyMeta = storedMeta._safety && typeof storedMeta._safety === 'object' ? storedMeta._safety : null
    supplementaryItems = mergeSupplementaryItems(parseSupplementaryField(get('customers', f, 'supplementary_info')), storedMeta._supplementary_items)
    automaticProfilePending = storedMeta._automatic_profile_pending && typeof storedMeta._automatic_profile_pending === 'object' ? storedMeta._automatic_profile_pending : null
    mutationStates = sanitizeMutationStates(storedMeta._mutation_states)
  } catch { profileFieldMeta = {} }
  const aiSummary = parsedJson(get('customers', f, 'ai_customer_summary'), aiSummaryMeta?.summary || null)
  const understanding = understandingMeta?.payload && typeof understandingMeta.payload === 'object' ? understandingMeta.payload : null
  const salesUnderstanding = salesUnderstandingMeta?.payload && typeof salesUnderstandingMeta.payload === 'object' ? salesUnderstandingMeta.payload : null
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
  const referrerName = text(get('customers', f, 'referrer_name'))
  return { id: text(get('customers', f, 'customer_id')) || row.record_id, createdAt: date(get('customers', f, 'created_at')) || date(get('customers', f, 'submitted_at')), createdByStaffId: text(get('customers', f, 'created_by_staff_id')) || undefined, createdByName: text(get('customers', f, 'created_by_name')) || undefined, name, initials: name.slice(0, 1), phone: normalizePhone(get('customers', f, 'phone')), wechat: text(get('customers', f, 'wechat')), source: text(get('customers', f, 'source')) || '历史数据导入', status: '活跃', grade: text(get('customers', f, 'sabc')) || 'C', gradeSource: '导师确认', mentorId: text(get('customers', f, 'current_mentor_id')) || null, referrerName, introducer: referrerName, need: text(get('customers', f, 'current_issue')), helpExpectation: text(get('customers', f, 'help_expectation')), goal: text(get('customers', f, 'current_goal')), brief: text(get('customers', f, 'brief')), aiSummary: aiSummary && typeof aiSummary === 'object' ? aiSummary : undefined, aiSummaryStatus: aiSummaryMeta?.status, aiSummaryMeta, understanding: understanding && typeof understanding === 'object' ? understanding : undefined, understandingStatus: understandingMeta?.status, understandingMeta, salesUnderstanding: salesUnderstanding && typeof salesUnderstanding === 'object' ? salesUnderstanding : undefined, salesUnderstandingStatus: salesUnderstandingMeta?.status, salesUnderstandingMeta, safety: safetyMeta?.payload && typeof safetyMeta.payload === 'object' ? safetyMeta.payload : undefined, safetyStatus: safetyMeta?.status, safetyMeta, intendedCourse: text(get('customers', f, 'intended_course')) || null, confirmedFacts: [], aiQuestions: [], paid: boolean(get('customers', f, 'is_paid')), lastActivity: '', nextFollowup: null, lastFollowupAt: null, nextFollowupAt: null, followupStatus: '待跟进', notes: text(get('customers', f, 'notes')), profileFields, profileFieldMeta, supplementaryItems, automaticProfilePending, profileUpdatedAt: date(get('customers', f, 'profile_updated_at')) || null, profileSchemaVersion: text(get('customers', f, 'profile_schema_version')) || CUSTOMER_PROFILE_SCHEMA_VERSION, profileVersion, mutationStates, _recordId: row.record_id }
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
  const loginEnabled = permissionRole === 'ADMIN' ? rawLoginEnabled === '' || rawLoginEnabled === undefined || rawLoginEnabled === null ? true : boolean(rawLoginEnabled) : boolean(rawLoginEnabled)
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
  const source = ['STRUCTURED_INPUT', 'USER_EXPLICIT', 'ADMIN_CONFIRMED', 'MENTOR_FACTUAL_INPUT', 'MENTOR_CONFIRMED', 'MENTOR_OBSERVATION', 'AI_EXTRACTED_CONFIRMED', 'AI_INFERENCE', 'IMPORTED_HISTORY', 'LEGACY_MIGRATION', 'MANUAL'].includes(text(get('profileChanges', f, 'source'))) ? text(get('profileChanges', f, 'source')) : 'MENTOR_OBSERVATION'
  return { id: text(get('profileChanges', f, 'change_id')) || row.record_id, customerId: text(get('profileChanges', f, 'customer_id')), field: text(get('profileChanges', f, 'field_key')) || text(get('profileChanges', f, 'field')), fieldName: text(get('profileChanges', f, 'field_name')) || text(get('profileChanges', f, 'field_key')) || text(get('profileChanges', f, 'field')), oldValue, newValue, source, confidence: Number(get('profileChanges', f, 'confidence') ?? 0.9), confirmed: boolean(get('profileChanges', f, 'confirmed')), updatedAt: date(get('profileChanges', f, 'changed_at')) || date(get('profileChanges', f, 'updated_at')), operatorId: text(get('profileChanges', f, 'operator_id')) || undefined, serviceRecordId: text(get('profileChanges', f, 'service_record_id')) || undefined, sourceRecordId: text(get('profileChanges', f, 'source_record_id')) || undefined, evidenceId: text(get('profileChanges', f, 'evidence_id')) || undefined, updateBatchId: text(get('profileChanges', f, 'update_batch_id')) || undefined, _recordId: row.record_id }
}

function parsedJson(value, fallback = null) { try { return JSON.parse(text(value) || '') } catch { return fallback } }
function sourceRecord(row) {
  const f = row.fields || {}
  const sourceRole = text(get('sourceRecords', f, 'source_role')) || 'UNKNOWN'
  const privacyMeta = parsedJson(get('sourceRecords', f, 'privacy_meta_json'), {})
  const serviceNecessity = privacyMeta.serviceNecessity || (text(get('sourceRecords', f, 'privacy_level')) === 'HIGH_SENSITIVE' ? 'RELEVANT' : '')
  return { id: text(get('sourceRecords', f, 'source_id')) || row.record_id, subjectType: text(get('sourceRecords', f, 'subject_type')) || 'PERSON', subjectId: text(get('sourceRecords', f, 'subject_id')), customerId: text(get('sourceRecords', f, 'customer_id')), sourceType: text(get('sourceRecords', f, 'source_type')), title: text(get('sourceRecords', f, 'title')), rawText: text(get('sourceRecords', f, 'raw_text')), fileRef: text(get('sourceRecords', f, 'file_ref')), occurredAt: date(get('sourceRecords', f, 'occurred_at')) || null, uploadedAt: date(get('sourceRecords', f, 'uploaded_at')) || null, uploadedBy: text(get('sourceRecords', f, 'uploaded_by')), sourceRole, sourcePerspective: sourcePerspectiveFromRole(sourceRole), serviceRecordId: text(get('sourceRecords', f, 'service_record_id')), contentHash: text(get('sourceRecords', f, 'content_hash')), processingStatus: text(get('sourceRecords', f, 'processing_status')) || 'UPLOADED', processingVersion: Number(get('sourceRecords', f, 'processing_version') || 1), sensitivityLevel: text(get('sourceRecords', f, 'sensitivity_level')) || 'HIGH', privacyLevel: text(get('sourceRecords', f, 'privacy_level')) || 'NORMAL', privacyStatus: text(get('sourceRecords', f, 'privacy_status')) || 'READY', privacyMeta, serviceNecessity, serviceNecessityReason: privacyMeta.serviceNecessityReason || '', temporalType: privacyMeta.temporalType || 'UNKNOWN', mentorSafeSummary: text(get('sourceRecords', f, 'mentor_safe_summary')) || privacyMeta.mentorSafeSummary || '', mentorServiceDetail: privacyMeta.mentorServiceDetail || '', necessaryExcerpt: privacyMeta.necessaryExcerpt || '', salesSafeSummary: privacyMeta.salesSafeSummary || '', notes: text(get('sourceRecords', f, 'notes')), sourceVersion: Number(get('sourceRecords', f, 'source_version') || 1), extractorVersion: text(get('sourceRecords', f, 'extractor_version')), lastBatchId: text(get('sourceRecords', f, 'last_batch_id')), processingStartedAt: date(get('sourceRecords', f, 'processing_started_at')) || null, lastProcessingAt: date(get('sourceRecords', f, 'last_processing_at')) || null, processingError: text(get('sourceRecords', f, 'processing_error')) || null, createdAt: date(get('sourceRecords', f, 'created_at')) || null, updatedAt: date(get('sourceRecords', f, 'updated_at')) || null, _recordId: row.record_id }
}
function evidenceItem(row) {
  const f = row.fields || {}
  const privacyMeta = parsedJson(get('evidenceItems', f, 'privacy_meta_json'), {})
  const serviceNecessity = privacyMeta.serviceNecessity || (text(get('evidenceItems', f, 'privacy_level')) === 'HIGH_SENSITIVE' ? 'RELEVANT' : '')
  const contentSource = text(get('evidenceItems', f, 'content_source')) || undefined
  const informationNature = text(get('evidenceItems', f, 'information_nature')) || undefined
  const verificationStatus = text(get('evidenceItems', f, 'verification_status')) || undefined
  return { id: text(get('evidenceItems', f, 'evidence_id')) || row.record_id, subjectType: text(get('evidenceItems', f, 'subject_type')) || 'PERSON', subjectId: text(get('evidenceItems', f, 'subject_id')), customerId: text(get('evidenceItems', f, 'customer_id')), sourceId: text(get('evidenceItems', f, 'source_id')), evidenceType: text(get('evidenceItems', f, 'evidence_type')), semanticKind: text(get('evidenceItems', f, 'semantic_kind')), fieldKey: text(get('evidenceItems', f, 'field_key')), standardValue: parsedJson(get('evidenceItems', f, 'standard_value'), text(get('evidenceItems', f, 'standard_value'))), displayText: text(get('evidenceItems', f, 'display_text')), sourceExcerpt: text(get('evidenceItems', f, 'source_excerpt')), locator: parsedJson(get('evidenceItems', f, 'locator_json'), {}), occurredAt: date(get('evidenceItems', f, 'occurred_at')) || null, sourceRole: text(get('evidenceItems', f, 'source_role')), contentSource, informationNature, verificationStatus, provenanceStatus: contentSource || informationNature || verificationStatus ? 'EXPLICIT' : 'LEGACY_MISSING', confidence: Number(get('evidenceItems', f, 'confidence') || 0), reviewStatus: text(get('evidenceItems', f, 'review_status')) || 'PENDING_REVIEW', extractionBatchId: text(get('evidenceItems', f, 'extraction_batch_id')), provider: text(get('evidenceItems', f, 'provider')) || 'DEEPSEEK', model: text(get('evidenceItems', f, 'model')), modelVersion: text(get('evidenceItems', f, 'model_version')), promptVersion: text(get('evidenceItems', f, 'prompt_version')), privacyLevel: text(get('evidenceItems', f, 'privacy_level')) || 'NORMAL', privacyMeta, serviceNecessity, serviceNecessityReason: privacyMeta.serviceNecessityReason || '', temporalType: privacyMeta.temporalType || 'UNKNOWN', mentorSafeText: text(get('evidenceItems', f, 'mentor_safe_text')), mentorServiceDetail: privacyMeta.mentorServiceDetail || '', necessaryExcerpt: privacyMeta.necessaryExcerpt || '', salesSafeSummary: privacyMeta.salesSafeSummary || '', createdAt: date(get('evidenceItems', f, 'created_at')) || null, updatedAt: date(get('evidenceItems', f, 'updated_at')) || null, _recordId: row.record_id }
}
function proposalRecord(row) {
  const f = row.fields || {}
  return { id: text(get('profileUpdateProposals', f, 'proposal_id')) || row.record_id, customerId: text(get('profileUpdateProposals', f, 'customer_id')), subjectId: text(get('profileUpdateProposals', f, 'subject_id')), evidenceId: text(get('profileUpdateProposals', f, 'evidence_id')), sourceId: text(get('profileUpdateProposals', f, 'source_id')), fieldKey: text(get('profileUpdateProposals', f, 'field_key')), fieldName: text(get('profileUpdateProposals', f, 'field_name')), currentValue: parsedJson(get('profileUpdateProposals', f, 'current_value'), text(get('profileUpdateProposals', f, 'current_value'))), proposedValue: parsedJson(get('profileUpdateProposals', f, 'proposed_value'), text(get('profileUpdateProposals', f, 'proposed_value'))), action: text(get('profileUpdateProposals', f, 'action')), changeType: text(get('profileUpdateProposals', f, 'change_type')), reviewStatus: text(get('profileUpdateProposals', f, 'review_status')) || 'PENDING_REVIEW', reason: text(get('profileUpdateProposals', f, 'reason')), confidence: Number(get('profileUpdateProposals', f, 'confidence') || 0), extractionBatchId: text(get('profileUpdateProposals', f, 'extraction_batch_id')), reviewerId: text(get('profileUpdateProposals', f, 'reviewer_id')), reviewedAt: date(get('profileUpdateProposals', f, 'reviewed_at')) || null, createdAt: date(get('profileUpdateProposals', f, 'created_at')) || null, updatedAt: date(get('profileUpdateProposals', f, 'updated_at')) || null, _recordId: row.record_id }
}
function conflictRecord(row) {
  const f = row.fields || {}
  return { id: text(get('evidenceConflicts', f, 'conflict_id')) || row.record_id, subjectId: text(get('evidenceConflicts', f, 'subject_id')), customerId: text(get('evidenceConflicts', f, 'customer_id')), fieldKey: text(get('evidenceConflicts', f, 'field_key')), conflictType: text(get('evidenceConflicts', f, 'conflict_type')), currentValue: parsedJson(get('evidenceConflicts', f, 'current_value'), text(get('evidenceConflicts', f, 'current_value'))), newValue: parsedJson(get('evidenceConflicts', f, 'new_value'), text(get('evidenceConflicts', f, 'new_value'))), currentEvidenceId: text(get('evidenceConflicts', f, 'current_evidence_id')), newEvidenceId: text(get('evidenceConflicts', f, 'new_evidence_id')), status: text(get('evidenceConflicts', f, 'status')) || 'OPEN', suggestedResolution: text(get('evidenceConflicts', f, 'suggested_resolution')), resolution: text(get('evidenceConflicts', f, 'resolution')), reviewerId: text(get('evidenceConflicts', f, 'reviewer_id')), resolvedAt: date(get('evidenceConflicts', f, 'resolved_at')) || null, createdAt: date(get('evidenceConflicts', f, 'created_at')) || null, updatedAt: date(get('evidenceConflicts', f, 'updated_at')) || null, _recordId: row.record_id }
}

function customerBelongsToStaff(customer, staffId) {
  return customer?.mentorId === staffId
}

function assertMentorAssignmentAuthority(database, actorId, updates) {
  const assignment = (Array.isArray(updates) ? updates : []).find((item) => ['mentor_id', 'current_mentor_id'].includes(item?.field))
  if (!assignment) return
  const actor = database.staff.find((item) => item.id === actorId)
  if (actor?.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw Object.assign(new Error('只有 ADMIN 可以重新分配导师'), { code: 'FORBIDDEN', status: 403 })
  const mentorId = text(assignment.value).trim()
  if (mentorId && !database.staff.some((item) => item.id === mentorId && item.permissionRole === 'MENTOR' && item.status === 'ACTIVE')) throw Object.assign(new Error('所选导师不存在或已停用'), { code: 'INVALID_MENTOR_ASSIGNMENT', status: 400 })
}

function mentorVisibleSource(source) {
  const meta = source?.privacyMeta || {}
  const policy = resolvePrivacyPolicy({ privacyLevel: source?.privacyLevel, categories: meta.categories, safetyFlags: meta.safetyFlags, currentRole: 'MENTOR', assertionType: meta.assertionType, verification: meta.verification, serviceNecessity: source?.serviceNecessity || meta.serviceNecessity, serviceNecessityOverride: meta.serviceNecessityOverride, temporalType: source?.temporalType || meta.temporalType })
  if (policy.canViewRaw) return source
  return { ...source, rawText: '', mentorSafeSummary: source.mentorSafeSummary || privacySafeText(meta), mentorServiceDetail: policy.canViewServiceDetail ? (source.mentorServiceDetail || meta.mentorServiceDetail || '') : '', necessaryExcerpt: policy.canViewNecessaryExcerpt ? (source.necessaryExcerpt || meta.necessaryExcerpt || '') : '', salesSafeSummary: meta.salesSafeSummary || '', privacyPolicy: policy }
}

function mentorVisibleEvidence(evidence, source) {
  const privacy = combinePrivacyContext(evidence, source)
  const meta = evidence?.privacyMeta || source?.privacyMeta || {}
  const policy = resolvePrivacyPolicy({ ...privacy, currentRole: 'MENTOR' })
  if (policy.canViewRaw) return evidence
  const sourceHighSensitive = source?.privacyLevel === 'HIGH_SENSITIVE'
  const safeMeta = sourceHighSensitive ? (source?.privacyMeta || {}) : meta
  const safeText = sourceHighSensitive ? privacySafeText(safeMeta) : (evidence.mentorSafeText || privacySafeText(meta))
  const serviceDetail = sourceHighSensitive ? (source?.mentorServiceDetail || safeMeta.mentorServiceDetail || safeText) : (evidence.mentorServiceDetail || meta.mentorServiceDetail || evidence.mentorSafeText || privacySafeText(meta))
  const necessaryExcerpt = sourceHighSensitive ? (source?.necessaryExcerpt || safeMeta.necessaryExcerpt || '') : (evidence.necessaryExcerpt || meta.necessaryExcerpt || '')
  return { ...evidence, sourceExcerpt: policy.canViewNecessaryExcerpt ? necessaryExcerpt : '', displayText: policy.canViewServiceDetail ? serviceDetail : safeText, standardValue: policy.canPromoteToProfile ? evidence.standardValue : undefined, mentorServiceDetail: policy.canViewServiceDetail ? serviceDetail : '', necessaryExcerpt: policy.canViewNecessaryExcerpt ? necessaryExcerpt : '', salesSafeSummary: safeMeta.salesSafeSummary || '', privacyPolicy: policy }
}

function profileMaterializationEvidence({ evidenceItems = [], sourceRecords = [], customer, actor }) {
  const sourceById = new Map(sourceRecords.map((source) => [source.id, source]))
  const role = actor?.permissionRole || 'ADMIN'
  const isAssignedMentor = role !== 'MENTOR' || customer?.mentorId === actor?.id
  return evidenceItems.filter((evidence) => {
    if (evidence.customerId !== customer?.id) return false
    if (evidence.contentSource === 'THIRD_PARTY_REPORTED') return false
    const source = sourceById.get(evidence.sourceId)
    const privacy = combinePrivacyContext(evidence, source)
    const policy = resolvePrivacyPolicy({ ...privacy, currentRole: role, isAssignedMentor })
    return policy.canPromoteToProfile
  })
}

function mentorVisibleSafetyAssessment(assessment, actorRole) {
  if (!assessment || actorRole !== 'MENTOR') return assessment
  const risk = assessment.risk_level
  const nextAction = risk === 'R4'
    ? '请立即由人工确认当前安全与紧急支持需求。'
    : risk === 'R3'
      ? '请先暂停商业流程，由人工确认当前安全状态并考虑专业转介。'
      : risk === 'R2'
        ? '请先稳定并确认当前状态，再决定是否进入常规服务。'
        : '先从客户最近最在意的一件具体事情开始确认。'
  return {
    ...assessment,
    safety_signals: (assessment.safety_signals || []).map((signal) => ({
      ...signal,
      short_description: '出现需要优先核实的安全相关信息',
      details: '',
      current_status: '需要人工确认',
      matched_phrase: undefined,
      source_excerpt: undefined,
    })),
    critical_unknowns: (assessment.critical_unknowns || []).map(() => '仍需人工确认的安全信息'),
    service_cautions: (assessment.service_cautions || []).length ? ['请谨慎处理，必要时咨询专业督导老师。'] : [],
    next_action: nextAction,
    conflicts: (assessment.conflicts || []).map(() => ({ status: '需要人工确认' })),
  }
}

function scope(database, actorId) {
  const actor = database.staff.find((item) => item.id === actorId)
  if (!actor) throw new Error('账号不存在')
  if (actor.status !== 'ACTIVE') throw new Error('该账户已停用，请联系管理员。')
  if (actor.permissionRole === 'ADMIN' && actor.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
  if (actor.permissionRole !== 'MENTOR') return database
  const visibleCustomerIds = new Set(database.customers.filter((item) => customerBelongsToStaff(item, actor.id)).map((item) => item.id))
  const visible = (items) => items.filter((item) => visibleCustomerIds.has(item.customerId))
  const sourceRecords = visible(database.sourceRecords).map(mentorVisibleSource)
  const sourceById = new Map(sourceRecords.map((item) => [item.id, item]))
  const evidenceItems = visible(database.evidenceItems).map((item) => mentorVisibleEvidence(item, sourceById.get(item.sourceId)))
  return { ...database, customers: database.customers.filter((item) => visibleCustomerIds.has(item.id)), appointments: visible(database.appointments), sessions: visible(database.sessions), enrollments: visible(database.enrollments), profileChanges: visible(database.profileChanges), sourceRecords, evidenceItems, profileUpdateProposals: visible(database.profileUpdateProposals), evidenceConflicts: visible(database.evidenceConflicts) }
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
  const values = { profile_field_meta_json: serializeCustomerDerivedMeta(customerRecord), profile_schema_version: customerRecord.profileSchemaVersion || CUSTOMER_PROFILE_SCHEMA_VERSION, profile_updated_at: customerRecord.profileUpdatedAt || now() }
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
  if (Array.isArray(customerRecord.supplementaryItems) && customerRecord.supplementaryItems.length > 0) {
    values.supplementary_info = serializeSupplementaryField(customerRecord.supplementaryItems)
  }
  return mapFields('customers', values)
}

export function serializeCustomerDerivedMeta(customerRecord, overrides = {}) {
  return JSON.stringify({
    _profile_version: customerRecord.profileVersion || 0,
    _fields: customerRecord.profileFieldMeta || {},
    _ai_summary: Object.prototype.hasOwnProperty.call(overrides, 'aiSummary') ? overrides.aiSummary : customerRecord.aiSummaryMeta || null,
    _understanding: Object.prototype.hasOwnProperty.call(overrides, 'understanding') ? overrides.understanding : customerRecord.understandingMeta || null,
    _sales_understanding: Object.prototype.hasOwnProperty.call(overrides, 'salesUnderstanding') ? overrides.salesUnderstanding : customerRecord.salesUnderstandingMeta || null,
    _safety: Object.prototype.hasOwnProperty.call(overrides, 'safety') ? overrides.safety : customerRecord.safetyMeta || null,
    _supplementary_items: (customerRecord.supplementaryItems || []).map(({ text: _text, ...item }) => item),
    _automatic_profile_pending: Object.prototype.hasOwnProperty.call(overrides, 'automaticProfilePending') ? overrides.automaticProfilePending : customerRecord.automaticProfilePending || null,
    _mutation_states: Object.prototype.hasOwnProperty.call(overrides, 'mutationStates') ? sanitizeMutationStates(overrides.mutationStates) : sanitizeMutationStates(customerRecord.mutationStates),
  })
}

async function updateCustomerRecordSafely(recordId, customerId, buildFields, verify) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latestRow = await getRecord(config.feishu.tables.customers, recordId)
    if (!latestRow) throw Object.assign(new Error('客户不存在'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const latestCustomer = customer(latestRow)
    if (latestCustomer.id !== customerId) throw Object.assign(new Error('客户回读不匹配'), { code: 'CUSTOMER_READBACK_MISMATCH', status: 502 })
    await updateRecord(config.feishu.tables.customers, recordId, buildFields(latestCustomer))
    const verifiedRow = await getRecord(config.feishu.tables.customers, recordId)
    if (!verifiedRow) {
      lastError = Object.assign(new Error('客户更新后暂未读回'), { code: 'CUSTOMER_METADATA_UNKNOWN', status: 503 })
      continue
    }
    const verifiedCustomer = customer(verifiedRow)
    if (verifiedCustomer.id !== customerId) {
      lastError = Object.assign(new Error('客户更新回读不匹配'), { code: 'CUSTOMER_READBACK_MISMATCH', status: 502 })
      continue
    }
    if (!verify || verify(verifiedCustomer)) return { row: verifiedRow, customer: verifiedCustomer }
    lastError = Object.assign(new Error('客户元数据更新发生并发冲突'), { code: 'CUSTOMER_METADATA_CONFLICT', status: 409 })
  }
  throw lastError || Object.assign(new Error('客户元数据更新结果未知'), { code: 'CUSTOMER_METADATA_UNKNOWN', status: 503 })
}

function validateManualCustomer(input) {
  const nickname = text(input?.nickname).trim()
  if (!nickname) throw new Error('客户昵称不能为空')
  const contacts = validateCustomerContacts({ phone: input?.phone, wechat: input?.wechat })
  if (!contacts.ok) throw Object.assign(new Error(contacts.message), { code: contacts.field === 'contact' ? 'CUSTOMER_CONTACT_REQUIRED' : 'CUSTOMER_CONTACT_INVALID', status: 400, field: contacts.field })
  return { nickname, phone: contacts.phone, wechat: contacts.wechat, introducer: text(input?.introducer).trim(), situation: text(input?.situation).trim() }
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
  if (!Array.isArray(drafts)) return false
  if (!config.feishu.tables.enrollments) throw new Error('报名记录表尚未配置，暂时不能保存已报名课程')
  validateEnrollmentDrafts(database, drafts)
  const uniqueDrafts = new Map(drafts.map((draft) => [draft.productId, draft]))
  let changed = false
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
      const unchanged = existing.paymentStatus === paymentStatus
        && (draft.amount === undefined || Number(existing.amount) === Number(draft.amount))
        && (draft.enrolledAt === undefined || String(existing.enrolledAt || '') === String(draft.enrolledAt || ''))
        && (draft.paidAt === undefined || String(existing.paidAt || '') === String(draft.paidAt || ''))
      if (unchanged) continue
      await updateRecord(config.feishu.tables.enrollments, existing._recordId, mapFields('enrollments', fields))
      changed = true
      continue
    }
    if (cancelled?._recordId) {
      await updateRecord(config.feishu.tables.enrollments, cancelled._recordId, mapFields('enrollments', { ...fields, status: 'ACTIVE' }))
      changed = true
      continue
    }
    const enrolledAt = draft.enrolledAt || now()
    const enrollmentId = operationId ? stableOperationId(`${operationId}:${product.id}`, 'ENR') : `E-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    const createdAt = now()
    const writeValues = { enrollment_id: enrollmentId, customer_id: customerId, product_id: product.id, product_name: product.name, enrollment_source: 'MANUAL', payment_status: paymentStatus, paid: paymentStatus === 'PAID', amount: draft.amount ?? null, enrolled_at: enrolledAt, paid_at: draft.paidAt || null, operator_id: operatorId, created_at: createdAt, status: 'ACTIVE' }
    const writeResult = await createRecord(config.feishu.tables.enrollments, mapFields('enrollments', writeValues), { operation: 'enrollment.create', operationId: enrollmentId, customerId, entityType: 'enrollments', idempotency: { field: mapField('enrollments', 'enrollment_id'), value: enrollmentId } })
    const recordId = writeResult?.record?.record_id || writeResult?.record_id || writeResult?.record?.id || ''
    database.enrollments = [...database.enrollments, enrollment({ record_id: recordId, fields: mapFields('enrollments', writeValues) })]
    changed = true
  }
  if (replace) {
    const selected = new Set(uniqueDrafts.keys())
    for (const current of database.enrollments.filter((item) => item.customerId === customerId && item.status !== 'CANCELLED' && !selected.has(item.productId))) {
      if (current._recordId) await updateRecord(config.feishu.tables.enrollments, current._recordId, mapFields('enrollments', { status: 'CANCELLED' }))
      changed = true
    }
  }
  return changed
}

async function createManualProfileChange(database, { customerId, field, fieldName, oldValue, newValue, operatorId, operationId = '' }) {
  if (sameProfileValue(oldValue, newValue)) return null
  const existing = (database.profileChanges || []).find((item) => item.customerId === customerId && item.field === field && sameProfileValue(item.oldValue, oldValue) && sameProfileValue(item.newValue, newValue) && item.operatorId === operatorId)
  if (existing) return existing
  const changedAt = feishuDate()
  const changeId = operationId ? stableOperationId(`${operationId}:${field}`, 'PCH') : `PCH-${crypto.randomUUID()}`
  await createMappedRecord('profileChanges', 'profile-change.manual-customer', { change_id: changeId, customer_id: customerId, field, field_key: field, field_name: fieldName || field, old_value: JSON.stringify(oldValue ?? null), new_value: JSON.stringify(newValue ?? null), source: 'MANUAL', confidence: 1, confirmed: true, updated_at: changedAt, changed_at: changedAt, operator_id: operatorId || '', service_record_id: '', source_record_id: '', evidence_id: '', update_batch_id: '' })
  return { id: changeId, customerId, field, fieldName: fieldName || field, oldValue: oldValue ?? null, newValue: newValue ?? null, source: 'MANUAL', confidence: 1, confirmed: true, updatedAt: new Date().toISOString(), operatorId }
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
    customerRecord.profileFieldMeta[field] = {
      source: update.source,
      confidence: update.confidence,
      confirmed: update.confirmed,
      updatedAt,
      ...(provenanceContext.sourceRecordId ? { sourceRecordId: provenanceContext.sourceRecordId } : {}),
      ...(provenanceContext.evidenceId ? { evidenceId: provenanceContext.evidenceId } : {}),
      ...(provenanceContext.updateBatchId ? { extractionBatchId: provenanceContext.updateBatchId } : {}),
      ...(provenanceContext.sourceEventAt ? { sourceEventAt: provenanceContext.sourceEventAt } : {}),
      ...(provenanceContext.sourceEntryAt ? { sourceEntryAt: provenanceContext.sourceEntryAt } : {}),
      ...(provenanceContext.sourceVersion ? { sourceVersion: provenanceContext.sourceVersion } : {}),
    }
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
  if (changed.length) customerRecord.aiSummaryMeta = { ...(customerRecord.aiSummaryMeta || {}), status: 'STALE', inputFingerprint: '', updatedAt }
  if (changed.length) customerRecord.understandingMeta = { ...(customerRecord.understandingMeta || {}), status: 'STALE', inputFingerprint: '', updatedAt }
  if (changed.length) customerRecord.salesUnderstandingMeta = { ...(customerRecord.salesUnderstandingMeta || {}), status: 'STALE', inputFingerprint: '', updatedAt }
  if (changed.length) customerRecord.safetyMeta = { ...(customerRecord.safetyMeta || {}), status: 'STALE', inputFingerprint: '', updatedAt }
  customerRecord.profileUpdatedAt = updatedAt
  customerRecord.profileSchemaVersion = CUSTOMER_PROFILE_SCHEMA_VERSION
  if (!changed.length) return { customerRecord, writeResult: null, changes: [] }
  const writeResult = await updateRecord(config.feishu.tables.customers, row.record_id, profileFieldsForWrite(customerRecord, changed))
  const persistedChanges = []
  for (const change of changed.filter((item) => customerHistoryPolicy(item.field) === 'TRACK' || (item.field === 'age' && !customerRecord.profileFields.birth_date))) {
    const changeId = provenanceContext.updateBatchId ? stableOperationId(`${provenanceContext.updateBatchId}:${change.field}`, 'PCH') : `PCH-${crypto.randomUUID()}`
    await createMappedRecord('profileChanges', 'profile-change.provenance', { change_id: changeId, customer_id: customerId, field: change.field, field_key: change.field, field_name: mapField('customers', change.field), old_value: JSON.stringify(change.oldValue ?? null), new_value: JSON.stringify(change.value ?? null), source: change.source, confidence: change.confidence, confirmed: change.confirmed, updated_at: changedAt, changed_at: changedAt, operator_id: operatorId || '', service_record_id: serviceRecordId || '', source_record_id: provenanceContext.sourceRecordId || '', evidence_id: provenanceContext.evidenceId || '', update_batch_id: provenanceContext.updateBatchId || '' })
    persistedChanges.push({ id: changeId, customerId, field: change.field, fieldName: mapField('customers', change.field), oldValue: change.oldValue ?? null, newValue: change.value ?? null, source: change.source, confidence: change.confidence, confirmed: change.confirmed, updatedAt: new Date().toISOString(), operatorId, serviceRecordId })
  }
  return { customerRecord, writeResult, changes: persistedChanges }
}

async function appendCustomerSupplementaryItem(database, customerId, evidence, operatorId) {
  const customerRecord = database.customers.find((item) => item.id === customerId)
  const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
  if (!customerRecord || !row || !evidence?.displayText) return false
  const items = Array.isArray(customerRecord.supplementaryItems) ? customerRecord.supplementaryItems : []
  const itemId = stableId('SUP', `${customerId}:${evidence.sourceId || ''}:${evidence.id || evidence.displayText}`)
  if (items.some((item) => item.id === itemId || (item.text === evidence.displayText && item.sourceId === evidence.sourceId))) return false
  const updatedAt = now()
  customerRecord.supplementaryItems = [...items, {
    id: itemId,
    text: evidence.displayText,
    source: evidence.informationNature === 'AI_INFERENCE' || evidence.evidenceType === 'HYPOTHESIS' ? 'AI_INFERENCE' : 'AI_EXTRACTED',
    confidence: evidence.confidence,
    confirmed: false,
    status: 'PENDING_REVIEW',
    sourceRecordId: evidence.sourceId || '',
    evidenceId: evidence.id || '',
    updatedAt,
    operatorId: operatorId || '',
  }]
  customerRecord.profileVersion = Number(customerRecord.profileVersion || 0) + 1
  customerRecord.profileUpdatedAt = updatedAt
  customerRecord.profileSchemaVersion = CUSTOMER_PROFILE_SCHEMA_VERSION
  await updateRecord(config.feishu.tables.customers, row.record_id, profileFieldsForWrite(customerRecord, []))
  return true
}

const stage2Table = (name) => config.feishu.tables[name]
const stage2RequiredTables = ['sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']
const SOURCE_RAW_TEXT_MAX_CHARS = 500_000
function requireStage2Tables() { const missing = stage2RequiredTables.filter((name) => !stage2Table(name)); if (missing.length) throw Object.assign(new Error('Stage 2 资料表尚未配置'), { code: 'STAGE2_TABLES_NOT_CONFIGURED', status: 503, missing }) }
function stage2Json(value) { return JSON.stringify(value ?? null) }
function normalizeSourceRawText(value) {
  const normalized = String(value ?? '').replace(/\r\n/g, '\n').trim()
  if (normalized.length > SOURCE_RAW_TEXT_MAX_CHARS) {
    throw Object.assign(new Error(`原始资料过长，最多支持 ${SOURCE_RAW_TEXT_MAX_CHARS.toLocaleString()} 个字符。请保留完整资料后分段保存。`), { code: 'SOURCE_TEXT_TOO_LARGE', status: 413, maxChars: SOURCE_RAW_TEXT_MAX_CHARS, actualChars: normalized.length })
  }
  return normalized
}

function automaticProfileText(input, situation = '') {
  const chunks = []
  if (String(situation || '').trim()) chunks.push(String(situation).trim())
  const labels = { current_core_issue: '当前困扰', help_expectation: '希望获得帮助', current_goal: '当前目标' }
  for (const update of Array.isArray(input?.profileUpdates) ? input.profileUpdates : []) {
    const field = String(update?.field || '').trim()
    const value = String(update?.value ?? '').trim()
    if (labels[field] && value) chunks.push(`${labels[field]}：${value}`)
  }
  return normalizeSourceRawText(chunks.join('\n'))
}

function automaticProfileTextFromCustomer(customer) {
  return automaticProfileText({
    profileUpdates: [
      { field: 'current_core_issue', value: customer?.need || '' },
      { field: 'help_expectation', value: customer?.helpExpectation || '' },
      { field: 'current_goal', value: customer?.goal || '' },
    ],
  }, customer?.notes || '')
}

function automaticProfilePendingMarker(rawText, actorId, reason) {
  return {
    contentHash: contentHash(rawText),
    actorId: text(actorId),
    reason: text(reason),
    createdAt: now(),
    sourceReference: { kind: 'CUSTOMER_FIELDS', fields: ['notes', 'current_issue', 'help_expectation', 'current_goal'] },
  }
}

function isAutomaticProfileSource(source) {
  return String(source?.notes || '').startsWith(AUTO_PROFILE_SOURCE_PREFIX)
}

function automaticProfileSourceIdForText(customerId, rawText) {
  const normalizedText = normalizeSourceRawText(rawText)
  const sourceOperationId = stableOperationId(`${customerId}:${contentHash(normalizedText)}`, 'AUTO-SOURCE')
  return stableId('SRC', `${customerId}:${sourceOperationId}`)
}

function automaticProfileSourceIdForContentHash(customerId, hash) {
  const sourceOperationId = stableOperationId(`${customerId}:${hash}`, 'AUTO-SOURCE')
  return stableId('SRC', `${customerId}:${sourceOperationId}`)
}

function findMatchingAutomaticProfileSource(sourceRecords, customerId, contentHashValue) {
  const expectedSourceId = automaticProfileSourceIdForContentHash(customerId, contentHashValue)
  return (sourceRecords || []).find((item) => item.customerId === customerId && (item.id === expectedSourceId || (item.contentHash === contentHashValue && isAutomaticProfileSource(item)))) || null
}

function mapAutomaticProfileStageFromSource(source) {
  if (!source) return 'PENDING'
  if (source.processingStatus === 'UPLOADED') return 'SOURCE_CREATED'
  if (source.processingStatus === 'PROCESSING') return 'PROCESSING'
  if (source.processingStatus === 'COMPLETED') return 'COMPLETED'
  if (source.processingStatus === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED'
  if (source.processingStatus === 'FAILED') return 'FAILED'
  return 'SOURCE_CREATED'
}

function automaticProfileArchivingAllowedForCustomer(customerId) {
  if (!config.features.automaticProfileArchiving) return false
  if (config.features.automaticProfileArchivingMode === 'canary' || config.features.automaticProfileArchivingCanary) return config.features.automaticProfileCanaryCustomerIds.has(text(customerId))
  return config.features.automaticProfileArchivingMode === 'production' || config.appEnv !== 'production'
}

function automaticProfileEventAllowed(eventAt) {
  if (config.appEnv !== 'production' || config.features.automaticProfileArchivingMode !== 'production') return true
  const enabledAt = Date.parse(config.features.automaticProfileArchivingEnabledAt || '')
  const occurredAt = Date.parse(eventAt || '')
  return Number.isFinite(enabledAt) && Number.isFinite(occurredAt) && occurredAt >= enabledAt
}

function automaticProfileStatus(sources, evidenceItems, customerId) {
  const latest = (sources || [])
    .filter((source) => source.customerId === customerId && isAutomaticProfileSource(source))
    .sort((a, b) => String(b.occurredAt || b.uploadedAt || b.createdAt || '').localeCompare(String(a.occurredAt || a.uploadedAt || a.createdAt || '')))[0]
  if (!latest) return 'NOT_STARTED'
  if (latest.processingStatus === 'UPLOADED' || latest.processingStatus === 'PROCESSING') return 'PROCESSING'
  if (latest.processingStatus === 'FAILED') return 'FAILED'
  if (latest.processingStatus === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED'
  if (latest.processingStatus !== 'COMPLETED') return 'PENDING'
  const hasUsableEvidence = (evidenceItems || []).some((item) => item.sourceId === latest.id && !['SUPERSEDED', 'REJECTED'].includes(item.reviewStatus))
  return hasUsableEvidence ? 'COMPLETED' : 'NO_USABLE_OUTPUT'
}

async function waitForSourceVisibility(sourceId) {
  const result = await boundedReadAfterWrite(async () => {
    const tableId = stage2Table('sourceRecords')
    if (!tableId) return null
    const rows = await searchRecords(tableId, buildSearchExactFilter(mapField('sourceRecords', 'source_id'), sourceId))
    const row = rows.find((item) => text(get('sourceRecords', item.fields, 'source_id')) === sourceId) || rows[0]
    return row ? sourceRecord(row) : null
  })
  return result.value
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
  // ProfileChanges uses the Feishu record_id as its durable row identity;
  // the domain-level change_id is retained in memory/audit context but is
  // not a column in the existing table contract.
  const persistedValues = tableKey === 'profileChanges'
    ? Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'change_id'))
    : values
  const mapped = mapFields(tableKey, persistedValues)
  const operationId = text(values.operationId || values.source_id || values.change_id || values.evidence_id || values.proposal_id || values.enrollment_id || values.service_record_id)
  const uniqueKey = tableKey === 'profileChanges' ? null : ['source_id', 'change_id', 'evidence_id', 'proposal_id', 'enrollment_id', 'service_record_id'].find((key) => text(values[key]))
  try {
    return await createRecord(config.feishu.tables[tableKey], mapped, { operation, operationId, customerId: text(values.customer_id), entityType: tableKey, ...(uniqueKey ? { idempotency: { field: mapField(tableKey, uniqueKey), value: values[uniqueKey] } } : {}) })
  } catch (error) {
    throw attachFeishuWriteContext(error, tableKey, operation, values)
  }
}
async function updateMappedRecord(tableKey, operation, recordId, values) {
  const mapped = mapFields(tableKey, values)
  const operationId = text(values.operationId || values.source_id || values.change_id || values.evidence_id || values.proposal_id || values.enrollment_id || values.service_record_id)
  try {
    return await updateRecord(config.feishu.tables[tableKey], recordId, mapped, { operation, operationId, customerId: text(values.customer_id), entityType: tableKey })
  } catch (error) {
    throw attachFeishuWriteContext(error, tableKey, operation, values)
  }
}
function sourceInput(input, actorId) {
  const sourceType = String(input?.sourceType || '').trim().toUpperCase()
  const rawText = normalizeSourceRawText(input?.rawText)
  if (!SOURCE_TYPES.has(sourceType)) throw Object.assign(new Error('不支持的资料类型'), { code: 'INVALID_SOURCE_TYPE', status: 400 })
  if (!rawText && sourceType !== 'FILE_UPLOAD') throw Object.assign(new Error('原始资料不能为空'), { code: 'SOURCE_TEXT_REQUIRED', status: 400 })
  const customerId = text(input?.customerId).trim()
  if (!customerId) throw Object.assign(new Error('客户ID不能为空'), { code: 'SOURCE_CUSTOMER_REQUIRED', status: 400 })
  const legacyRole = text(input?.sourceRole)
  const dialogueConfirmation = sourceType === 'FILE_UPLOAD'
    ? verifyDialogueConfirmation({ token: input?.dialogueConfirmation, contentHash: contentHash(rawText), targetCustomerId: customerId, customerOperationId: text(input?.customerOperationId), secret: config.authSecret })
    : null
  const dialogueContext = dialogueConfirmation ? { classification: dialogueConfirmation.classification, currentCustomerSpeakerId: dialogueConfirmation.currentCustomerSpeakerId, targetCustomerId: dialogueConfirmation.targetCustomerId, customerOperationId: dialogueConfirmation.customerOperationId } : null
  const sourcePerspective = input?.sourcePerspective === 'CUSTOMER_FIRST_PARTY' ? 'CUSTOMER_FIRST_PARTY' : input?.sourcePerspective === 'STAFF_REPORTED' ? 'STAFF_REPORTED' : legacyRole ? sourcePerspectiveFromRole(legacyRole) : 'STAFF_REPORTED'
  const sourceRole = legacyRole === 'MENTOR' ? 'MENTOR' : sourcePerspective === 'CUSTOMER_FIRST_PARTY' ? 'CUSTOMER' : 'ADMIN'
  const userNotes = normalizeText(input?.notes, 700)
  return { sourceType, rawText, customerId, subjectType: text(input?.subjectType) || 'PERSON', subjectId: text(input?.subjectId) || customerId, title: normalizeText(input?.title, 200) || '客户补充资料', occurredAt: null, sourceRole, sourcePerspective, serviceRecordId: text(input?.serviceRecordId), notes: `${userNotes}${userNotes ? '\n' : ''}${dialogueContext ? serializeDialogueContext(dialogueContext) : ''}`, dialogueContext, uploadedBy: actorId, operationId: text(input?.operationId), contentHash: text(input?.contentHash) || contentHash(rawText), fileRef: normalizeText(input?.fileRef, 2000) }
}
function evidenceWriteFields(item, source, sourceId) {
  return mapFields('evidenceItems', { evidence_id: item.id || stableId('EVD', `${sourceId}:${item.extractionBatchId}:${item.sourceExcerpt}:${item.displayText}`), subject_type: source.subjectType, subject_id: source.subjectId, customer_id: source.customerId, source_id: sourceId, evidence_type: item.evidenceType, semantic_kind: item.semanticKind, field_key: item.fieldKey || '', standard_value: stage2Json(item.standardValue), display_text: item.displayText, source_excerpt: item.sourceExcerpt, locator_json: stage2Json(item.locator), occurred_at: item.occurredAt || source.occurredAt || '', source_role: source.sourceRole, content_source: item.contentSource, information_nature: item.informationNature, verification_status: item.verificationStatus, confidence: item.confidence, review_status: item.reviewStatus, reviewer_id: '', reviewed_at: '', extraction_batch_id: item.extractionBatchId, provider: 'DEEPSEEK', model: item.model, model_version: item.modelVersion, prompt_version: item.promptVersion, created_at: now(), updated_at: now() })
}

export class FeishuRepository {
  constructor({ authRepository = new FeishuAuthCredentialRepository(), evidenceExtractor = createEvidenceCandidates, dialogueClassifier = classifyDialogue } = {}) { this.queryLogs = []; this.auditLogs = []; this.saveTraces = []; this.evidenceTraces = []; this.sourceSaveTimes = new Map(); this.recentCustomerWrites = new Map(); this.recentSourceWrites = new Map(); this.sourceProcessingLocks = new Map(); this.conflictResolutionLocks = new Map(); this.automaticProfilePendingKeys = new Set(); this.pendingEnrollmentRecoveryKeys = new Set(); this.localAutoProfileJobs = new Map(); this.instancePendingAutoProfiles = new Map(); this.autoProfileResumeInFlight = new Set(); this.scopedCustomerCache = new Map(); this.lastKnownGood = null; this.lastKnownGoodByCustomer = new Map(); this.customerWriteQueue = new CustomerWriteQueue(); this.authRepository = authRepository; this.evidenceExtractor = evidenceExtractor; this.dialogueClassifier = dialogueClassifier; this.understandingRefreshTimers = new Map(); this.autoProcessingRecoveryTimer = null; this.autoProcessingRecoveryRunning = false; this.autoRecoveryCircuit = { day: '', count: 0, paused: false }; this.databaseCache = { data: null, savedAt: 0, promise: null, generation: 0 }; this.directoryCache = { data: null, savedAt: 0, promise: null, generation: 0 }; this.staffCache = { data: null, savedAt: 0, promise: null, generation: 0 }; this.profileReadCache = { data: null, savedAt: 0, promise: null, generation: 0 }; this.understandingConflictCache = { data: null, savedAt: 0, promise: null, generation: 0 } }
  audit(operation, targetId, operatorId, result = 'SUCCESS', error = '') {
    const entry = { operation, target_id: targetId || '', operator_id: operatorId || '', result, error_code: error ? 'OPERATION_FAILED' : undefined, timestamp: now() }
    this.auditLogs.unshift(entry)
    if (this.auditLogs.length > 200) this.auditLogs.length = 200
    console.info('[ASVA_AUDIT]', JSON.stringify(entry))
  }
  invalidateDatabaseCache() { this.databaseCache.data = null; this.databaseCache.savedAt = 0; this.databaseCache.promise = null; this.databaseCache.generation += 1; this.directoryCache.data = null; this.directoryCache.savedAt = 0; this.directoryCache.promise = null; this.directoryCache.generation += 1; this.staffCache.data = null; this.staffCache.savedAt = 0; this.staffCache.promise = null; this.staffCache.generation += 1; this.profileReadCache.data = null; this.profileReadCache.savedAt = 0; this.profileReadCache.promise = null; this.profileReadCache.generation += 1; this.understandingConflictCache.data = null; this.understandingConflictCache.savedAt = 0; this.understandingConflictCache.promise = null; this.understandingConflictCache.generation += 1; this.markAllScopedCachesDirty() }
  markAllScopedCachesDirty() {
    const tables = ['customers', 'staff', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']
    for (const entry of this.scopedCustomerCache.values()) {
      entry.dirty = new Set(tables)
    }
  }
  markScopedDirty(customerId, tables = []) {
    const id = text(customerId).trim()
    if (!id) return
    const entry = this.scopedCustomerCache.get(id)
    if (!entry) return
    if (!entry.dirty) entry.dirty = new Set()
    for (const table of tables) entry.dirty.add(table)
  }
  clearScopedCustomerCache(customerId) {
    const id = text(customerId).trim()
    if (!id) { this.scopedCustomerCache.clear(); return }
    this.scopedCustomerCache.delete(id)
  }

  startAutomaticProcessingRecovery() {
    // Periodic 11-table recovery was removed from the request path. Keep this
    // method as a no-op so callers and older module entrypoints stay safe.
    return
  }

  scheduleAutomaticProcessing(actorId, sourceId) {
    if (!config.features.automaticProfileArchiving) return
    // DURABLE_RECOVERABLE: SourceRecords.processing_status (UPLOADED/PROCESSING/FAILED)
    // plus /api/admin/recover-automatic-processing. setImmediate only accelerates the live path.
    this.audit('SCHEDULE_AUTOMATIC_PROCESSING', sourceId, actorId, 'QUEUED')
    setImmediate(() => { void this.processSource(actorId, sourceId).catch((error) => this.audit('PROCESS_SOURCE_AUTOMATIC', sourceId, actorId, 'FAIL', error?.code || 'AUTO_PROCESSING_FAILED')) })
  }

  scheduleAutomaticCustomerProfile(actorId, customerId, rawText, reason) {
    if (!automaticProfileArchivingAllowedForCustomer(customerId) || !automaticProfileEventAllowed(now())) return { status: 'DISABLED' }
    const normalizedText = normalizeSourceRawText(rawText)
    if (!normalizedText) return { status: 'NOT_REQUIRED' }
    const pendingKey = `${customerId}:${contentHash(normalizedText)}`
    if (this.automaticProfilePendingKeys.has(pendingKey)) return { status: 'QUEUED' }
    this.automaticProfilePendingKeys.add(pendingKey)
    // Durable marker is customers.profile_field_meta_json._automatic_profile_pending
    // (written by ensureAutomaticProfilePending / save paths). Recover entry:
    // recoverAutomaticCustomerProfile / maybeResumeAutomaticCustomerProfile.
    // setImmediate still defers past customerWriteQueue holders (updateCustomer),
    // but the Promise is tracked so createCustomer can best-effort await SOURCE_CREATED
    // before the CloudBase instance freezes after the HTTP response.
    this.audit('SCHEDULE_AUTOMATIC_CUSTOMER_PROFILE', customerId, actorId, 'QUEUED')
    let resolveJob
    let rejectJob
    const jobPromise = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject })
    this.localAutoProfileJobs.set(customerId, { promise: jobPromise, startedAt: Date.now(), actorId, reason, pendingKey })
    this.instancePendingAutoProfiles.set(customerId, { actorId, reason, createdAt: Date.now(), contentHash: contentHash(normalizedText) })
    setImmediate(() => {
      this.queueAutomaticCustomerProfile(actorId, customerId, normalizedText, reason)
        .then((result) => {
          if (result?.status === 'QUEUED' && result?.sourceId) this.instancePendingAutoProfiles.delete(customerId)
          resolveJob(result)
        })
        .catch((error) => {
          this.audit('QUEUE_AUTOMATIC_CUSTOMER_PROFILE', customerId, actorId, 'FAIL', error?.code || 'AUTO_SOURCE_QUEUE_FAILED')
          rejectJob(error)
        })
        .finally(() => this.automaticProfilePendingKeys.delete(pendingKey))
    })
    return { status: 'QUEUED' }
  }

  async awaitAutomaticCustomerProfileKickoff(customerId, { budgetMs = 3500 } = {}) {
    const job = this.localAutoProfileJobs.get(customerId)
    if (!job?.promise) return { status: 'MISSING' }
    let timer
    try {
      const outcome = await Promise.race([
        job.promise.then((value) => ({ status: 'DONE', value })).catch((error) => ({ status: 'FAILED', errorCode: error?.code || 'AUTO_SOURCE_QUEUE_FAILED' })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'BUDGET_EXCEEDED' }), Math.max(0, Number(budgetMs) || 0)) }),
      ])
      return outcome
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async maybeResumeAutomaticCustomerProfile(actorId, customerId) {
    const requestedCustomerId = text(customerId).trim()
    if (!requestedCustomerId) return { status: 'NOT_REQUIRED' }
    if (!config.features.automaticProfileArchiving) return { status: 'DISABLED' }
    if (!automaticProfileArchivingAllowedForCustomer(requestedCustomerId)) return { status: 'DISABLED' }
    if (this.autoProfileResumeInFlight.has(requestedCustomerId)) return { status: 'RUNNING' }
    const local = this.instancePendingAutoProfiles.get(requestedCustomerId)
    this.autoProfileResumeInFlight.add(requestedCustomerId)
    try {
      const result = await this.recoverAutomaticCustomerProfile(actorId || local?.actorId, requestedCustomerId)
      if (result?.status && !['PENDING', 'FAILED', 'DISABLED'].includes(result.status)) {
        this.instancePendingAutoProfiles.delete(requestedCustomerId)
      }
      return result
    } catch (error) {
      this.audit('RESUME_AUTOMATIC_CUSTOMER_PROFILE', requestedCustomerId, actorId || '', 'FAIL', error?.code || 'AUTO_RESUME_FAILED')
      return { status: 'FAILED', customerId: requestedCustomerId, errorCode: error?.code || 'AUTO_RESUME_FAILED' }
    } finally {
      this.autoProfileResumeInFlight.delete(requestedCustomerId)
    }
  }

  async resumeInstancePendingAutoProfiles(actorId) {
    const entries = [...this.instancePendingAutoProfiles.entries()]
    let resumed = 0
    for (const [customerId, meta] of entries) {
      if (Date.now() - Number(meta.createdAt || 0) > 30 * 60_000) {
        this.instancePendingAutoProfiles.delete(customerId)
        continue
      }
      void this.maybeResumeAutomaticCustomerProfile(actorId || meta.actorId, customerId)
      resumed += 1
    }
    return { status: 'OK', resumed }
  }

  withCustomerScope(customerId, scene, fn) {
    return scopedReadStore.run({ customerId: text(customerId), scene: scene || 'SCOPED_AI' }, fn)
  }

  rememberCustomerLastKnownGood(customerId, database) {
    if (!customerId || !database) return
    this.lastKnownGoodByCustomer.set(customerId, cloneDatabase(projectCustomerDatabase(database, customerId)))
  }

  scopedReadStats() {
    return [...(this.scopedReadTraces || [])]
  }

  noteScopedRead(trace) {
    if (!this.scopedReadTraces) this.scopedReadTraces = []
    this.scopedReadTraces.unshift(trace)
    if (this.scopedReadTraces.length > 50) this.scopedReadTraces.length = 50
  }

  async searchTableByField(tableKey, fieldKey, value, { scene = 'SCOPED_AI' } = {}) {
    const tableId = stage2Table(tableKey) || config.feishu.tables[tableKey]
    if (!tableId) return []
    const fieldName = mapField(tableKey, fieldKey)
    const startedAt = Date.now()
    const rows = await searchRecords(tableId, buildSearchExactFilter(fieldName, value))
    this.noteScopedRead({ scene, table: tableKey, field: fieldKey, value: String(value || ''), rowCount: rows.length, durationMs: Date.now() - startedAt, mode: 'SEARCH' })
    return rows
  }

  async loadCustomerScopedCached(customerId, { force = false, scene = 'SCOPED_AI', includeStaff = true } = {}) {
    const requestedCustomerId = text(customerId).trim()
    if (!requestedCustomerId) throw Object.assign(new Error('customerId 必填'), { code: 'CUSTOMER_ID_REQUIRED', status: 400 })
    const entry = this.scopedCustomerCache.get(requestedCustomerId)
    const dirty = entry?.dirty instanceof Set ? entry.dirty : new Set()
    if (!force && entry?.database && dirty.size === 0 && Date.now() - Number(entry.savedAt || 0) < 45_000) {
      return cloneDatabase(entry.database)
    }
    if (entry?.database && dirty.size > 0 && dirty.size < 6) {
      const refreshed = await this.refreshCustomerScopedTables(requestedCustomerId, entry, { scene, includeStaff, tables: [...dirty] })
      return cloneDatabase(refreshed)
    }
    const database = await this.loadCustomerScoped(requestedCustomerId, { force: true, scene, includeStaff })
    this.scopedCustomerCache.set(requestedCustomerId, { database: cloneDatabase(database), savedAt: Date.now(), dirty: new Set() })
    return database
  }

  async refreshCustomerScopedTables(customerId, entry, { scene = 'SCOPED_AI', includeStaff = true, tables = [] } = {}) {
    const startedAt = Date.now()
    const database = cloneDatabase(entry.database)
    const uniqueTables = new Set(database._scopedTables || [])
    const refresh = async (tableKey) => {
      if (tableKey === 'staff') {
        const staffRows = includeStaff ? (await this.loadStaffRecords({ force: true })).map((item) => {
          // loadStaffRecords returns mapped staff; rebuild minimal _rows via list only when needed
          return item
        }) : []
        // Prefer cached mapped staff; keep previous _rows.staff when list not available.
        database.staff = staffRows
        uniqueTables.add('staff')
        return
      }
      if (tableKey === 'customers') {
        const customerRows = await this.searchTableByField('customers', 'customer_id', customerId, { scene })
        database.customers = customerRows.map(customer)
        database._rows.customers = customerRows
        uniqueTables.add('customers')
        return
      }
      if (tableKey === 'sourceRecords') {
        const sourceRows = await this.searchTableByField('sourceRecords', 'customer_id', customerId, { scene })
        database.sourceRecords = sourceRows.map(sourceRecord)
        database._rows.sourceRecords = sourceRows
        uniqueTables.add('sourceRecords')
        return
      }
      if (tableKey === 'evidenceItems') {
        const evidenceRows = await this.searchTableByField('evidenceItems', 'customer_id', customerId, { scene })
        const allEvidenceItems = evidenceRows.map(evidenceItem)
        const evidenceItems = allEvidenceItems.filter((item) => {
          if (item.reviewStatus === 'CONFIRMED') return true
          if (item.reviewStatus !== 'PENDING_REVIEW') return false
          const source = database.sourceRecords.find((candidate) => candidate.id === item.sourceId)
          return !source?.lastBatchId || source.lastBatchId === item.extractionBatchId
        })
        database._allEvidenceItems = allEvidenceItems
        database.evidenceItems = evidenceItems
        database._rows.evidenceItems = evidenceRows
        uniqueTables.add('evidenceItems')
        return
      }
      if (tableKey === 'profileUpdateProposals') {
        const proposalRows = await this.searchTableByField('profileUpdateProposals', 'customer_id', customerId, { scene })
        const activeEvidenceIds = new Set(database.evidenceItems.map((item) => item.id))
        database.profileUpdateProposals = proposalRows.map(proposalRecord).filter((item) => activeEvidenceIds.has(item.evidenceId))
        database._rows.profileUpdateProposals = proposalRows
        uniqueTables.add('profileUpdateProposals')
        return
      }
      if (tableKey === 'evidenceConflicts') {
        const conflictRows = await this.searchTableByField('evidenceConflicts', 'customer_id', customerId, { scene })
        const activeEvidenceIds = new Set(database.evidenceItems.map((item) => item.id))
        database.evidenceConflicts = conflictRows.map(conflictRecord).filter((item) => activeEvidenceIds.has(item.newEvidenceId) || activeEvidenceIds.has(item.currentEvidenceId))
        database._rows.evidenceConflicts = conflictRows
        uniqueTables.add('evidenceConflicts')
      }
    }
    // Refresh interdependent tables in a stable order.
    const order = ['customers', 'staff', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']
    for (const tableKey of order) {
      if (tables.includes(tableKey)) await refresh(tableKey)
    }
    // Recompute customer derived projection after evidence/source refresh.
    for (const item of database.customers) {
      const customerEvidence = database.evidenceItems.filter((evidence) => evidence.customerId === item.id)
      const profileEvidence = profileMaterializationEvidence({ evidenceItems: customerEvidence, sourceRecords: database.sourceRecords, customer: item, actor: { permissionRole: 'ADMIN' } })
      item.profileMaterialization = materializeCustomerProfile({ customer: item, evidenceItems: profileEvidence, summaryMeta: item.aiSummaryMeta })
      const currentFingerprint = understandingInputFingerprint({ customer: item, evidenceItems: customerEvidence, conflicts: database.evidenceConflicts.filter((conflict) => conflict.customerId === item.id) })
      if (!item.understandingMeta || item.understandingMeta.inputFingerprint !== currentFingerprint || item.understandingMeta.promptVersion !== CUSTOMER_UNDERSTANDING_PROMPT_VERSION) item.understandingStatus = 'STALE'
    }
    database._scoped = true
    database._scopedCustomerId = customerId
    database._scopedTables = [...uniqueTables]
    database._scopedTableCount = uniqueTables.size
    database._scopedDurationMs = Date.now() - startedAt
    database._scopedPartialRefresh = true
    database._scopedRefreshedTables = [...tables]
    this.rememberCustomerLastKnownGood(customerId, database)
    this.scopedCustomerCache.set(customerId, { database: cloneDatabase(database), savedAt: Date.now(), dirty: new Set() })
    this.noteScopedRead({ scene, table: '_partial', field: 'customer_id', value: customerId, rowCount: database.customers.length, durationMs: database._scopedDurationMs, mode: 'CUSTOMER_SCOPED_PARTIAL', tableCount: tables.length, tables })
    return database
  }

  async loadCustomerScoped(customerId, { force = true, scene = 'SCOPED_AI', includeStaff = true } = {}) {
    if (this.load !== FeishuRepository.prototype.load) return this.load({ force })
    const requestedCustomerId = text(customerId).trim()
    if (!requestedCustomerId) throw Object.assign(new Error('customerId 必填'), { code: 'CUSTOMER_ID_REQUIRED', status: 400 })
    const startedAt = Date.now()
    const memBefore = process.memoryUsage().heapUsed
    const tableKeys = []
    const customerRows = await this.searchTableByField('customers', 'customer_id', requestedCustomerId, { scene })
    tableKeys.push('customers')
    const staffPromise = includeStaff
      ? (async () => {
          tableKeys.push('staff')
          // Reuse the staff cache instead of listing the full staff table on every scoped force load.
          const mapped = await this.loadStaffRecords({ force: false })
          return { mapped, rows: [] }
        })()
      : Promise.resolve({ mapped: [], rows: [] })
    const [staffBundle, sourceRows, evidenceRows, proposalRows, conflictRows] = await Promise.all([
      staffPromise,
      this.searchTableByField('sourceRecords', 'customer_id', requestedCustomerId, { scene }).then((rows) => { tableKeys.push('sourceRecords'); return rows }),
      this.searchTableByField('evidenceItems', 'customer_id', requestedCustomerId, { scene }).then((rows) => { tableKeys.push('evidenceItems'); return rows }),
      this.searchTableByField('profileUpdateProposals', 'customer_id', requestedCustomerId, { scene }).then((rows) => { tableKeys.push('profileUpdateProposals'); return rows }),
      this.searchTableByField('evidenceConflicts', 'customer_id', requestedCustomerId, { scene }).then((rows) => { tableKeys.push('evidenceConflicts'); return rows }),
    ])
    const customers = customerRows.map(customer)
    const sourceRecords = sourceRows.map(sourceRecord)
    const allEvidenceItems = evidenceRows.map(evidenceItem)
    const evidenceItems = allEvidenceItems.filter((item) => {
      if (item.reviewStatus === 'CONFIRMED') return true
      if (item.reviewStatus !== 'PENDING_REVIEW') return false
      const source = sourceRecords.find((candidate) => candidate.id === item.sourceId)
      return !source?.lastBatchId || source.lastBatchId === item.extractionBatchId
    })
    const activeEvidenceIds = new Set(evidenceItems.map((item) => item.id))
    const proposals = proposalRows.map(proposalRecord).filter((item) => activeEvidenceIds.has(item.evidenceId))
    const conflicts = conflictRows.map(conflictRecord).filter((item) => activeEvidenceIds.has(item.newEvidenceId) || activeEvidenceIds.has(item.currentEvidenceId))
    for (const item of customers) {
      const customerEvidence = evidenceItems.filter((evidence) => evidence.customerId === item.id)
      const profileEvidence = profileMaterializationEvidence({ evidenceItems: customerEvidence, sourceRecords, customer: item, actor: { permissionRole: 'ADMIN' } })
      item.profileMaterialization = materializeCustomerProfile({ customer: item, evidenceItems: profileEvidence, summaryMeta: item.aiSummaryMeta })
      const currentFingerprint = understandingInputFingerprint({ customer: item, evidenceItems: customerEvidence, conflicts: conflicts.filter((conflict) => conflict.customerId === item.id) })
      if (!item.understandingMeta || item.understandingMeta.inputFingerprint !== currentFingerprint || item.understandingMeta.promptVersion !== CUSTOMER_UNDERSTANDING_PROMPT_VERSION) item.understandingStatus = 'STALE'
    }
    const durationMs = Date.now() - startedAt
    const memAfter = process.memoryUsage().heapUsed
    const uniqueTables = [...new Set(tableKeys)]
    const database = {
      staff: staffBundle.mapped,
      customers,
      appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [],
      sourceRecords, evidenceItems, profileUpdateProposals: proposals, evidenceConflicts: conflicts,
      _allEvidenceItems: allEvidenceItems,
      _missingRepositories: ['EnrollmentRepository'],
      _scoped: true,
      _scopedCustomerId: requestedCustomerId,
      _scopedTableCount: uniqueTables.length,
      _scopedTables: uniqueTables,
      _scopedDurationMs: durationMs,
      _scopedHeapDeltaBytes: Math.max(0, memAfter - memBefore),
      _scopedPeakHeapUsed: memAfter,
      _rows: {
        ...emptyScopedRows(),
        customers: customerRows,
        staff: staffBundle.rows,
        sourceRecords: sourceRows,
        evidenceItems: evidenceRows,
        profileUpdateProposals: proposalRows,
        evidenceConflicts: conflictRows,
      },
    }
    this.rememberCustomerLastKnownGood(requestedCustomerId, database)
    this.scopedCustomerCache.set(requestedCustomerId, { database: cloneDatabase(database), savedAt: Date.now(), dirty: new Set() })
    this.noteScopedRead({ scene, table: '_aggregate', field: 'customer_id', value: requestedCustomerId, rowCount: customers.length, durationMs, mode: 'CUSTOMER_SCOPED', tableCount: uniqueTables.length, tables: uniqueTables, heapDeltaBytes: database._scopedHeapDeltaBytes })
    if (config.appEnv === 'development') console.info('[ASVA_PERF_SCOPED_READ]', JSON.stringify({ scene, customer_id: requestedCustomerId, table_count: uniqueTables.length, tables: uniqueTables, duration_ms: durationMs, heap_delta_bytes: database._scopedHeapDeltaBytes }))
    return cloneDatabase(database)
  }

  async loadSourceScoped(sourceId, { force = true, scene = 'SCOPED_AI' } = {}) {
    if (this.load !== FeishuRepository.prototype.load) return this.load({ force })
    const requestedSourceId = text(sourceId).trim()
    if (!requestedSourceId) throw Object.assign(new Error('sourceId 必填'), { code: 'SOURCE_ID_REQUIRED', status: 400 })
    const sourceRows = await this.searchTableByField('sourceRecords', 'source_id', requestedSourceId, { scene })
    const source = sourceRows[0] ? sourceRecord(sourceRows[0]) : null
    if (!source?.customerId) return null
    const database = await this.loadCustomerScoped(source.customerId, { force, scene })
    // Ensure the exact source row is present even if customer_id search lagged.
    if (!database.sourceRecords.some((item) => item.id === requestedSourceId) && source) {
      database.sourceRecords = [...database.sourceRecords, source]
      database._rows.sourceRecords = [...(database._rows.sourceRecords || []), sourceRows[0]]
    }
    database._scopedSourceId = requestedSourceId
    return database
  }

  async clearAutomaticProfilePending(customerId, marker) {
    if (!marker?.contentHash) return false
    if (this.load === FeishuRepository.prototype.load && !scopedReadStore.getStore() && customerId) {
      return this.withCustomerScope(customerId, 'CLEAR_PENDING', () => this.clearAutomaticProfilePending(customerId, marker))
    }
    const database = await this.load({ force: true })
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!row) return false
    const matchingSource = findMatchingAutomaticProfileSource(database.sourceRecords, customerId, marker.contentHash)
    // Only clear after a durable SourceRecords row is visible. A successful
    // createSource() promise alone is not enough when persistence is delayed
    // or a concurrent meta writer could otherwise erase recovery intent.
    if (!matchingSource) {
      this.audit('CLEAR_AUTOMATIC_PROFILE_PENDING', customerId, marker.actorId || '', 'PENDING', 'SOURCE_NOT_VISIBLE')
      return false
    }
    try {
      await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => {
        if (latestCustomer.automaticProfilePending?.contentHash !== marker.contentHash) {
          return mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer) })
        }
        return mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { automaticProfilePending: null }) })
      }, (latestCustomer) => latestCustomer.automaticProfilePending?.contentHash !== marker.contentHash)
      return true
    } catch (error) {
      this.audit('CLEAR_AUTOMATIC_PROFILE_PENDING', customerId, marker.actorId || '', 'PENDING', error?.code || 'AUTO_PENDING_CLEAR_FAILED')
      return false
    }
  }

  async stampAutomaticProfilePendingError(customerId, marker, errorCode) {
    if (!customerId || !marker?.contentHash) return false
    if (this.load === FeishuRepository.prototype.load && !scopedReadStore.getStore()) {
      return this.withCustomerScope(customerId, 'STAMP_PENDING', () => this.stampAutomaticProfilePendingError(customerId, marker, errorCode))
    }
    const database = await this.load({ force: true })
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!row) return false
    const existing = customer(row).automaticProfilePending
    // Never stamp/write an old marker over a newer or missing different pending.
    if (existing?.contentHash !== marker.contentHash) return false
    const stamped = {
      ...existing,
      lastErrorCode: text(errorCode) || 'AUTO_SOURCE_QUEUE_FAILED',
      lastErrorAt: now(),
    }
    try {
      await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => {
        const current = latestCustomer.automaticProfilePending
        if (current?.contentHash !== marker.contentHash) {
          throw Object.assign(new Error('automatic profile pending hash mismatch'), { code: 'AUTO_PENDING_HASH_MISMATCH', status: 409 })
        }
        return mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { automaticProfilePending: { ...current, lastErrorCode: stamped.lastErrorCode, lastErrorAt: stamped.lastErrorAt } }) })
      }, (latestCustomer) => latestCustomer.automaticProfilePending?.contentHash === marker.contentHash && latestCustomer.automaticProfilePending?.lastErrorCode === stamped.lastErrorCode)
      return true
    } catch (error) {
      if (error?.code === 'AUTO_PENDING_HASH_MISMATCH') return false
      this.audit('STAMP_AUTOMATIC_PROFILE_PENDING_ERROR', customerId, marker.actorId || '', 'PENDING', error?.code || 'AUTO_PENDING_STAMP_FAILED')
      return false
    }
  }

  async ensureAutomaticProfilePending(customerId, marker) {
    if (!customerId || !marker?.contentHash) return false
    if (this.load === FeishuRepository.prototype.load && !scopedReadStore.getStore()) {
      return this.withCustomerScope(customerId, 'ENSURE_PENDING', () => this.ensureAutomaticProfilePending(customerId, marker))
    }
    const database = await this.load({ force: true })
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!row) return false
    const existing = customer(row).automaticProfilePending
    if (existing?.contentHash === marker.contentHash) return true
    // Different hash means a newer/other pending already exists — never overwrite.
    if (existing?.contentHash && existing.contentHash !== marker.contentHash) return false
    try {
      await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => {
        const current = latestCustomer.automaticProfilePending
        if (current?.contentHash === marker.contentHash) {
          return mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer) })
        }
        if (current?.contentHash && current.contentHash !== marker.contentHash) {
          throw Object.assign(new Error('newer automatic profile pending present'), { code: 'AUTO_PENDING_NEWER_EXISTS', status: 409 })
        }
        return mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { automaticProfilePending: marker }) })
      }, (latestCustomer) => latestCustomer.automaticProfilePending?.contentHash === marker.contentHash)
      return true
    } catch (error) {
      if (error?.code === 'AUTO_PENDING_NEWER_EXISTS') return false
      this.audit('ENSURE_AUTOMATIC_PROFILE_PENDING', customerId, marker.actorId || '', 'PENDING', error?.code || 'AUTO_PENDING_ENSURE_FAILED')
      return false
    }
  }

  resetAutoRecoveryCircuitIfNeeded() {
    const day = new Date().toISOString().slice(0, 10)
    if (this.autoRecoveryCircuit.day !== day) this.autoRecoveryCircuit = { day, count: 0, paused: false }
  }

  noteAutoRecoverySchedule() {
    this.resetAutoRecoveryCircuitIfNeeded()
    this.autoRecoveryCircuit.count += 1
    if (this.autoRecoveryCircuit.count > AUTO_RECOVERY_CIRCUIT_MAX_PER_DAY) {
      this.autoRecoveryCircuit.paused = true
      this.audit('RECOVER_AUTOMATIC_PROCESSING', '', '', 'FAIL', 'AUTO_RECOVERY_CIRCUIT_OPEN')
    }
  }

  async stampAutoRetryCapReached(source) {
    if (!source?._recordId || source.processingError === AUTO_RETRY_CAP_REACHED) return false
    if (!hasReachedAutoRetryCap(source)) return false
    if (isNonRetryableAutoProcessingError(source.processingError) && source.processingError !== AUTO_RETRY_CAP_REACHED) return false
    const stampedAt = now()
    await updateMappedRecord('sourceRecords', 'source.processing.auto_retry_cap', source._recordId, {
      processing_status: 'FAILED',
      processing_error: AUTO_RETRY_CAP_REACHED,
      last_processing_at: stampedAt,
      updated_at: stampedAt,
    }).catch(() => {})
    this.audit('RECOVER_AUTOMATIC_PROCESSING', source.id, '', 'FAIL', AUTO_RETRY_CAP_REACHED)
    return true
  }

  async recoverAutomaticProcessing() {
    if (!config.features.automaticProfileArchiving) return { status: 'DISABLED', scheduledCustomers: 0, scheduledSources: 0 }
    if (this.autoProcessingRecoveryRunning) return { status: 'RUNNING', scheduledCustomers: 0, scheduledSources: 0 }
    this.resetAutoRecoveryCircuitIfNeeded()
    if (this.autoRecoveryCircuit.paused) {
      this.audit('RECOVER_AUTOMATIC_PROCESSING', '', '', 'FAIL', 'AUTO_RECOVERY_CIRCUIT_OPEN')
      return { status: 'CIRCUIT_OPEN', scheduledCustomers: 0, scheduledSources: 0 }
    }
    this.autoProcessingRecoveryRunning = true
    let scheduledCustomers = 0
    let scheduledSources = 0
    try {
      const database = await this.load({ force: true })
      const fallbackActor = database.staff.find((item) => item.permissionRole === 'ADMIN' && item.status === 'ACTIVE' && item.loginEnabled === true)?.id
      for (const customer of database.customers.filter((item) => automaticProfileArchivingAllowedForCustomer(item.id) && automaticProfileEventAllowed(item.automaticProfilePending?.createdAt) && item.automaticProfilePending?.contentHash).slice(0, 10)) {
        const pending = customer.automaticProfilePending
        const actorId = database.staff.some((item) => item.id === pending.actorId && item.status === 'ACTIVE') ? pending.actorId : fallbackActor
        const recoveredText = automaticProfileTextFromCustomer(customer)
        if (contentHash(recoveredText) !== pending.contentHash) {
          this.audit('RECOVER_AUTOMATIC_PROCESSING', customer.id, actorId || '', 'PENDING', 'AUTOMATIC_PROFILE_REFERENCE_CHANGED')
          continue
        }
        if (actorId) {
          this.scheduleAutomaticCustomerProfile(actorId, customer.id, recoveredText, pending.reason || 'RECOVERY')
          scheduledCustomers += 1
        }
      }
      for (const source of database.sourceRecords.filter((item) => automaticProfileArchivingAllowedForCustomer(item.customerId) && automaticProfileEventAllowed(item.createdAt || item.uploadedAt || item.occurredAt || item.processingStartedAt))) {
        if (!shouldAutoRecoverSource(source)) {
          if (hasReachedAutoRetryCap(source) && ['FAILED', 'PROCESSING'].includes(source.processingStatus)) await this.stampAutoRetryCapReached(source)
          continue
        }
        if (this.autoRecoveryCircuit.paused || scheduledSources >= 10) break
        const actorId = database.staff.some((item) => item.id === source.uploadedBy && item.status === 'ACTIVE') ? source.uploadedBy : fallbackActor
        if (!actorId) continue
        this.noteAutoRecoverySchedule()
        this.scheduleAutomaticProcessing(actorId, source.id)
        scheduledSources += 1
      }
      return { status: 'OK', scheduledCustomers, scheduledSources }
    } finally {
      this.autoProcessingRecoveryRunning = false
    }
  }

  async queueAutomaticCustomerProfile(actorId, customerId, rawText, reason) {
    if (!automaticProfileArchivingAllowedForCustomer(customerId)) return { status: 'DISABLED' }
    const normalizedText = normalizeSourceRawText(rawText)
    if (!normalizedText) return { status: 'NOT_REQUIRED' }
    const marker = automaticProfilePendingMarker(normalizedText, actorId, reason)
    const sourceOperationId = stableOperationId(`${customerId}:${contentHash(normalizedText)}`, 'AUTO-SOURCE')
    try {
      const source = await this.createSource(actorId, { customerId, sourceType: 'TEXT_INPUT', rawText: normalizedText, operationId: sourceOperationId, sourcePerspective: 'STAFF_REPORTED', notes: `${AUTO_PROFILE_SOURCE_PREFIX}${reason}` })
      // Clearing the recovery marker is best-effort housekeeping. It must not
      // keep a successful source enqueue (or the customer-save response) open.
      // clearAutomaticProfilePending now also requires a visible SourceRecords row.
      void this.clearAutomaticProfilePending(customerId, marker)
        .catch((error) => this.audit('CLEAR_AUTOMATIC_PROFILE_PENDING', customerId, actorId, 'PENDING', error?.code || 'AUTO_PENDING_CLEAR_FAILED'))
      if (!['COMPLETED', 'REVIEW_REQUIRED'].includes(source.processingStatus)) this.scheduleAutomaticProcessing(actorId, source.id)
      return { status: 'QUEUED', sourceId: source.id }
    } catch (error) {
      if (error?.code === 'SOURCE_DUPLICATE' && error?.sourceId) {
        void this.clearAutomaticProfilePending(customerId, marker)
          .catch((clearError) => this.audit('CLEAR_AUTOMATIC_PROFILE_PENDING', customerId, actorId, 'PENDING', clearError?.code || 'AUTO_PENDING_CLEAR_FAILED'))
        this.scheduleAutomaticProcessing(actorId, error.sourceId)
        return { status: 'QUEUED', sourceId: error.sourceId, reused: true }
      }
      this.audit('QUEUE_AUTOMATIC_CUSTOMER_PROFILE', customerId, actorId, 'PENDING', error?.code || 'AUTO_SOURCE_QUEUE_FAILED')
      void this.stampAutomaticProfilePendingError(customerId, marker, error?.code || 'AUTO_SOURCE_QUEUE_FAILED')
        .catch((stampError) => this.audit('STAMP_AUTOMATIC_PROFILE_PENDING_ERROR', customerId, actorId, 'PENDING', stampError?.code || 'AUTO_PENDING_STAMP_FAILED'))
      return { status: 'PENDING', errorCode: error?.code || 'AUTO_SOURCE_QUEUE_FAILED' }
    }
  }

  async recoverAutomaticCustomerProfile(actorId, customerId) {
    const requestedCustomerId = text(customerId).trim()
    if (!requestedCustomerId) throw Object.assign(new Error('customerId 必填'), { code: 'CUSTOMER_ID_REQUIRED', status: 400 })
    if (!config.features.automaticProfileArchiving) return { status: 'DISABLED', customerId: requestedCustomerId }
    if (!automaticProfileArchivingAllowedForCustomer(requestedCustomerId)) return { status: 'DISABLED', customerId: requestedCustomerId }
    if (this.load === FeishuRepository.prototype.load && !scopedReadStore.getStore()) {
      return this.withCustomerScope(requestedCustomerId, 'RECOVER_CUSTOMER', () => this.recoverAutomaticCustomerProfile(actorId, customerId))
    }

    const database = await this.load({ force: true })
    const customer = database.customers.find((item) => item.id === requestedCustomerId)
    if (!customer) throw Object.assign(new Error('客户不存在'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })

    const recoveredText = automaticProfileTextFromCustomer(customer)
    if (!recoveredText) return { status: 'NOT_REQUIRED', customerId: requestedCustomerId }

    const eventAt = customer.automaticProfilePending?.createdAt || customer.createdAt || now()
    if (!automaticProfileEventAllowed(eventAt)) return { status: 'DISABLED', customerId: requestedCustomerId, reason: 'BEFORE_ENABLED_AT' }

    const textHash = contentHash(recoveredText)
    const existingSource = findMatchingAutomaticProfileSource(database.sourceRecords, requestedCustomerId, textHash)
    const fallbackActor = database.staff.find((item) => item.permissionRole === 'ADMIN' && item.status === 'ACTIVE' && item.loginEnabled === true)?.id
    const resolvedActorId = database.staff.some((item) => item.id === actorId && item.status === 'ACTIVE')
      ? actorId
      : (customer.automaticProfilePending?.actorId && database.staff.some((item) => item.id === customer.automaticProfilePending.actorId && item.status === 'ACTIVE')
        ? customer.automaticProfilePending.actorId
        : fallbackActor)
    if (!resolvedActorId) return { status: 'FAILED', customerId: requestedCustomerId, errorCode: 'NO_ACTIVE_ACTOR' }

    if (existingSource) {
      if (customer.automaticProfilePending?.contentHash === textHash) {
        void this.clearAutomaticProfilePending(requestedCustomerId, customer.automaticProfilePending)
          .catch((error) => this.audit('CLEAR_AUTOMATIC_PROFILE_PENDING', requestedCustomerId, resolvedActorId, 'PENDING', error?.code || 'AUTO_PENDING_CLEAR_FAILED'))
      }
      const stage = mapAutomaticProfileStageFromSource(existingSource)
      if (['SOURCE_CREATED', 'PROCESSING', 'FAILED'].includes(stage) && !hasReachedAutoRetryCap(existingSource) && !isNonRetryableAutoProcessingError(existingSource.processingError)) {
        this.scheduleAutomaticProcessing(resolvedActorId, existingSource.id)
        return {
          status: stage === 'FAILED' ? 'PROCESSING' : stage,
          customerId: requestedCustomerId,
          sourceId: existingSource.id,
          reused: true,
          scheduledProcessing: true,
        }
      }
      return {
        status: stage,
        customerId: requestedCustomerId,
        sourceId: existingSource.id,
        reused: true,
        scheduledProcessing: false,
      }
    }

    const reason = customer.automaticProfilePending?.reason || 'RECOVERY'
    const marker = automaticProfilePendingMarker(recoveredText, resolvedActorId, reason)
    const ensured = await this.ensureAutomaticProfilePending(requestedCustomerId, marker)
    if (!ensured) {
      return { status: 'PENDING', customerId: requestedCustomerId, errorCode: 'AUTO_PENDING_ENSURE_FAILED' }
    }
    const queued = await this.queueAutomaticCustomerProfile(resolvedActorId, requestedCustomerId, recoveredText, reason)
    if (queued.status === 'QUEUED') {
      return {
        status: 'SOURCE_CREATED',
        customerId: requestedCustomerId,
        sourceId: queued.sourceId,
        reused: Boolean(queued.reused),
        scheduledProcessing: true,
      }
    }
    if (queued.status === 'PENDING') {
      return { status: 'PENDING', customerId: requestedCustomerId, errorCode: queued.errorCode || 'AUTO_SOURCE_QUEUE_FAILED' }
    }
    return { status: queued.status || 'FAILED', customerId: requestedCustomerId, errorCode: queued.errorCode }
  }

  async loadStaffRecords({ force = false } = {}) {
    if (this.load !== FeishuRepository.prototype.load) {
      const database = await this.load({ force })
      return (database.staff || []).map((item) => ({ ...item }))
    }
    const nowMs = Date.now()
    if (!force && this.staffCache.data && nowMs - this.staffCache.savedAt < 45_000) return this.staffCache.data.map((item) => ({ ...item }))
    if (!force && this.staffCache.promise) return this.staffCache.promise
    const startedAt = Date.now()
    const request = (async () => {
      const rows = config.feishu.tables.staff ? await listRecords(config.feishu.tables.staff) : []
      const records = rows.map(staff)
      this.staffCache.data = records
      this.staffCache.savedAt = Date.now()
      if (config.appEnv === 'development') console.info('[ASVA_PERF_CACHE]', JSON.stringify({ cache: 'staff', state: 'MISS', duration_ms: Date.now() - startedAt, row_count: records.length }))
      return records.map((item) => ({ ...item }))
    })()
    this.staffCache.promise = request
    request.finally(() => { if (this.staffCache.promise === request) this.staffCache.promise = null }).catch(() => {})
    return request
  }

  async loadDirectory({ force = false, maxAgeMs = 45_000 } = {}) {
    const nowMs = Date.now()
    if (!force && this.directoryCache.data && nowMs - this.directoryCache.savedAt < maxAgeMs) {
      if (config.appEnv === 'development') console.info('[ASVA_PERF_CACHE]', JSON.stringify({ cache: 'directory', state: 'HIT', age_ms: nowMs - this.directoryCache.savedAt }))
      return cloneDatabase(this.directoryCache.data)
    }
    if (!force && this.directoryCache.promise) {
      if (config.appEnv === 'development') console.info('[ASVA_PERF_CACHE]', JSON.stringify({ cache: 'directory', state: 'IN_FLIGHT' }))
      return this.directoryCache.promise.then(cloneDatabase)
    }
    const generation = this.directoryCache.generation
    const startedAt = Date.now()
    const request = this.loadDirectoryFresh().then((database) => {
      if (this.directoryCache.generation === generation) { this.directoryCache.data = cloneDatabase(database); this.directoryCache.savedAt = Date.now() }
      if (config.appEnv === 'development') console.info('[ASVA_PERF_DIRECTORY_READ]', JSON.stringify({ table_count: 4, duration_ms: Date.now() - startedAt, customer_count: database.customers.length }))
      return database
    })
    this.directoryCache.promise = request
    request.finally(() => { if (this.directoryCache.promise === request) this.directoryCache.promise = null }).catch(() => {})
    return request
  }

  async loadDirectoryFresh() {
    const entries = [['customers', config.feishu.tables.customers], ['staff', config.feishu.tables.staff], ['products', config.feishu.tables.products], ['enrollments', config.feishu.tables.enrollments]]
    const rows = await Promise.all(entries.map(async ([table, tableId]) => tableId ? listRecords(tableId) : []))
    const [customerRows, staffRows, productRows, enrollmentRows] = rows
    const customers = customerRows.map(customer)
    return {
      staff: staffRows.map(staff), customers, appointments: [], sessions: [], followups: [], products: productRows.map(product), enrollments: enrollmentRows.map(enrollment), profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
      _rows: { customers: customerRows, staff: staffRows, products: productRows, enrollments: enrollmentRows },
      _missingRepositories: config.feishu.tables.enrollments ? [] : ['EnrollmentRepository'],
    }
  }

  freshFullDatabase() {
    const nowMs = Date.now()
    return this.databaseCache.data && nowMs - this.databaseCache.savedAt < 45_000 ? cloneDatabase(this.databaseCache.data) : null
  }

  customerReadDatabase({ customerRows = [], staffRows = [], sourceRows = [], evidenceRows = [], conflictRows = [] } = {}) {
    const sourceRecords = sourceRows.map(sourceRecord)
    const allEvidenceItems = evidenceRows.map(evidenceItem)
    const evidenceItems = allEvidenceItems.filter((item) => {
      if (item.reviewStatus === 'CONFIRMED') return true
      if (item.reviewStatus !== 'PENDING_REVIEW') return false
      const source = sourceRecords.find((candidate) => candidate.id === item.sourceId)
      return !source?.lastBatchId || source.lastBatchId === item.extractionBatchId
    })
    const activeEvidenceIds = new Set(evidenceItems.map((item) => item.id))
    return {
      staff: staffRows.map(staff), customers: customerRows.map(customer), appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords, evidenceItems,
      profileUpdateProposals: [], evidenceConflicts: conflictRows.map(conflictRecord).filter((item) => activeEvidenceIds.has(item.newEvidenceId) || activeEvidenceIds.has(item.currentEvidenceId)),
      _missingRepositories: [], _allEvidenceItems: allEvidenceItems,
      _rows: { appointments: [], customers: customerRows, services: [], staff: staffRows, products: [], enrollments: [], profileChanges: [], sourceRecords: sourceRows, evidenceItems: evidenceRows, profileUpdateProposals: [], evidenceConflicts: conflictRows },
    }
  }

  async loadProfileRead({ force = false } = {}) {
    if (this.load !== FeishuRepository.prototype.load) return this.load({ force })
    const full = !force ? this.freshFullDatabase() : null
    if (full) return full
    const nowMs = Date.now()
    if (!force && this.profileReadCache.data && nowMs - this.profileReadCache.savedAt < 45_000) return cloneDatabase(this.profileReadCache.data)
    if (!force && this.profileReadCache.promise) return this.profileReadCache.promise.then(cloneDatabase)
    const generation = this.profileReadCache.generation
    const request = this.loadProfileReadFresh().then((database) => {
      if (this.profileReadCache.generation === generation) { this.profileReadCache.data = cloneDatabase(database); this.profileReadCache.savedAt = Date.now() }
      return database
    })
    this.profileReadCache.promise = request
    request.finally(() => { if (this.profileReadCache.promise === request) this.profileReadCache.promise = null }).catch(() => {})
    return request.then(cloneDatabase)
  }

  async loadProfileReadFresh() {
    const entries = [['customers', config.feishu.tables.customers], ['staff', config.feishu.tables.staff], ['sourceRecords', config.feishu.tables.sourceRecords], ['evidenceItems', config.feishu.tables.evidenceItems]]
    const rows = await Promise.all(entries.map(async ([table, tableId]) => tableId ? listRecords(tableId) : []))
    const [customerRows, staffRows, sourceRows, evidenceRows] = rows
    return this.customerReadDatabase({ customerRows, staffRows, sourceRows, evidenceRows })
  }

  async loadUnderstandingConflicts({ force = false } = {}) {
    const nowMs = Date.now()
    if (!force && this.understandingConflictCache.data && nowMs - this.understandingConflictCache.savedAt < 45_000) return this.understandingConflictCache.data.map((item) => ({ ...item }))
    if (!force && this.understandingConflictCache.promise) return this.understandingConflictCache.promise.then((items) => items.map((item) => ({ ...item })))
    const generation = this.understandingConflictCache.generation
    const request = (async () => {
      const rows = config.feishu.tables.evidenceConflicts ? await listRecords(config.feishu.tables.evidenceConflicts) : []
      const records = rows.map(conflictRecord)
      if (this.understandingConflictCache.generation === generation) { this.understandingConflictCache.data = records; this.understandingConflictCache.savedAt = Date.now() }
      return records
    })()
    this.understandingConflictCache.promise = request
    request.finally(() => { if (this.understandingConflictCache.promise === request) this.understandingConflictCache.promise = null }).catch(() => {})
    return request.then((items) => items.map((item) => ({ ...item })))
  }

  async loadUnderstandingRead({ force = false } = {}) {
    if (this.load !== FeishuRepository.prototype.load) return this.load({ force })
    const full = !force ? this.freshFullDatabase() : null
    if (full) return full
    const [profileDatabase, conflicts] = await Promise.all([this.loadProfileRead({ force }), this.loadUnderstandingConflicts({ force })])
    const activeEvidenceIds = new Set(profileDatabase.evidenceItems.map((item) => item.id))
    return { ...profileDatabase, evidenceConflicts: conflicts.filter((item) => activeEvidenceIds.has(item.newEvidenceId) || activeEvidenceIds.has(item.currentEvidenceId)) }
  }

  async loadCustomerSaveContext({ force = false, maxAgeMs = 45_000 } = {}) {
    // Keep isolated repository tests and injected providers on their supplied
    // data source while production uses the small directory projection.
    if (this.load !== FeishuRepository.prototype.load) return this.load({ force })
    return this.loadDirectory({ force, maxAgeMs })
  }

  async load({ force = false } = {}) {
    const scoped = scopedReadStore.getStore()
    if (scoped?.customerId && this.load === FeishuRepository.prototype.load) {
      const lkg = this.lastKnownGoodByCustomer.get(scoped.customerId)
      try {
        return await this.loadCustomerScopedCached(scoped.customerId, { force, scene: scoped.scene || 'SCOPED_AI' })
      } catch (error) {
        if (!error?.retryable || !lkg) throw error
        console.warn('[ASVA_FEISHU_READ]', JSON.stringify({ result: 'LKG_SCOPED', freshness: 'DELAYED', customer_id: scoped.customerId, normalized_error: error.code || 'FEISHU_UNAVAILABLE' }))
        return { ...cloneDatabase(lkg), _dataFreshness: 'DELAYED', _scoped: true, _scopedCustomerId: scoped.customerId }
      }
    }
    const nowMs = Date.now()
    if (!force && this.databaseCache.data && nowMs - this.databaseCache.savedAt < 45_000) {
      if (config.appEnv === 'development') console.info('[ASVA_PERF_CACHE]', JSON.stringify({ cache: 'database', state: 'HIT', age_ms: nowMs - this.databaseCache.savedAt }))
      return cloneDatabase(this.databaseCache.data)
    }
    if (!force && this.databaseCache.promise) {
      if (config.appEnv === 'development') console.info('[ASVA_PERF_CACHE]', JSON.stringify({ cache: 'database', state: 'IN_FLIGHT' }))
      return this.databaseCache.promise.then(cloneDatabase)
    }
    const startedAt = Date.now()
    const generation = this.databaseCache.generation
    const request = this.loadFresh().then((database) => {
      if (this.databaseCache.generation === generation) {
        this.databaseCache.data = cloneDatabase(database)
        this.databaseCache.savedAt = Date.now()
      }
      if (config.appEnv === 'development') console.info('[ASVA_PERF_CACHE]', JSON.stringify({ cache: 'database', state: 'MISS', duration_ms: Date.now() - startedAt }))
      return database
    }).catch((error) => {
      if (!error?.retryable || !this.lastKnownGood) throw error
      console.warn('[ASVA_FEISHU_READ]', JSON.stringify({ result: 'LKG', freshness: 'DELAYED', normalized_error: error.code || 'FEISHU_UNAVAILABLE' }))
      return { ...cloneDatabase(this.lastKnownGood), _dataFreshness: 'DELAYED' }
    })
    this.databaseCache.promise = request
    request.finally(() => { if (this.databaseCache.promise === request) this.databaseCache.promise = null }).catch(() => {})
    try {
      const database = await request
      this.lastKnownGood = cloneDatabase(database)
      // Store per-customer slices only — never deep-clone the full database once per customer.
      for (const customer of database.customers) this.rememberCustomerLastKnownGood(customer.id, database)
      return cloneDatabase(database)
    } catch (error) {
      throw error
    }
  }

  async loadFresh() {
    const entries = [['appointments', config.feishu.tables.appointments], ['customers', config.feishu.tables.customers], ['serviceRecords', config.feishu.tables.serviceRecords], ['staff', config.feishu.tables.staff], ['products', config.feishu.tables.products], ['enrollments', config.feishu.tables.enrollments], ['profileChanges', config.feishu.tables.profileChanges], ['sourceRecords', config.feishu.tables.sourceRecords], ['evidenceItems', config.feishu.tables.evidenceItems], ['profileUpdateProposals', config.feishu.tables.profileUpdateProposals], ['evidenceConflicts', config.feishu.tables.evidenceConflicts]]
    const tableDurations = {}
    const rows = await Promise.all(entries.map(async ([table, tableId]) => {
      if (!tableId) return []
      const startedAt = Date.now()
      const result = await listRecords(tableId)
      tableDurations[table] = Date.now() - startedAt
      return result
    }))
    const [appointmentRows, customerRows, serviceRows, staffRows, productRows, enrollmentRows, profileChangeRows, sourceRows, evidenceRows, proposalRows, conflictRows] = rows
    const customers = customerRows.map(customer)
    const sourceRecords = sourceRows.map(sourceRecord)
    const allEvidenceItems = evidenceRows.map(evidenceItem)
    const evidenceItems = allEvidenceItems.filter((item) => {
      if (item.reviewStatus === 'CONFIRMED') return true
      if (item.reviewStatus !== 'PENDING_REVIEW') return false
      const source = sourceRecords.find((candidate) => candidate.id === item.sourceId)
      return !source?.lastBatchId || source.lastBatchId === item.extractionBatchId
    })
    const activeEvidenceIds = new Set(evidenceItems.map((item) => item.id))
    const proposals = proposalRows.map(proposalRecord).filter((item) => activeEvidenceIds.has(item.evidenceId))
    const conflicts = conflictRows.map(conflictRecord).filter((item) => activeEvidenceIds.has(item.newEvidenceId) || activeEvidenceIds.has(item.currentEvidenceId))
    for (const item of customers) {
      const customerEvidence = evidenceItems.filter((evidence) => evidence.customerId === item.id)
      const profileEvidence = profileMaterializationEvidence({ evidenceItems: customerEvidence, sourceRecords, customer: item, actor: { permissionRole: 'ADMIN' } })
      item.profileMaterialization = materializeCustomerProfile({ customer: item, evidenceItems: profileEvidence, summaryMeta: item.aiSummaryMeta })
      const currentFingerprint = understandingInputFingerprint({ customer: item, evidenceItems: customerEvidence, conflicts: conflicts.filter((conflict) => conflict.customerId === item.id) })
      if (!item.understandingMeta || item.understandingMeta.inputFingerprint !== currentFingerprint || item.understandingMeta.promptVersion !== CUSTOMER_UNDERSTANDING_PROMPT_VERSION) item.understandingStatus = 'STALE'
    }
    if (config.appEnv === 'development') console.info('[ASVA_PERF_DASHBOARD_READ]', JSON.stringify({ external_request_count: entries.filter(([, tableId]) => Boolean(tableId)).length, parallel: true, table_durations_ms: tableDurations }))
    return {
      staff: staffRows.map(staff), customers, appointments: appointmentRows.map(appointment), sessions: serviceRows.map(service), followups: [], products: productRows.map(product), enrollments: enrollmentRows.map(enrollment), profileChanges: profileChangeRows.map(profileChange), sourceRecords, evidenceItems, profileUpdateProposals: proposals, evidenceConflicts: conflicts,
      _missingRepositories: config.feishu.tables.enrollments ? [] : ['EnrollmentRepository'],
      _allEvidenceItems: allEvidenceItems,
      _rows: { appointments: appointmentRows, customers: customerRows, services: serviceRows, staff: staffRows, products: productRows, enrollments: enrollmentRows, profileChanges: profileChangeRows, sourceRecords: sourceRows, evidenceItems: evidenceRows, profileUpdateProposals: proposalRows, evidenceConflicts: conflictRows },
    }
  }

  async scopedDirectory(actorId) {
    return scope(await this.loadDirectory(), actorId)
  }

  async customerDirectory(actorId) {
    return publicDirectoryDto(await this.scopedDirectory(actorId))
  }

  async loadCustomerDetailFresh(customerId, directory) {
    const entries = [['appointments', config.feishu.tables.appointments], ['serviceRecords', config.feishu.tables.serviceRecords], ['profileChanges', config.feishu.tables.profileChanges]]
    const startedAt = Date.now()
    const rows = await Promise.all(entries.map(async ([table, tableId]) => tableId ? listRecords(tableId) : []))
    const [appointmentRows, serviceRows, profileChangeRows] = rows
    const customerRecord = directory.customers.find((item) => item.id === customerId)
    if (!customerRecord) throw Object.assign(new Error('客户不存在'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const detailDatabase = {
      staff: directory.staff,
      customers: [{ ...customerRecord }],
      appointments: appointmentRows.map(appointment).filter((item) => item.customerId === customerId),
      sessions: serviceRows.map(service).filter((item) => item.customerId === customerId),
      followups: [],
      products: directory.products,
      enrollments: directory.enrollments.filter((item) => item.customerId === customerId),
      profileChanges: profileChangeRows.map(profileChange).filter((item) => item.customerId === customerId),
      sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
    }
    if (config.appEnv === 'development') console.info('[ASVA_PERF_CUSTOMER_DETAIL_READ]', JSON.stringify({ table_count: entries.filter(([, tableId]) => Boolean(tableId)).length, duration_ms: Date.now() - startedAt, customer_id_present: Boolean(customerRecord) }))
    return detailDatabase
  }

  async customerDetail(actorId, customerId) {
    const directory = await this.scopedDirectory(actorId)
    if (!directory.customers.some((item) => item.id === customerId)) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const detail = await this.loadCustomerDetailFresh(customerId, directory)
    return publicCustomerDetailDto(detail)
  }

  async customerProfile(actorId, customerId) {
    requireStage2Tables()
    const database = await this.loadProfileRead()
    const visibleDatabase = scope(database, actorId)
    const customer = visibleDatabase.customers.find((item) => item.id === customerId)
    if (!customer) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    // Single-customer auto resume: if durable pending remains (e.g. prior setImmediate lost
    // after CloudBase freeze), kick recover without restoring 11-table / 30s scanners.
    if (customer.automaticProfilePending?.contentHash || this.instancePendingAutoProfiles.has(customerId)) {
      void this.maybeResumeAutomaticCustomerProfile(actorId, customerId)
    }
    const actor = database.staff.find((item) => item.id === actorId)
    const evidenceItems = profileMaterializationEvidence({ evidenceItems: visibleDatabase.evidenceItems, sourceRecords: visibleDatabase.sourceRecords, customer, actor })
    const profileMaterialization = materializeCustomerProfile({ customer, evidenceItems, summaryMeta: customer.aiSummaryMeta })
    return publicCustomerProfile(customer, profileMaterialization, automaticProfileStatus(database.sourceRecords, database.evidenceItems, customer.id))
  }

  async loadAfterWrite(writeResult, targetCustomerId, { allowMissingCustomerRetry = Boolean(writeResult && targetCustomerId) } = {}) {
    this.invalidateDatabaseCache()
    const writeRecordId = writeResult?.record?.record_id || writeResult?.record_id || writeResult?.record?.id
    const result = await boundedReadAfterWrite(async () => {
      const database = await this.load()
      if (database._dataFreshness === 'DELAYED') return { ...database, _persistenceStatus: 'COMMITTED' }
      if (targetCustomerId && !database.customers.some((item) => item.id === targetCustomerId)) {
        if (!allowMissingCustomerRetry) throw Object.assign(new Error('客户不存在'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
        throw new FeishuUnavailableError('写入后暂未读到目标记录', { retryable: true, operation: 'readback_customer' })
      }
      return database
    }, { delays: READ_AFTER_WRITE_DELAYS_MS })
    if (result.value?._dataFreshness === 'DELAYED') {
      console.warn('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: writeRecordId, target_customer_id: targetCustomerId, readback_status: 'READBACK_DELAYED', write_status: 'WRITE_COMMITTED', final_result: 'SUCCESS' }))
      return result.value
    }
    if (result.value) {
      console.info('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: writeRecordId, target_customer_id: targetCustomerId, readback_status: 'READBACK_SUCCESS', retry_count: result.attempts - 1, final_result: 'SUCCESS' }))
      return result.value
    }
    const error = result.lastError
    console.error('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: writeRecordId, target_customer_id: targetCustomerId, readback_status: 'READBACK_FAILED', retry_count: result.attempts - 1, final_result: 'FAIL', provider_code: error?.providerCode, provider_request_id: error?.providerRequestId }))
    const fallback = targetCustomerId ? this.lastKnownGoodByCustomer.get(targetCustomerId) : this.lastKnownGood
    if (fallback) {
      console.warn('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: writeRecordId, target_customer_id: targetCustomerId, readback_status: 'READBACK_DELAYED', write_status: 'WRITE_COMMITTED', final_result: 'SUCCESS' }))
      return { ...cloneDatabase(fallback), _dataFreshness: 'DELAYED', _persistenceStatus: 'COMMITTED' }
    }
    console.warn('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: writeRecordId, target_customer_id: targetCustomerId, readback_status: 'READBACK_UNAVAILABLE', write_status: 'WRITE_COMMITTED', final_result: 'SUCCESS' }))
    return { ...(this.lastKnownGood ? cloneDatabase(this.lastKnownGood) : { staff: [], customers: [], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {} }), _dataFreshness: 'DELAYED', _persistenceStatus: 'COMMITTED' }
  }

  async loadCustomerAfterWrite(writeResult, targetCustomerId, baseDatabase, { delays = READ_AFTER_WRITE_DELAYS_MS } = {}) {
    const recordId = writeResult?.record?.record_id || writeResult?.record_id || writeResult?.record?.id
    if (!recordId || !config.feishu.tables.customers) return this.loadAfterWrite(writeResult, targetCustomerId)
    const result = await boundedReadAfterWrite(async () => {
      const row = await getRecord(config.feishu.tables.customers, recordId)
      if (!row) throw new FeishuUnavailableError('写入后暂未读到目标客户', { retryable: true, operation: 'readback_customer_by_id', customerId: targetCustomerId })
      const parsed = customer(row)
      if (parsed.id !== targetCustomerId) throw Object.assign(new Error('写入回读客户不匹配'), { code: 'CUSTOMER_READBACK_MISMATCH', status: 502 })
      return { row, parsed }
    }, { delays })
    if (!result.value) {
      // Feishu has acknowledged the write. Keep the targeted result path bounded;
      // a delayed readback must not trigger an unrelated 11-table reload.
      console.warn('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: recordId, target_customer_id: targetCustomerId, readback_status: 'READBACK_DELAYED', write_status: 'WRITE_COMMITTED', final_result: 'SUCCESS' }))
      const next = cloneDatabase(baseDatabase)
      this.rememberCustomerLastKnownGood(targetCustomerId, next)
      return { ...next, _persistenceStatus: 'COMMITTED', _dataFreshness: 'DELAYED' }
    }
    const next = cloneDatabase(baseDatabase)
    next.customers = next.customers.some((item) => item.id === targetCustomerId)
      ? next.customers.map((item) => item.id === targetCustomerId ? result.value.parsed : item)
      : [...next.customers, result.value.parsed]
    next._rows = { ...(next._rows || {}), customers: [...(next._rows?.customers || []).filter((item) => item.record_id !== recordId && text(get('customers', item.fields, 'customer_id')) !== targetCustomerId), result.value.row] }
    this.rememberCustomerLastKnownGood(targetCustomerId, next)
    return { ...next, _persistenceStatus: 'COMMITTED' }
  }

  applyCustomerMutationRow(database, row, targetCustomerId) {
    if (!row) return database
    const parsed = customer(row)
    if (parsed.id !== targetCustomerId) throw Object.assign(new Error('客户更新回读不匹配'), { code: 'CUSTOMER_READBACK_MISMATCH', status: 502 })
    const next = cloneDatabase(database)
    next.customers = next.customers.some((item) => item.id === targetCustomerId)
      ? next.customers.map((item) => item.id === targetCustomerId ? parsed : item)
      : [...next.customers, parsed]
    next._rows = { ...(next._rows || {}), customers: [...(next._rows?.customers || []).filter((item) => item.record_id !== row.record_id && text(get('customers', item.fields, 'customer_id')) !== targetCustomerId), row] }
    this.rememberCustomerLastKnownGood(targetCustomerId, next)
    return { ...next, _persistenceStatus: 'COMMITTED' }
  }

  async dashboard(staffId) { return scope(await this.load(), staffId) }
  async basicDashboard(staffId) {
    const database = publicDirectoryDto(await this.scopedDirectory(staffId))
    const actor = database.staff.find((item) => item.id === staffId)
    if (!actor || actor.status !== 'ACTIVE' || actor.loginEnabled !== true) throw new Error('无权查看数据看板')
    return buildBasicDashboard(database)
  }
  async assistantQuery(actorId, question, context) {
    try {
      const database = await this.load()
      const visibleDatabase = scope(database, actorId)
      const result = await queryAssistant(visibleDatabase, question, context, actorId)
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
    const record = (await this.loadStaffRecords()).find((item) => item.id === staffId)
    if (!record) throw new Error('账号不存在')
    if (record.status !== 'ACTIVE') throw new Error('该账户已停用，请联系管理员。')
    return record
  }
  async validateSession(staffId, authVersion, sessionAuthMode = '') {
    // Preserve both authorization checks, but do not serialize independent
    // Staff and AuthCredentials reads on a cold CloudBase instance.
    if (config.authMode === 'PASSWORD' && sessionAuthMode !== 'PASSWORD') throw invalidLogin()
    const [account, credential] = await Promise.all([
      this.staff(staffId),
      config.authMode === 'PASSWORD' ? this.authRepository.findByStaffId(staffId) : Promise.resolve(null),
    ])
    if (config.authMode === 'PASSWORD' && (!credential || credential.credentialStatus === 'DISABLED' || Number(credential.authVersion || 0) !== Number(authVersion || 0))) throw invalidLogin()
    return { account, credential }
  }
  async authenticate(phone, secret, ip = 'unknown') {
    if (loginRateLimiter.isBlocked(phone, ip)) throw Object.assign(new Error('登录尝试过于频繁，请稍后再试'), { code: 'AUTH_RATE_LIMITED', status: 429 })
    const database = { staff: await this.loadStaffRecords() }
    const normalized = normalizePhone(phone)
    const account = database.staff.find((item) => normalizePhone(item.phone) === normalized)
    const validStaff = ['ADMIN', 'MENTOR'].includes(account?.permissionRole) && account.status === 'ACTIVE' && account.loginEnabled === true
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
      // 非阻塞记录登录成功，避免飞书写入延迟影响登录响应
      this.authRepository.recordSuccessfulLogin(account.id).catch(err => {
        console.warn('[AUTH] recordSuccessfulLogin failed:', err?.message || err)
      })
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
    this.invalidateDatabaseCache()
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
    this.invalidateDatabaseCache()
    const account = await this.staff(staffId)
    const credential = await this.authRepository.findByStaffId(staffId)
    const hasCurrentPassword = typeof currentPassword === 'string' && currentPassword.length > 0
    const currentMatches = await verifyPassword(currentPassword, credential?.passwordHash || dummyPasswordHash)
    const firstChangeGuard = credential?.mustChangePassword === true && !hasCurrentPassword
    if (!credential || (!currentMatches && !firstChangeGuard)) throw Object.assign(new Error('当前密码不正确'), { code: 'PASSWORD_INVALID', status: 401 })
    validatePassword(nextPassword, { phone: account.phone })
    if (await verifyPassword(nextPassword, credential.passwordHash)) {
      const code = credential.mustChangePassword ? PASSWORD_POLICY_CODES.SAME_AS_TEMPORARY : 'PASSWORD_REUSE_NOT_ALLOWED'
      const message = credential.mustChangePassword ? '新密码不能与初始密码相同' : '新密码不能与当前密码相同'
      throw Object.assign(new Error(message), { code, status: 400 })
    }
    const timestamp = now()
    await this.authRepository.updatePassword(credential, await hashPassword(nextPassword), { password_algorithm: 'scrypt', must_change_password: false, password_changed_at: timestamp, auth_version: Number(credential.authVersion || 0) + 1, credential_status: 'ACTIVE', updated_at: timestamp })
    return { ok: true, mustChangePassword: false, authVersion: Number(credential.authVersion || 0) + 1 }
  }
  async resetPassword(actorId, targetStaffId) {
    this.invalidateDatabaseCache()
    const actor = await this.staff(actorId)
    if (actor.permissionRole !== 'ADMIN') throw new Error('只有 ADMIN 可以重置密码')
    const target = (await this.load()).staff.find((item) => item.id === targetStaffId)
    if (!target) throw new Error('账号不存在')
    const generated = generateInitialPassword({ phone: target.phone })
    validatePassword(generated, { phone: target.phone })
    const current = await this.authRepository.findByStaffId(targetStaffId)
    const timestamp = now()
    const nextVersion = Number(current?.authVersion || 0) + 1
    if (current) await this.authRepository.updatePassword(current, await hashPassword(generated), { password_algorithm: 'scrypt', must_change_password: true, password_changed_at: null, auth_version: nextVersion, credential_status: 'ACTIVE', updated_at: timestamp })
    else await this.authRepository.createCredential({ staffId: targetStaffId, loginPhone: target.phone, passwordHash: await hashPassword(generated), passwordAlgorithm: 'scrypt', mustChangePassword: true, passwordChangedAt: null, authVersion: nextVersion, credentialStatus: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp, lastLoginAt: null })
    this.audit('RESET_PASSWORD', targetStaffId, actorId)
    return { ok: true, staffId: targetStaffId, mustChangePassword: true, authVersion: nextVersion, initialPassword: generated }
  }
  async syncCredentialPhone(staffId, phone) {
    const credential = await this.authRepository.findByStaffId(staffId)
    if (credential) await this.authRepository.updateLoginPhone(staffId, normalizePhone(phone))
  }
  async customer(actorId, customerId) { return (await this.customerDetail(actorId, customerId)).customers.find((item) => item.id === customerId) }

  async getCustomerUnderstanding(actorId, customerId) {
    const database = await this.loadUnderstandingRead()
    const visible = scope(database, actorId)
    const customerRecord = visible.customers.find((item) => item.id === customerId)
    if (!customerRecord) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const evidenceItems = buildConsultationContext({ role: database.staff.find((item) => item.id === actorId)?.permissionRole || 'MENTOR', isAssignedMentor: true, evidenceItems: visible.evidenceItems.filter((item) => item.customerId === customerId), sourceRecords: visible.sourceRecords })
    const conflicts = visible.evidenceConflicts.filter((item) => item.customerId === customerId)
    const context = buildCustomerUnderstandingContext({ customer: customerRecord, evidenceItems, sourceRecords: visible.sourceRecords, conflicts })
    const fingerprint = context.input_fingerprint
    const storedMeta = customerRecord.understandingMeta || {}
    const fresh = storedMeta.status === 'FRESH' && storedMeta.inputFingerprint === fingerprint && storedMeta.promptVersion === CUSTOMER_UNDERSTANDING_PROMPT_VERSION
    const status = fresh ? 'FRESH' : storedMeta.status === 'PROCESSING' ? 'PROCESSING' : storedMeta.status === 'FAILED' ? 'FAILED' : 'STALE'
    const understanding = customerRecord.understanding || createLocalCustomerUnderstanding(context)
    const source = customerRecord.understanding ? storedMeta.provider || 'DEEPSEEK' : 'STRUCTURED_FALLBACK'
    return { customerId, status, understanding, meta: { ...storedMeta, understandingId: storedMeta.understandingId || `UNDERSTANDING-${customerId}`, customerId, understandingVersion: CUSTOMER_UNDERSTANDING_VERSION, status, source, inputFingerprint: storedMeta.inputFingerprint || fingerprint, evidenceFingerprint: storedMeta.evidenceFingerprint || fingerprint, sourceProfileVersion: customerRecord.profileVersion || 0, profileVersion: customerRecord.profileVersion || 0, promptVersion: CUSTOMER_UNDERSTANDING_PROMPT_VERSION }, evidence_refs: context.evidence_refs, context_summary: { coverage_gaps: context.coverage_gaps, evidence_count: context.evidence_refs.length, density: context.context_density } }
  }

  scheduleCustomerUnderstandingRefresh(actorId, customerId) {
    if (!config.deepseek.apiKey) return
    const previous = this.understandingRefreshTimers.get(customerId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.understandingRefreshTimers.delete(customerId)
      void this.refreshCustomerUnderstanding(actorId, customerId).catch((error) => this.audit('REFRESH_CUSTOMER_UNDERSTANDING', customerId, actorId, 'FAIL', error instanceof Error ? error.code || error.message : 'UNDERSTANDING_REFRESH_FAILED'))
    }, 30_000)
    this.understandingRefreshTimers.set(customerId, timer)
  }

  async refreshCustomerUnderstanding(actorId, customerId, { force = false } = {}) {
    return this.customerWriteQueue.run(customerId, () => this.refreshCustomerUnderstandingUnsafe(actorId, customerId, { force }))
  }

  async refreshCustomerUnderstandingUnsafe(actorId, customerId, { force = false } = {}) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    const visible = scope(database, actorId)
    const customerRecord = visible.customers.find((item) => item.id === customerId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!customerRecord || !row) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const evidenceItems = buildConsultationContext({ role: database.staff.find((item) => item.id === actorId)?.permissionRole || 'MENTOR', isAssignedMentor: true, evidenceItems: visible.evidenceItems.filter((item) => item.customerId === customerId), sourceRecords: visible.sourceRecords })
    const conflicts = visible.evidenceConflicts.filter((item) => item.customerId === customerId)
    const context = buildCustomerUnderstandingContext({ customer: customerRecord, evidenceItems, sourceRecords: visible.sourceRecords, conflicts })
    const inputFingerprint = context.input_fingerprint || understandingInputFingerprint({ customer: customerRecord, evidenceItems, conflicts })
    const currentMeta = customerRecord.understandingMeta || {}
    const processingAge = currentMeta.updatedAt ? Date.now() - new Date(currentMeta.updatedAt).getTime() : Number.POSITIVE_INFINITY
    if (!force && currentMeta.status === 'PROCESSING' && processingAge >= 0 && processingAge < 5 * 60 * 1000) return this.getCustomerUnderstanding(actorId, customerId)
    if (!force && currentMeta.status === 'FRESH' && currentMeta.inputFingerprint === inputFingerprint && currentMeta.promptVersion === CUSTOMER_UNDERSTANDING_PROMPT_VERSION) return this.getCustomerUnderstanding(actorId, customerId)
    const processingMeta = { ...currentMeta, understandingId: currentMeta.understandingId || `UNDERSTANDING-${customerId}`, customerId, understandingVersion: CUSTOMER_UNDERSTANDING_VERSION, status: 'PROCESSING', inputFingerprint, evidenceFingerprint: inputFingerprint, sourceProfileVersion: customerRecord.profileVersion || 0, profileVersion: customerRecord.profileVersion || 0, promptVersion: CUSTOMER_UNDERSTANDING_PROMPT_VERSION, provider: 'DEEPSEEK', model: config.deepseek.model, updatedAt: now(), payload: customerRecord.understanding || null }
    const writeMeta = (meta) => updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { understanding: meta }) }), (latestCustomer) => latestCustomer.understandingMeta?.updatedAt === meta.updatedAt && latestCustomer.understandingMeta?.status === meta.status)
    await writeMeta(processingMeta)
    const startedAt = Date.now()
    try {
      if (!config.deepseek.apiKey) throw Object.assign(new Error('DeepSeek 尚未配置'), { code: 'DEEPSEEK_UNAVAILABLE', status: 503 })
      const redactValues = [customerRecord.name, customerRecord.phone, customerRecord.wechat]
      let result = await createCustomerUnderstanding({ context, redactValues })
      let quality = qualityCheckCustomerUnderstanding(result, { evidenceIds: context.evidence_refs.map((item) => item.evidence_id), openConflictFields: conflicts.filter((item) => item.status === 'OPEN').map((item) => item.fieldKey) })
      if (!quality.ok) {
        result = await createCustomerUnderstanding({ context, repair: true, redactValues })
        quality = qualityCheckCustomerUnderstanding(result, { evidenceIds: context.evidence_refs.map((item) => item.evidence_id), openConflictFields: conflicts.filter((item) => item.status === 'OPEN').map((item) => item.fieldKey) })
      }
      if (!quality.ok) throw Object.assign(new Error('客户理解质量门禁未通过'), { code: 'UNDERSTANDING_QUALITY_FAILED', status: 502, quality })
      const freshMeta = { ...processingMeta, status: 'FRESH', generatedAt: result.generated_at || now(), updatedAt: now(), durationMs: Date.now() - startedAt, evidenceCount: context.evidence_refs.length, quality, payload: result }
      await writeMeta(freshMeta)
      this.audit('REFRESH_CUSTOMER_UNDERSTANDING', customerId, actorId)
      return this.getCustomerUnderstanding(actorId, customerId)
    } catch (error) {
      const failedMeta = { ...processingMeta, status: 'FAILED', updatedAt: now(), durationMs: Date.now() - startedAt, errorCode: error?.code || 'UNDERSTANDING_REFRESH_FAILED', payload: customerRecord.understanding || null }
      await writeMeta(failedMeta).catch(() => {})
      throw error
    }
  }

  async getCustomerSalesUnderstanding(actorId, customerId) {
    const database = await this.load()
    const visible = scope(database, actorId)
    const customerRecord = visible.customers.find((item) => item.id === customerId)
    if (!customerRecord) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const evidenceItems = buildSalesContext({ evidenceItems: visible.evidenceItems.filter((item) => item.customerId === customerId), sourceRecords: visible.sourceRecords })
    const conflicts = visible.evidenceConflicts.filter((item) => item.customerId === customerId)
    const enrollments = visible.enrollments.filter((item) => item.customerId === customerId)
    const products = database.products
    const sessions = visible.sessions.filter((item) => item.customerId === customerId)
    const appointments = visible.appointments.filter((item) => item.customerId === customerId)
    const context = buildCustomerSalesContext({ customer: customerRecord, evidenceItems, sourceRecords: visible.sourceRecords, conflicts, enrollments, products, sessions, safetyAssessment: customerRecord.safety })
    const storedMeta = customerRecord.salesUnderstandingMeta || {}
    const fresh = storedMeta.status === 'FRESH' && storedMeta.inputFingerprint === context.input_fingerprint && storedMeta.promptVersion === CUSTOMER_SALES_UNDERSTANDING_PROMPT_VERSION
    const status = fresh ? 'FRESH' : storedMeta.status === 'PROCESSING' ? 'PROCESSING' : storedMeta.status === 'FAILED' ? 'FAILED' : 'STALE'
    const salesUnderstanding = customerRecord.salesUnderstanding
      ? applyAbilityEvidenceGate(applyWillingnessEvidenceGate(customerRecord.salesUnderstanding, { evidenceItems, enrollments, sessions, appointments }), { evidenceItems, enrollments })
      : createLocalCustomerSalesUnderstanding(context)
    const source = customerRecord.salesUnderstanding ? storedMeta.provider || 'DEEPSEEK' : 'STRUCTURED_FALLBACK'
    return { customerId, status, salesUnderstanding, meta: { ...storedMeta, salesUnderstandingId: storedMeta.salesUnderstandingId || `SALES-UNDERSTANDING-${customerId}`, customerId, salesUnderstandingVersion: CUSTOMER_SALES_UNDERSTANDING_VERSION, status, source, inputFingerprint: storedMeta.inputFingerprint || context.input_fingerprint, profileVersion: customerRecord.profileVersion || 0, promptVersion: CUSTOMER_SALES_UNDERSTANDING_PROMPT_VERSION }, historical_enrollments: historicalSalesRecords({ enrollments, products, sessions }).enrollmentHistory, service_history: historicalSalesRecords({ enrollments: [], products, sessions }).serviceHistory, evidence_refs: context.evidence_refs, context_summary: { density: context.customer_snapshot.context_density, evidence_count: context.evidence_refs.length } }
  }

  async refreshCustomerSalesUnderstanding(actorId, customerId, { force = false } = {}) {
    return this.customerWriteQueue.run(customerId, () => this.refreshCustomerSalesUnderstandingUnsafe(actorId, customerId, { force }))
  }

  async refreshCustomerSalesUnderstandingUnsafe(actorId, customerId, { force = false } = {}) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    const visible = scope(database, actorId)
    const customerRecord = visible.customers.find((item) => item.id === customerId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!customerRecord || !row) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const evidenceItems = buildSalesContext({ evidenceItems: visible.evidenceItems.filter((item) => item.customerId === customerId), sourceRecords: visible.sourceRecords })
    const conflicts = visible.evidenceConflicts.filter((item) => item.customerId === customerId)
    const enrollments = visible.enrollments.filter((item) => item.customerId === customerId)
    const sessions = visible.sessions.filter((item) => item.customerId === customerId)
    const appointments = visible.appointments.filter((item) => item.customerId === customerId)
    const context = buildCustomerSalesContext({ customer: customerRecord, evidenceItems, sourceRecords: visible.sourceRecords, conflicts, enrollments, products: database.products, sessions, safetyAssessment: customerRecord.safety })
    const inputFingerprint = context.input_fingerprint
    const currentMeta = customerRecord.salesUnderstandingMeta || {}
    const processingAge = currentMeta.updatedAt ? Date.now() - new Date(currentMeta.updatedAt).getTime() : Number.POSITIVE_INFINITY
    if (!force && currentMeta.status === 'PROCESSING' && processingAge >= 0 && processingAge < 5 * 60 * 1000) return this.getCustomerSalesUnderstanding(actorId, customerId)
    if (!force && currentMeta.status === 'FRESH' && currentMeta.inputFingerprint === inputFingerprint && currentMeta.promptVersion === CUSTOMER_SALES_UNDERSTANDING_PROMPT_VERSION) return this.getCustomerSalesUnderstanding(actorId, customerId)
    const processingMeta = { ...currentMeta, salesUnderstandingId: currentMeta.salesUnderstandingId || `SALES-UNDERSTANDING-${customerId}`, customerId, salesUnderstandingVersion: CUSTOMER_SALES_UNDERSTANDING_VERSION, status: 'PROCESSING', inputFingerprint, profileVersion: customerRecord.profileVersion || 0, promptVersion: CUSTOMER_SALES_UNDERSTANDING_PROMPT_VERSION, provider: 'DEEPSEEK', model: config.deepseek.model, updatedAt: now(), payload: customerRecord.salesUnderstanding || null }
    const writeMeta = (meta) => updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { salesUnderstanding: meta }) }), (latestCustomer) => latestCustomer.salesUnderstandingMeta?.updatedAt === meta.updatedAt && latestCustomer.salesUnderstandingMeta?.status === meta.status)
    await writeMeta(processingMeta)
    const startedAt = Date.now()
    try {
      if (!config.deepseek.apiKey) throw Object.assign(new Error('DeepSeek 尚未配置'), { code: 'DEEPSEEK_UNAVAILABLE', status: 503 })
      const redactValues = [customerRecord.name, customerRecord.phone, customerRecord.wechat]
      const result = applyAbilityEvidenceGate(applyWillingnessEvidenceGate(normalizeCustomerSalesUnderstanding(await createCustomerSalesUnderstanding({ context, redactValues }), { evidenceIds: context.evidence_refs.map((item) => item.evidence_id), safetyAssessment: customerRecord.safety, contextDensity: context.customer_snapshot.context_density.classification }), { evidenceItems, enrollments, sessions, appointments }), { evidenceItems, enrollments })
      const quality = qualityCheckCustomerSalesUnderstanding(result, { evidenceIds: context.evidence_refs.map((item) => item.evidence_id), hasStrongPaymentSignal: context.financial_evidence.length > 0 || context.paid_history_count > 0 })
      if (!quality.ok) throw Object.assign(new Error('销售视角质量门禁未通过'), { code: 'SALES_UNDERSTANDING_QUALITY_FAILED', status: 502, quality })
      const freshMeta = { ...processingMeta, status: 'FRESH', generatedAt: result.generated_at || now(), updatedAt: now(), durationMs: Date.now() - startedAt, evidenceCount: context.evidence_refs.length, quality, payload: result }
      await writeMeta(freshMeta)
      this.audit('REFRESH_CUSTOMER_SALES_UNDERSTANDING', customerId, actorId)
      return this.getCustomerSalesUnderstanding(actorId, customerId)
    } catch (error) {
      const failedMeta = { ...processingMeta, status: 'FAILED', updatedAt: now(), durationMs: Date.now() - startedAt, errorCode: error?.code || 'SALES_UNDERSTANDING_REFRESH_FAILED', payload: customerRecord.salesUnderstanding || null }
      await writeMeta(failedMeta).catch(() => {})
      throw error
    }
  }

  async markSafetyStale(customerId) {
    // Profile writes and safety metadata writes share one Feishu JSON field.
    // Always rebuild from the persisted row here; a cached pre-profile-write
    // snapshot could otherwise overwrite a newer field's provenance/status.
    this.invalidateDatabaseCache()
    const database = await this.load({ force: true })
    const customerRecord = database.customers.find((item) => item.id === customerId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!customerRecord || !row) return
    const updatedAt = now()
    const safetyMeta = { ...(customerRecord.safetyMeta || {}), customerId, assessmentVersion: SAFETY_ASSESSMENT_VERSION, status: 'STALE', inputFingerprint: '', updatedAt }
    await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { safety: safetyMeta }) }), (latestCustomer) => latestCustomer.safetyMeta?.updatedAt === safetyMeta.updatedAt && latestCustomer.safetyMeta?.status === safetyMeta.status)
  }

  async getCustomerSafetyAssessment(actorId, customerId) {
    const database = await this.load()
    const visible = scope(database, actorId)
    const customerRecord = visible.customers.find((item) => item.id === customerId)
    if (!customerRecord) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const evidenceItems = database.evidenceItems.filter((item) => item.customerId === customerId)
    const conflicts = database.evidenceConflicts.filter((item) => item.customerId === customerId)
    const context = buildCustomerSafetyContext({ customer: customerRecord, evidenceItems, sourceRecords: database.sourceRecords, conflicts })
    const storedMeta = customerRecord.safetyMeta || {}
    const status = resolveSafetyStatus({ storedMeta, inputFingerprint: context.input_fingerprint, promptVersion: SAFETY_PROMPT_VERSION })
    const actor = database.staff.find((item) => item.id === actorId)
    const evidenceById = new Map(database.evidenceItems.filter((item) => item.customerId === customerId).map((item) => [item.id, item]))
    const sourceById = new Map(database.sourceRecords.filter((item) => item.customerId === customerId).map((item) => [item.id, item]))
    const evidence_refs = context.evidence_refs.map(({ evidence_id, source_id, source_title, display_text, excerpt, occurred_at, evidence_type, source_perspective }) => {
      const evidence = evidenceById.get(evidence_id)
      const source = sourceById.get(source_id)
      const meta = evidence?.privacyMeta || source?.privacyMeta || {}
      const policy = resolvePrivacyPolicy({ privacyLevel: evidence?.privacyLevel || source?.privacyLevel, categories: meta.categories, safetyFlags: meta.safetyFlags, currentRole: actor?.permissionRole || 'ADMIN', assertionType: meta.assertionType, verification: meta.verification, serviceNecessity: evidence?.serviceNecessity || source?.serviceNecessity || meta.serviceNecessity, serviceNecessityOverride: meta.serviceNecessityOverride, temporalType: evidence?.temporalType || source?.temporalType || meta.temporalType })
      return { evidence_id, source_id, source_title, display_text: policy.canViewRaw ? display_text : policy.canViewServiceDetail ? evidence?.mentorServiceDetail || meta.mentorServiceDetail || evidence?.mentorSafeText || source?.mentorSafeSummary || privacySafeText(meta) : evidence?.mentorSafeText || source?.mentorSafeSummary || privacySafeText(meta), excerpt: policy.canViewRaw ? excerpt : policy.canViewNecessaryExcerpt ? evidence?.necessaryExcerpt || meta.necessaryExcerpt || '' : '', occurred_at, evidence_type, source_perspective }
    })
    return { customerId, status, assessment: mentorVisibleSafetyAssessment(storedMeta.payload || null, actor?.permissionRole), meta: { ...storedMeta, customerId, assessmentVersion: SAFETY_ASSESSMENT_VERSION, status, inputFingerprint: storedMeta.inputFingerprint || context.input_fingerprint, promptVersion: SAFETY_PROMPT_VERSION, safetyDataSufficiency: context.safety_data_sufficiency }, context_summary: { density: context.context_density, safety_data_sufficiency: context.safety_data_sufficiency, critical_unknowns: storedMeta.payload?.critical_unknowns || [], evidence_count: context.evidence_refs.length }, evidence_refs }
  }

  async refreshCustomerSafetyAssessment(actorId, customerId, { force = false } = {}) {
    return this.customerWriteQueue.run(customerId, () => this.refreshCustomerSafetyAssessmentUnsafe(actorId, customerId, { force }))
  }

  async refreshCustomerSafetyAssessmentUnsafe(actorId, customerId, { force = false } = {}) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    const visible = scope(database, actorId)
    const customerRecord = visible.customers.find((item) => item.id === customerId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!customerRecord || !row) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const evidenceItems = database.evidenceItems.filter((item) => item.customerId === customerId)
    const conflicts = database.evidenceConflicts.filter((item) => item.customerId === customerId)
    const context = buildCustomerSafetyContext({ customer: customerRecord, evidenceItems, sourceRecords: database.sourceRecords, conflicts })
    const inputFingerprint = context.input_fingerprint
    const currentMeta = customerRecord.safetyMeta || {}
    const processingAge = currentMeta.updatedAt ? Date.now() - new Date(currentMeta.updatedAt).getTime() : Number.POSITIVE_INFINITY
    if (!force && currentMeta.status === 'PROCESSING' && processingAge >= 0 && processingAge < 5 * 60 * 1000) return this.getCustomerSafetyAssessment(actorId, customerId)
    if (!force && currentMeta.status === 'FRESH' && currentMeta.inputFingerprint === inputFingerprint && currentMeta.promptVersion === SAFETY_PROMPT_VERSION) return this.getCustomerSafetyAssessment(actorId, customerId)
    const processingMeta = { ...currentMeta, customerId, assessmentVersion: SAFETY_ASSESSMENT_VERSION, status: 'PROCESSING', inputFingerprint, promptVersion: SAFETY_PROMPT_VERSION, contextDensity: context.context_density, contextDensitySource: context.context_density_source, contextDensityPolicyVersion: context.context_density_policy_version, provider: 'DEEPSEEK', model: config.deepseek.model, updatedAt: now(), payload: currentMeta.payload || null }
    const writeMeta = (meta) => updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { safety: meta }) }), (latestCustomer) => latestCustomer.safetyMeta?.updatedAt === meta.updatedAt && latestCustomer.safetyMeta?.status === meta.status)
    await writeMeta(processingMeta)
    const startedAt = Date.now()
    try {
      if (!config.deepseek.apiKey) throw Object.assign(new Error('DeepSeek 尚未配置'), { code: 'DEEPSEEK_UNAVAILABLE', status: 503 })
      const candidates = await createSafetySignalCandidates({ context })
      const { assessment, quality } = buildSafetyAssessment({ context, candidates, now: now() })
      if (!quality.ok) throw Object.assign(new Error('安全评估质量门禁未通过'), { code: 'SAFETY_QUALITY_FAILED', status: 502, quality })
      const freshMeta = { ...processingMeta, status: 'FRESH', generatedAt: assessment.generated_at, updatedAt: now(), durationMs: Date.now() - startedAt, evidenceCount: context.evidence_refs.length, quality, payload: assessment }
      await writeMeta(freshMeta)
      this.audit('REFRESH_CUSTOMER_SAFETY', customerId, actorId)
      return this.getCustomerSafetyAssessment(actorId, customerId)
    } catch (error) {
      const failedMeta = { ...buildSafetyFailureMeta(processingMeta, { errorCode: error?.code || 'SAFETY_REFRESH_FAILED', updatedAt: now() }), durationMs: Date.now() - startedAt }
      await writeMeta(failedMeta).catch(() => {})
      throw error
    }
  }

  async profileDraft(actorId, customerId, textInput) {
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const current = database.customers.find((item) => item.id === customerId)
    if (!current) throw new Error('客户不存在')
    return createProfileDraft({ text: textInput, existing: current.profileFields || {} })
  }
  async previewCustomer(actorId, input) {
    const startedAt = Date.now()
    const database = await this.loadCustomerSaveContext()
    scope(database, actorId)
    const normalized = validateManualCustomer(input)
    const identity = resolveCustomerIdentity(database.customers, normalized)
    // Preview only resolves identity and duplicates. AI extraction must stay outside the customer save critical path.
    const response = { duplicates: duplicateMatches(database, input), identity: { result: identity.result, matched_customer_id: identity.matched_customer_id, match_reasons: identity.match_reasons, confidence: identity.confidence }, updates: [] }
    console.info('[ASVA_CUSTOMER_SAVE]', JSON.stringify({ operation: 'customer.preview', operation_id: text(input?.operationId).trim() || undefined, preview_ms: Date.now() - startedAt, result: 'SUCCESS' }))
    return response
  }
  async persistCustomerMutationState(database, customerId, operationId, state) {
    if (!operationId) return null
    const customerRecord = database.customers.find((item) => item.id === customerId)
    const row = database._rows?.customers?.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!customerRecord || !row) throw Object.assign(new Error('客户不存在'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const nextState = { ...state, operationId, customerId, updatedAt: state.updatedAt || now() }
    // Always merge from the latest Feishu row. Never pass automaticProfilePending
    // here: a COMMITTED transition must not clear or overwrite a pending marker
    // that still awaits a durable SourceRecords row.
    const safeWrite = await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => {
      const mutationState = nextState.status === 'COMMITTED' ? { ...nextState, resultFingerprint: customerResultFingerprint(latestCustomer) } : nextState
      const mutationStates = { ...sanitizeMutationStates(latestCustomer.mutationStates), [operationId]: mutationState }
      return mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { mutationStates }) })
    }, (latestCustomer) => {
      const persisted = latestCustomer.mutationStates?.[operationId]
      return persisted?.status === nextState.status && persisted?.payloadHash === nextState.payloadHash && persisted?.customerId === customerId && (nextState.status !== 'COMMITTED' || persisted?.resultFingerprint === customerResultFingerprint(latestCustomer))
    })
    const writeResult = { record: safeWrite.row, record_id: safeWrite.row.record_id }
    customerRecord.mutationStates = sanitizeMutationStates({ ...customerRecord.mutationStates, [operationId]: nextState })
    this.invalidateDatabaseCache()
    return writeResult
  }
  customerSaveStatusFromDatabase(database, actorId, customerId, normalizedOperationId) {
    const visible = scope(database, actorId)
    const customerRecord = customerId
      ? visible.customers.find((item) => item.id === customerId)
      : visible.customers.find((item) => item.mutationStates?.[normalizedOperationId]) || visible.customers.find((item) => item.id === customerIdForOperation(normalizedOperationId))
    const resolvedCustomerId = customerRecord?.id || customerId || customerIdForOperation(normalizedOperationId)
    if (!customerRecord) {
      if (!customerId) return { operationId: normalizedOperationId, customerId: resolvedCustomerId, status: 'UNKNOWN', customer: null }
      throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    }
    const state = customerRecord.mutationStates?.[normalizedOperationId]
    if (!state) return { operationId: normalizedOperationId, customerId: resolvedCustomerId, status: 'UNKNOWN', customer: null }
    const response = { operationId: normalizedOperationId, customerId: resolvedCustomerId, status: state.status, updatedAt: state.updatedAt || null, customer: null }
    if (state.status === 'PERSISTED') return { ...response, ...publicCustomerMutationDto(database, actorId, resolvedCustomerId, state.kind === 'CREATE', normalizedOperationId) }
    if (state.status === 'COMMITTED') {
      const resultMatchesCurrent = state.resultFingerprint && state.resultFingerprint === customerResultFingerprint(customerRecord)
      if (!resultMatchesCurrent) return { ...response, mutation: publicMutationState(state), resultSnapshotAvailable: false, resultChangedSinceOperation: Boolean(state.resultFingerprint) }
      return { ...response, ...publicCustomerMutationDto(database, actorId, resolvedCustomerId, state.kind === 'CREATE', normalizedOperationId), resultSnapshotAvailable: true }
    }
    return response
  }
  async loadCustomerSaveStatusContext(actorId, customerId) {
    // A save can land in a different function instance whose 45s directory
    // cache predates the write. Status lookups therefore read the customers
    // table directly and never trust the directory snapshot.
    const customerRows = config.feishu.tables.customers ? await listRecords(config.feishu.tables.customers) : []
    const row = customerRows.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!row) return null
    const staffRecords = await this.loadStaffRecords()
    const parsed = customer(row)
    const database = { staff: staffRecords, customers: [parsed], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: { customers: [row] } }
    const visible = scope(database, actorId)
    if (!visible.customers.some((item) => item.id === customerId)) return null
    return { row, customer: parsed, staff: staffRecords }
  }
  async loadCustomerMutationCollections(customerId) {
    const [enrollmentRows, profileChangeRows] = await Promise.all([
      config.feishu.tables.enrollments ? listRecords(config.feishu.tables.enrollments) : [],
      config.feishu.tables.profileChanges ? listRecords(config.feishu.tables.profileChanges) : [],
    ])
    return {
      enrollments: enrollmentRows.map(enrollment).filter((item) => item.customerId === customerId),
      profileChanges: profileChangeRows.map(profileChange).filter((item) => item.customerId === customerId),
    }
  }
  async customerSaveStatus(actorId, customerId, operationId) {
    const normalizedOperationId = text(operationId).trim()
    if (!normalizedOperationId) throw Object.assign(new Error('缺少操作编号'), { code: 'CUSTOMER_SAVE_OPERATION_REQUIRED', status: 400 })
    // Isolated repository tests and injected data sources keep their supplied
    // database; production uses the targeted fresh read below.
    if (this.load !== FeishuRepository.prototype.load) return this.customerSaveStatusFromDatabase(await this.load(), actorId, customerId, normalizedOperationId)
    const requestedCustomerId = text(customerId).trim()
    const resolvedCustomerId = requestedCustomerId || customerIdForOperation(normalizedOperationId)
    const context = await this.loadCustomerSaveStatusContext(actorId, resolvedCustomerId)
    if (!context) {
      if (!requestedCustomerId) return { operationId: normalizedOperationId, customerId: resolvedCustomerId, status: 'UNKNOWN', customer: null }
      throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    }
    const state = context.customer.mutationStates?.[normalizedOperationId]
    if (!state || state.customerId !== resolvedCustomerId) return { operationId: normalizedOperationId, customerId: resolvedCustomerId, status: 'UNKNOWN', customer: null }
    const response = { operationId: normalizedOperationId, customerId: resolvedCustomerId, status: state.status, updatedAt: state.updatedAt || null, customer: null }
    if (state.status !== 'PERSISTED' && state.status !== 'COMMITTED') return response
    if (state.status === 'COMMITTED') {
      const resultMatchesCurrent = state.resultFingerprint && state.resultFingerprint === customerResultFingerprint(context.customer)
      if (!resultMatchesCurrent) return { ...response, mutation: publicMutationState(state), resultSnapshotAvailable: false, resultChangedSinceOperation: Boolean(state.resultFingerprint) }
    }
    // The fast create path has no enrollments or profile changes to hydrate.
    const collections = state.kind === 'CREATE' && state.status === 'PERSISTED' && state.enrollmentStatus === 'COMPLETED'
      ? { enrollments: [], profileChanges: [] }
      : await this.loadCustomerMutationCollections(resolvedCustomerId)
    const database = { staff: context.staff, customers: [context.customer], appointments: [], sessions: [], followups: [], products: [], enrollments: collections.enrollments, profileChanges: collections.profileChanges, sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: { customers: [context.row] } }
    return state.status === 'PERSISTED'
      ? { ...response, ...publicCustomerMutationDto(database, actorId, resolvedCustomerId, state.kind === 'CREATE', normalizedOperationId) }
      : { ...response, ...publicCustomerMutationDto(database, actorId, resolvedCustomerId, state.kind === 'CREATE', normalizedOperationId), resultSnapshotAvailable: true }
  }
  async resumePendingCustomerEnrollment(actorId, customerId, input, operationId, inputHash, { compactResponse = false } = {}) {
    // This path only runs after a Customer record has already been proven
    // durable. A full read is acceptable here: it is a bounded recovery of a
    // failed enrollment sync, never part of the normal create critical path.
    let current = await this.load({ force: true })
    scope(current, actorId)
    const customerRecord = current.customers.find((item) => item.id === customerId)
    const previousMutation = customerRecord?.mutationStates?.[operationId]
    if (!customerRecord || !previousMutation || previousMutation.payloadHash !== inputHash || previousMutation.status !== 'PERSISTED' || previousMutation.enrollmentStatus !== 'PENDING') {
      throw incompleteMutationError(previousMutation)
    }
    try {
      await mergeEnrollments(current, customerId, input.enrollments, actorId, operationId)
    } catch (error) {
      this.audit('RECOVER_CUSTOMER_ENROLLMENT', customerId, actorId, 'PENDING', error?.code || 'ENROLLMENT_SYNC_FAILED')
      const response = compactResponse
        ? publicCustomerMutationDto(current, actorId, customerId, false, operationId)
        : Object.assign(scope(current, actorId), { createdCustomerId: customerId, customerCreated: false })
      return { ...response, enrollmentStatus: 'PENDING', enrollmentMessage: partialEnrollmentFailureMessage() }
    }
    const mutationWrite = await this.persistCustomerMutationState(current, customerId, operationId, {
      kind: 'CREATE', status: 'COMMITTED', payloadHash: inputHash, enrollmentStatus: 'COMPLETED', enrollmentDrafts: [], enrollmentErrorCode: '', updatedAt: now(),
    })
    if (mutationWrite) current = await this.loadCustomerAfterWrite(mutationWrite, customerId, current)
    const response = compactResponse
      ? publicCustomerMutationDto(current, actorId, customerId, false, operationId)
      : Object.assign(scope(current, actorId), { createdCustomerId: customerId, customerCreated: false })
    return { ...response, enrollmentStatus: 'COMPLETED' }
  }
  async recoverPendingEnrollmentsForCustomer(actorId, customerId, operationId) {
    const database = await this.load({ force: true })
    const visible = scope(database, actorId)
    const customerRecord = visible.customers.find((item) => item.id === customerId)
    const state = customerRecord?.mutationStates?.[operationId]
    if (!customerRecord) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    if (!state || state.status !== 'PERSISTED' || state.enrollmentStatus !== 'PENDING') throw incompleteMutationError(state)
    return this.resumePendingCustomerEnrollment(actorId, customerId, { enrollments: state.enrollmentDrafts }, operationId, state.payloadHash, { compactResponse: true })
  }
  schedulePendingCustomerEnrollmentRecovery(actorId, customerId, input, operationId, inputHash) {
    const key = `${customerId}:${operationId}`
    if (this.pendingEnrollmentRecoveryKeys.has(key)) return
    this.pendingEnrollmentRecoveryKeys.add(key)
    // Enrollment writes are deliberately outside the customer-save response.
    // The operation id and enrollment ids make this retry safe if the client
    // submits the same save again while this task is still running.
    setImmediate(() => {
      void this.resumePendingCustomerEnrollment(actorId, customerId, input, operationId, inputHash, { compactResponse: true })
        .catch((error) => this.audit('RECOVER_CUSTOMER_ENROLLMENT', customerId, actorId, 'PENDING', error?.code || 'ENROLLMENT_SYNC_FAILED'))
        .finally(() => this.pendingEnrollmentRecoveryKeys.delete(key))
    })
  }
  scheduleLegacyCustomerEnrollmentSync(actorId, customerId, input) {
    // Older callers may omit operationId. Keep their course behavior, but do
    // not put the writes back on the customer-save critical path.
    setImmediate(() => {
      void this.load({ force: true }).then((database) => {
        scope(database, actorId)
        return mergeEnrollments(database, customerId, input.enrollments, actorId, '')
      }).catch((error) => this.audit('RECOVER_CUSTOMER_ENROLLMENT', customerId, actorId, 'PENDING', error?.code || 'ENROLLMENT_SYNC_FAILED'))
    })
  }
  async createCustomer(actorId, input, requestId = '', { compactResponse = false } = {}) {
    const startedAt = Date.now()
    const timings = { identity_resolution_ms: 0, customer_write_ms: 0, write_ack_ms: 0, readback_ms: 0, enrollment_write_ms: 0, profile_change_ms: 0, ai_ms: 0 }
    const operationId = text(input?.operationId).trim()
    const traceOperationId = operationId || `customer-save-${crypto.randomUUID()}`
    let result = 'ERROR'
    let phase = 'CONTEXT'
    let writeStarted = false
    let commitMode = 'NONE'
    try {
      const identityStartedAt = Date.now()
      // Customer creation must see recent writes: a retry after a lost response
      // must not use a pre-write directory snapshot and create a duplicate.
      const database = input?.profileUpdates?.length ? await this.load() : await this.loadCustomerSaveContext({ maxAgeMs: 2_000 })
      scope(database, actorId)
      const normalized = validateManualCustomer(input)
      const existingId = operationId ? customerIdForOperation(operationId) : ''
      const existing = existingId ? database.customers.find((item) => item.id === existingId) : null
      const inputHash = mutationPayloadHash(input)
      if (existing && operationId) {
        const previousMutation = existing.mutationStates?.[operationId]
        if (!previousMutation) throw Object.assign(new Error('保存结果暂时无法确认，请查询原操作状态后再继续。'), { code: 'CUSTOMER_SAVE_UNKNOWN', status: 409 })
        if (previousMutation.payloadHash && previousMutation.payloadHash !== inputHash) throw Object.assign(new Error('同一操作编号对应的资料已发生变化，请使用新的操作编号。'), { code: 'CUSTOMER_SAVE_OPERATION_CONFLICT', status: 409 })
        if (previousMutation.status === 'FAILED') throw confirmedMutationFailureError()
        if (previousMutation.status === 'PERSISTED' && previousMutation.enrollmentStatus === 'PENDING') {
          this.schedulePendingCustomerEnrollmentRecovery(actorId, existing.id, input, operationId, inputHash)
          result = 'SUCCESS'
          return compactResponse
            ? publicCustomerMutationDto(database, actorId, existing.id, false, operationId)
            : Object.assign(scope(database, actorId), { createdCustomerId: existing.id, customerCreated: false })
        }
        if (previousMutation.status === 'PERSISTED' && previousMutation.enrollmentStatus === 'COMPLETED' && !previousMutation.enrollmentErrorCode && !input.profileUpdates?.length && !(Array.isArray(input.enrollments) && input.enrollments.length)) {
          // All requested customer data is durable; only the COMMITTED marker
          // is pending. Heal it in the background and return the same success.
          this.scheduleCustomerMutationCommit(database, existing.id, operationId, previousMutation, actorId)
          result = 'SUCCESS'
          return compactResponse
            ? publicCustomerMutationDto(database, actorId, existing.id, false, operationId)
            : Object.assign(scope(database, actorId), { createdCustomerId: existing.id, customerCreated: false })
        }
        if (previousMutation.status !== 'COMMITTED') throw incompleteMutationError(previousMutation)
        result = 'SUCCESS'
        return compactResponse
          ? publicCustomerMutationDto(database, actorId, existing.id, false, operationId)
          : Object.assign(scope(database, actorId), { createdCustomerId: existing.id, customerCreated: false })
      }
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
      const automaticText = automaticProfileText(input, normalized.situation)
      const hasEnrollments = Array.isArray(input.enrollments) && input.enrollments.length > 0
      let current = database
      if (!existing) {
        const customerWriteStartedAt = Date.now()
        const createdAt = now()
        const initialFields = { phone: { source: 'STRUCTURED_INPUT', confidence: 1, confirmed: true, updatedAt: createdAt }, ...(normalized.wechat ? { wechat: { source: 'STRUCTURED_INPUT', confidence: 1, confirmed: true, updatedAt: createdAt } } : {}) }
        const actor = database.staff.find((item) => item.id === actorId)
        const assignedMentorId = actor?.permissionRole === 'MENTOR' ? actor.id : text(input?.mentorId).trim()
        if (assignedMentorId && !database.staff.some((item) => item.id === assignedMentorId && item.permissionRole === 'MENTOR' && item.status === 'ACTIVE')) throw Object.assign(new Error('所选导师不存在或已停用'), { status: 400, code: 'INVALID_MENTOR_ASSIGNMENT' })
        const mutationStates = operationId ? { [operationId]: { operationId, kind: 'CREATE', customerId, status: 'PERSISTED', payloadHash: inputHash, enrollmentStatus: hasEnrollments ? 'PENDING' : 'COMPLETED', enrollmentDrafts: normalizeMutationEnrollments(input.enrollments).items, updatedAt: createdAt } } : {}
        const writeValues = { customer_id: customerId, nickname: normalized.nickname, created_by_staff_id: actorId, created_by_name: actor?.name || '', current_mentor_id: assignedMentorId, source: text(input.source).trim() || '管理员手动录入', notes: normalized.situation, current_issue: '', help_expectation: '', current_goal: '', sabc: 'C', is_paid: false, created_at: createdAt, profile_field_meta_json: JSON.stringify({ _profile_version: 1, _fields: initialFields, _automatic_profile_pending: automaticProfileArchivingAllowedForCustomer(customerId) && automaticText ? automaticProfilePendingMarker(automaticText, actorId, 'CUSTOMER_SAVE') : null, _mutation_states: sanitizeMutationStates(mutationStates) }), profile_schema_version: CUSTOMER_PROFILE_SCHEMA_VERSION, profile_updated_at: createdAt }
        if (normalized.phone) writeValues.phone = normalized.phone
        if (normalized.wechat) writeValues.wechat = normalized.wechat
        if (normalized.introducer) writeValues.referrer_name = normalized.introducer
        phase = 'WRITE'
        const writeResult = await createRecord(config.feishu.tables.customers, mapFields('customers', writeValues), { operation: 'customer.create', operationId: customerId, customerId, entityType: 'customers', idempotency: { field: mapField('customers', 'customer_id'), value: customerId } })
        // Only an acknowledged write counts as started. The gateway already
        // checks the customer_id idempotency key for retryable write failures,
        // so a thrown write means no confirmed Customers record exists.
        writeStarted = true
        timings.write_ack_ms = Date.now() - customerWriteStartedAt
        const writeRecordId = writeResult?.record?.record_id || writeResult?.record_id || writeResult?.record?.id || ''
        const optimisticRow = { record_id: writeRecordId, fields: mapFields('customers', writeValues) }
        const optimisticCustomer = customer(optimisticRow)
        current = {
          ...cloneDatabase(current),
          customers: [...current.customers.filter((item) => item.id !== customerId), optimisticCustomer],
          _rows: { ...(current._rows || {}), customers: [...(current._rows?.customers || []).filter((item) => item.record_id !== writeRecordId && text(get('customers', item.fields, 'customer_id')) !== customerId), optimisticRow] },
        }
        this.invalidateDatabaseCache()
        // The create response already contains the acknowledged record id and
        // the exact fields written above. Avoid a synchronous GET: the durable
        // PERSISTED mutation state is part of the same Customers write.
        timings.customer_write_ms = timings.write_ack_ms
      }
      if (input.profileUpdates?.length) {
        phase = 'PROFILE'
        const profileStartedAt = Date.now()
        const profileWrite = await persistCustomerProfile(current, customerId, normalizeProfileUpdates(input.profileUpdates, current.customers.find((item) => item.id === customerId), true), undefined, actorId)
        current = await this.loadCustomerAfterWrite(profileWrite.writeResult, customerId, current)
        if (profileWrite.changes?.length) current.profileChanges = [...(current.profileChanges || []), ...profileWrite.changes]
        timings.profile_change_ms = Date.now() - profileStartedAt
      }
      const automaticProfile = automaticText
        ? this.scheduleAutomaticCustomerProfile(actorId, customerId, automaticText, 'CUSTOMER_SAVE')
        : { status: 'NOT_REQUIRED' }
      // Best-effort same-request kickoff: pending is already durable on Customers.
      // Await briefly so CloudBase can finish createSource before the instance freezes;
      // never fail the save if the budget is exceeded — single-customer resume continues later.
      if (automaticProfile.status === 'QUEUED') {
        const kickoff = await this.awaitAutomaticCustomerProfileKickoff(customerId, { budgetMs: 3500 })
        automaticProfile.kickoffStatus = kickoff.status
        if (kickoff.status === 'DONE' && kickoff.value?.sourceId) {
          automaticProfile.sourceId = kickoff.value.sourceId
          automaticProfile.queueStatus = kickoff.value.status
        }
      }
      result = 'SUCCESS'
      // Stage 1 keeps Customer creation separate from Appointment/ServiceCase. The old follow-up fields remain compatibility-only.
      if (operationId && !existing) {
        const mutationState = {
          kind: 'CREATE',
          status: 'PERSISTED',
          payloadHash: inputHash,
          enrollmentStatus: hasEnrollments ? 'PENDING' : 'COMPLETED',
          enrollmentDrafts: normalizeMutationEnrollments(input.enrollments).items,
          enrollmentErrorCode: '',
          updatedAt: now(),
        }
        // The initial Customers write already persisted this state. The only
        // follow-up is explicitly background work: a marker transition for a
        // no-course save, or enrollment recovery for a course save.
        if (hasEnrollments) {
          commitMode = 'ASYNC_ENROLLMENT'
          if (operationId) this.schedulePendingCustomerEnrollmentRecovery(actorId, customerId, input, operationId, inputHash)
          else this.scheduleLegacyCustomerEnrollmentSync(actorId, customerId, input)
        } else {
          commitMode = 'ASYNC'
          this.scheduleCustomerMutationCommit(current, customerId, operationId, mutationState, actorId)
        }
      }
      phase = 'DONE'
      const latest = current
      if (!existing) this.recentCustomerWrites.set(customerId, Date.now())
      const response = compactResponse
        ? publicCustomerMutationDto(latest, actorId, customerId, !existing, operationId)
        : Object.assign(scope(latest, actorId), { createdCustomerId: customerId, customerCreated: !existing })
      return { ...response, automaticProfile, ...(hasEnrollments ? { enrollmentStatus: 'PENDING', enrollmentMessage: '客户已保存，课程正在后台同步。' } : {}) }
    } catch (error) {
      if (!writeStarted && error instanceof FeishuUnavailableError && error.writeDispatched !== true) {
        // Only failures raised before the write request left the process are
        // definitively "not started". Timeouts or lost responses after the
        // request was sent must stay UNKNOWN and go through operation recovery.
        throw Object.assign(error, { code: 'CUSTOMER_SAVE_NOT_STARTED', writeStatus: 'NOT_STARTED', status: 502 })
      }
      throw error
    } finally {
      const total = Date.now() - startedAt
      const measured = timings.identity_resolution_ms + timings.customer_write_ms + timings.enrollment_write_ms + timings.profile_change_ms + timings.ai_ms
      const trace = { request_id: requestId || undefined, operation_id: traceOperationId, result, phase, commit_mode: commitMode, customer_save_total_ms: total, ...timings, other_ms: Math.max(0, total - measured) }
      this.saveTraces.unshift(trace)
      this.saveTraces = this.saveTraces.slice(0, 50)
      console.info('[ASVA_CUSTOMER_SAVE]', JSON.stringify({ operation: 'customer.create', ...trace }))
    }
  }
  scheduleCustomerMutationCommit(database, customerId, operationId, state, actorId) {
    setImmediate(() => {
      void this.persistCustomerMutationState(database, customerId, operationId, { ...state, status: 'COMMITTED', enrollmentStatus: 'COMPLETED', enrollmentDrafts: [], enrollmentErrorCode: '', updatedAt: now() })
        .catch((error) => this.audit('COMMIT_CUSTOMER_MUTATION', customerId, actorId, 'PENDING', error?.code || 'CUSTOMER_MUTATION_COMMIT_FAILED'))
    })
  }
  async updateCustomer(actorId, customerId, input, { compactResponse = false } = {}) { return this.customerWriteQueue.run(customerId, () => this.updateCustomerUnsafe(actorId, customerId, input, { compactResponse })) }
  async updateCustomerUnsafe(actorId, customerId, input, { compactResponse = false } = {}) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    const visibleDatabase = scope(database, actorId)
    const actor = database.staff.find((item) => item.id === actorId)
    const introducerProvided = Object.prototype.hasOwnProperty.call(input || {}, 'introducer')
    if (introducerProvided && (actor?.permissionRole !== 'ADMIN' || actor.loginEnabled !== true)) throw Object.assign(new Error('只有 ADMIN 可以修改介绍人'), { code: 'FORBIDDEN', status: 403 })
    const current = visibleDatabase.customers.find((item) => item.id === customerId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!current || !row) throw new Error('客户不存在')
    const operationId = text(input?.operationId).trim()
    const inputHash = mutationPayloadHash(input)
    const previousMutation = operationId ? current.mutationStates?.[operationId] : null
    if (previousMutation) {
      if (previousMutation.payloadHash && previousMutation.payloadHash !== inputHash) throw Object.assign(new Error('同一操作编号对应的资料已发生变化，请使用新的操作编号。'), { code: 'CUSTOMER_SAVE_OPERATION_CONFLICT', status: 409 })
      if (previousMutation.status === 'FAILED') throw confirmedMutationFailureError()
      if (previousMutation.status !== 'COMMITTED') throw incompleteMutationError(previousMutation)
      return compactResponse ? publicCustomerMutationDto(database, actorId, customerId, false, operationId) : scope(database, actorId)
    }
    assertMentorAssignmentAuthority(database, actorId, input.profileUpdates)
    validateEnrollmentDrafts(database, input.enrollments)
    const phoneProvided = Object.prototype.hasOwnProperty.call(input || {}, 'phone')
    const wechatProvided = Object.prototype.hasOwnProperty.call(input || {}, 'wechat')
    const phoneChanged = phoneProvided && String(input.phone || '').trim() !== String(current.phone || '').trim()
    const wechatChanged = wechatProvided && String(input.wechat || '').trim() !== String(current.wechat || '').trim()
    const nextPhone = phoneProvided ? input.phone : current.phone
    const nextWechat = wechatProvided ? input.wechat : current.wechat
    if (phoneChanged || wechatChanged) {
      const changedFields = [phoneChanged ? ['phone', nextPhone] : null, wechatChanged ? ['wechat', nextWechat] : null].filter(Boolean)
      for (const [field, value] of changedFields) {
        const validation = validateCustomerContactField(field, value)
        if (!validation.ok) throw Object.assign(new Error(validation.message), { code: 'CUSTOMER_CONTACT_INVALID', status: 400, field })
      }
      if (!String(nextPhone || '').trim() && !String(nextWechat || '').trim()) {
        throw Object.assign(new Error('手机号或微信号至少填写一个联系方式。'), { code: 'CUSTOMER_CONTACT_REQUIRED', status: 400, field: 'contact' })
      }
    }
    const situationProvided = Object.prototype.hasOwnProperty.call(input || {}, 'situation')
    const normalized = { nickname: text(input.nickname || current.name).trim(), phone: normalizePhone(nextPhone), wechat: text(nextWechat).trim(), introducer: introducerProvided ? text(input.introducer).trim() : text(current.introducer || current.referrerName).trim(), situation: situationProvided ? text(input.situation).trim() : text(current.notes).trim() }
    const automaticText = automaticProfileText(input, situationProvided && normalized.situation !== String(current.notes || '').trim() ? normalized.situation : '')
    const identity = resolveCustomerIdentity(database.customers.filter((item) => item.id !== customerId), normalized)
    if (identity.result === 'CONFLICT') throw Object.assign(new Error('手机号和微信号分别匹配到了不同客户，请人工确认。'), { status: 409, code: 'IDENTITY_CONFLICT' })
    if (identity.result === 'EXACT_MATCH') throw Object.assign(new Error('该联系方式已绑定其他客户，不能覆盖。'), { status: 409, code: 'CUSTOMER_DUPLICATE' })
    const identityUpdates = []
    if (normalizePhone(current.phone) !== normalized.phone) identityUpdates.push({ field: 'phone', value: normalized.phone, source: 'USER_EXPLICIT', confidence: 1, confirmed: true })
    if (normalizeWechat(current.wechat) !== normalizeWechat(normalized.wechat)) identityUpdates.push({ field: 'wechat', value: normalized.wechat, source: 'USER_EXPLICIT', confidence: 1, confirmed: true })
    if (identityUpdates.length) await persistCustomerProfile(database, customerId, normalizeProfileUpdates(identityUpdates, current, true), undefined, actorId)
    const nicknameChanged = normalized.nickname !== current.name
    const notesChanged = situationProvided && normalized.situation !== String(current.notes || '').trim()
    const previousIntroducer = current.referrerName || ''
    const introducerChanged = introducerProvided && previousIntroducer !== normalized.introducer
    const customerValues = {}
    if (nicknameChanged) customerValues.nickname = normalized.nickname
    if (situationProvided && notesChanged) customerValues.notes = normalized.situation
    const requestedSource = text(input.source).trim()
    if (requestedSource && requestedSource !== current.source) customerValues.source = requestedSource
    if (introducerChanged) customerValues.referrer_name = normalized.introducer
    const persistedState = operationId ? { operationId, kind: 'UPDATE', customerId, status: 'PERSISTED', payloadHash: inputHash, updatedAt: now() } : null
    let customerWriteResult = null
    if (Object.keys(customerValues).length) {
      if (operationId) {
        const safeWrite = await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', {
          ...customerValues,
          profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, {
            ...(automaticProfileArchivingAllowedForCustomer(customerId) && automaticText ? { automaticProfilePending: automaticProfilePendingMarker(automaticText, actorId, 'CUSTOMER_UPDATE') } : {}),
            mutationStates: { ...latestCustomer.mutationStates, [operationId]: persistedState },
          }),
        }), (latestCustomer) => latestCustomer.mutationStates?.[operationId]?.status === 'PERSISTED' && latestCustomer.mutationStates?.[operationId]?.payloadHash === inputHash)
        customerWriteResult = { record: safeWrite.row, record_id: safeWrite.row.record_id }
      } else {
        if (automaticProfileArchivingAllowedForCustomer(customerId) && automaticText) {
          const pendingMarker = automaticProfilePendingMarker(automaticText, actorId, 'CUSTOMER_UPDATE')
          const safeWrite = await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', {
            ...customerValues,
            profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { automaticProfilePending: pendingMarker }),
          }), (latestCustomer) => latestCustomer.automaticProfilePending?.contentHash === pendingMarker.contentHash)
          customerWriteResult = { record: safeWrite.row, record_id: safeWrite.row.record_id }
        } else {
          customerWriteResult = await updateRecord(config.feishu.tables.customers, row.record_id, mapFields('customers', customerValues))
        }
      }
    } else if (operationId) {
      const safeWrite = await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', {
        profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { mutationStates: { ...latestCustomer.mutationStates, [operationId]: persistedState } }),
      }), (latestCustomer) => latestCustomer.mutationStates?.[operationId]?.status === 'PERSISTED' && latestCustomer.mutationStates?.[operationId]?.payloadHash === inputHash)
      customerWriteResult = { record: safeWrite.row, record_id: safeWrite.row.record_id }
    }
    const manualChanges = []
    if (nicknameChanged) manualChanges.push(await createManualProfileChange(database, { customerId, field: 'nickname', fieldName: '客户昵称', oldValue: current.name, newValue: normalized.nickname, operatorId: actorId, operationId: text(input?.operationId).trim() }))
    if (notesChanged) manualChanges.push(await createManualProfileChange(database, { customerId, field: 'notes', fieldName: '客户情况', oldValue: current.notes || null, newValue: normalized.situation || null, operatorId: actorId, operationId: text(input?.operationId).trim() }))
    if (introducerChanged) manualChanges.push(await createManualProfileChange(database, { customerId, field: 'introducer', fieldName: '介绍人', oldValue: previousIntroducer || null, newValue: normalized.introducer || null, operatorId: actorId, operationId: text(input?.operationId).trim() }))
    let latest = customerWriteResult ? await this.loadCustomerAfterWrite(customerWriteResult, customerId, database) : database
    latest = { ...latest, profileChanges: [...(latest.profileChanges || []), ...manualChanges.filter(Boolean)] }
    if (input.profileUpdates?.length) {
      const profileWrite = await persistCustomerProfile(latest, customerId, normalizeProfileUpdates(input.profileUpdates, latest.customers.find((item) => item.id === customerId), true), undefined, actorId)
      if (profileWrite.writeResult) latest = await this.loadCustomerAfterWrite(profileWrite.writeResult, customerId, latest)
      if (profileWrite.changes?.length) latest.profileChanges = [...(latest.profileChanges || []), ...profileWrite.changes]
    }
    const previousEnrollmentIds = latest.enrollments.filter((item) => item.customerId === customerId && item.status !== 'CANCELLED').map((item) => item.productId).sort()
    const enrollmentsChanged = await mergeEnrollments(latest, customerId, input.enrollments, actorId, text(input?.operationId).trim(), { replace: Array.isArray(input.enrollments) })
    if (enrollmentsChanged) {
      const nextEnrollmentIds = (Array.isArray(input.enrollments) ? input.enrollments : []).map((item) => item.productId).filter(Boolean).sort()
      const enrollmentChange = await createManualProfileChange(database, { customerId, field: 'enrollments', fieldName: '报名课程', oldValue: previousEnrollmentIds, newValue: nextEnrollmentIds, operatorId: actorId, operationId: text(input?.operationId).trim() })
      if (enrollmentChange) latest = { ...latest, profileChanges: [...latest.profileChanges, enrollmentChange] }
    }
    // Customer updates do not create or mutate Appointment in Stage 1.
    if (enrollmentsChanged) latest = await this.loadAfterWrite(undefined, customerId)
    const automaticProfile = automaticText
      ? this.scheduleAutomaticCustomerProfile(actorId, customerId, automaticText, 'CUSTOMER_UPDATE')
      : { status: 'NOT_REQUIRED' }
    if (operationId) {
      const mutationWrite = await this.persistCustomerMutationState(latest, customerId, operationId, { kind: 'UPDATE', status: 'COMMITTED', payloadHash: inputHash, updatedAt: now() })
      if (mutationWrite) latest = await this.loadCustomerAfterWrite(mutationWrite, customerId, latest)
    }
    const response = compactResponse ? publicCustomerMutationDto(latest, actorId, customerId, false, operationId) : scope(latest, actorId)
    return { ...response, automaticProfile }
  }

  async updateCustomerEnrollments(actorId, customerId, drafts, operationId = '') { return this.customerWriteQueue.run(customerId, () => this.updateCustomerEnrollmentsUnsafe(actorId, customerId, drafts, operationId)) }
  async updateCustomerEnrollmentsUnsafe(actorId, customerId, drafts, operationId = '') {
    this.invalidateDatabaseCache()
    const database = await this.load()
    scope(database, actorId)
    if (!database.customers.some((item) => item.id === customerId)) throw new Error('客户不存在')
    const current = database.enrollments.filter((item) => item.customerId === customerId && item.status !== 'CANCELLED').map((item) => item.productId).sort()
    const next = (Array.isArray(drafts) ? drafts : []).map((item) => item.productId).filter(Boolean).sort()
    const changed = await mergeEnrollments(database, customerId, Array.isArray(drafts) ? drafts : [], actorId, text(operationId).trim(), { replace: true })
    if (!changed) return scope(database, actorId)
    const change = await createManualProfileChange(database, { customerId, field: 'enrollments', fieldName: '报名课程', oldValue: current, newValue: next, operatorId: actorId, operationId: text(operationId).trim() })
    const latest = await this.loadAfterWrite(undefined, customerId)
    if (change) latest.profileChanges = [...latest.profileChanges, change]
    return scope(latest, actorId)
  }
  async confirmProfile(actorId, customerId, updates) { return this.customerWriteQueue.run(customerId, () => this.confirmProfileUnsafe(actorId, customerId, updates)) }
  async confirmProfileUnsafe(actorId, customerId, updates) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const current = database.customers.find((item) => item.id === customerId)
    if (!current) throw new Error('客户不存在')
    assertMentorAssignmentAuthority(database, actorId, updates)
    await persistCustomerProfile(database, customerId, normalizeProfileUpdates(updates, current, true), undefined, actorId)
    const latest = await this.loadAfterWrite(undefined, customerId)
    return latest.customers.find((item) => item.id === customerId) || current
  }
  async identifyDialogue(actorId, input) {
    const rawText = normalizeSourceRawText(input?.text)
    const targetCustomerId = text(input?.targetCustomerId)
    if (targetCustomerId) {
      const database = await this.load()
      if (!scope(database, actorId).customers.some((item) => item.id === targetCustomerId)) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    }
    const raw = await this.dialogueClassifier({ text: rawText })
    const { normalizeDialogueAssessment } = await import('../shared/dialogue-gate.mjs')
    const assessment = normalizeDialogueAssessment(raw, rawText)
    return { contentHash: contentHash(rawText), ...assessment, analysisToken: createDialogueAnalysisToken({ contentHash: contentHash(rawText), targetCustomerId, customerOperationId: text(input?.customerOperationId), assessment, secret: config.authSecret }) }
  }
  async confirmDialogue(actorId, input) {
    const targetCustomerId = text(input?.targetCustomerId)
    if (targetCustomerId) {
      const database = await this.load()
      if (!scope(database, actorId).customers.some((item) => item.id === targetCustomerId)) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    }
    return finalizeDialogueConfirmation({ analysisToken: input?.analysisToken, contentHash: text(input?.contentHash), targetCustomerId, customerOperationId: text(input?.customerOperationId), speakerId: text(input?.speakerId), secret: config.authSecret })
  }
  async prepareLegacySourceInput(actorId, input) {
    const sourceType = String(input?.sourceType || '').trim().toUpperCase()
    const rawText = normalizeSourceRawText(input?.rawText || input?.document?.extractedText || input?.document?.extracted_text)
    let rawAssessment
    try {
      rawAssessment = await this.dialogueClassifier({ text: rawText })
    } catch (error) {
      const unavailable = Object.assign(new Error('资料人物归属暂时无法确认，请刷新页面后重试。'), { code: 'DIALOGUE_GATE_UNAVAILABLE', status: 503, cause: error })
      this.audit('IDENTIFY_SOURCE_DIALOGUE', text(input?.customerId), actorId, 'FAIL', error?.code || 'DIALOGUE_GATE_UNAVAILABLE')
      throw unavailable
    }
    const assessment = normalizeDialogueAssessment(rawAssessment, rawText)
    if (assessment.classification !== 'NOT_DIALOGUE') {
      throw Object.assign(new Error('检测到对话式资料，请刷新页面后确认人物身份，再重新提交。'), { code: 'DIALOGUE_CONFIRMATION_REQUIRED', status: 409, classification: assessment.classification })
    }
    const customerId = text(input?.customerId)
    const customerOperationId = text(input?.customerOperationId)
    const analysisToken = createDialogueAnalysisToken({ contentHash: contentHash(rawText), targetCustomerId: customerId, customerOperationId, assessment, secret: config.authSecret })
    const confirmation = finalizeDialogueConfirmation({ analysisToken, contentHash: contentHash(rawText), targetCustomerId: customerId, customerOperationId, secret: config.authSecret })
    return { ...input, ...(sourceType === 'FILE_UPLOAD' ? { rawText } : {}), dialogueConfirmation: confirmation.dialogueConfirmation }
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
    const customerId = text(input?.customerId)
    return this.customerWriteQueue.run(customerId, async () => {
      const run = async () => {
      const operationId = text(input?.operationId)
      if (operationId) {
        const database = await this.load()
        const visibleDatabase = scope(database, actorId)
        const sourceId = stableId('SRC', `${customerId}:${operationId}`)
        const persisted = visibleDatabase.sourceRecords.find((item) => item.id === sourceId)
        if (persisted) return persisted
      }
      let sourceInputValue = input
      const rawText = normalizeSourceRawText(input?.rawText || input?.document?.extractedText || input?.document?.extracted_text)
      let hasValidConfirmation = false
      if (typeof input?.dialogueConfirmation === 'string' && input.dialogueConfirmation) {
        try {
          verifyDialogueConfirmation({ token: input.dialogueConfirmation, contentHash: contentHash(rawText), targetCustomerId: customerId, customerOperationId: text(input?.customerOperationId), secret: config.authSecret })
          hasValidConfirmation = true
        } catch {}
      }
      if (!hasValidConfirmation && String(input?.sourceType || '').trim().toUpperCase() === 'FILE_UPLOAD') sourceInputValue = await this.prepareLegacySourceInput(actorId, input)
      return this.createSourceUnsafe(actorId, sourceInputValue)
      }
      if (customerId && this.load === FeishuRepository.prototype.load && !scopedReadStore.getStore()) {
        return this.withCustomerScope(customerId, 'CREATE_SOURCE', run)
      }
      return run()
    })
  }
  async createSourceUnsafe(actorId, input) {
    this.invalidateDatabaseCache()
    requireStage2Tables()
    const startedAt = Date.now()
    const requestedCustomerId = text(input?.customerId).trim()
    if (requestedCustomerId && this.load === FeishuRepository.prototype.load && !scopedReadStore.getStore()) {
      return this.withCustomerScope(requestedCustomerId, 'CREATE_SOURCE', () => this.createSourceUnsafe(actorId, input))
    }
    let database = await this.load()
    let visibleDatabase = scope(database, actorId)
    if (!visibleDatabase.customers.some((item) => item.id === requestedCustomerId)) {
      const recentWriteAt = this.recentCustomerWrites.get(requestedCustomerId) || 0
      if (!recentWriteAt || Date.now() - recentWriteAt > RECENT_WRITE_WINDOW_MS) {
        this.recentCustomerWrites.delete(requestedCustomerId)
        throw Object.assign(new Error('客户不存在'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
      }
      database = await this.loadAfterWrite(undefined, requestedCustomerId, { allowMissingCustomerRetry: true })
      visibleDatabase = scope(database, actorId)
    }
    const requestedOperationId = text(input?.operationId).trim()
    const requestedSourceId = text(input?.sourceId).trim() || (requestedOperationId ? stableId('SRC', `${requestedCustomerId}:${requestedOperationId}`) : '')
    const existingByOperation = requestedSourceId ? database.sourceRecords.find((item) => item.id === requestedSourceId) : null
    if (existingByOperation) {
      if (existingByOperation.customerId !== requestedCustomerId) throw Object.assign(new Error('资料操作与客户不匹配'), { code: 'SOURCE_OPERATION_CUSTOMER_MISMATCH', status: 409 })
      return existingByOperation
    }
    let sourceInputValue = input
    if (String(input?.sourceType || '').trim().toUpperCase() === 'FILE_UPLOAD') {
      const document = input?.document || {}
      const fileHash = text(document.fileHash || document.file_hash)
      const extractedText = normalizeSourceRawText(document.extractedText || document.extracted_text)
      if (!fileHash || !extractedText) throw Object.assign(new Error('资料读取失败，请检查文件后重新上传。'), { code: 'DOCUMENT_TEXT_EMPTY', status: 422 })
      const duplicate = database.sourceRecords.find((item) => item.customerId === requestedCustomerId && parseDocumentFileRef(item.fileRef)?.file_hash === fileHash)
      if (duplicate) throw Object.assign(new Error('这份资料已经记录过了'), { code: 'SOURCE_DUPLICATE', status: 409, sourceId: duplicate.id })
      const fileRef = documentFileRef({ filename: document.filename, mimeType: document.mimeType, extension: document.extension, size: document.size, fileHash, charCount: document.charCount || Array.from(extractedText).length })
      sourceInputValue = { ...input, rawText: extractedText, contentHash: contentHash(extractedText), fileRef }
    }
    const normalized = sourceInput(sourceInputValue, actorId)
    if (!visibleDatabase.customers.some((item) => item.id === normalized.customerId)) throw new Error('客户不存在')
    const duplicate = database.sourceRecords.find((item) => item.customerId === normalized.customerId && item.contentHash === normalized.contentHash)
    if (duplicate) throw Object.assign(new Error('这份资料已经记录过了'), { code: 'SOURCE_DUPLICATE', status: 409, sourceId: duplicate.id })
    const sourceId = requestedSourceId || (normalized.operationId ? stableId('SRC', `${normalized.customerId}:${normalized.operationId}`) : stableId('SRC', `${normalized.customerId}:${normalized.contentHash}`))
    const existingSource = database.sourceRecords.find((item) => item.id === sourceId)
    if (existingSource) return existingSource
    const recentSourceWriteAt = this.recentSourceWrites.get(sourceId) || 0
    if (recentSourceWriteAt && Date.now() - recentSourceWriteAt <= RECENT_WRITE_WINDOW_MS) {
      const existingRecentSource = await waitForSourceVisibility(sourceId)
      if (existingRecentSource) return existingRecentSource
      return { id: sourceId, sourceId, customerId: normalized.customerId, subjectType: normalized.subjectType, subjectId: normalized.subjectId, sourceType: normalized.sourceType, title: normalized.title, rawText: normalized.rawText, fileRef: normalized.fileRef, sourceRole: normalized.sourceRole, contentHash: normalized.contentHash, processingStatus: 'UPLOADED', _persistenceStatus: 'COMMITTED', _dataFreshness: 'DELAYED' }
    }
    const timestamp = now()
    const sourceWriteResult = await createMappedRecord('sourceRecords', 'source.create', { source_id: sourceId, subject_type: normalized.subjectType, subject_id: normalized.subjectId, customer_id: normalized.customerId, source_type: normalized.sourceType, title: normalized.title, raw_text: normalized.rawText, file_ref: normalized.fileRef, occurred_at: '', uploaded_at: timestamp, uploaded_by: normalized.uploadedBy, source_role: normalized.sourceRole, service_record_id: normalized.serviceRecordId, content_hash: normalized.contentHash, processing_status: 'UPLOADED', processing_version: 1, sensitivity_level: 'HIGH', privacy_level: 'NORMAL', privacy_status: 'PROCESSING', privacy_meta_json: '{}', mentor_safe_summary: '', notes: normalized.notes, source_version: 1, extractor_version: 'evidence-v1', last_batch_id: '', processing_started_at: '', last_processing_at: '', processing_error: '', created_at: timestamp, updated_at: timestamp })
    this.recentSourceWrites.set(sourceId, Date.now())
    this.sourceSaveTimes.set(sourceId, Date.now() - startedAt)
    try {
      const privacy = classifyPrivacyText(normalized.rawText)
      await updateMappedRecord('sourceRecords', 'source.privacy.classify', sourceWriteResult?.record?.record_id || sourceWriteResult?.record_id, { privacy_level: privacy.privacyLevel, privacy_status: 'READY', privacy_meta_json: JSON.stringify(privacy), mentor_safe_summary: privacy.mentorSafeSummary, updated_at: now() })
    } catch (error) {
      await updateMappedRecord('sourceRecords', 'source.privacy.review-required', sourceWriteResult?.record?.record_id || sourceWriteResult?.record_id, { privacy_level: 'HIGH_SENSITIVE', privacy_status: 'REVIEW_REQUIRED', privacy_meta_json: JSON.stringify({ classificationReason: '隐私分类失败', categories: [], safetyFlags: [], serviceNecessity: 'UNKNOWN', mentorSafeSummary: '该资料正在进行安全处理，请稍后查看。' }), mentor_safe_summary: '该资料正在进行安全处理，请稍后查看。', updated_at: now() }).catch(() => {})
      this.audit('CLASSIFY_SOURCE_PRIVACY', sourceId, actorId, 'FAIL', error instanceof Error ? error.message : 'PRIVACY_CLASSIFICATION_FAILED')
    }
    const result = await waitForSourceVisibility(sourceId)
    if (result) {
      if (!isAutomaticProfileSource(normalized)) this.scheduleAutomaticProcessing(actorId, sourceId)
      return result
    }
    console.warn('[ASVA_FEISHU_READBACK]', JSON.stringify({ write_record_id: sourceWriteResult?.record?.record_id || sourceWriteResult?.record_id, source_id: sourceId, readback_status: 'READBACK_DELAYED', write_status: 'WRITE_COMMITTED', final_result: 'SUCCESS' }))
    if (!isAutomaticProfileSource(normalized)) this.scheduleAutomaticProcessing(actorId, sourceId)
    return { id: sourceId, sourceId, customerId: normalized.customerId, subjectType: normalized.subjectType, subjectId: normalized.subjectId, sourceType: normalized.sourceType, title: normalized.title, rawText: normalized.rawText, fileRef: normalized.fileRef, sourceRole: normalized.sourceRole, contentHash: normalized.contentHash, processingStatus: 'UPLOADED', _persistenceStatus: 'COMMITTED', _dataFreshness: 'DELAYED' }
  }
  async sourceWorkspace(actorId, customerId) {
    requireStage2Tables()
    const database = await this.load()
    const visibleDatabase = scope(database, actorId)
    if (!visibleDatabase.customers.some((item) => item.id === customerId)) throw new Error('客户不存在')
    const includeRaw = database.staff.find((item) => item.id === actorId)?.permissionRole === 'ADMIN'
    const customer = visibleDatabase.customers.find((item) => item.id === customerId)
    const evidenceItems = visibleDatabase.evidenceItems.filter((item) => item.customerId === customerId)
    const actor = database.staff.find((item) => item.id === actorId)
    const profileEvidence = customer ? profileMaterializationEvidence({ evidenceItems, sourceRecords: visibleDatabase.sourceRecords, customer, actor }) : []
    return { sources: visibleDatabase.sourceRecords.filter((item) => item.customerId === customerId).map((item) => publicSource(item, { includeRaw })), evidenceItems, proposals: visibleDatabase.profileUpdateProposals.filter((item) => item.customerId === customerId), conflicts: visibleDatabase.evidenceConflicts.filter((item) => item.customerId === customerId), profileMaterialization: customer ? materializeCustomerProfile({ customer, evidenceItems: profileEvidence, summaryMeta: customer.aiSummaryMeta }) : undefined }
  }
  async sourceDetail(actorId, sourceId) {
    requireStage2Tables()
    if (this.load === FeishuRepository.prototype.load && !scopedReadStore.getStore()) {
      const sourceRows = await this.searchTableByField('sourceRecords', 'source_id', sourceId, { scene: 'SOURCE_DETAIL' })
      const bootSource = sourceRows[0] ? sourceRecord(sourceRows[0]) : null
      if (bootSource?.customerId) return this.withCustomerScope(bootSource.customerId, 'SOURCE_DETAIL', () => this.sourceDetail(actorId, sourceId))
    }
    const database = await this.load()
    const visibleDatabase = scope(database, actorId)
    const source = visibleDatabase.sourceRecords.find((item) => item.id === sourceId)
    if (!source) throw new Error('资料不存在')
    const includeRaw = database.staff.find((item) => item.id === actorId)?.permissionRole === 'ADMIN'
    return { source: publicSource(source, { includeRaw }), evidenceItems: visibleDatabase.evidenceItems.filter((item) => item.sourceId === sourceId), proposals: visibleDatabase.profileUpdateProposals.filter((item) => item.sourceId === sourceId), conflicts: visibleDatabase.evidenceConflicts.filter((item) => item.newEvidenceId && visibleDatabase.evidenceItems.find((evidence) => evidence.id === item.newEvidenceId)?.sourceId === sourceId), profileMaterialization: visibleDatabase.customers.find((item) => item.id === source.customerId)?.profileMaterialization }
  }
  async sourceStatus(actorId, customerId, operationId) {
    requireStage2Tables()
    const requestedCustomerId = text(customerId).trim()
    const requestedOperationId = text(operationId).trim()
    if (!requestedCustomerId || !requestedOperationId) throw Object.assign(new Error('保存状态查询参数不完整'), { code: 'SOURCE_STATUS_QUERY_REQUIRED', status: 400 })
    const database = await this.load()
    const visibleDatabase = scope(database, actorId)
    if (!visibleDatabase.customers.some((item) => item.id === requestedCustomerId)) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
    const sourceId = stableId('SRC', `${requestedCustomerId}:${requestedOperationId}`)
    const source = visibleDatabase.sourceRecords.find((item) => item.id === sourceId)
    if (!source) return { status: 'NOT_FOUND', source: null }
    const includeRaw = database.staff.find((item) => item.id === actorId)?.permissionRole === 'ADMIN'
    return { status: 'PERSISTED', source: publicSource(source, { includeRaw }) }
  }
  async processSource(actorId, sourceId, { force = false } = {}) {
    const inFlight = this.sourceProcessingLocks.get(sourceId)
    if (inFlight) return inFlight
    const task = this.processSourceUnsafe(actorId, sourceId, { force })
    this.sourceProcessingLocks.set(sourceId, task)
    try { return await task } finally { if (this.sourceProcessingLocks.get(sourceId) === task) this.sourceProcessingLocks.delete(sourceId) }
  }
  async processSourceUnsafe(actorId, sourceId, { force = false } = {}) {
    this.invalidateDatabaseCache()
    requireStage2Tables()
    const startedAt = Date.now()
    if (this.load === FeishuRepository.prototype.load && !scopedReadStore.getStore()) {
      const sourceRows = await this.searchTableByField('sourceRecords', 'source_id', sourceId, { scene: 'PROCESS_SOURCE' })
      const bootSource = sourceRows[0] ? sourceRecord(sourceRows[0]) : null
      if (!bootSource?.customerId) throw new Error('资料不存在')
      return this.withCustomerScope(bootSource.customerId, 'PROCESS_SOURCE', () => this.processSourceUnsafe(actorId, sourceId, { force }))
    }
    const database = await this.load()
    const visibleDatabase = scope(database, actorId)
    let source = visibleDatabase.sourceRecords.find((item) => item.id === sourceId)
    const sourceRow = database._rows.sourceRecords.find((item) => item.record_id === source?._recordId)
    if (!source || !sourceRow) throw new Error('资料不存在')
    if (isAutomaticProfileSource(source) && !automaticProfileArchivingAllowedForCustomer(source.customerId)) {
      this.audit('PROCESS_SOURCE_AUTOMATIC', sourceId, actorId, 'DISABLED', 'AUTOMATIC_PROFILE_CANARY_CUSTOMER_NOT_ALLOWED')
      return this.sourceDetail(actorId, sourceId)
    }
    if (isAutomaticProfileSource(source) && !automaticProfileEventAllowed(source.createdAt || source.uploadedAt || source.occurredAt || source.processingStartedAt)) {
      this.audit('PROCESS_SOURCE_AUTOMATIC', sourceId, actorId, 'DISABLED', 'AUTOMATIC_PROFILE_EVENT_BEFORE_ENABLE_TIME')
      return this.sourceDetail(actorId, sourceId)
    }
    const dialogueContext = parseDialogueContext(source.notes)
    const allExistingEvidence = (database._allEvidenceItems || database.evidenceItems).filter((item) => item.sourceId === sourceId)
    const existingEvidence = database.evidenceItems.filter((item) => item.sourceId === sourceId)
    // REVIEW_REQUIRED with unactivated persisted Evidence is recoverable: the
    // prior readback failed before the batch pointer was committed. Do not
    // confuse it with a genuine review-required outcome.
    const hasUnactivatedEvidenceBatch = source.processingStatus === 'REVIEW_REQUIRED' && existingEvidence.length > 0 && !source.lastBatchId
    if (!force && ['COMPLETED', 'REVIEW_REQUIRED'].includes(source.processingStatus) && existingEvidence.length && !hasUnactivatedEvidenceBatch) return this.sourceDetail(actorId, sourceId)
    if (!force && source.processingStatus === 'PROCESSING' && !isStaleProcessing(source)) return this.sourceDetail(actorId, sourceId)
    const processingVersion = Number(source.processingVersion || 1) + 1
    const resumeExistingEvidence = !force && existingEvidence.length > 0 && ['PROCESSING', 'FAILED', 'REVIEW_REQUIRED'].includes(source.processingStatus)
    // A failed automatic run may have committed its Evidence before the
    // post-write readback returned. Continue that exact batch instead of
    // calling the model again or creating a second set of Evidence.
    const resumableEvidence = resumeExistingEvidence ? existingEvidence.filter((item) => item.reviewStatus !== 'SUPERSEDED') : []
    const resumableBatchIds = [...new Set(resumableEvidence.map((item) => String(item.extractionBatchId || '')).filter(Boolean))]
    if (resumeExistingEvidence && resumableBatchIds.length !== 1) throw Object.assign(new Error('既有 Evidence 批次无法安全恢复'), { code: 'EVIDENCE_RESUME_BATCH_AMBIGUOUS', status: 409 })
    const batchId = resumeExistingEvidence
      ? resumableBatchIds[0]
      : stableId('EXT', `${sourceId}:${source.contentHash}:${source.extractorVersion || 'evidence-v1'}:${processingVersion}`)
    const processingStartedAt = now()
    const processingDiagnostics = { source_char_count: String(source.rawText || '').length, prompt_char_count: 0, token_estimate: 0, extracted_candidate_count: 0, privacy_restricted_count: 0, cross_customer_rejected_count: 0 }
    await updateMappedRecord('sourceRecords', 'source.processing.start', sourceRow.record_id, { processing_status: 'PROCESSING', processing_version: processingVersion, processing_started_at: processingStartedAt, last_processing_at: processingStartedAt, processing_error: '', updated_at: processingStartedAt })
    try {
      if (!source.rawText) throw Object.assign(new Error('原始资料不能为空'), { code: 'SOURCE_TEXT_REQUIRED', status: 400 })
      const candidates = []
      if (!resumeExistingEvidence) {
        const chunks = chunkText(source.rawText)
        for (const chunk of chunks) {
          const rawItems = await this.evidenceExtractor({ text: chunk.text, sourceRole: source.sourceRole, sourcePerspective: source.sourcePerspective, dialogueContext, current: database.customers.find((item) => item.id === source.customerId)?.profileFields || {}, onDiagnostics: (diagnostics) => { processingDiagnostics.prompt_char_count += Number(diagnostics?.prompt_char_count || 0); processingDiagnostics.token_estimate += Number(diagnostics?.token_estimate || 0) } })
          processingDiagnostics.extracted_candidate_count += rawItems.length
          for (const rawItem of rawItems) {
            if (rawItem?.customer_id && String(rawItem.customer_id) !== String(source.customerId)) {
              processingDiagnostics.cross_customer_rejected_count += 1
              continue
            }
            if (String(rawItem?.evidence_type || '').toUpperCase() === 'OBSERVATION' && source.sourceRole !== 'MENTOR' && String(rawItem?.content_source || '').toUpperCase() !== 'MENTOR_OBSERVATION') continue
            if (dialogueContext && dialogueContext.classification !== 'NOT_DIALOGUE') {
              const speakerId = String(rawItem?.speaker_id || rawItem?.speakerId || '').trim()
              const subjectScope = String(rawItem?.subject_scope || rawItem?.subjectScope || '').trim().toUpperCase()
              if (speakerId !== dialogueContext.currentCustomerSpeakerId || subjectScope !== 'CURRENT_CUSTOMER') {
                processingDiagnostics.cross_customer_rejected_count += 1
                continue
              }
            }
            // The current mentor/admin write path has no authenticated
            // customer-submission proof. Keep CUSTOMER_DIRECT unavailable
            // here even when the model sees first-person or quoted wording.
            const normalized = normalizeEvidenceCandidate(rawItem, { sourceId, chunk, extractionBatchId: batchId, model: config.deepseek.model, modelVersion: 'v1', promptVersion: 'evidence-v1', trustedCustomerSubmission: false })
            if (normalized) {
              const canonical = normalizeCanonicalFact({ fieldKey: rawItem?.field_key || normalized.fieldKey || '', value: rawItem?.value ?? normalized.standardValue, sourceExcerpt: normalized.sourceExcerpt, displayText: normalized.displayText, semanticKind: rawItem?.semantic_kind || normalized.semanticKind, occurredAt: normalized.occurredAt })
              normalized._canonicalGrounded = canonical.grounded !== false
              normalized._canonicalFieldKey = canonical.canonicalFieldKey
              normalized._temporalType = canonical.temporalType
              if (canonical.storageFieldKey) {
                normalized.fieldKey = canonical.storageFieldKey
                normalized.standardValue = canonical.canonicalValue
                normalized.semanticKind = canonical.semanticKind
              } else {
                // Unknown mappings remain auditable Evidence but cannot enter
                // profile update or conflict logic.
                normalized.fieldKey = null
              }
              const excerpt = normalizeText(normalized.sourceExcerpt, 500).replace(/\s+/g, '')
              const rawSource = normalizeText(source.rawText, 500_000)
              const compactSource = rawSource.replace(/\s+/g, '')
              const exactExcerpt = Boolean(excerpt && compactSource.includes(excerpt))
              const rawStart = Number(rawItem?.locator?.char_start)
              const rawEnd = Number(rawItem?.locator?.char_end)
              const rangeIsGrounded = (start, end) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= rawSource.length && rawSource.slice(start, end).trim().length > 0
              const explicitRange = rangeIsGrounded(rawStart, rawEnd) || rangeIsGrounded(Number(chunk.charStart || 0) + rawStart, Number(chunk.charStart || 0) + rawEnd)
              normalized._sourceGrounded = exactExcerpt || explicitRange
              const privacy = classifyPrivacyText(`${normalized.displayText}\n${normalized.sourceExcerpt}`)
              normalized.privacyLevel = privacy.privacyLevel
              normalized.privacyMeta = privacy
              normalized.mentorSafeText = privacySafeText(privacy, normalized.displayText)
              const privacyPolicy = resolvePrivacyPolicy({ privacyLevel: privacy.privacyLevel, categories: privacy.categories, safetyFlags: privacy.safetyFlags, currentRole: 'ADMIN', assertionType: privacy.assertionType, verification: privacy.verification, serviceNecessity: privacy.serviceNecessity, temporalType: privacy.temporalType })
              if (!privacyPolicy.canUseInGlobalAI) processingDiagnostics.privacy_restricted_count += 1
              candidates.push(normalized)
            }
          }
        }
      }
      // Deduplicate both the model output and any already-persisted recovery
      // batch by stable logical identity. Physical duplicates remain
      // auditable in Feishu, but may not cause repeated profile writes.
      const unique = resumeExistingEvidence ? dedupeEvidence(resumableEvidence) : dedupeEvidence(candidates)
      const protectedKeys = new Set(allExistingEvidence.filter((item) => item.reviewStatus === 'CONFIRMED').map((item) => evidenceLogicalKey(item)))
      const rejectedEvidence = []
      const replaceableEvidence = (resumeExistingEvidence ? unique : unique.filter((item) => !protectedKeys.has(evidenceLogicalKey(item)))).filter((item) => {
        if (resumeExistingEvidence) return true
        const compactExcerpt = normalizeText(item.sourceExcerpt, 500).replace(/\s+/g, '')
        const valid = item.sourceId === sourceId && Boolean(compactExcerpt) && item._sourceGrounded === true && item._canonicalGrounded === true
        if (!valid) rejectedEvidence.push({ fieldKey: item.fieldKey || '', reason: item._sourceGrounded === true ? 'CANONICAL_NOT_GROUNDED' : 'SOURCE_NOT_GROUNDED' })
        return valid
      })
      processingDiagnostics.rejected_evidence_count = rejectedEvidence.length
      const customer = database.customers.find((item) => item.id === source.customerId)
      const createdEvidence = []
      for (const item of replaceableEvidence) {
        const evidence = { ...item, id: resumeExistingEvidence ? item.id : stableId('EVD', `${sourceId}:${batchId}:${evidenceLogicalKey(item)}`), extractionBatchId: batchId }
        if (resumeExistingEvidence) {
          createdEvidence.push(evidence)
          continue
        }
        try {
          const write = await createMappedRecord('evidenceItems', 'evidence.create', { evidence_id: evidence.id, subject_type: source.subjectType, subject_id: source.subjectId, customer_id: source.customerId, source_id: sourceId, evidence_type: evidence.evidenceType, semantic_kind: evidence.semanticKind, field_key: evidence.fieldKey || '', standard_value: stage2Json(evidence.standardValue), display_text: evidence.displayText, source_excerpt: evidence.sourceExcerpt, locator_json: stage2Json(evidence.locator), occurred_at: evidence.occurredAt || source.occurredAt || '', source_role: source.sourceRole, content_source: evidence.contentSource, information_nature: evidence.informationNature, verification_status: evidence.verificationStatus, confidence: evidence.confidence, review_status: evidence.reviewStatus, reviewer_id: '', reviewed_at: '', extraction_batch_id: evidence.extractionBatchId, provider: 'DEEPSEEK', model: evidence.model, model_version: evidence.modelVersion, prompt_version: evidence.promptVersion, privacy_level: evidence.privacyLevel || 'NORMAL', privacy_meta_json: stage2Json(evidence.privacyMeta || {}), mentor_safe_text: evidence.mentorSafeText || evidence.displayText, created_at: now(), updated_at: now() })
          evidence._recordId = write?.record?.record_id || write?.record_id || ''
        } catch (error) {
          throw Object.assign(error instanceof Error ? error : new Error('Evidence 批次写入失败'), { code: 'EVIDENCE_WRITE_FAILED', causeCode: processingErrorCode(error) })
        }
        createdEvidence.push(evidence)
      }
      this.markScopedDirty(source.customerId, ['evidenceItems'])
      this.databaseCache.data = null; this.databaseCache.savedAt = 0; this.databaseCache.promise = null; this.databaseCache.generation += 1
      this.profileReadCache.data = null; this.profileReadCache.savedAt = 0; this.profileReadCache.promise = null; this.profileReadCache.generation += 1
      const expectedEvidenceIds = new Set(createdEvidence.map((item) => item.id).filter(Boolean))
      const expectedRecordIds = new Set((resumeExistingEvidence ? resumableEvidence : createdEvidence).map((item) => item._recordId).filter(Boolean))
      const exactBatchReadback = async () => {
        // Keep retries on the evidence table only — a force load with empty dirty
        // would otherwise re-search all scoped tables on every readback attempt.
        this.markScopedDirty(source.customerId, ['evidenceItems'])
        const persisted = await this.load({ force: true })
        const persistedAllEvidence = (persisted._allEvidenceItems || persisted.evidenceItems).filter((item) => item.sourceId === sourceId && item.extractionBatchId === batchId && item.reviewStatus !== 'SUPERSEDED')
        const persistedEvidenceIds = new Set(persistedAllEvidence.map((item) => item.id))
        const persistedRecordIds = new Set(persistedAllEvidence.map((item) => item._recordId))
        const idsMatch = expectedEvidenceIds.size === persistedEvidenceIds.size && [...expectedEvidenceIds].every((id) => persistedEvidenceIds.has(id))
        const recordsMatch = [...expectedRecordIds].every((id) => persistedRecordIds.has(id))
        if (idsMatch && recordsMatch) return { persistedAllEvidence, method: 'BATCH_LIST' }
        // Feishu list results can lag a successful create. Re-read only the
        // exact record IDs written (or safely resumed), with bounded retries.
        if (!expectedRecordIds.size) return null
        const exactRows = await Promise.all([...expectedRecordIds].map(async (recordId) => {
          try { return await getRecord(stage2Table('evidenceItems'), recordId) } catch (error) { if (error?.code === 'FEISHU_NOT_FOUND' || error?.retryable === true) return null; throw error }
        }))
        const exactItems = exactRows.filter(Boolean).map(evidenceItem)
        const exactIds = new Set(exactItems.filter((item) => item.sourceId === sourceId && item.extractionBatchId === batchId && item.reviewStatus !== 'SUPERSEDED').map((item) => item.id))
        return exactIds.size === expectedEvidenceIds.size && [...expectedEvidenceIds].every((id) => exactIds.has(id))
          ? { persistedAllEvidence: exactItems, method: 'EXACT_RECORDS' }
          : null
      }
      const readback = await boundedReadAfterWrite(exactBatchReadback, { delays: READ_AFTER_WRITE_DELAYS_MS, isVisible: Boolean })
      if (!readback.value) throw Object.assign(new Error('Evidence 批次精确回读校验失败'), { code: 'EVIDENCE_BATCH_READBACK_FAILED', status: 502 })

      // A zero-result replacement must never erase a previously active
      // generation. The new batch is kept for diagnostics only; the source
      // pointer stays on the last known-good generation.
      if (replaceableEvidence.length === 0 && existingEvidence.length > 0) {
        const finishedAt = now()
        const uniqueUnprotectedCandidates = unique.filter((item) => !protectedKeys.has(evidenceLogicalKey(item)))
        const groundingRejected = uniqueUnprotectedCandidates.length > 0 && rejectedEvidence.length === uniqueUnprotectedCandidates.length && rejectedEvidence.every((item) => ['SOURCE_NOT_GROUNDED', 'CANONICAL_NOT_GROUNDED'].includes(item.reason))
        const emptyBatchError = candidates.length === 0
          ? 'EMPTY_BATCH_EXTRACTED_NONE_PRESERVED_ACTIVE_GENERATION'
          : groundingRejected
            ? 'EMPTY_BATCH_GROUNDING_ALL_FAILED_PRESERVED_ACTIVE_GENERATION'
            : 'NO_VALID_EVIDENCE_PRESERVED_ACTIVE_GENERATION'
        await updateMappedRecord('sourceRecords', `source.processing.${emptyBatchError.toLowerCase()}`, sourceRow.record_id, {
          processing_status: 'REVIEW_REQUIRED',
          processing_version: processingVersion,
          last_processing_at: finishedAt,
          processing_error: emptyBatchError,
          updated_at: finishedAt,
        })
        this.markScopedDirty(source.customerId, ['sourceRecords', 'evidenceItems'])
        const preserved = await this.load({ force: true })
        const preservedEvidence = preserved.evidenceItems.filter((item) => item.sourceId === sourceId)
        this.evidenceTraces.unshift({ source_id: sourceId, processing_status: 'REVIEW_REQUIRED', processing_error: emptyBatchError, extraction_batch: batchId, evidence_count: 0, preserved_active_evidence_count: preservedEvidence.length, proposal_count: 0, conflict_count: 0, model: config.deepseek.model, prompt_version: 'evidence-v1', ...processingDiagnostics, rejected_evidence_count: rejectedEvidence.length, source_save_ms: this.sourceSaveTimes.get(sourceId), background_analysis_ms: Date.now() - startedAt, duration_ms: Date.now() - startedAt })
        this.evidenceTraces = this.evidenceTraces.slice(0, 50)
        this.audit('PROCESS_SOURCE', sourceId, actorId, 'REVIEW_REQUIRED', emptyBatchError)
        return this.sourceDetail(actorId, sourceId)
      }

      try {
        await updateMappedRecord('sourceRecords', 'source.processing.activate', sourceRow.record_id, { last_batch_id: batchId, updated_at: now() })
      } catch (error) {
        throw Object.assign(new Error('Evidence 批次切换失败'), { code: 'EVIDENCE_BATCH_SWITCH_FAILED', causeCode: processingErrorCode(error) })
      }
      this.markScopedDirty(source.customerId, ['sourceRecords', 'evidenceItems'])
      const activated = await this.load({ force: true })
      const oldReplaceable = (activated._allEvidenceItems || activated.evidenceItems).filter((item) => item.sourceId === sourceId && item.reviewStatus !== 'CONFIRMED' && item.reviewStatus !== 'SUPERSEDED' && item.extractionBatchId !== batchId)
      for (const oldEvidence of oldReplaceable) await updateMappedRecord('evidenceItems', 'evidence.supersede', oldEvidence._recordId, { review_status: 'SUPERSEDED', updated_at: now() })
      this.markScopedDirty(source.customerId, ['evidenceItems'])
      const refreshed = await this.load({ force: true })
      // A legacy/failed batch can contain repeated physical rows with the
      // same logical Evidence identity. Keep them for audit, but materialize
      // the profile from one canonical item only.
      const allEvidence = dedupeEvidence(refreshed.evidenceItems.filter((item) => item.sourceId === sourceId))
      if (!customer) throw Object.assign(new Error('客户不存在'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
      const automaticMode = automaticProfileArchivingAllowedForCustomer(source.customerId)
      const derivedErrors = []
      const archivingCounts = {
        mappedEvidenceCount: 0,
        mappedNoChangeCount: 0,
        physicalFieldWriteCount: 0,
        supplementaryWriteCount: 0,
        unresolvedMappedEvidenceCount: 0,
      }
      for (const evidence of allEvidence) {
        try {
          if (evidence.fieldKey) archivingCounts.mappedEvidenceCount += 1
          const currentValue = database.customers.find((item) => item.id === source.customerId)?.profileFields?.[evidence.fieldKey] ?? null
          const change = classifyEvidenceChange(evidence, currentValue)
          const existingProposal = refreshed.profileUpdateProposals.find((item) => item.evidenceId === evidence.id)
          if (existingProposal || (evidence.evidenceType !== 'FACT' && evidence.fieldKey)) {
            if (evidence.fieldKey) archivingCounts.unresolvedMappedEvidenceCount += 1
            continue
          }
          const timestamp = now()
          if (change.changeType === 'NO_CHANGE') {
            if (evidence.fieldKey) archivingCounts.mappedNoChangeCount += 1
            if (!automaticMode && evidence.reviewStatus !== 'CONFIRMED') await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
            continue
          }
          if (!automaticMode && shouldAutoConfirmEvidence(evidence) && evidence.reviewStatus !== 'CONFIRMED') await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
          const privacyPolicy = resolvePrivacyPolicy({ ...combinePrivacyContext(evidence, source), currentRole: 'ADMIN' })
          const provenanceAllowsAutoApply = automaticMode
            ? !['UNKNOWN', 'MIXED'].includes(evidence.contentSource) && evidence.informationNature !== 'AI_INFERENCE' && evidence.verificationStatus !== 'CONFLICTED'
            : !evidence.contentSource && !evidence.informationNature && !evidence.verificationStatus
              ? true
              : evidence.verificationStatus === 'HUMAN_VERIFIED'
          if (!evidence.fieldKey) {
            if (automaticMode && privacyPolicy.canPromoteToProfile && provenanceAllowsAutoApply) {
              const appended = await appendCustomerSupplementaryItem(database, source.customerId, evidence, actorId)
              if (appended) archivingCounts.supplementaryWriteCount += 1
            }
            continue
          }
          const currentCustomer = database.customers.find((item) => item.id === source.customerId)
          const profileMeta = currentCustomer?.profileFieldMeta?.[evidence.fieldKey]
          const incomingEventAt = evidence.occurredAt || source.occurredAt || ''
          const incomingEntryAt = source.uploadedAt || source.createdAt || ''
          const currentEventAt = profileMeta?.sourceEventAt || ''
          const currentEntryAt = profileMeta?.sourceEntryAt || ''
          const incomingEventMs = incomingEventAt ? new Date(incomingEventAt).getTime() : Number.NaN
          const currentEventMs = currentEventAt ? new Date(currentEventAt).getTime() : Number.NaN
          const incomingEntryMs = incomingEntryAt ? new Date(incomingEntryAt).getTime() : Number.NaN
          const currentEntryMs = currentEntryAt ? new Date(currentEntryAt).getTime() : Number.NaN
          const sameSource = profileMeta?.sourceRecordId && profileMeta.sourceRecordId === sourceId
          const incomingVersion = Number(source.sourceVersion || 0)
          const currentVersion = Number(profileMeta?.sourceVersion || 0)
          const incomingOrderMs = Number.isFinite(incomingEventMs) ? incomingEventMs : incomingEntryMs
          const currentOrderMs = Number.isFinite(currentEventMs) ? currentEventMs : currentEntryMs
          const olderSourceOrder = Number.isFinite(incomingOrderMs) && Number.isFinite(currentOrderMs) && incomingOrderMs < currentOrderMs
          const olderSameSourceVersion = sameSource && incomingVersion > 0 && currentVersion > 0 && incomingVersion < currentVersion
          const staleIncoming = olderSourceOrder || olderSameSourceVersion
          const currentFactAllowed = automaticMode && isSnapshotEvidence(evidence) && !staleIncoming
          const requiresReview = Boolean(change.conflictType && isSnapshotEvidence(evidence) && !currentFactAllowed)
          const autoApply = privacyPolicy.canPromoteToProfile && provenanceAllowsAutoApply && !requiresReview && !staleIncoming && isSnapshotEvidence(evidence) && (['ADD', 'UPDATE', 'APPEND'].includes(change.action) || currentFactAllowed) && PROFILE_FIELD_KEYS.has(evidence.fieldKey)
          if (autoApply) {
            const update = normalizeProfileUpdates([{ field: evidence.fieldKey, value: evidence.standardValue, source: 'AI_EXTRACTED', confidence: evidence.confidence }], database.customers.find((item) => item.id === source.customerId), automaticMode ? false : true)[0]
            if (update) {
              const profileWrite = await persistCustomerProfile(database, source.customerId, [update], undefined, actorId, {
                sourceRecordId: sourceId,
                evidenceId: evidence.id,
                updateBatchId: evidence.extractionBatchId,
                sourceEventAt: incomingEventAt,
                sourceEntryAt: incomingEntryAt,
                sourceVersion: incomingVersion,
              })
              archivingCounts.physicalFieldWriteCount += profileWrite.changes.length
              if (profileWrite.changes.length === 0) archivingCounts.mappedNoChangeCount += 1
              if (!automaticMode) await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
            }
          }
          if (!autoApply) archivingCounts.unresolvedMappedEvidenceCount += 1
          if (automaticMode && !autoApply && (evidence.informationNature === 'AI_INFERENCE' || evidence.evidenceType === 'HYPOTHESIS')) await appendCustomerSupplementaryItem(database, source.customerId, evidence, actorId)
          const reviewStatus = automaticMode ? 'PENDING_REVIEW' : autoApply || shouldAutoConfirmEvidence(evidence) ? 'CONFIRMED' : 'PENDING_REVIEW'
          if (privacyPolicy.canPromoteToProfile && evidence.fieldKey && isSnapshotEvidence(evidence)) {
            const proposalAction = autoApply && change.action === 'REVIEW_REQUIRED' ? 'UPDATE' : change.action
            const proposal = { id: proposalId(evidence.id, evidence.fieldKey), customerId: source.customerId, subjectId: source.subjectId, evidenceId: evidence.id, sourceId, fieldKey: evidence.fieldKey, fieldName: mapField('customers', evidence.fieldKey), currentValue, proposedValue: evidence.standardValue, action: PROPOSAL_ACTIONS.has(proposalAction) ? proposalAction : 'REVIEW_REQUIRED', changeType: change.changeType, reviewStatus, reason: evidence.displayText, confidence: evidence.confidence, extractionBatchId: evidence.extractionBatchId, reviewerId: '', reviewedAt: null, createdAt: timestamp, updatedAt: timestamp }
            if (!refreshed.profileUpdateProposals.some((item) => item.id === proposal.id)) await createMappedRecord('profileUpdateProposals', 'proposal.create', { proposal_id: proposal.id, customer_id: proposal.customerId, subject_id: proposal.subjectId, evidence_id: proposal.evidenceId, source_id: proposal.sourceId, field_key: proposal.fieldKey, field_name: proposal.fieldName, current_value: stage2Json(proposal.currentValue), proposed_value: stage2Json(proposal.proposedValue), action: proposal.action, change_type: proposal.changeType, review_status: proposal.reviewStatus, reason: proposal.reason, confidence: proposal.confidence, extraction_batch_id: proposal.extractionBatchId, reviewer_id: proposal.reviewerId, reviewed_at: proposal.reviewedAt || '', created_at: proposal.createdAt, updated_at: proposal.updatedAt })
          }
          if (requiresReview) {
            this.markScopedDirty(source.customerId, ['evidenceItems', 'evidenceConflicts'])
            const latest = await this.load({ force: true })
            const currentEvidence = latest.evidenceItems.find((item) => item.customerId === source.customerId && item.fieldKey === evidence.fieldKey && item.reviewStatus === 'CONFIRMED' && JSON.stringify(item.standardValue ?? null) === JSON.stringify(currentValue ?? null))
            const conflict = { id: conflictId(evidence.fieldKey, currentEvidence?.id || '', evidence.id), subjectId: source.subjectId, customerId: source.customerId, fieldKey: evidence.fieldKey, conflictType: change.conflictType, currentValue, newValue: evidence.standardValue, currentEvidenceId: currentEvidence?.id || '', newEvidenceId: evidence.id, status: 'OPEN', suggestedResolution: '人工核验当前资料与新资料', resolution: '', reviewerId: '', resolvedAt: null, createdAt: timestamp, updatedAt: timestamp }
            if (!latest.evidenceConflicts.some((item) => item.id === conflict.id)) await createMappedRecord('evidenceConflicts', 'conflict.create', { conflict_id: conflict.id, subject_id: conflict.subjectId, customer_id: conflict.customerId, field_key: conflict.fieldKey, conflict_type: conflict.conflictType, current_value: stage2Json(conflict.currentValue), new_value: stage2Json(conflict.newValue), current_evidence_id: conflict.currentEvidenceId, new_evidence_id: conflict.newEvidenceId, status: 'OPEN', suggested_resolution: conflict.suggestedResolution, resolution: '', reviewer_id: '', resolved_at: '', created_at: conflict.createdAt, updated_at: conflict.updatedAt })
          }
        } catch (error) {
          derivedErrors.push(processingErrorCode(error))
        }
      }
      const debugBeforeStatus = await this.load()
      const hasOpenConflict = debugBeforeStatus.evidenceConflicts.some((item) => item.newEvidenceId && debugBeforeStatus.evidenceItems.find((evidence) => evidence.id === item.newEvidenceId)?.sourceId === sourceId && item.status === 'OPEN')
      const archiveOutcome = classifyStructuredArchivingOutcome({
        validEvidenceCount: replaceableEvidence.length,
        ...archivingCounts,
        derivedErrorCount: derivedErrors.length,
        hasOpenConflict,
      })
      const finalStatus = archiveOutcome.status
      const finishedAt = now()
      const finalErrors = [...new Set([...derivedErrors, ...(archiveOutcome.errorCode ? [archiveOutcome.errorCode] : []), ...(candidates.length > 0 && replaceableEvidence.length === 0 ? ['NO_VALID_EVIDENCE'] : [])])]
      await updateMappedRecord('sourceRecords', `source.processing.${finalStatus.toLowerCase()}`, sourceRow.record_id, { processing_status: finalStatus, processing_version: processingVersion, last_processing_at: finishedAt, processing_error: finalErrors.length ? finalErrors.join(',').slice(0, 200) : '', updated_at: finishedAt })
      const debugDatabase = await this.load()
      this.evidenceTraces.unshift({ source_id: sourceId, processing_status: finalStatus, archive_outcome: archiveOutcome.outcome, processing_error: finalErrors.length ? finalErrors.join(',') : '', extraction_batch: batchId, evidence_count: replaceableEvidence.length, ...archivingCounts, proposal_count: debugDatabase.profileUpdateProposals.filter((item) => item.sourceId === sourceId).length, conflict_count: debugDatabase.evidenceConflicts.filter((item) => item.newEvidenceId && debugDatabase.evidenceItems.find((evidence) => evidence.id === item.newEvidenceId)?.sourceId === sourceId).length, model: config.deepseek.model, prompt_version: 'evidence-v1', ...processingDiagnostics, source_save_ms: this.sourceSaveTimes.get(sourceId), background_analysis_ms: Date.now() - startedAt, duration_ms: Date.now() - startedAt })
      this.evidenceTraces = this.evidenceTraces.slice(0, 50)
      this.audit('PROCESS_SOURCE', sourceId, actorId)
      await this.markSafetyStale(source.customerId).catch((error) => this.audit('MARK_SAFETY_STALE', source.customerId, actorId, 'FAIL', error instanceof Error ? error.code || error.message : 'SAFETY_STALE_FAILED'))
      this.scheduleCustomerUnderstandingRefresh(actorId, source.customerId)
      return this.sourceDetail(actorId, sourceId)
    } catch (error) {
      const failedAt = now()
      const failedCode = finalizeAutoProcessingFailureCode(error, processingVersion)
      await updateMappedRecord('sourceRecords', 'source.processing.failed', sourceRow.record_id, { processing_status: 'FAILED', processing_version: processingVersion, last_processing_at: failedAt, processing_error: failedCode, updated_at: failedAt }).catch(() => {})
      this.evidenceTraces.unshift({ source_id: sourceId, processing_status: 'FAILED', processing_error: failedCode, extraction_batch: batchId, evidence_count: 0, proposal_count: 0, conflict_count: 0, model: config.deepseek.model, prompt_version: 'evidence-v1', ...processingDiagnostics, duration_ms: Date.now() - startedAt })
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
    const mappedEvidence = database.evidenceItems.filter((item) => item.sourceId === sourceId && item.fieldKey)
    const customer = database.customers.find((item) => item.id === source.customerId)
    const allMappedFactsPersisted = mappedEvidence.length > 0 && mappedEvidence.every((item) => sameProfileValue(customer?.profileFields?.[item.fieldKey], item.standardValue))
    const partialArchive = /STRUCTURED_ARCHIVE_PARTIAL|DERIVED_WRITE_FAILED|NO_ARCHIVABLE_FACTS/.test(source.processingError || '')
    if (partialArchive && !allMappedFactsPersisted) return
    if (!pendingProposal && !openConflict) {
      const row = database._rows.sourceRecords.find((item) => item.record_id === source._recordId)
      if (row) await updateRecord(stage2Table('sourceRecords'), row.record_id, mapFields('sourceRecords', { processing_status: 'COMPLETED', processing_error: '', updated_at: now() }))
    }
  }
  async reviewProposal(actorId, proposalIdValue, decision) {
    this.invalidateDatabaseCache()
    requireStage2Tables()
    const database = await this.load()
    const visibleDatabase = scope(database, actorId)
    const proposal = visibleDatabase.profileUpdateProposals.find((item) => item.id === proposalIdValue)
    if (!proposal) throw new Error('档案更新建议不存在')
    if (!['CONFIRM', 'REJECT'].includes(decision)) throw Object.assign(new Error('审核动作无效'), { code: 'INVALID_REVIEW_DECISION', status: 400 })
    const row = database._rows.profileUpdateProposals.find((item) => item.record_id === proposal._recordId)
    const timestamp = now()
    if (decision === 'CONFIRM') {
      const evidence = database.evidenceItems.find((item) => item.id === proposal.evidenceId)
      if (!evidence || !proposal.fieldKey) throw new Error('建议缺少可追溯证据')
      const current = database.customers.find((item) => item.id === proposal.customerId)
      const update = { field: proposal.fieldKey, value: proposal.proposedValue, source: evidence.evidenceType === 'HYPOTHESIS' ? 'AI_INFERENCE' : 'MENTOR_CONFIRMED', confidence: proposal.confidence, confirmed: true }
      if (update.source === 'AI_INFERENCE') throw Object.assign(new Error('AI假设不能写入当前客户档案'), { code: 'HYPOTHESIS_NOT_WRITABLE', status: 400 })
      await persistCustomerProfile(database, proposal.customerId, normalizeProfileUpdates([update], current, true), undefined, actorId, { sourceRecordId: proposal.sourceId, evidenceId: proposal.evidenceId, updateBatchId: proposal.extractionBatchId })
      // Confirming a profile proposal records a human decision about this
      // proposal. It does not prove the external truth of the evidence.
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
    const inFlight = this.conflictResolutionLocks.get(conflictIdValue)
    if (inFlight) return inFlight
    const task = this.resolveConflictUnsafe(actorId, conflictIdValue, resolution)
    this.conflictResolutionLocks.set(conflictIdValue, task)
    try { return await task } finally { if (this.conflictResolutionLocks.get(conflictIdValue) === task) this.conflictResolutionLocks.delete(conflictIdValue) }
  }
  async resolveConflictUnsafe(actorId, conflictIdValue, resolution) {
    this.invalidateDatabaseCache()
    requireStage2Tables()
    const database = await this.load()
    const visibleDatabase = scope(database, actorId)
    if (!CONFLICT_RESOLUTIONS.has(resolution)) throw Object.assign(new Error('冲突处理方式无效'), { code: 'INVALID_CONFLICT_RESOLUTION', status: 400 })
    const conflict = visibleDatabase.evidenceConflicts.find((item) => item.id === conflictIdValue)
    if (!conflict) throw new Error('冲突不存在')
    if (conflict.status !== 'OPEN') return this.sourceWorkspace(actorId, conflict.customerId)
    const row = database._rows.evidenceConflicts.find((item) => item.record_id === conflict._recordId)
    const proposal = database.profileUpdateProposals.find((item) => item.evidenceId === conflict.newEvidenceId)
    const timestamp = now()
    const evidence = database.evidenceItems.find((item) => item.id === conflict.newEvidenceId)
    if (resolution === 'USE_NEW' && proposal) {
      if (!evidence || !proposal.fieldKey) throw new Error('冲突缺少可追溯证据')
      const current = database.customers.find((item) => item.id === proposal.customerId)
      const update = normalizeProfileUpdates([{ field: proposal.fieldKey, value: proposal.proposedValue, source: 'MENTOR_CONFIRMED', confidence: proposal.confidence }], current, true)[0]
      if (!update) throw new Error('冲突的新资料无效')
      await persistCustomerProfile(database, proposal.customerId, [update], undefined, actorId, { sourceRecordId: proposal.sourceId, evidenceId: proposal.evidenceId, updateBatchId: proposal.extractionBatchId })
      // Conflict resolution chooses how the profile should proceed; it is
      // not an external fact-verification operation.
      await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
      const proposalRow = database._rows.profileUpdateProposals.find((item) => item.record_id === proposal._recordId)
      if (proposalRow) await updateRecord(stage2Table('profileUpdateProposals'), proposalRow.record_id, mapFields('profileUpdateProposals', { review_status: 'CONFIRMED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
    } else {
      const keepEvidence = resolution === 'KEEP_BOTH'
      if (evidence) await updateRecord(stage2Table('evidenceItems'), evidence._recordId, mapFields('evidenceItems', { review_status: keepEvidence ? 'CONFIRMED' : 'REJECTED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
      if (proposal) {
        const proposalRow = database._rows.profileUpdateProposals.find((item) => item.record_id === proposal._recordId)
        if (proposalRow) await updateRecord(stage2Table('profileUpdateProposals'), proposalRow.record_id, mapFields('profileUpdateProposals', { review_status: keepEvidence ? 'CONFIRMED' : 'REJECTED', reviewer_id: actorId, reviewed_at: timestamp, updated_at: timestamp }))
      }
    }
    await updateRecord(stage2Table('evidenceConflicts'), row.record_id, mapFields('evidenceConflicts', { status: 'RESOLVED', resolution, reviewer_id: actorId, resolved_at: timestamp, updated_at: timestamp }))
    const newEvidence = database.evidenceItems.find((item) => item.id === conflict.newEvidenceId)
    this.invalidateDatabaseCache()
    if (newEvidence) await this.maybeCompleteSource(newEvidence.sourceId)
    return this.sourceWorkspace(actorId, conflict.customerId)
  }
  async overrideServiceNecessity(actorId, { entityType = 'source', id, serviceNecessity } = {}) {
    this.invalidateDatabaseCache()
    if (!SERVICE_NECESSITY_LEVELS.has(serviceNecessity)) throw Object.assign(new Error('服务必要性等级无效'), { code: 'INVALID_SERVICE_NECESSITY', status: 400 })
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (!actor || actor.permissionRole !== 'ADMIN') throw Object.assign(new Error('只有管理员可以调整服务必要性'), { code: 'FORBIDDEN', status: 403 })
    const table = entityType === 'evidence' ? 'evidenceItems' : 'sourceRecords'
    const record = database[table].find((item) => item.id === id)
    const row = database._rows[table]?.find((item) => item.record_id === record?._recordId)
    if (!record || !row) throw Object.assign(new Error('隐私资料不存在'), { code: 'PRIVACY_RECORD_NOT_FOUND', status: 404 })
    const nextMeta = applyServiceNecessityOverride(record.privacyMeta || {}, serviceNecessity)
    await updateRecord(stage2Table(table), row.record_id, mapFields(table, { privacy_meta_json: JSON.stringify(nextMeta), updated_at: now() }))
    this.audit('OVERRIDE_SERVICE_NECESSITY', id, actorId)
    return this.sourceWorkspace(actorId, record.customerId)
  }
  async saveBrief(actorId, customerId, brief) { return this.customerWriteQueue.run(customerId, () => this.saveBriefUnsafe(actorId, customerId, brief)) }
  async saveBriefUnsafe(actorId, customerId, brief) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!row) throw new Error('客户不存在')
    await updateRecord(config.feishu.tables.customers, row.record_id, mapFields('customers', { brief }))
    return (await this.dashboard(actorId)).customers.find((item) => item.id === customerId)
  }

  async refreshCustomerSummary(actorId, customerId, { force = false } = {}) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    const visible = scope(database, actorId)
    const customerRecord = visible.customers.find((item) => item.id === customerId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!customerRecord || !row) throw new Error('客户不存在')
    const evidenceItems = visible.evidenceItems.filter((item) => item.customerId === customerId && resolvePrivacyPolicy({ privacyLevel: item.privacyLevel, categories: item.privacyMeta?.categories, safetyFlags: item.privacyMeta?.safetyFlags, currentRole: 'ADMIN', assertionType: item.privacyMeta?.assertionType }).canUseInGlobalAI)
    const inputFingerprint = summaryInputFingerprint({ customer: customerRecord, evidenceItems })
    const currentMeta = customerRecord.aiSummaryMeta || {}
    const processingAge = currentMeta.updatedAt ? Date.now() - new Date(currentMeta.updatedAt).getTime() : Number.POSITIVE_INFINITY
    if (!force && currentMeta.status === 'PROCESSING' && processingAge >= 0 && processingAge < 5 * 60 * 1000) return customerRecord
    if (!force && currentMeta.status === 'FRESH' && currentMeta.inputFingerprint === inputFingerprint) return customerRecord
    const processingMeta = { ...currentMeta, status: 'PROCESSING', inputFingerprint, updatedAt: now() }
    await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { aiSummary: processingMeta }) }), (latestCustomer) => latestCustomer.aiSummaryMeta?.updatedAt === processingMeta.updatedAt && latestCustomer.aiSummaryMeta?.status === processingMeta.status)
    try {
      const privateProfileFields = new Set(['phone', 'wechat', 'current_mentor_id', 'mentor_id'])
      const safeProfile = Object.fromEntries(Object.entries(customerRecord.profileFields || {}).filter(([field]) => !privateProfileFields.has(field)))
      const safeText = (value) => String(value || '').replace(/1\d{10}/g, '[PHONE_REDACTED]').replace(/微信(?:号|号码)?[：:]?\s*[A-Za-z0-9_-]+/gi, '微信信息已省略')
      const safeEvidence = evidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED' && item.evidenceType !== 'HYPOTHESIS').map((item) => ({ evidenceType: item.evidenceType, semanticKind: item.semanticKind, fieldKey: item.fieldKey, value: item.standardValue, displayText: safeText(item.displayText), occurredAt: item.occurredAt }))
      const safeRenderer = { coverage: customerRecord.profileMaterialization?.coverage || null, sections: (customerRecord.profileMaterialization?.sections || []).map((section) => ({ title: section.title, items: section.items.map((item) => ({ label: item.label, text: safeText(item.text) })) })) }
      const context = { now: new Date().toISOString(), customer: { need: safeText(customerRecord.need), helpExpectation: safeText(customerRecord.helpExpectation), goal: safeText(customerRecord.goal), profile: safeProfile }, currentCase: null, recentSessions: [], recentChanges: [], enrollments: [], profileRenderer: safeRenderer, confirmedEvidence: safeEvidence }
      const result = await createCustomerIntelligence({ context })
      const freshMeta = { status: 'FRESH', inputFingerprint, summary: result.summary, updatedAt: now() }
      await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { aiSummary: freshMeta }), ai_customer_summary: JSON.stringify(result.summary) }), (latestCustomer) => latestCustomer.aiSummaryMeta?.updatedAt === freshMeta.updatedAt && latestCustomer.aiSummaryMeta?.status === freshMeta.status)
      return (await this.load()).customers.find((item) => item.id === customerId)
    } catch (error) {
      const failedMeta = { ...processingMeta, status: 'FAILED', updatedAt: now(), errorCode: 'SUMMARY_REFRESH_FAILED' }
      await updateCustomerRecordSafely(row.record_id, customerId, (latestCustomer) => mapFields('customers', { profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { aiSummary: failedMeta }) }), (latestCustomer) => latestCustomer.aiSummaryMeta?.updatedAt === failedMeta.updatedAt && latestCustomer.aiSummaryMeta?.status === failedMeta.status).catch(() => {})
      throw Object.assign(new Error('客户摘要刷新失败，请稍后重试'), { code: 'SUMMARY_REFRESH_FAILED', status: 503, cause: error })
    }
  }

  async createMentor(actorId, input) {
    const phone = normalizePhone(input?.phone)
    const previous = mentorCreateLocks.get(phone) || Promise.resolve()
    const current = previous.then(() => this.createMentorLocked(actorId, input, phone))
    const tracked = current.catch(() => {})
    mentorCreateLocks.set(phone, tracked)
    try { return await current } finally { if (mentorCreateLocks.get(phone) === tracked) mentorCreateLocks.delete(phone) }
  }

  async createMentorLocked(actorId, input, phone = normalizePhone(input?.phone)) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以管理导师账户')
    const name = text(input?.name).trim()
    if (!name) throw new Error('导师昵称不能为空')
    if (!validPhone(phone)) throw new Error('请输入有效手机号')
    const findAuthByStaffId = async (staffId) => typeof this.authRepository.findByStaffId === 'function' ? this.authRepository.findByStaffId(staffId).catch(() => null) : null
    const duplicate = database.staff.find((item) => normalizePhone(item.phone) === phone)
    const existingCredential = await this.authRepository.findByPhone?.(phone)
    if (duplicate || existingCredential) {
      const credential = duplicate ? await findAuthByStaffId(duplicate.id) || existingCredential : existingCredential
      if (duplicate?.status === 'ACTIVE' && credential && credential.credentialStatus !== 'DISABLED') throw Object.assign(new Error('该手机号已绑定完整导师账户，无需重复创建。若未保存初始密码，请使用重置密码。'), { code: 'ACCOUNT_ALREADY_EXISTS', status: 409 })
      throw Object.assign(new Error('该手机号对应的导师账户资料不完整，系统未重复创建，请联系管理员处理。'), { code: 'ACCOUNT_INCONSISTENT', status: 409 })
    }
    const initialPassword = typeof input?.initialPassword === 'string' && input.initialPassword ? input.initialPassword : generateInitialPassword({ phone })
    validatePassword(initialPassword, { phone })
    const passwordHash = await hashPassword(initialPassword)
    const createdAt = feishuDate()
    const staffId = stableOperationId(phone, 'M')
    const credentialId = stableOperationId(phone, 'CRED')
    let staffRecordId = ''
    let staffWriteCommitted = false
    let authWriteCommitted = false
    try {
      const createdStaff = await createRecord(config.feishu.tables.staff, mapFields('staff', { staff_id: staffId, nickname: name, name, phone, login_phone: phone, role: 'MENTOR', permission_role: 'MENTOR', status: 'ACTIVE', display_status: '在职', login_enabled: true, created_at: createdAt, updated_at: createdAt, display_role: '导师', mentor_id: staffId, specialty: '' }), { operation: 'mentor.create', operationId: staffId, entityType: 'staff', idempotency: { field: mapField('staff', 'phone'), value: phone } })
      staffRecordId = createdStaff?.record?.record_id || createdStaff?.record_id || ''
      staffWriteCommitted = true
      await this.authRepository.createCredential({ credentialId, staffId, loginPhone: phone, passwordHash, passwordAlgorithm: 'scrypt', mustChangePassword: true, passwordChangedAt: null, authVersion: 1, credentialStatus: 'ACTIVE', createdAt, updatedAt: createdAt, lastLoginAt: null })
      authWriteCommitted = true
    } catch (error) {
      if (!staffWriteCommitted && error?.retryable) {
        const reconciledStaff = await this.reconcileMentorStaff(phone, staffId)
        if (reconciledStaff) {
          staffRecordId = reconciledStaff._recordId || staffRecordId
          staffWriteCommitted = true
          try {
            await this.authRepository.createCredential({ credentialId, staffId, loginPhone: phone, passwordHash, passwordAlgorithm: 'scrypt', mustChangePassword: true, passwordChangedAt: null, authVersion: 1, credentialStatus: 'ACTIVE', createdAt, updatedAt: createdAt, lastLoginAt: null })
            authWriteCommitted = true
          } catch (reconcileError) {
            const existingAuth = await findAuthByStaffId(staffId)
            if (existingAuth) authWriteCommitted = true
            else error = reconcileError
          }
        }
      }
      if (staffWriteCommitted && !authWriteCommitted) {
        const existingAuth = await findAuthByStaffId(staffId)
        if (existingAuth) authWriteCommitted = true
      }
      if (staffWriteCommitted && authWriteCommitted) error = null
      let compensated = false
      if (staffRecordId && staffWriteCommitted && !authWriteCommitted && error?.code !== 'ACCOUNT_INCONSISTENT') {
        try { await deleteRecord(config.feishu.tables.staff, staffRecordId); compensated = true } catch (rollbackError) { this.audit('CREATE_MENTOR_ROLLBACK', staffId, actorId, 'FAILED', rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); throw Object.assign(new Error('导师账号创建未完成，系统回滚失败，请联系管理员。'), { code: 'MENTOR_CREATE_ROLLBACK_FAILED', status: 503, cause: error }) }
      }
      if (staffWriteCommitted && !authWriteCommitted && !compensated) {
        const partial = Object.assign(new Error('导师账号创建未完成，系统已保留异常记录，请联系管理员处理。'), { code: 'PARTIAL_INCONSISTENT', status: 503, cause: error })
        this.audit('CREATE_MENTOR', staffId, actorId, 'PARTIAL', partial.message)
        throw partial
      }
      if (error) {
        this.audit('CREATE_MENTOR', staffId, actorId, 'FAILED', error instanceof Error ? error.message : String(error))
        throw error
      }
    }
    this.audit('CREATE_MENTOR', staffId, actorId)
    const created = { id: staffId, name, role: 'MENTOR', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, displayRole: '导师', title: '导师', phone, specialty: '', avatar: name.slice(0, 1) }
    return { ...created, initialPassword, accountCreateCommitted: true, createOutcome: 'CREATED' }
  }

  async reconcileMentorStaff(phone, staffId) {
    try {
      const database = await this.load({ force: true })
      return database.staff.find((item) => item.id === staffId || normalizePhone(item.phone) === phone) || null
    } catch { return null }
  }

  async updateMentor(actorId, mentorId, input) {
    this.invalidateDatabaseCache()
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
      const credential = await this.authRepository.findByStaffId(mentorId)
      await updateRecord(config.feishu.tables.staff, row.record_id, mapFields('staff', { nickname: name, name, phone, login_phone: phone, role: 'MENTOR', permission_role: 'MENTOR', status: 'ACTIVE', display_status: '在职', login_enabled: Boolean(credential && credential.credentialStatus !== 'DISABLED'), updated_at: feishuDate(), display_role: '导师' }))
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
    this.invalidateDatabaseCache()
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

  async updateCustomerReferrer(actorId, customerId, referrerName) { return this.customerWriteQueue.run(customerId, () => this.updateCustomerReferrerUnsafe(actorId, customerId, referrerName)) }
  async updateCustomerReferrerUnsafe(actorId, customerId, referrerName) {
    this.invalidateDatabaseCache()
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw Object.assign(new Error('只有 ADMIN 可以修改介绍人'), { code: 'FORBIDDEN', status: 403 })
    const visibleDatabase = scope(database, actorId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!row || !visibleDatabase.customers.some((item) => item.id === customerId)) throw new Error('客户不存在')
    const value = typeof referrerName === 'string' ? referrerName.trim() : ''
    const previous = visibleDatabase.customers.find((item) => item.id === customerId)?.referrerName || ''
    await updateRecord(config.feishu.tables.customers, row.record_id, mapFields('customers', { referrer_name: value }))
    if (previous !== value) {
      const changedAt = feishuDate()
      await createMappedRecord('profileChanges', 'profile-change.manual-introducer', { customer_id: customerId, field: 'introducer', field_key: 'introducer', field_name: '介绍人', old_value: JSON.stringify(previous || null), new_value: JSON.stringify(value || null), source: 'MANUAL', confidence: 1, confirmed: true, updated_at: changedAt, changed_at: changedAt, operator_id: actorId, service_record_id: '', source_record_id: '', evidence_id: '', update_batch_id: '' })
    }
    return (await this.dashboard(actorId)).customers.find((item) => item.id === customerId)
  }

  async assignAppointment(actorId, appointmentId, mentorId) {
    this.invalidateDatabaseCache()
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
    this.invalidateDatabaseCache()
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
    this.invalidateDatabaseCache()
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
    const automaticText = automaticProfileText({ profileUpdates }, [input.profileText, input.notes, input.coreNeed].filter(Boolean).join('\n'))
    let serviceRecordCreated = false
    try {
      await createRecord(config.feishu.tables.serviceRecords, mapFields('serviceRecords', { service_record_id: serviceRecordId, customer_id: appointment.customerId, appointment_id: appointment.id, mentor_id: appointment.assignedMentorId || actorId, operator_id: actorId, topic: input.topic, result: input.result, current_core_need: input.coreNeed, is_paid: input.paid, sabc: input.grade, intended_course: input.intendedCourse || '', notes: input.notes, profile_text: input.profileText || '', profile_updates_json: JSON.stringify(profileUpdates), profile_update_confirmed: profileUpdates.length > 0, ai_summary: input.aiSummary || '', ai_status: input.aiStatus || '', ai_next_step: input.aiNextStep || '', mentor_confirmed: true, created_at: now }), { operation: 'service-record.create', operationId: serviceRecordId, customerId: appointment.customerId, entityType: 'serviceRecords', idempotency: { field: mapField('serviceRecords', 'service_record_id'), value: serviceRecordId } })
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
    if (customerRow) {
      if (automaticProfileArchivingAllowedForCustomer(appointment.customerId) && automaticText) {
        const pendingMarker = automaticProfilePendingMarker(automaticText, actorId, 'SERVICE_RECORD')
        await updateCustomerRecordSafely(customerRow.record_id, appointment.customerId, (latestCustomer) => mapFields('customers', {
          current_issue: input.coreNeed,
          is_paid: input.paid,
          sabc: input.grade,
          intended_course: input.intendedCourse || '',
          notes: input.notes,
          current_core_issue: input.coreNeed,
          profile_field_meta_json: serializeCustomerDerivedMeta(latestCustomer, { automaticProfilePending: pendingMarker }),
        }), (latestCustomer) => latestCustomer.automaticProfilePending?.contentHash === pendingMarker.contentHash)
      } else {
        await updateRecord(config.feishu.tables.customers, customerRow.record_id, mapFields('customers', { current_issue: input.coreNeed, is_paid: input.paid, sabc: input.grade, intended_course: input.intendedCourse || '', notes: input.notes, current_core_issue: input.coreNeed }))
      }
    }
      const automaticProfile = automaticText
        ? this.scheduleAutomaticCustomerProfile(actorId, appointment.customerId, automaticText, 'SERVICE_RECORD')
        : { status: 'NOT_REQUIRED' }
      return { ...scope(await this.load(), actorId), automaticProfile }
    } catch (error) {
      if (serviceRecordCreated) Object.assign(error, { code: 'PARTIAL_WRITE', status: 500 })
      throw error
    }
  }

  async createAppointment(input) {
    this.invalidateDatabaseCache()
    let customerId = input.customerId
    const database = await this.load()
    if (!database.customers.some((item) => item.id === customerId)) {
      const normalized = validateManualCustomer({ nickname: input.nickname, phone: input.phone, wechat: input.wechat, situation: input.customerSituation || input.description })
      customerId = `CUS-${Date.now()}`
      await createRecord(config.feishu.tables.customers, mapFields('customers', { customer_id: customerId, nickname: normalized.nickname, phone: normalized.phone, wechat: normalized.wechat, source: '解忧小屋', notes: normalized.situation, created_at: input.createdAt || now(), sabc: 'C', is_paid: false, profile_schema_version: 'v0.5' }), { operation: 'appointment.customer.create', operationId: customerId, customerId, entityType: 'customers', idempotency: { field: mapField('customers', 'customer_id'), value: customerId } })
    }
    const appointmentId = input.requestId || `A-${Date.now()}`
    await createRecord(config.feishu.tables.appointments, mapFields('appointments', { appointment_id: appointmentId, customer_id: customerId, current_issue_description: input.description, expectation: input.expectation, submitted_at: input.submittedAt || new Date().toISOString(), status: 'WAIT_ASSIGN', assigned_mentor_id: '', followup_handled: false, followup_info_completed: false, created_at: input.createdAt || new Date().toISOString(), case_source: input.caseSource || input.source || 'JIEYOU_APPOINTMENT' }), { operation: 'appointment.create', operationId: appointmentId, customerId, entityType: 'appointments', idempotency: { field: mapField('appointments', 'appointment_id'), value: appointmentId } })
    return this.load()
  }

  async teamSnapshot(actorId, statusFilter = '') {
    const database = await this.customerDirectory(actorId)
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('无权查看团队数据')
    const all = await this.loadDirectory()
    return all.staff.filter((item) => item.permissionRole === 'MENTOR' && (!statusFilter || item.status === statusFilter)).map((mentor) => {
      const assignedCustomers = all.customers.filter((item) => customerBelongsToStaff(item, mentor.id))
      return { mentor, customerCount: assignedCustomers.length, customerPreviews: assignedCustomers.slice(0, 6).map((customer) => ({ id: customer.id, name: customer.name, initials: customer.initials, need: customer.need })) }
    })
  }

  async dashboardSnapshot(actorId) {
    const database = await this.customerDirectory(actorId)
    if (database.staff.find((item) => item.id === actorId)?.permissionRole !== 'ADMIN' || database.staff.find((item) => item.id === actorId)?.loginEnabled !== true) throw new Error('无权查看数据看板')
    const all = await this.loadDirectory()
    const currentMonth = new Date()
    const monthKeys = Array.from({ length: 3 }, (_, index) => {
      const month = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() - (2 - index), 1))
      return month.toISOString().slice(0, 7)
    })
    const customerTrend = monthKeys.map((monthKey) => ({ label: monthKey.slice(5), value: all.customers.filter((item) => item.createdAt.startsWith(monthKey)).length }))
    const currentMonthKey = monthKeys[2]
    return { customerCount: all.customers.length, monthNewCustomers: all.customers.filter((item) => item.createdAt.startsWith(currentMonthKey)).length, paidCustomers: all.customers.filter((item) => item.paid).length, mentorCount: all.staff.filter((item) => item.permissionRole === 'MENTOR').length, recentCustomers: all.customers.slice(0, 5) }
  }
}
