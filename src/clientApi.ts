import type { Customer, CustomerDraftPreview, Database, FeedbackInput, ManualCustomerInput, MentorAccountInput, NewAppointmentInput, ProfileDraft, ProfileUpdate, Staff, StaffStatus } from './domain'
import type { createLocalApi } from './api'
import { queryLocalAssistant } from './assistant'
import { createLocalBrief, createLocalCoreSummary, type AiBrief, type AiCoreSummary, type CustomerAiContext } from './customer-ai'

export interface AiDraft { summary: string; currentStatus: string; nextStep: string }
export interface CustomerIntelligence { summary: AiCoreSummary; brief: AiBrief }
export interface TeamSnapshot { mentor: Staff; customerCount: number; waitFollowUp: number; waitFeedback: number; completed: number }
export interface DashboardSnapshot { customerCount: number; monthNewCustomers: number; monthAppointments: number; monthCompleted: number; paidCustomers: number; mentorCount: number; statusCounts: Record<'WAIT_ASSIGN' | 'WAIT_FOLLOW_UP' | 'WAIT_FEEDBACK' | 'COMPLETED', number>; customerTrend: Array<{ label: string; value: number }>; mentorLoad: Array<{ name: string; count: number }> }
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

export interface WorkbenchApi {
  login(phone: string, code: string): Promise<Staff>
  dashboard(staffId: string): Promise<Database>
  staff(staffId: string): Promise<Staff | undefined>
  customer(actorId: string, id: string): Promise<Customer | undefined>
  createAppointment(input: NewAppointmentInput): Promise<Database>
  previewCustomer(actorId: string, input: ManualCustomerInput): Promise<CustomerDraftPreview>
  createCustomer(actorId: string, input: ManualCustomerInput): Promise<Database>
  updateCustomer(actorId: string, customerId: string, input: ManualCustomerInput): Promise<Database>
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
}

type LocalApi = ReturnType<typeof createLocalApi>

export function createLocalAsyncApi(api: LocalApi): WorkbenchApi {
  return {
    login: async (phone, code) => api.login(phone, code),
    dashboard: async (staffId) => api.dashboard(staffId),
    staff: async (staffId) => api.staff(staffId),
    customer: async (actorId, id) => api.customer(actorId, id),
    createAppointment: async (input) => api.createAppointment(input),
    previewCustomer: async (actorId, input) => api.previewCustomer(actorId, input),
    createCustomer: async (actorId, input) => api.createCustomer(actorId, input),
    updateCustomer: async (actorId, customerId, input) => api.updateCustomer(actorId, customerId, input),
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
  }
}

export function createHttpApi(baseUrl: string): WorkbenchApi {
  const base = baseUrl.replace(/\/$/, '')
  async function request<T>(path: string, staffId: string | undefined, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    headers.set('Content-Type', 'application/json')
    if (staffId) headers.set('X-Staff-Id', staffId)
    const response = await fetch(`${base}${path}`, { ...init, headers })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
    return payload as T
  }
  return {
    login: (phone, code) => request<Staff>('/api/auth/login', undefined, { method: 'POST', body: JSON.stringify({ phone, code }) }),
    dashboard: (staffId) => request<Database>('/api/dashboard', staffId),
    staff: async (staffId) => request<Staff>('/api/staff/me', staffId),
    customer: (actorId, id) => request<Customer>(`/api/customers/${encodeURIComponent(id)}`, actorId),
    createAppointment: (input) => request<Database>('/api/appointments', undefined, { method: 'POST', body: JSON.stringify(input) }),
    previewCustomer: (actorId, input) => request<CustomerDraftPreview>('/api/customers/preview', actorId, { method: 'POST', body: JSON.stringify(input) }),
    createCustomer: (actorId, input) => request<Database>('/api/customers', actorId, { method: 'POST', body: JSON.stringify(input) }),
    updateCustomer: (actorId, customerId, input) => request<Database>(`/api/customers/${encodeURIComponent(customerId)}`, actorId, { method: 'PATCH', body: JSON.stringify(input) }),
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
  }
}
