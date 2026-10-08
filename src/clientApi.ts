import type { Customer, CustomerDraftPreview, Database, EnrollmentDraft, FeedbackInput, ManualCustomerInput, MentorAccountInput, NewAppointmentInput, ProfileDraft, ProfileMaterialization, ProfileUpdate, Staff, StaffStatus } from './domain'
import type { createLocalApi } from './api'
import { queryLocalAssistant } from './assistant'
import { createLocalBrief, createLocalCoreSummary, type AiBrief, type AiCoreSummary, type CustomerAiContext } from './customer-ai'

export interface AiDraft { summary: string; currentStatus: string; nextStep: string }
export interface CustomerIntelligence { summary: AiCoreSummary; brief: AiBrief }
export interface TeamSnapshot { mentor: Staff; customerCount: number; waitFollowUp: number; waitFeedback: number; completed: number }
export interface DashboardSnapshot { customerCount: number; monthNewCustomers: number; monthAppointments: number; monthCompleted: number; paidCustomers: number; mentorCount: number; statusCounts: Record<'WAIT_ASSIGN' | 'WAIT_FOLLOW_UP' | 'WAIT_FEEDBACK' | 'COMPLETED', number>; customerTrend: Array<{ label: string; value: number }>; mentorLoad: Array<{ name: string; count: number }> }
export interface HealthMetadata { ok: boolean; service: string; appVersion?: string; releaseCounter?: number; release?: string; gitCommit?: string; gitBranch?: string; buildTime?: string | null; environment?: string; dataMode?: string; authMode?: string; featureFlags?: Record<string, boolean>; authConfigured?: boolean; adminAuthConfigured?: boolean; authCredentialStoreConfigured?: boolean; feishuConfigured?: boolean; deepseekConfigured?: boolean }
export interface SavePerformanceTrace { request_id?: string; operation_id?: string; result: 'SUCCESS' | 'ERROR'; customer_save_total_ms: number; identity_resolution_ms: number; customer_write_ms: number; enrollment_write_ms: number; profile_change_ms: number; ai_ms: number; other_ms: number }
export interface EvidenceDebugTrace { source_id: string; processing_status: string; extraction_batch: string; evidence_count: number; proposal_count: number; conflict_count: number; model: string; prompt_version: string; duration_ms: number }
export interface SourceRecord { id: string; subjectType: string; subjectId: string; customerId: string; sourceType: string; title: string; rawText?: string; fileRef?: string; fileName?: string; occurredAt?: string | null; uploadedAt?: string | null; uploadedBy?: string; sourceRole?: string; sourcePerspective?: 'STAFF_REPORTED' | 'CUSTOMER_FIRST_PARTY' | 'MENTOR_OBSERVATION'; contentHash?: string; processingStatus: string; processingVersion?: number; sensitivityLevel?: string; sourceVersion?: number; lastBatchId?: string }
export interface EvidenceItem { id: string; sourceId: string; customerId: string; evidenceType: 'FACT' | 'SELF_MEANING' | 'OBSERVATION' | 'HYPOTHESIS'; semanticKind: string; fieldKey?: string; standardValue: unknown; displayText: string; sourceExcerpt: string; locator?: Record<string, unknown>; occurredAt?: string | null; confidence: number; reviewStatus: string; extractionBatchId?: string }
export interface ProfileUpdateProposal { id: string; customerId: string; evidenceId: string; sourceId: string; fieldKey: string; fieldName: string; currentValue: unknown; proposedValue: unknown; action: string; changeType: string; reviewStatus: string; reason: string; confidence: number }
export interface EvidenceConflict { id: string; customerId: string; fieldKey: string; conflictType: string; currentValue: unknown; newValue: unknown; currentEvidenceId?: string; newEvidenceId: string; status: string; resolution?: string }
export interface SourceWorkspace { sources: SourceRecord[]; evidenceItems: EvidenceItem[]; proposals: ProfileUpdateProposal[]; conflicts: EvidenceConflict[]; profileMaterialization?: ProfileMaterialization }
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

