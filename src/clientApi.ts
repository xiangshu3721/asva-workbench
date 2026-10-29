import type { Customer, CustomerDraftPreview, CustomerSalesUnderstandingMeta, CustomerSalesUnderstandingV1, CustomerUnderstandingMeta, CustomerUnderstandingV1, Database, DialogueAssessment, DialogueConfirmation, EnrollmentDraft, FeedbackInput, ManualCustomerInput, MentorAccountInput, MentorAccountResult, NewAppointmentInput, ProfileDraft, ProfileMaterialization, ProfileUpdate, Staff, StaffStatus, SummaryStatus } from './domain'
import type { createLocalApi } from './api'
import { queryLocalAssistant } from './assistant'
import { createLocalBrief, createLocalCoreSummary, type AiBrief, type AiCoreSummary, type CustomerAiContext } from './customer-ai'
// @ts-expect-error Shared runtime module intentionally stays framework-neutral.
import { buildBasicDashboard } from '../shared/basic-dashboard.mjs'
// @ts-expect-error Shared runtime module intentionally stays framework-neutral.
import { createLocalCustomerUnderstanding } from '../shared/customer-understanding.mjs'
// @ts-expect-error Shared runtime module intentionally stays framework-neutral.
import { buildCustomerSalesContext, createLocalCustomerSalesUnderstanding, historicalSalesRecords } from '../shared/customer-sales-understanding.mjs'
import { readAccessToken, writeAccessToken } from './auth-storage'

type CustomerDto = Partial<Customer> & Pick<Customer, 'id' | 'name'>

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayValue<T>(value: unknown): T[] { return Array.isArray(value) ? value as T[] : [] }

/**
 * Keep the progressive directory/detail contract safe at the API boundary.
 * The directory intentionally returns only profile coverage; it must not be
 * mistaken for a fully materialized profile and must still be renderable.
 */
export function normalizeCustomerDto(value: unknown): Customer {
  const item = objectValue(value) as CustomerDto
  const rawMaterialization = objectValue(item.profileMaterialization)
  const hasMaterializationBody = Array.isArray(rawMaterialization.sections) && Array.isArray(rawMaterialization.lifeEvents)
  const coverage = objectValue(rawMaterialization.coverage)
  const profileMaterialization = item.profileMaterialization ? {
    schemaVersion: String(rawMaterialization.schemaVersion || ''),
    currentSnapshot: objectValue(rawMaterialization.currentSnapshot) as ProfileMaterialization['currentSnapshot'],
    sections: arrayValue<ProfileMaterialization['sections'][number]>(rawMaterialization.sections),
    provisionalItems: arrayValue<ProfileMaterialization['provisionalItems'][number]>(rawMaterialization.provisionalItems),
    supplementaryItems: arrayValue<NonNullable<ProfileMaterialization['supplementaryItems']>[number]>(rawMaterialization.supplementaryItems),
    lifeEvents: arrayValue<ProfileMaterialization['lifeEvents'][number]>(rawMaterialization.lifeEvents),
    ...(typeof rawMaterialization.rawNotes === 'string' ? { rawNotes: rawMaterialization.rawNotes } : {}),
    coverage: {
      percentage: Number(coverage.percentage || 0),
      domains: arrayValue<ProfileMaterialization['coverage']['domains'][number]>(coverage.domains),
    },
    aiSummaryStatus: (rawMaterialization.aiSummaryStatus || 'STALE') as SummaryStatus,
    ...(typeof rawMaterialization.aiSummaryFingerprint === 'string' ? { aiSummaryFingerprint: rawMaterialization.aiSummaryFingerprint } : {}),
  } : undefined
  return {
    ...(item as Customer),
    confirmedFacts: arrayValue<string>(item.confirmedFacts),
    aiQuestions: arrayValue<string>(item.aiQuestions),
    profileFields: objectValue(item.profileFields) as Customer['profileFields'],
    profileFieldMeta: objectValue(item.profileFieldMeta) as Customer['profileFieldMeta'],
    ...(profileMaterialization ? { profileMaterialization, profileMaterializationLoaded: hasMaterializationBody } : {}),
  }
}

export function normalizeDatabaseDto(value: unknown): Database {
  const database = objectValue(value)
  return {
    ...(database as unknown as Database),
    staff: arrayValue<Staff>(database.staff),
    customers: arrayValue(database.customers).map(normalizeCustomerDto),
    appointments: arrayValue<Database['appointments'][number]>(database.appointments),
    sessions: arrayValue<Database['sessions'][number]>(database.sessions),
    followups: arrayValue<Database['followups'][number]>(database.followups),
    products: arrayValue<Database['products'][number]>(database.products),
    enrollments: arrayValue<Database['enrollments'][number]>(database.enrollments),
    profileChanges: arrayValue<Database['profileChanges'][number]>(database.profileChanges),
  }
}

export interface AiDraft { summary: string; currentStatus: string; nextStep: string }
export interface CustomerIntelligence { summary: AiCoreSummary; brief: AiBrief }
export interface CustomerUnderstandingResponse { customerId: string; status: SummaryStatus; understanding: CustomerUnderstandingV1 | null; meta: CustomerUnderstandingMeta; evidence_refs: Array<{ evidence_id: string; source_id: string; source_title: string; display_text: string; excerpt: string; occurred_at?: string | null; evidence_type: string; source_perspective?: string }>; context_summary: { coverage_gaps: string[]; evidence_count: number } }
export interface CustomerSalesUnderstandingResponse { customerId: string; status: SummaryStatus; salesUnderstanding: CustomerSalesUnderstandingV1 | null; meta: CustomerSalesUnderstandingMeta; historical_enrollments: Array<{ name: string; type: string; status: string; enrolled_at?: string | null; paid_at?: string | null; payment_status: string; amount_recorded?: number | null }>; service_history: Array<{ name: string; type: string; status: string; occurred_at?: string | null; summary: string }>; evidence_refs: CustomerUnderstandingResponse['evidence_refs']; context_summary: { density: string; evidence_count: number } }
export interface SafetyAssessmentResponse { customerId: string; status: 'FRESH' | 'STALE' | 'PROCESSING' | 'FAILED'; assessment: { risk_level: string; risk_confidence: string; service_gate: string; commercial_block: string; requires_human_review: boolean; requires_safety_check: boolean; recommended_escalation: string; critical_unknowns: string[]; service_cautions: string[]; next_action: string; safety_signals: Array<{ signal_type: string; subject_scope: string; polarity: string; recency: string; short_description: string }>; } | null; meta: Record<string, unknown>; context_summary: { density: string; safety_data_sufficiency: string; critical_unknowns: string[]; evidence_count: number }; evidence_refs: Array<{ evidence_id: string; source_id: string; source_title: string; display_text: string; excerpt: string; occurred_at?: string | null; evidence_type: string; source_perspective?: string }> }
export interface TeamSnapshotCustomerPreview { id: string; name: string; initials: string; need: string }
export interface TeamSnapshot { mentor: Staff; customerCount: number; customerPreviews?: TeamSnapshotCustomerPreview[] }
export interface DashboardSnapshot { customerCount: number; monthNewCustomers: number; paidCustomers: number; mentorCount: number; recentCustomers: Customer[] }
export interface BasicDashboardCourse { course_id: string; course_name: string; enrollment_count: number; percentage: number }
export interface BasicDashboardOwner { staff_id: string; staff_name: string; role: string; customer_count: number }
export interface BasicDashboardInsight { type: string; text: string }
export interface BasicDashboard { customer_total: number; new_customers_this_week: number; previous_week_new_customers: number; enrolled_customer_total: number; active_enrollment_total: number; profile_pending_total: number; course_enrollment_distribution: BasicDashboardCourse[]; customer_owner_distribution: BasicDashboardOwner[]; management_insights: BasicDashboardInsight[]; generated_at: string }
export interface HealthMetadata { ok: boolean; service: string; appVersion?: string; releaseCounter?: number; release?: string; gitCommit?: string; gitBranch?: string; buildTime?: string | null; appEnv?: string; environment?: string; dataMode?: string; authMode?: string; featureFlags?: Record<string, boolean>; authConfigured?: boolean; adminAuthConfigured?: boolean; authCredentialStoreConfigured?: boolean; feishuConfigured?: boolean; deepseekConfigured?: boolean }
export interface SavePerformanceTrace { request_id?: string; operation_id?: string; result: 'SUCCESS' | 'ERROR'; customer_save_total_ms: number; identity_resolution_ms: number; customer_write_ms: number; enrollment_write_ms: number; profile_change_ms: number; ai_ms: number; other_ms: number }
export interface EvidenceDebugTrace { source_id: string; processing_status: string; extraction_batch: string; evidence_count: number; proposal_count: number; conflict_count: number; model: string; prompt_version: string; duration_ms: number }
export interface SourceRecord { id: string; subjectType: string; subjectId: string; customerId: string; sourceType: string; title: string; rawText?: string; fileRef?: string; fileName?: string; occurredAt?: string | null; uploadedAt?: string | null; uploadedBy?: string; sourceRole?: string; sourcePerspective?: 'STAFF_REPORTED' | 'CUSTOMER_FIRST_PARTY' | 'MENTOR_OBSERVATION'; contentHash?: string; processingStatus: string; processingVersion?: number; sensitivityLevel?: string; privacyLevel?: 'NORMAL' | 'SENSITIVE' | 'HIGH_SENSITIVE'; privacyStatus?: string; privacyMeta?: Record<string, unknown>; serviceNecessity?: 'LOW' | 'RELEVANT' | 'CRITICAL' | 'UNKNOWN'; serviceNecessityReason?: string; temporalType?: string; mentorSafeSummary?: string; mentorServiceDetail?: string; necessaryExcerpt?: string; salesSafeSummary?: string; sourceVersion?: number; lastBatchId?: string; processingStartedAt?: string | null; lastProcessingAt?: string | null; processingError?: string | null }
export interface EvidenceItem { id: string; sourceId: string; customerId: string; evidenceType: 'FACT' | 'SELF_MEANING' | 'OBSERVATION' | 'HYPOTHESIS'; semanticKind: string; fieldKey?: string; standardValue: unknown; displayText: string; sourceExcerpt: string; locator?: Record<string, unknown>; occurredAt?: string | null; sourceRole?: string; contentSource?: 'CUSTOMER_DIRECT' | 'STAFF_TRANSCRIBED_CUSTOMER' | 'MENTOR_REPORTED' | 'MENTOR_OBSERVATION' | 'THIRD_PARTY_REPORTED' | 'UNKNOWN' | 'MIXED'; informationNature?: 'OBJECTIVE_RECORD' | 'PERSONAL_STATEMENT' | 'REPORTED_SPEECH' | 'BEHAVIOR_OBSERVATION' | 'SUBJECTIVE_JUDGMENT' | 'AI_INFERENCE' | 'UNKNOWN'; verificationStatus?: 'UNKNOWN' | 'SOURCE_SUPPORTED' | 'HUMAN_VERIFIED' | 'CONFLICTED'; provenanceStatus?: 'EXPLICIT' | 'LEGACY_MISSING'; confidence: number; reviewStatus: string; privacyLevel?: 'NORMAL' | 'SENSITIVE' | 'HIGH_SENSITIVE'; privacyMeta?: Record<string, unknown>; serviceNecessity?: 'LOW' | 'RELEVANT' | 'CRITICAL' | 'UNKNOWN'; serviceNecessityReason?: string; temporalType?: string; mentorSafeText?: string; mentorServiceDetail?: string; necessaryExcerpt?: string; salesSafeSummary?: string; extractionBatchId?: string }
export interface ProfileUpdateProposal { id: string; customerId: string; evidenceId: string; sourceId: string; fieldKey: string; fieldName: string; currentValue: unknown; proposedValue: unknown; action: string; changeType: string; reviewStatus: string; reason: string; confidence: number }
export interface EvidenceConflict { id: string; customerId: string; fieldKey: string; conflictType: string; currentValue: unknown; newValue: unknown; currentEvidenceId?: string; newEvidenceId: string; status: string; resolution?: string }
export interface SourceWorkspace { sources: SourceRecord[]; evidenceItems: EvidenceItem[]; proposals: ProfileUpdateProposal[]; conflicts: EvidenceConflict[]; profileMaterialization?: ProfileMaterialization }
export interface SourceSaveStatus { status: 'PERSISTED' | 'NOT_FOUND'; source: SourceRecord | null }
export type AssistantQueryType = 'CUSTOMER_DETAIL' | 'CUSTOMER_SUMMARY' | 'CUSTOMER_LIST' | 'CUSTOMER_PURCHASES' | 'STATUS_SUMMARY' | 'MENTOR_SUMMARY' | 'MENTOR_LIST' | 'PRODUCT_LIST' | 'SERVICE_RECORD_LIST' | 'ENROLLMENT_QUERY' | 'REVENUE_SUMMARY' | 'UNSUPPORTED'
export type AssistantQueryStatus = 'SUCCESS' | 'NO_DATA' | 'AMBIGUOUS' | 'INVALID_QUERY' | 'DATA_SOURCE_ERROR'
export interface QueryTimeRange { start: string; end: string; label: string }
export interface QueryPlan { query_type: AssistantQueryType; entity: { type: 'CUSTOMER' | 'MENTOR' | 'PRODUCT' | 'NONE'; name?: string; id?: string } | null; filters: Record<string, string | boolean | undefined>; metrics: string[]; time_range: QueryTimeRange | null; joins: string[]; result_mode: 'SINGLE_ENTITY' | 'SUMMARY' | 'LIST' }
export interface QueryExecutionContext { user_id: string; role: 'ADMIN'; query_plan: QueryPlan; resolved_entities: Record<string, unknown>; repositories_used: string[]; row_count: number; matched_row_count?: number; data_coverage?: QueryDataCoverage; context_kept?: string[]; context_added?: string[]; context_replaced?: string[]; context_cleared?: string[]; data_quality_warnings?: string[]; latency_ms?: number; executed_at: string; status: AssistantQueryStatus; error_reason?: string }
export interface QueryDSLFilter { field: string; operator: 'EQ' | 'NEQ' | 'IN' | 'CONTAINS'; value: string | string[] | boolean }
export interface QueryDSLSort { metric: string; direction: 'ASC' | 'DESC' }
export interface QueryDSL { operation: 'ENTITY_DETAIL' | 'ENTITY_LIST' | 'COUNT' | 'AGGREGATE' | 'GROUP_AGGREGATE' | 'SUMMARY' | 'RANK' | 'TREND' | 'COMPARE'; entity: string; metrics: string[]; dimensions: string[]; filters: QueryDSLFilter[]; time_range: QueryTimeRange | null; sort: QueryDSLSort[]; limit: number; compare_time_range?: QueryTimeRange | null }
export interface QueryState { entity?: string; metrics: string[]; dimensions: string[]; filters: QueryDSLFilter[]; time_range: QueryTimeRange | null; compare_time_range?: QueryTimeRange | null; operation?: QueryDSL['operation']; last_result?: string }
export interface QueryDataBasis { metric?: string; source: string[]; filters: QueryDSLFilter[]; time_field?: string; time_range: QueryTimeRange | null; aggregation?: string; row_count: number; executed_at: string; warnings?: string[]; coverage?: QueryDataCoverage }
export interface QueryDataCoverage { requested: string[]; available: string[]; missing: string[]; complete: boolean }
export interface AssistantResultField { label: string; value: string }
export interface AssistantResultRecord { id: string; customerId?: string; name: string; mentor?: string; date?: string; amount?: number; detail?: string; fields?: AssistantResultField[] }
export interface AssistantQueryContext { page?: 'CUSTOMER_DETAIL'; customerId?: string; now?: string; state?: QueryState; lastQuery?: { kind: string; queryType?: AssistantQueryType; productName?: string; customerIds?: string[]; customerId?: string; timeRange?: QueryTimeRange | null; state?: QueryState; dsl?: QueryDSL } }
export interface AssistantQueryResult { kind: string; answer: string; customerId?: string; records?: AssistantResultRecord[]; candidates?: AssistantResultRecord[]; pagination?: { total: number; limit: number; has_more: boolean }; continuation?: { kind: string; queryType?: AssistantQueryType; productName?: string; customerIds?: string[]; customerId?: string; timeRange?: QueryTimeRange | null; state?: QueryState; dsl?: QueryDSL }; plan?: QueryPlan; dsl?: QueryDSL; queryState?: QueryState; dataBasis?: QueryDataBasis[]; debug?: QueryExecutionContext }
export type FeedbackDraftInput = Omit<FeedbackInput, 'appointmentId' | 'aiSummary' | 'aiStatus' | 'aiNextStep'> & { appointmentId?: string; expectation?: string }
export interface DocumentExtractionResult { document_type: string; extracted_text: string; extraction_method: string; char_count: number; warnings: string[]; duration_ms: number; file_hash: string; size: number }
export interface DocumentUploadInput { filename: string; mimeType: string; extension: string; size: number; base64: string }
export interface CustomerMutationResult {
  customer: Customer
  enrollments: Database['enrollments']
  profileChanges: Database['profileChanges']
  createdCustomerId: string
  customerCreated: boolean
  persistenceStatus?: 'PERSISTED' | 'COMMITTED' | 'DELAYED'
  enrollmentStatus?: 'COMPLETED' | 'PENDING'
  enrollmentMessage?: string
  mutation?: CustomerMutationState
}
export type CustomerCreateResult = CustomerMutationResult
export type CustomerMutationStateStatus = 'PROCESSING' | 'VERIFYING' | 'PERSISTED' | 'COMMITTED' | 'UNKNOWN' | 'FAILED'
export interface CustomerMutationState { operationId: string; customerId: string; kind: 'CREATE' | 'UPDATE'; status: CustomerMutationStateStatus; enrollmentStatus?: 'COMPLETED' | 'PENDING'; updatedAt?: string | null }
export interface CustomerSaveStatusResponse { operationId: string; customerId: string; status: CustomerMutationStateStatus; updatedAt?: string | null; customer?: Customer | null; enrollments?: Database['enrollments']; profileChanges?: Database['profileChanges']; createdCustomerId?: string; customerCreated?: boolean; persistenceStatus?: 'PERSISTED' | 'COMMITTED' | 'DELAYED'; enrollmentStatus?: 'COMPLETED' | 'PENDING'; enrollmentMessage?: string; resultSnapshotAvailable?: boolean; resultChangedSinceOperation?: boolean; mutation?: CustomerMutationState }