export interface WorkbenchApi {
  login(phone: string, password: string): Promise<Staff & { mustChangePassword?: boolean }>
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; mustChangePassword: boolean; token?: string }>
  resetPassword(actorId: string, staffId: string, password: string): Promise<{ ok: boolean; staffId: string; mustChangePassword: boolean }>
  health(): Promise<HealthMetadata>
  savePerformanceTraces(): Promise<SavePerformanceTrace[]>
  evidenceDebug(): Promise<EvidenceDebugTrace[]>
  dashboard(staffId: string): Promise<Database>
  staff(staffId: string): Promise<Staff | undefined>
  customer(actorId: string, id: string): Promise<Customer | undefined>
  createAppointment(input: NewAppointmentInput): Promise<Database>
  previewCustomer(actorId: string, input: ManualCustomerInput): Promise<CustomerDraftPreview>
  createCustomer(actorId: string, input: ManualCustomerInput): Promise<Database>
  updateCustomer(actorId: string, customerId: string, input: ManualCustomerInput): Promise<Database>
  updateCustomerEnrollments(actorId: string, customerId: string, enrollments: EnrollmentDraft[]): Promise<Database>
  assignAppointment(actorId: string, appointmentId: string, mentorId: string): Promise<Database>
  markFollowupDone(actorId: string, appointmentId: string): Promise<Database>
  saveFeedback(actorId: string, feedback: FeedbackInput): Promise<Database>
  profileDraft(actorId: string, customerId: string, text: string): Promise<ProfileDraft>
  confirmProfile(actorId: string, customerId: string, updates: ProfileUpdate[]): Promise<Customer>
  updateCustomerReferrer(actorId: string, customerId: string, referrerName: string): Promise<Customer | undefined>
  createMentor(actorId: string, input: MentorAccountInput): Promise<Staff>
  updateMentor(actorId: string, mentorId: string, input: MentorAccountInput): Promise<Staff>
  deactivateMentor(actorId: string, mentorId: string): Promise<Staff>
  teamSnapshot(actorId: string, status?: StaffStatus): Promise<TeamSnapshot[]>
  dashboardSnapshot(actorId: string): Promise<DashboardSnapshot>
  assistantQuery(actorId: string, question: string, context?: AssistantQueryContext): Promise<AssistantQueryResult>
  customerIntelligence(actorId: string, input: { context: CustomerAiContext }): Promise<CustomerIntelligence>
  serviceSummary(actorId: string, input: FeedbackDraftInput): Promise<AiDraft>
  brief(actorId: string, input: { name: string; need: string; expectation: string }): Promise<string>
  saveBrief(actorId: string, customerId: string, brief: string): Promise<Customer | undefined>
  extractDocument(actorId: string, input: DocumentUploadInput): Promise<DocumentExtractionResult>
  sourceWorkspace(actorId: string, customerId: string): Promise<SourceWorkspace>
  createSource(actorId: string, input: { customerId: string; sourceType: string; rawText: string; sourcePerspective?: 'STAFF_REPORTED' | 'CUSTOMER_FIRST_PARTY'; fileRef?: string; notes?: string; document?: { filename: string; mimeType: string; extension: string; size: number; fileHash: string; charCount: number; extractedText: string } }): Promise<SourceRecord>
  processSource(actorId: string, sourceId: string, force?: boolean): Promise<{ source: SourceRecord; evidenceItems: EvidenceItem[]; proposals: ProfileUpdateProposal[]; conflicts: EvidenceConflict[] }>
  reviewProposal(actorId: string, proposalId: string, decision: 'CONFIRM' | 'REJECT'): Promise<SourceWorkspace>
  resolveConflict(actorId: string, conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN'): Promise<SourceWorkspace>
}

export interface ApiRequestTrace { time: string; method: string; path: string; status: number | null; duration: number; request_id?: string; result: 'SUCCESS' | 'ERROR' }
export interface ApiErrorInfo { code: string; message: string; request_id?: string }
export class ApiError extends Error {
  code: string
  request_id?: string
  constructor(info: ApiErrorInfo) { super(info.message); this.name = 'ApiError'; this.code = info.code; this.request_id = info.request_id }
}

const requestTraces: ApiRequestTrace[] = []
export function getApiRequestTraces() { return [...requestTraces] }
export function clearApiRequestTraces() { requestTraces.splice(0, requestTraces.length) }

type LocalApi = ReturnType<typeof createLocalApi>

export function createLocalAsyncApi(api: LocalApi): WorkbenchApi {
  return {
    login: async (phone, password) => api.login(phone, password),
    changePassword: async () => { throw new Error('本地 Demo 不支持密码修改') },
    resetPassword: async () => { throw new Error('本地 Demo 不支持密码重置') },
    health: async () => ({ ok: true, service: 'asva-api', environment: 'local', dataMode: 'demo', featureFlags: { externalAppointment: false } }),
    savePerformanceTraces: async () => [],
    evidenceDebug: async () => [],
    dashboard: async (staffId) => api.dashboard(staffId),
    staff: async (staffId) => api.staff(staffId),
    customer: async (actorId, id) => api.customer(actorId, id),
    createAppointment: async (input) => api.createAppointment(input),
    previewCustomer: async (actorId, input) => api.previewCustomer(actorId, input),
    createCustomer: async (actorId, input) => api.createCustomer(actorId, input),
    updateCustomer: async (actorId, customerId, input) => api.updateCustomer(actorId, customerId, input),
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
    serviceSummary: async (_actorId, input) => ({ summary: `本次围绕“${input.topic || '客户当前困扰'}”完成跟进。建议保留对客户当前需求的持续观察，并根据已确认的信息决定下一步。`, currentStatus: '已完成本次沟通，等待管理员确认记录。', nextStep: input.result === '暂时结束' ? '本次预约完成，保留后续重新预约入口。' : '本次预约已完成，后续如有新预约将重新进入流程。' }),
    brief: async (_actorId, input) => `已知：${input.need || '暂无当前困扰描述'}。接待时先确认客户最想解决的具体问题，再确认希望获得的帮助和当前可行动的一步。`,
    saveBrief: async (actorId, customerId) => api.customer(actorId, customerId),
    extractDocument: async () => { throw new Error('本地 Demo 不支持文件读取') },
    sourceWorkspace: async () => ({ sources: [], evidenceItems: [], proposals: [], conflicts: [] }),
    createSource: async () => { throw new Error('本地 Demo 不支持资料分析') },
    processSource: async () => { throw new Error('本地 Demo 不支持资料分析') },
    reviewProposal: async () => { throw new Error('本地 Demo 不支持资料分析') },
    resolveConflict: async () => { throw new Error('本地 Demo 不支持资料分析') },
  }
}