function customerMutationFromDatabase(database: Database & Partial<CustomerMutationResult>, customerId = database.createdCustomerId || '', customerCreated = database.customerCreated === true): CustomerMutationResult {
  const customer = database.customers.find((item) => item.id === customerId)
  if (!customer) throw new Error('保存后未找到客户')
  return { customer, enrollments: database.enrollments.filter((item) => item.customerId === customerId), profileChanges: database.profileChanges.filter((item) => item.customerId === customerId), createdCustomerId: customerId, customerCreated, persistenceStatus: 'COMMITTED', mutation: database.mutation }
}
export type AutomaticProfileStatus = 'NOT_STARTED' | 'PROCESSING' | 'COMPLETED' | 'REVIEW_REQUIRED' | 'NO_USABLE_OUTPUT' | 'FAILED' | 'PENDING'
export interface CustomerProfileResponse { customerId: string; profileFields?: Customer['profileFields']; profileFieldMeta?: Customer['profileFieldMeta']; profileUpdatedAt?: string | null; profileSchemaVersion?: string; profileVersion?: number; profileMaterialization: ProfileMaterialization; autoOrganizeStatus?: AutomaticProfileStatus }

export interface WorkbenchApi {
  login(phone: string, password: string): Promise<Staff & { mustChangePassword?: boolean }>
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; mustChangePassword: boolean; token?: string }>
  resetPassword(actorId: string, staffId: string): Promise<{ ok: boolean; staffId: string; mustChangePassword: boolean; initialPassword?: string }>
  generateMentorInitialPassword(actorId: string, phone: string): Promise<string>
  health(): Promise<HealthMetadata>
  savePerformanceTraces(): Promise<SavePerformanceTrace[]>
  evidenceDebug(): Promise<EvidenceDebugTrace[]>
  dashboard(staffId: string): Promise<Database>
  customerDirectory(staffId: string): Promise<Database>
  customerDetail(actorId: string, customerId: string): Promise<Database>
  customerProfile(actorId: string, customerId: string): Promise<CustomerProfileResponse>
  basicDashboard(staffId: string): Promise<BasicDashboard>
  staff(staffId: string): Promise<Staff | undefined>
  customer(actorId: string, id: string): Promise<Customer | undefined>
  createAppointment(input: NewAppointmentInput): Promise<Database>
  previewCustomer(actorId: string, input: ManualCustomerInput): Promise<CustomerDraftPreview>
  createCustomer(actorId: string, input: ManualCustomerInput): Promise<CustomerCreateResult>
  updateCustomer(actorId: string, customerId: string, input: ManualCustomerInput): Promise<CustomerMutationResult>
  customerSaveStatus(actorId: string, operationId: string, customerId?: string): Promise<CustomerSaveStatusResponse>
  updateCustomerEnrollments(actorId: string, customerId: string, enrollments: EnrollmentDraft[]): Promise<Database>
  assignAppointment(actorId: string, appointmentId: string, mentorId: string): Promise<Database>
  markFollowupDone(actorId: string, appointmentId: string): Promise<Database>
  saveFeedback(actorId: string, feedback: FeedbackInput): Promise<Database>
  profileDraft(actorId: string, customerId: string, text: string): Promise<ProfileDraft>
  confirmProfile(actorId: string, customerId: string, updates: ProfileUpdate[]): Promise<Customer>
  updateCustomerReferrer(actorId: string, customerId: string, referrerName: string): Promise<Customer | undefined>
  createMentor(actorId: string, input: MentorAccountInput): Promise<MentorAccountResult>
  updateMentor(actorId: string, mentorId: string, input: MentorAccountInput): Promise<Staff>
  deactivateMentor(actorId: string, mentorId: string): Promise<Staff>
  teamSnapshot(actorId: string, status?: StaffStatus): Promise<TeamSnapshot[]>
  dashboardSnapshot(actorId: string): Promise<DashboardSnapshot>
  assistantQuery(actorId: string, question: string, context?: AssistantQueryContext): Promise<AssistantQueryResult>
  customerIntelligence(actorId: string, input: { context: CustomerAiContext }): Promise<CustomerIntelligence>
  refreshCustomerSummary(actorId: string, customerId: string, force?: boolean): Promise<Customer | undefined>
  getCustomerUnderstanding(actorId: string, customerId: string): Promise<CustomerUnderstandingResponse>
  refreshCustomerUnderstanding(actorId: string, customerId: string, force?: boolean): Promise<CustomerUnderstandingResponse>
  getCustomerSalesUnderstanding(actorId: string, customerId: string): Promise<CustomerSalesUnderstandingResponse>
  refreshCustomerSalesUnderstanding(actorId: string, customerId: string, force?: boolean): Promise<CustomerSalesUnderstandingResponse>
  getCustomerSafetyAssessment(actorId: string, customerId: string): Promise<SafetyAssessmentResponse>
  refreshCustomerSafetyAssessment(actorId: string, customerId: string, force?: boolean): Promise<SafetyAssessmentResponse>
  serviceSummary(actorId: string, input: FeedbackDraftInput): Promise<AiDraft>
  brief(actorId: string, input: { name: string; need: string; expectation: string }): Promise<string>
  saveBrief(actorId: string, customerId: string, brief: string): Promise<Customer | undefined>
  extractDocument(actorId: string, input: DocumentUploadInput): Promise<DocumentExtractionResult>
  identifyDialogue(actorId: string, input: { text: string; targetCustomerId?: string; customerOperationId?: string }): Promise<DialogueAssessment>
  confirmDialogue(actorId: string, input: { analysisToken: string; contentHash: string; targetCustomerId?: string; customerOperationId?: string; speakerId?: string }): Promise<DialogueConfirmation>
  sourceWorkspace(actorId: string, customerId: string): Promise<SourceWorkspace>
  sourceStatus(actorId: string, customerId: string, operationId: string): Promise<SourceSaveStatus>
  createSource(actorId: string, input: { customerId: string; sourceType: string; rawText: string; operationId?: string; customerOperationId?: string; dialogueConfirmation?: string; sourcePerspective?: 'STAFF_REPORTED' | 'CUSTOMER_FIRST_PARTY'; fileRef?: string; notes?: string; document?: { filename: string; mimeType: string; extension: string; size: number; fileHash: string; charCount: number; extractedText: string } }): Promise<SourceRecord>
  processSource(actorId: string, sourceId: string, force?: boolean): Promise<{ source: SourceRecord; evidenceItems: EvidenceItem[]; proposals: ProfileUpdateProposal[]; conflicts: EvidenceConflict[] }>
  overrideServiceNecessity(actorId: string, input: { entityType: 'source' | 'evidence'; id: string; serviceNecessity: 'LOW' | 'RELEVANT' | 'CRITICAL' }): Promise<SourceWorkspace>
  reviewProposal(actorId: string, proposalId: string, decision: 'CONFIRM' | 'REJECT'): Promise<SourceWorkspace>
  resolveConflict(actorId: string, conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN'): Promise<SourceWorkspace>
}

export interface ApiRequestTrace { time: string; method: string; path: string; status: number | null; duration: number; request_id?: string; result: 'SUCCESS' | 'ERROR' }
export interface ApiErrorInfo { code: string; message: string; request_id?: string; serverCode?: string; httpStatus?: number; matches?: any[]; identity?: any }
export class ApiError extends Error {
  code: string
  request_id?: string
  serverCode?: string
  httpStatus?: number
  matches?: any[]
  identity?: any
  constructor(info: ApiErrorInfo) { super(info.message); this.name = 'ApiError'; this.code = info.code; this.request_id = info.request_id; this.serverCode = info.serverCode; this.httpStatus = info.httpStatus; this.matches = info.matches; this.identity = info.identity }
}

const requestTraces: ApiRequestTrace[] = []
export function getApiRequestTraces() { return [...requestTraces] }
export function clearApiRequestTraces() { requestTraces.splice(0, requestTraces.length) }
export interface PendingCustomerMutation { actorId: string; operationId: string; customerId?: string; kind: 'CREATE' | 'UPDATE'; startedAt: string }
const PENDING_CUSTOMER_MUTATION_KEY = 'asva:pending-customer-mutation-v1'
export function rememberPendingCustomerMutation(value: PendingCustomerMutation) {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(PENDING_CUSTOMER_MUTATION_KEY, JSON.stringify(value))
}
export function readPendingCustomerMutation(): PendingCustomerMutation | null {
  if (typeof window === 'undefined') return null
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PENDING_CUSTOMER_MUTATION_KEY) || 'null')
    return value && typeof value.actorId === 'string' && typeof value.operationId === 'string' && (value.kind === 'CREATE' || value.kind === 'UPDATE') ? value as PendingCustomerMutation : null
  } catch { return null }
}
export function clearPendingCustomerMutation(operationId?: string) {
  if (typeof window === 'undefined') return
  const current = readPendingCustomerMutation()
  if (!operationId || current?.operationId === operationId) window.sessionStorage.removeItem(PENDING_CUSTOMER_MUTATION_KEY)
}

export const CLIENT_DEFAULT_TIMEOUT_MS = 20_000
// Customer creation has a durable operation record and an explicit status
// readback. Fail over early instead of making the form look stuck for 20s.
export const CLIENT_CUSTOMER_SAVE_TIMEOUT_MS = 8_000
// After the soft customer-save timeout the request is allowed to finish so the
// server can complete the Customers write while the client verifies the
// operation. This is a hard ceiling, not a longer blocking wait.
export const CLIENT_CUSTOMER_SAVE_HARD_TIMEOUT_MS = 30_000
export const CLIENT_SOURCE_SAVE_TIMEOUT_MS = 70_000
const CUSTOMER_SAVE_STATUS_DELAYS_MS = [0, 500, 1000, 2000, 4000]

function emitCustomerSaveState(operationId: string, status: CustomerMutationStateStatus, customerId?: string) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('asva-customer-save-state', { detail: { operationId, status, customerId: customerId || '' } }))
}

function isRecoverableCustomerSaveError(error: unknown) {
  const value = error as { code?: string; serverCode?: string }
  return value?.code === 'REQUEST_TIMEOUT' || value?.code === 'NETWORK_UNREACHABLE' || value?.code === 'CORS_PREFLIGHT_FAILED' || (value?.code === 'HTTP_502' && String(value?.serverCode || '').startsWith('FEISHU_')) || (value?.code === 'HTTP_409' && ['CUSTOMER_SAVE_UNKNOWN', 'CUSTOMER_SAVE_INCOMPLETE'].includes(String(value?.serverCode || '')))
}

export function classifyFetchFailure(error: unknown, timedOut = false): { code: 'REQUEST_TIMEOUT' | 'NETWORK_UNREACHABLE' | 'CORS_PREFLIGHT_FAILED'; message: string } {
  if (timedOut) return { code: 'REQUEST_TIMEOUT', message: '请求等待时间较长，正在确认保存结果。' }
  const errorText = error instanceof Error ? `${error.name} ${error.message}` : String(error || '')
  if (/cors|cross[- ]origin|preflight|access[- ]control|blocked by cors policy/i.test(errorText)) {
    return { code: 'CORS_PREFLIGHT_FAILED', message: 'CORS_PREFLIGHT_FAILED：浏览器拒绝跨域预检，请检查网络或稍后重试。' }
  }
  return { code: 'NETWORK_UNREACHABLE', message: '请求未完成，请检查网络或稍后重试。' }
}