export function createHttpApi(baseUrl: string): WorkbenchApi {
  const base = baseUrl.replace(/\/$/, '')
  async function request<T>(path: string, staffId: string | undefined, init?: RequestInit): Promise<T> {
    const startedAt = performance.now()
    const method = init?.method || 'GET'
    const headers = new Headers(init?.headers)
    headers.set('Content-Type', 'application/json')
    const token = window.sessionStorage.getItem('asva_session_token')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    else if (staffId) headers.set('X-Staff-Id', staffId)
    let response: Response
    try { response = await fetch(`${base}${path}`, { ...init, headers }) } catch (error) {
      requestTraces.unshift({ time: new Date().toISOString(), method, path, status: null, duration: Math.round(performance.now() - startedAt), result: 'ERROR' })
      requestTraces.splice(20)
      throw new ApiError({ code: 'NETWORK_ERROR', message: '网络连接失败，请稍后重试。' })
    }
    const payload = await response.json().catch(() => null)
    const requestId = response.headers.get('X-Request-Id') || payload?.request_id || undefined
    requestTraces.unshift({ time: new Date().toISOString(), method, path, status: response.status, duration: Math.round(performance.now() - startedAt), request_id: requestId, result: response.ok ? 'SUCCESS' : 'ERROR' })
    requestTraces.splice(20)
    if (!response.ok) throw new ApiError({ code: payload?.code || `HTTP_${response.status}`, message: payload?.message || payload?.error || `HTTP ${response.status}`, request_id: requestId })
    if (path === '/api/auth/login' && payload?.token) window.sessionStorage.setItem('asva_session_token', payload.token)
    return payload as T
  }
  return {
    login: (phone, password) => request<Staff & { mustChangePassword?: boolean }>('/api/auth/login', undefined, { method: 'POST', body: JSON.stringify({ phone, password }) }),
    changePassword: async (currentPassword, newPassword) => { const result = await request<{ ok: boolean; mustChangePassword: boolean; token?: string }>('/api/auth/change-password', undefined, { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); if (result.token) window.sessionStorage.setItem('asva_session_token', result.token); return result },
    resetPassword: (actorId, staffId, password) => request<{ ok: boolean; staffId: string; mustChangePassword: boolean }>(`/api/staff/${encodeURIComponent(staffId)}/reset-password`, actorId, { method: 'POST', body: JSON.stringify({ password }) }),
    health: () => request<HealthMetadata>('/api/health', undefined),
    savePerformanceTraces: () => request<SavePerformanceTrace[]>('/api/debug/save-traces', undefined),
    evidenceDebug: () => request<EvidenceDebugTrace[]>('/api/debug/evidence', undefined),
    dashboard: (staffId) => request<Database>('/api/dashboard', staffId),
    staff: async (staffId) => request<Staff>('/api/staff/me', staffId),
    customer: (actorId, id) => request<Customer>(`/api/customers/${encodeURIComponent(id)}`, actorId),
    createAppointment: (input) => request<Database>('/api/appointments', undefined, { method: 'POST', body: JSON.stringify(input) }),
    previewCustomer: (actorId, input) => request<CustomerDraftPreview>('/api/customers/preview', actorId, { method: 'POST', body: JSON.stringify(input) }),
    createCustomer: (actorId, input) => request<Database>('/api/customers', actorId, { method: 'POST', body: JSON.stringify(input) }),
    updateCustomer: (actorId, customerId, input) => request<Database>(`/api/customers/${encodeURIComponent(customerId)}`, actorId, { method: 'PATCH', body: JSON.stringify(input), headers: input.operationId ? { 'X-Idempotency-Key': input.operationId } : undefined }),
    updateCustomerEnrollments: (actorId, customerId, enrollments) => request<Database>(`/api/customers/${encodeURIComponent(customerId)}/enrollments`, actorId, { method: 'PUT', body: JSON.stringify({ enrollments, operationId: `enrollments-${customerId}-${Date.now()}` }) }),
    assignAppointment: (actorId, appointmentId, mentorId) => request<Database>(`/api/appointments/${encodeURIComponent(appointmentId)}/assign`, actorId, { method: 'POST', body: JSON.stringify({ mentorId }) }),
    markFollowupDone: (actorId, appointmentId) => request<Database>(`/api/appointments/${encodeURIComponent(appointmentId)}/complete-followup`, actorId, { method: 'POST', body: '{}' }),
    saveFeedback: (actorId, feedback) => request<Database>(`/api/appointments/${encodeURIComponent(feedback.appointmentId)}/feedback`, actorId, { method: 'POST', body: JSON.stringify(feedback) }),
    profileDraft: (actorId, customerId, text) => request<ProfileDraft>('/api/customers/' + encodeURIComponent(customerId) + '/profile/extract', actorId, { method: 'POST', body: JSON.stringify({ text }) }),
    confirmProfile: (actorId, customerId, updates) => request<Customer>('/api/customers/' + encodeURIComponent(customerId) + '/profile/confirm', actorId, { method: 'POST', body: JSON.stringify({ updates }) }),
    updateCustomerReferrer: (actorId, customerId, referrerName) => request<Customer>(`/api/customers/${encodeURIComponent(customerId)}/referrer`, actorId, { method: 'POST', body: JSON.stringify({ referrerName }) }),
    createMentor: (actorId, input) => request<Staff>('/api/staff/mentors', actorId, { method: 'POST', body: JSON.stringify(input) }),
    updateMentor: (actorId, mentorId, input) => request<Staff>(`/api/staff/mentors/${encodeURIComponent(mentorId)}`, actorId, { method: 'PATCH', body: JSON.stringify(input) }),
    deactivateMentor: (actorId, mentorId) => request<Staff>(`/api/staff/mentors/${encodeURIComponent(mentorId)}/deactivate`, actorId, { method: 'POST', body: '{}' }),
    teamSnapshot: (actorId, status) => request<TeamSnapshot[]>(`/api/staff/mentors${status ? `?status=${encodeURIComponent(status)}` : ''}`, actorId),
    dashboardSnapshot: (actorId) => request<DashboardSnapshot>('/api/dashboard/snapshot', actorId),
    assistantQuery: (actorId, question, context) => request<AssistantQueryResult>('/api/ai/query', actorId, { method: 'POST', body: JSON.stringify({ question, context }) }),
    customerIntelligence: (actorId, input) => request<CustomerIntelligence>('/api/ai/customer-intelligence', actorId, { method: 'POST', body: JSON.stringify(input) }),
    serviceSummary: (actorId, input) => request<AiDraft>('/api/ai/service-summary', actorId, { method: 'POST', body: JSON.stringify(input) }),
    brief: async (actorId, input) => (await request<{ brief: string }>('/api/ai/brief', actorId, { method: 'POST', body: JSON.stringify(input) })).brief,
    saveBrief: (actorId, customerId, brief) => request<Customer>(`/api/customers/${encodeURIComponent(customerId)}/brief`, actorId, { method: 'POST', body: JSON.stringify({ brief }) }),
    extractDocument: (actorId, input) => request<DocumentExtractionResult>('/api/documents/extract', actorId, { method: 'POST', body: JSON.stringify({ document: input }) }),
    sourceWorkspace: (actorId, customerId) => request<SourceWorkspace>(`/api/customers/${encodeURIComponent(customerId)}/sources`, actorId),
    createSource: (actorId, input) => request<SourceRecord>('/api/sources', actorId, { method: 'POST', body: JSON.stringify(input) }),
    processSource: (actorId, sourceId, force = false) => request<{ source: SourceRecord; evidenceItems: EvidenceItem[]; proposals: ProfileUpdateProposal[]; conflicts: EvidenceConflict[] }>(`/api/sources/${encodeURIComponent(sourceId)}/process`, actorId, { method: 'POST', body: JSON.stringify({ force }) }),
    reviewProposal: (actorId, proposalId, decision) => request<SourceWorkspace>(`/api/profile-proposals/${encodeURIComponent(proposalId)}/review`, actorId, { method: 'POST', body: JSON.stringify({ decision }) }),
    resolveConflict: (actorId, conflictId, resolution) => request<SourceWorkspace>(`/api/evidence-conflicts/${encodeURIComponent(conflictId)}/resolve`, actorId, { method: 'POST', body: JSON.stringify({ resolution }) }),
  }
}