type LocalApi = ReturnType<typeof createLocalApi>

export function createLocalAsyncApi(api: LocalApi): WorkbenchApi {
  const localUnderstanding = async (actorId: string, customerId: string): Promise<CustomerUnderstandingResponse> => {
    const customer = await api.customer(actorId, customerId)
    const context = { generated_at: new Date().toISOString(), current_needs: customer?.need ? [{ text: customer.need, evidence_ids: [] }] : [], resources: customer?.profileFields?.current_resources ? [{ text: String(customer.profileFields.current_resources), evidence_ids: [] }] : [], top_life_events: [], coverage_gaps: customer?.profileMaterialization?.coverage.domains.filter((item) => item.status !== 'KNOWN').map((item) => item.name) || ['当前资料'], evidence_refs: [] }
    return { customerId, status: 'FRESH', understanding: customer ? createLocalCustomerUnderstanding(context) as CustomerUnderstandingV1 : null, meta: { status: 'FRESH', promptVersion: 'understanding-v1' }, evidence_refs: [], context_summary: { coverage_gaps: context.coverage_gaps, evidence_count: 0 } }
  }
  const localSalesUnderstanding = async (actorId: string, customerId: string): Promise<CustomerSalesUnderstandingResponse> => {
    const database = await api.dashboard(actorId)
    const customer = database.customers.find((item) => item.id === customerId)
    const context = buildCustomerSalesContext({ customer: customer || {}, evidenceItems: [], sourceRecords: [], conflicts: [], enrollments: database.enrollments.filter((item) => item.customerId === customerId), products: database.products, sessions: database.sessions.filter((item) => item.customerId === customerId), safetyAssessment: customer?.safety })
    const history = historicalSalesRecords({ enrollments: database.enrollments.filter((item) => item.customerId === customerId), products: database.products, sessions: database.sessions.filter((item) => item.customerId === customerId) })
    return { customerId, status: 'FRESH', salesUnderstanding: customer ? createLocalCustomerSalesUnderstanding(context) as CustomerSalesUnderstandingV1 : null, meta: { status: 'FRESH', promptVersion: 'sales-understanding-v1' }, historical_enrollments: history.enrollmentHistory, service_history: history.serviceHistory, evidence_refs: [], context_summary: { density: context.customer_snapshot?.context_density?.classification || 'SPARSE', evidence_count: 0 } }
  }
  return {
    login: async (phone, password) => api.login(phone, password),
    changePassword: async () => { throw new Error('本地 Demo 不支持密码修改') },
    resetPassword: async () => { throw new Error('本地 Demo 不支持密码重置') },
    generateMentorInitialPassword: async () => { throw new Error('本地 Demo 不支持导师账号创建') },
    health: async () => ({ ok: true, service: 'asva-api', appEnv: 'mock', environment: 'mock', dataMode: 'mock', authMode: 'MOCK', featureFlags: { externalAppointment: false } }),
    savePerformanceTraces: async () => [],
    evidenceDebug: async () => [],
    dashboard: async (staffId) => api.dashboard(staffId),
    customerDirectory: async (staffId) => api.dashboard(staffId),
    customerDetail: async (actorId, customerId) => { const database = api.dashboard(actorId); return { ...database, customers: database.customers.filter((item) => item.id === customerId), appointments: database.appointments.filter((item) => item.customerId === customerId), sessions: database.sessions.filter((item) => item.customerId === customerId), enrollments: database.enrollments.filter((item) => item.customerId === customerId), profileChanges: database.profileChanges.filter((item) => item.customerId === customerId) } },
    customerProfile: async (actorId, customerId) => { const customer = await api.customer(actorId, customerId); if (!customer) throw new Error('客户不存在或无权访问'); return { customerId, profileFields: customer.profileFields, profileFieldMeta: customer.profileFieldMeta, profileUpdatedAt: customer.profileUpdatedAt, profileSchemaVersion: customer.profileSchemaVersion, profileVersion: customer.profileVersion, profileMaterialization: customer.profileMaterialization || { schemaVersion: 'profile-materialization-v2', currentSnapshot: {}, sections: [], provisionalItems: [], lifeEvents: [], coverage: { percentage: 0, domains: [] }, aiSummaryStatus: 'STALE' }, autoOrganizeStatus: 'NOT_STARTED' } },
    basicDashboard: async (staffId) => buildBasicDashboard(api.dashboard(staffId)),
    staff: async (staffId) => api.staff(staffId),
    customer: async (actorId, id) => api.customer(actorId, id),
    createAppointment: async (input) => api.createAppointment(input),
    previewCustomer: async (actorId, input) => api.previewCustomer(actorId, input),
    createCustomer: async (actorId, input) => customerMutationFromDatabase(await api.createCustomer(actorId, input) as Database & Partial<CustomerMutationResult>),
    updateCustomer: async (actorId, customerId, input) => customerMutationFromDatabase(await api.updateCustomer(actorId, customerId, input) as Database, customerId, false),
    customerSaveStatus: async (_actorId, operationId, customerId) => ({ operationId, customerId: customerId || '', status: 'UNKNOWN', customer: null }),
    updateCustomerEnrollments: async (actorId, customerId, enrollments) => api.updateCustomerEnrollments(actorId, customerId, enrollments),
    assignAppointment: async (actorId, appointmentId, mentorId) => api.assignAppointment(actorId, appointmentId, mentorId),
    markFollowupDone: async (actorId, appointmentId) => api.markFollowupDone(actorId, appointmentId),
    saveFeedback: async (actorId, feedback) => api.saveFeedback(actorId, feedback),
    profileDraft: async (actorId, customerId, text) => api.profileDraft(actorId, customerId, text),
    confirmProfile: async (actorId, customerId, updates) => api.confirmProfile(actorId, customerId, updates),
    updateCustomerReferrer: async (actorId, customerId, referrerName) => api.updateCustomerReferrer(actorId, customerId, referrerName),
    createMentor: async (actorId, input) => api.createMentor(actorId, input),
    updateMentor: async (actorId, mentorId, input) => api.updateMentor(actorId, mentorId, input),
    deactivateMentor: async (actorId, mentorId) => api.deactivateMentor(actorId, mentorId),
    teamSnapshot: async (actorId, status) => api.teamSnapshot(actorId, status),
    dashboardSnapshot: async (actorId) => api.dashboardSnapshot(actorId),
    assistantQuery: async (actorId, question, context) => queryLocalAssistant(api.dashboard(actorId), question, context, actorId),
    customerIntelligence: async (_actorId, input) => { const summary = createLocalCoreSummary(input.context); return { summary, brief: createLocalBrief(input.context, summary) } },
    refreshCustomerSummary: async (actorId, customerId) => api.customer(actorId, customerId),
    getCustomerUnderstanding: localUnderstanding,
    refreshCustomerUnderstanding: localUnderstanding,
    getCustomerSalesUnderstanding: localSalesUnderstanding,
    refreshCustomerSalesUnderstanding: localSalesUnderstanding,
    getCustomerSafetyAssessment: async (actorId: string, customerId: string) => ({ customerId, status: 'STALE', assessment: null, meta: {}, context_summary: { density: 'SPARSE', safety_data_sufficiency: 'INSUFFICIENT', critical_unknowns: ['当前本地 Demo 不执行安全评估'], evidence_count: 0 }, evidence_refs: [] }),
    refreshCustomerSafetyAssessment: async (actorId: string, customerId: string) => ({ customerId, status: 'STALE', assessment: null, meta: {}, context_summary: { density: 'SPARSE', safety_data_sufficiency: 'INSUFFICIENT', critical_unknowns: ['本地 Demo 不执行安全评估'], evidence_count: 0 }, evidence_refs: [] }),
    serviceSummary: async (_actorId, input) => ({ summary: `本次围绕“${input.topic || '客户当前困扰'}”完成跟进。建议保留对客户当前需求的持续观察，并根据已确认的信息决定下一步。`, currentStatus: '已完成本次沟通，等待管理员确认记录。', nextStep: input.result === '暂时结束' ? '本次预约完成，保留后续重新预约入口。' : '本次预约已完成，后续如有新预约将重新进入流程。' }),
    brief: async (_actorId, input) => `已知：${input.need || '暂无当前困扰描述'}。接待时先确认客户最想解决的具体问题，再确认希望获得的帮助和当前可行动的一步。`,
    saveBrief: async (actorId, customerId) => api.customer(actorId, customerId),
    extractDocument: async () => { throw new Error('本地 Demo 不支持文件读取') },
    identifyDialogue: async () => { throw new Error('本地 Demo 不支持对话资料识别') },
    confirmDialogue: async () => { throw new Error('本地 Demo 不支持对话资料确认') },
    sourceWorkspace: async () => ({ sources: [], evidenceItems: [], proposals: [], conflicts: [] }),
    sourceStatus: async () => ({ status: 'NOT_FOUND', source: null }),
    createSource: async () => { throw new Error('本地 Demo 不支持资料分析') },
    processSource: async () => { throw new Error('本地 Demo 不支持资料分析') },
    overrideServiceNecessity: async () => { throw new Error('本地 Demo 不支持隐私策略调整') },
    reviewProposal: async () => { throw new Error('本地 Demo 不支持资料分析') },
    resolveConflict: async () => { throw new Error('本地 Demo 不支持资料分析') },
  }
}

export function createHttpApi(baseUrl: string): WorkbenchApi {
  const base = baseUrl.replace(/\/$/, '')
  async function request<T>(path: string, staffId: string | undefined, init?: RequestInit, options: { softTimeoutMs?: number; hardTimeoutMs?: number } = {}): Promise<T> {
    const startedAt = performance.now()
    const method = init?.method || 'GET'
    const headers = new Headers(init?.headers)
    headers.set('Content-Type', 'application/json')
    const token = readAccessToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    else if (staffId) headers.set('X-Staff-Id', staffId)
    if (!base) throw new ApiError({ code: 'CONFIGURATION_ERROR', message: '未配置真实 API 地址。请设置 VITE_API_BASE_URL 后重启前端；如需演示，请明确设置 VITE_APP_ENV=mock。' })
    let response: Response
    let payload: Record<string, any> | null = null
    const defaultTimeoutMs = path === '/api/sources' && method === 'POST'
      ? CLIENT_SOURCE_SAVE_TIMEOUT_MS
      : path === '/api/customers' && method === 'POST'
        ? CLIENT_CUSTOMER_SAVE_TIMEOUT_MS
        : CLIENT_DEFAULT_TIMEOUT_MS
    const softTimeoutMs = options.softTimeoutMs ?? defaultTimeoutMs
    const hardTimeoutMs = Math.max(options.hardTimeoutMs ?? defaultTimeoutMs, softTimeoutMs)
    const controller = new AbortController()
    let timedOut = false
    let softTimedOut = false
    const hardTimeoutHandle = setTimeout(() => { timedOut = true; controller.abort() }, hardTimeoutMs)
    let softTimeoutHandle: ReturnType<typeof setTimeout> | undefined
    const softTimeout = softTimeoutMs < hardTimeoutMs ? new Promise<never>((_, reject) => {
      softTimeoutHandle = setTimeout(() => {
        softTimedOut = true
        reject(Object.assign(new Error('请求等待时间较长'), { __softTimeout: true }))
      }, softTimeoutMs)
    }) : null
    const execution = (async () => {
      const nextResponse = await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal })
      let nextPayload: Record<string, any> | null = null
      try { nextPayload = await nextResponse.json() } catch (error) {
        if (timedOut) throw error
        nextPayload = null
      }
      return { response: nextResponse, payload: nextPayload }
    })()
    // A soft timeout only stops the caller waiting; the HTTP request keeps
    // running so the server can finish the Customers write.
    execution.finally(() => clearTimeout(hardTimeoutHandle)).catch(() => {})
    let completed: { response: Response; payload: Record<string, any> | null }
    try {
      completed = softTimeout ? await Promise.race([execution, softTimeout]) : await execution
    } catch (error) {
      if (softTimeoutHandle) clearTimeout(softTimeoutHandle)
      requestTraces.unshift({ time: new Date().toISOString(), method, path, status: null, duration: Math.round(performance.now() - startedAt), result: 'ERROR' })
      requestTraces.splice(20)
      const failure = softTimedOut
        ? { code: 'REQUEST_TIMEOUT' as const, message: '请求等待时间较长，正在确认保存结果。' }
        : classifyFetchFailure(error, timedOut)
      throw new ApiError(failure)
    }
    if (softTimeoutHandle) clearTimeout(softTimeoutHandle)
    response = completed.response
    payload = completed.payload
    const requestId = response.headers.get('X-Request-Id') || payload?.request_id || undefined
    const duration = Math.round(performance.now() - startedAt)
    requestTraces.unshift({ time: new Date().toISOString(), method, path, status: response.status, duration, request_id: requestId, result: response.ok ? 'SUCCESS' : 'ERROR' })
    requestTraces.splice(20)
    if (import.meta.env.DEV) {
      const metric = path === '/api/staff/me' ? 'STAFF_ME_MS' : path === '/api/dashboard' ? 'DASHBOARD_API_MS' : path === '/api/staff/mentors' ? 'MENTOR_API_MS' : undefined
      if (metric) console.info('[ASVA_PERF]', JSON.stringify({ metric, value_ms: duration, status: response.status, request_id: requestId }))
    }
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('asva-auth-expired'))
    if (!response.ok) throw new ApiError({ code: `HTTP_${response.status}`, serverCode: payload?.code, httpStatus: response.status, message: payload?.message || payload?.error || `HTTP ${response.status}`, request_id: requestId, matches: payload?.matches, identity: payload?.identity })
    if (payload === null) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'INVALID_RESPONSE：API 返回的内容不是有效 JSON。', request_id: requestId })
    if ((path === '/api/auth/login' || path === '/api/auth/change-password') && payload?.token) writeAccessToken(payload.token)
    return payload as T
  }
  async function recoverCustomerMutation(actorId: string, operationId: string, customerId?: string): Promise<CustomerMutationResult> {
    emitCustomerSaveState(operationId, 'VERIFYING', customerId)
    let lastError: unknown = null
    for (const delayMs of CUSTOMER_SAVE_STATUS_DELAYS_MS) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      try {
        const path = customerId
          ? `/api/customers/${encodeURIComponent(customerId)}/save-status?operationId=${encodeURIComponent(operationId)}`
          : `/api/customer-save-status?operationId=${encodeURIComponent(operationId)}`
        const status = await request<CustomerSaveStatusResponse>(path, actorId)
        if (status.status === 'FAILED') throw new ApiError({ code: 'CUSTOMER_SAVE_CONFIRMED_FAILED', serverCode: 'CUSTOMER_SAVE_CONFIRMED_FAILED', message: '客户保存已确认失败，填写内容仍保留。' })
        if ((status.status === 'PERSISTED' || status.status === 'COMMITTED') && status.customer) {
          emitCustomerSaveState(operationId, status.status, status.customerId)
          return { customer: status.customer, enrollments: status.enrollments || [], profileChanges: status.profileChanges || [], createdCustomerId: status.createdCustomerId || status.customerId, customerCreated: status.customerCreated === true, persistenceStatus: status.persistenceStatus || status.status, enrollmentStatus: status.enrollmentStatus || status.mutation?.enrollmentStatus || 'COMPLETED', enrollmentMessage: status.enrollmentMessage, mutation: status.mutation }
        }
        if (status.status === 'COMMITTED' && !status.customer) {
          emitCustomerSaveState(operationId, 'COMMITTED', status.customerId)
          throw new ApiError({ code: 'CUSTOMER_SAVE_COMMITTED_RESULT_UNAVAILABLE', serverCode: 'CUSTOMER_SAVE_COMMITTED_RESULT_UNAVAILABLE', message: '客户保存已确认，但客户已有后续更新，请刷新后查看。' })
        }
        if (status.status === 'PERSISTED') emitCustomerSaveState(operationId, 'PERSISTED', status.customerId)
        lastError = new ApiError({ code: 'CUSTOMER_SAVE_UNKNOWN', serverCode: 'CUSTOMER_SAVE_UNKNOWN', message: '保存结果暂时无法确认，原内容仍保留。' })
      } catch (error) {
        if (error instanceof ApiError && (error.code === 'CUSTOMER_SAVE_CONFIRMED_FAILED' || error.code === 'CUSTOMER_SAVE_COMMITTED_RESULT_UNAVAILABLE')) throw error
        lastError = error
      }
    }
    emitCustomerSaveState(operationId, 'UNKNOWN', customerId)
    throw new ApiError({ code: 'CUSTOMER_SAVE_UNKNOWN', serverCode: 'CUSTOMER_SAVE_UNKNOWN', message: '保存结果暂时无法确认，原内容仍保留。请稍后查询或重试。', request_id: lastError instanceof ApiError ? lastError.request_id : undefined })
  }
  return {
    login: (phone, password) => request<Staff & { mustChangePassword?: boolean }>('/api/auth/login', undefined, { method: 'POST', body: JSON.stringify({ phone, password }) }),
    changePassword: (currentPassword, newPassword) => request<{ ok: boolean; mustChangePassword: boolean; token?: string }>('/api/auth/change-password', undefined, { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
    resetPassword: (actorId, staffId) => request<{ ok: boolean; staffId: string; mustChangePassword: boolean; initialPassword?: string }>(`/api/staff/${encodeURIComponent(staffId)}/reset-password`, actorId, { method: 'POST', body: '{}' }),
    generateMentorInitialPassword: async (actorId, phone) => (await request<{ initial_password: string }>('/api/staff/mentor-initial-password', actorId, { method: 'POST', body: JSON.stringify({ phone }) })).initial_password,
    health: () => request<HealthMetadata>('/api/health', undefined),
    savePerformanceTraces: () => request<SavePerformanceTrace[]>('/api/debug/save-traces', undefined),
    evidenceDebug: () => request<EvidenceDebugTrace[]>('/api/debug/evidence', undefined),
    dashboard: async (staffId) => normalizeDatabaseDto(await request<Database>('/api/dashboard', staffId)),
    customerDirectory: async (staffId) => normalizeDatabaseDto(await request<Database>('/api/customers/directory', staffId)),
    customerDetail: async (actorId, customerId) => normalizeDatabaseDto(await request<Database>(`/api/customers/${encodeURIComponent(customerId)}/detail`, actorId)),
    customerProfile: (actorId, customerId) => request<CustomerProfileResponse>(`/api/customers/${encodeURIComponent(customerId)}/profile`, actorId),
    basicDashboard: (staffId) => request<BasicDashboard>('/api/dashboard/basic', staffId),
    staff: async (staffId) => request<Staff>('/api/staff/me', staffId),
    customer: (actorId, id) => request<Customer>(`/api/customers/${encodeURIComponent(id)}`, actorId),
    createAppointment: (input) => request<Database>('/api/appointments', undefined, { method: 'POST', body: JSON.stringify(input) }),
    previewCustomer: (actorId, input) => request<CustomerDraftPreview>('/api/customers/preview', actorId, { method: 'POST', body: JSON.stringify(input) }),
    createCustomer: async (actorId, input) => {
      const headers = new Headers(input.operationId ? { 'X-Idempotency-Key': input.operationId } : undefined)
      headers.set('X-ASVA-Response-Mode', 'customer-mutation-v1')
      const operationId = input.operationId || ''
      emitCustomerSaveState(operationId, 'PROCESSING')
      try {
        const result = await request<CustomerCreateResult | Database>('/api/customers', actorId, { method: 'POST', body: JSON.stringify(input), headers }, { softTimeoutMs: CLIENT_CUSTOMER_SAVE_TIMEOUT_MS, hardTimeoutMs: CLIENT_CUSTOMER_SAVE_HARD_TIMEOUT_MS })
        const mutation = 'customer' in result ? result : customerMutationFromDatabase(result as Database & Partial<CustomerMutationResult>, (result as Database & Partial<CustomerMutationResult>).createdCustomerId, (result as Database & Partial<CustomerMutationResult>).customerCreated === true)
        // R048.11: PERSISTED 和 COMMITTED 都是成功状态，不强制等待 COMMITTED
        if (operationId && mutation.mutation && mutation.mutation.status !== 'PERSISTED' && mutation.mutation.status !== 'COMMITTED') return recoverCustomerMutation(actorId, operationId, mutation.createdCustomerId)
        if (operationId) emitCustomerSaveState(operationId, mutation.mutation?.status || 'COMMITTED', mutation.createdCustomerId)
        return mutation
      } catch (error) {
        if (operationId && isRecoverableCustomerSaveError(error)) return recoverCustomerMutation(actorId, operationId)
        throw error
      }
    },
    updateCustomer: async (actorId, customerId, input) => {
      const headers = new Headers(input.operationId ? { 'X-Idempotency-Key': input.operationId } : undefined)
      headers.set('X-ASVA-Response-Mode', 'customer-mutation-v1')
      const operationId = input.operationId || ''
      emitCustomerSaveState(operationId, 'PROCESSING', customerId)
      try {
        const result = await request<CustomerMutationResult | Database>(`/api/customers/${encodeURIComponent(customerId)}`, actorId, { method: 'PATCH', body: JSON.stringify(input), headers })
        const mutation = 'customer' in result ? result : customerMutationFromDatabase(result, customerId, false)
        // R048.11: PERSISTED 和 COMMITTED 都是成功状态，不强制等待 COMMITTED
        if (operationId && mutation.mutation && mutation.mutation.status !== 'PERSISTED' && mutation.mutation.status !== 'COMMITTED') return recoverCustomerMutation(actorId, operationId, customerId)
        if (operationId) emitCustomerSaveState(operationId, mutation.mutation?.status || 'COMMITTED', customerId)
        return mutation
      } catch (error) {
        if (operationId && isRecoverableCustomerSaveError(error)) return recoverCustomerMutation(actorId, operationId, customerId)
        throw error
      }
    },
    customerSaveStatus: (actorId, operationId, customerId) => request<CustomerSaveStatusResponse>(customerId ? `/api/customers/${encodeURIComponent(customerId)}/save-status?operationId=${encodeURIComponent(operationId)}` : `/api/customer-save-status?operationId=${encodeURIComponent(operationId)}`, actorId),
    updateCustomerEnrollments: (actorId, customerId, enrollments) => request<Database>(`/api/customers/${encodeURIComponent(customerId)}/enrollments`, actorId, { method: 'PUT', body: JSON.stringify({ enrollments, operationId: `enrollments-${customerId}-${Date.now()}` }) }),
    assignAppointment: (actorId, appointmentId, mentorId) => request<Database>(`/api/appointments/${encodeURIComponent(appointmentId)}/assign`, actorId, { method: 'POST', body: JSON.stringify({ mentorId }) }),
    markFollowupDone: (actorId, appointmentId) => request<Database>(`/api/appointments/${encodeURIComponent(appointmentId)}/complete-followup`, actorId, { method: 'POST', body: '{}' }),
    saveFeedback: (actorId, feedback) => request<Database>(`/api/appointments/${encodeURIComponent(feedback.appointmentId)}/feedback`, actorId, { method: 'POST', body: JSON.stringify(feedback) }),
    profileDraft: (actorId, customerId, text) => request<ProfileDraft>('/api/customers/' + encodeURIComponent(customerId) + '/profile/extract', actorId, { method: 'POST', body: JSON.stringify({ text }) }),
    confirmProfile: (actorId, customerId, updates) => request<Customer>('/api/customers/' + encodeURIComponent(customerId) + '/profile/confirm', actorId, { method: 'POST', body: JSON.stringify({ updates }) }),
    updateCustomerReferrer: (actorId, customerId, referrerName) => request<Customer>(`/api/customers/${encodeURIComponent(customerId)}/referrer`, actorId, { method: 'POST', body: JSON.stringify({ referrerName }) }),
    createMentor: (actorId, input) => request<MentorAccountResult>('/api/staff/mentors', actorId, { method: 'POST', body: JSON.stringify(input), headers: { 'X-Idempotency-Key': `mentor-create-${input.phone.replace(/[\s-]/g, '')}` } }),
    updateMentor: (actorId, mentorId, input) => request<Staff>(`/api/staff/mentors/${encodeURIComponent(mentorId)}`, actorId, { method: 'PATCH', body: JSON.stringify(input) }),
    deactivateMentor: (actorId, mentorId) => request<Staff>(`/api/staff/mentors/${encodeURIComponent(mentorId)}/deactivate`, actorId, { method: 'POST', body: '{}' }),
    teamSnapshot: (actorId, status) => request<TeamSnapshot[]>(`/api/staff/mentors${status ? `?status=${encodeURIComponent(status)}` : ''}`, actorId),
    dashboardSnapshot: (actorId) => request<DashboardSnapshot>('/api/dashboard/snapshot', actorId),
    assistantQuery: (actorId, question, context) => request<AssistantQueryResult>('/api/ai/query', actorId, { method: 'POST', body: JSON.stringify({ question, context }) }),
    customerIntelligence: (actorId, input) => request<CustomerIntelligence>('/api/ai/customer-intelligence', actorId, { method: 'POST', body: JSON.stringify(input) }),
    refreshCustomerSummary: (actorId, customerId, force = false) => request<Customer>(`/api/customers/${encodeURIComponent(customerId)}/summary/refresh`, actorId, { method: 'POST', body: JSON.stringify({ force }) }),
    getCustomerUnderstanding: (actorId, customerId) => request<CustomerUnderstandingResponse>(`/api/customers/${encodeURIComponent(customerId)}/understanding`, actorId),
    refreshCustomerUnderstanding: (actorId, customerId, force = false) => request<CustomerUnderstandingResponse>(`/api/customers/${encodeURIComponent(customerId)}/understanding/refresh`, actorId, { method: 'POST', body: JSON.stringify({ force }) }),
    getCustomerSalesUnderstanding: (actorId, customerId) => request<CustomerSalesUnderstandingResponse>(`/api/customers/${encodeURIComponent(customerId)}/sales-understanding`, actorId),
    refreshCustomerSalesUnderstanding: (actorId, customerId, force = false) => request<CustomerSalesUnderstandingResponse>(`/api/customers/${encodeURIComponent(customerId)}/sales-understanding/refresh`, actorId, { method: 'POST', body: JSON.stringify({ force }) }),
    getCustomerSafetyAssessment: (actorId, customerId) => request<SafetyAssessmentResponse>(`/api/customers/${encodeURIComponent(customerId)}/safety-assessment`, actorId),
    refreshCustomerSafetyAssessment: (actorId, customerId, force = false) => request<SafetyAssessmentResponse>(`/api/customers/${encodeURIComponent(customerId)}/safety-assessment/refresh`, actorId, { method: 'POST', body: JSON.stringify({ force }) }),
    serviceSummary: (actorId, input) => request<AiDraft>('/api/ai/service-summary', actorId, { method: 'POST', body: JSON.stringify(input) }),
    brief: async (actorId, input) => (await request<{ brief: string }>('/api/ai/brief', actorId, { method: 'POST', body: JSON.stringify(input) })).brief,
    saveBrief: (actorId, customerId, brief) => request<Customer>(`/api/customers/${encodeURIComponent(customerId)}/brief`, actorId, { method: 'POST', body: JSON.stringify({ brief }) }),
    extractDocument: (actorId, input) => request<DocumentExtractionResult>('/api/documents/extract', actorId, { method: 'POST', body: JSON.stringify({ document: input }) }),
    identifyDialogue: (actorId, input) => request<DialogueAssessment>('/api/dialogue/identify', actorId, { method: 'POST', body: JSON.stringify(input) }).then((result) => ({ ...result, contentHash: result.contentHash || '' })),
    confirmDialogue: (actorId, input) => request<DialogueConfirmation>('/api/dialogue/confirm', actorId, { method: 'POST', body: JSON.stringify(input) }),
    sourceWorkspace: (actorId, customerId) => request<SourceWorkspace>(`/api/customers/${encodeURIComponent(customerId)}/sources`, actorId),
    sourceStatus: (actorId, customerId, operationId) => request<SourceSaveStatus>(`/api/customers/${encodeURIComponent(customerId)}/source-status?operationId=${encodeURIComponent(operationId)}`, actorId),
    createSource: (actorId, input) => request<SourceRecord>('/api/sources', actorId, { method: 'POST', body: JSON.stringify(input) }),
    processSource: (actorId, sourceId, force = false) => request<{ source: SourceRecord; evidenceItems: EvidenceItem[]; proposals: ProfileUpdateProposal[]; conflicts: EvidenceConflict[] }>(`/api/sources/${encodeURIComponent(sourceId)}/process`, actorId, { method: 'POST', body: JSON.stringify({ force }) }),
    overrideServiceNecessity: (actorId, input) => request<SourceWorkspace>('/api/privacy/service-necessity', actorId, { method: 'POST', body: JSON.stringify(input) }),
    reviewProposal: (actorId, proposalId, decision) => request<SourceWorkspace>(`/api/profile-proposals/${encodeURIComponent(proposalId)}/review`, actorId, { method: 'POST', body: JSON.stringify({ decision }) }),
    resolveConflict: (actorId, conflictId, resolution) => request<SourceWorkspace>(`/api/evidence-conflicts/${encodeURIComponent(conflictId)}/resolve`, actorId, { method: 'POST', body: JSON.stringify({ resolution }) }),
  }
}
