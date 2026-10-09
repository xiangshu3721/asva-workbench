export type Role = 'ADMIN' | 'MENTOR'
export type PermissionRole = 'ADMIN' | 'MENTOR'
export type StaffStatus = 'ACTIVE' | 'INACTIVE'
export type AppointmentWorkflowStatus = 'WAIT_ASSIGN' | 'WAIT_FOLLOW_UP' | 'WAIT_FEEDBACK' | 'COMPLETED'
export type ProfileSource = 'STRUCTURED_INPUT' | 'USER_EXPLICIT' | 'ADMIN_CONFIRMED' | 'MENTOR_FACTUAL_INPUT' | 'MENTOR_CONFIRMED' | 'MENTOR_OBSERVATION' | 'AI_EXTRACTED_CONFIRMED' | 'AI_INFERENCE' | 'IMPORTED_HISTORY' | 'LEGACY_MIGRATION'
export type ProfileValue = string | number | boolean | string[] | null
export type SummaryStatus = 'FRESH' | 'STALE' | 'PROCESSING' | 'FAILED'

export type UnderstandingConfidence = 'LOW' | 'MEDIUM' | 'HIGH'
export type UnderstandingInsightType = 'FACT_BASED' | 'SELF_MEANING_BASED' | 'SYNTHESIS' | 'WORKING_HYPOTHESIS'

export interface UnderstandingInsight {
  text: string
  detail?: string
  title?: string
  why_it_matters?: string
  pattern?: string
  trigger?: string
  current_cost?: string
  resource?: string
  side_a?: string
  side_b?: string
  description?: string
  focus?: string
  why_now?: string
  suggested_entry?: string
  evidence_ids: string[]
  confidence: UnderstandingConfidence
  type: UnderstandingInsightType
}

export interface UnderstandingGap {
  text: string
  detail?: string
  priority: 'HIGH' | 'MEDIUM' | 'LOW'
  evidence_ids: string[]
}

export interface CustomerUnderstandingV1 {
  schema_version: string
  generated_at: string
  one_line_understanding: UnderstandingInsight
  top_issues: UnderstandingInsight[]
  current_life_phase: UnderstandingInsight | null
  current_needs: UnderstandingInsight[]
  core_blocks: UnderstandingInsight[]
  resources_and_strengths: UnderstandingInsight[]
  key_tensions: UnderstandingInsight[]
  knowledge_gaps: UnderstandingGap[]
  next_conversation: Array<UnderstandingInsight & { prompt?: string }>
  service_cautions: Array<UnderstandingInsight & { avoid?: string; prefer?: string }>
  working_hypotheses: UnderstandingInsight[]
  meta: { overall_confidence: UnderstandingConfidence; evidence_count: number }
}

export interface CustomerUnderstandingMeta {
  status: SummaryStatus
  inputFingerprint?: string
  profileVersion?: number
  promptVersion?: string
  provider?: string
  model?: string
  generatedAt?: string
  updatedAt?: string
  durationMs?: number
  evidenceCount?: number
  quality?: { ungroundedClaimRate: number; unsupportedDiagnosis: boolean; unknownHandling: boolean; contradictionHandling: boolean }
  errorCode?: string
}

export interface AiCustomerSummary {
  overview: string
  core_issues: string[]
  priority_topics: string[]
  current_goals: string[]
  resources: string[]
  service_focus: string
  risk: { level: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNASSESSED'; reason: string }
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'
  missing_key_information: string[]
}

export type AppointmentStatus =
  | '待分配'
  | '已分配'
  | '待联系'
  | '已联系'
  | '已接待'
  | '待跟进'
  | '已完成'
  | '无法联系'

export type CustomerStatus = '活跃' | '待激活' | '已完成'
export type CustomerGrade = 'S' | 'A' | 'B' | 'C'
export type SalesStage =
  | '暂无需求'
  | '潜在需求'
  | '需求明确'
  | '已介绍方案'
  | '考虑中'
  | '已成交'
  | '未成交'
  | '长期培育'

export interface Staff {
  id: string
  name: string
  role: Role
  permissionRole: PermissionRole
  status: StaffStatus
  loginEnabled: boolean
  displayRole: string
  title: string
  phone: string
  specialty: string
  avatar: string
}

export interface MentorAccountInput {
  name: string
  phone: string
}

export interface ProfileEvidenceReference {
  evidenceId: string
  sourceId: string
  displayText: string
  excerpt: string
}

export interface ProfileMaterializationItem {
  label: string
  text: string
  evidenceIds: string[]
  basis: ProfileEvidenceReference[]
}

export interface ProfileMaterializationSection {
  title: string
  emptyLabel: string
  items: ProfileMaterializationItem[]
}

export interface ProfileMaterialization {
  schemaVersion: string
  currentSnapshot: Record<string, { value: ProfileValue; evidenceIds: string[]; basis: ProfileEvidenceReference[] }>
  sections: ProfileMaterializationSection[]
  lifeEvents: Array<{ id: string; title: string; detail: string; occurredAt: string | null; evidenceIds: string[]; basis: ProfileEvidenceReference[] }>
  coverage: { percentage: number; domains: Array<{ name: string; status: 'KNOWN' | 'PARTIAL' | 'UNKNOWN'; signalCount: number }> }
  aiSummaryStatus: SummaryStatus
  aiSummaryFingerprint?: string
}

export interface Customer {
  id: string
  createdAt: string
  createdByStaffId?: string
  createdByName?: string
  name: string
  initials: string
  phone: string
  wechat?: string
  source?: string
  status: CustomerStatus
  grade: CustomerGrade
  gradeSource: 'AI建议' | '导师确认'
  mentorId: string | null
  referrerName: string
  need: string
  helpExpectation: string
  goal: string
  brief: string
  aiSummary?: AiCustomerSummary
  aiSummaryStatus?: SummaryStatus
  intendedCourse: string | null
  understanding?: CustomerUnderstandingV1
  understandingStatus?: SummaryStatus
  understandingMeta?: CustomerUnderstandingMeta
  confirmedFacts: string[]
  aiQuestions: string[]
  paid: boolean
  lastActivity: string
  nextFollowup: string | null
  lastFollowupAt: string | null
  nextFollowupAt: string | null
  followupStatus: '待跟进' | '已完成'
  notes: string
  /** The customer's current structured profile; persisted on the Customer record. */
  profileFields?: Record<string, ProfileValue>
  profileFieldMeta?: Record<string, ProfileFieldMeta>
  profileUpdatedAt?: string | null
  profileSchemaVersion?: string
  profileVersion?: number
  profileMaterialization?: ProfileMaterialization
}

export interface ProfileFieldMeta {
  source: ProfileSource
  confidence: number
  confirmed: boolean
  updatedAt: string
  sourceRecordId?: string
  evidenceId?: string
  extractionBatchId?: string
}

export interface CustomerProfileState {
  customerId: string
  fields: Record<string, ProfileValue>
  fieldMeta: Record<string, ProfileFieldMeta>
  updatedAt: string | null
  schemaVersion: string
}

export interface ProfileUpdate {
  field: string
  value: ProfileValue
  source?: ProfileSource
  confidence?: number
  confirmed?: boolean
  previousValue?: ProfileValue
  conflict?: boolean
}

export interface ProfileDraft {
  updates: ProfileUpdate[]
}

export interface ProfileChange {
  id: string
  customerId: string
  field: string
  fieldName?: string
  oldValue: ProfileValue
  newValue: ProfileValue
  source: ProfileSource
  confidence: number
  confirmed: boolean
  updatedAt: string
  operatorId?: string
  serviceRecordId?: string
  sourceRecordId?: string
  evidenceId?: string
  updateBatchId?: string
}

export interface Appointment {
  id: string
  customerId: string
  topic: string
  submittedAt: string
  description: string
  expectation: string
  status: AppointmentStatus | AppointmentWorkflowStatus
  mentorId: string | null
  assignedMentorId: string | null
  followupHandled: boolean
  followupInfoCompleted: boolean
  createdAt: string
  completedAt?: string | null
  source: string
  /** Existing Appointment records are the V0.9 Case/跟进事项. */
  caseSource?: string
}

export interface ServiceSession {
  id: string
  customerId: string
  mentorId: string
  operatorId?: string
  type: string
  date: string
  duration: number
  topic: string
  note: string
  result: string
  nextStep: string
  followupDate: string | null
  aiSummary?: string
  profileText?: string
  profileUpdates?: ProfileUpdate[]
}

export interface Followup {
  id: string
  customerId: string
  ownerId: string
  date: string
  channel: string
  note: string
  status: '待跟进' | '已完成'
  stage: SalesStage
}

export interface Product {
  id: string
  name: string
  system: string
  audience: string
  cycle: string
  format: string
  status: '在售' | '筹备中'
  /** Production Feishu products are normalized to this flag when available. */
  active?: boolean
  summary: string
  fit: string[]
}

export type EnrollmentPaymentStatus = 'UNRECORDED' | 'PAID' | 'UNPAID'

export interface EnrollmentDraft {
  productId: string
  paymentStatus?: EnrollmentPaymentStatus
  amount?: number | null
  enrolledAt?: string | null
  paidAt?: string | null
}

export interface Enrollment {
  id: string
  customerId: string
  productId: string
  paid: boolean
  amount: number
  date: string
  status: '学习中' | '已完成' | 'CANCELLED'
  paymentStatus?: EnrollmentPaymentStatus
  enrollmentSource?: string
  enrolledAt?: string | null
  paidAt?: string | null
  operatorId?: string
}

export interface Database {
  staff: Staff[]
  customers: Customer[]
  appointments: Appointment[]
  sessions: ServiceSession[]
  followups: Followup[]
  products: Product[]
  enrollments: Enrollment[]
  profileChanges: ProfileChange[]
  _missingRepositories?: string[]
}

export interface DashboardStats {
  newAppointments: number
  unassigned: number
  todaySessions: number
  dueFollowups: number
  overdue: number
  customers: number
  activeCustomers: number
  paidCustomers: number
  monthlyPaid: number
}

export interface FeedbackInput {
  appointmentId: string
  topic: string
  result: string
  coreNeed: string
  paid: boolean
  grade: CustomerGrade
  intendedCourse: string | null
  notes: string
  aiSummary?: string
  aiStatus?: string
  aiNextStep?: string
  profileText?: string
  profileUpdates?: ProfileUpdate[]
}

export interface NewAppointmentInput {
  customerId: string
  topic: string
  submittedAt: string
  description: string
  expectation: string
  source: string
  createdAt: string
  nickname?: string
  phone?: string
  wechat?: string
  customerSituation?: string
  caseSource?: string
}

export interface ManualCustomerInput {
  operationId?: string
  nickname: string
  phone?: string
  wechat?: string
  situation: string
  needsFollowup: boolean
  mentorId?: string | null
  source?: string
  caseSource?: string
  profileUpdates?: ProfileUpdate[]
  confirmedNotSame?: boolean
  enrollments?: EnrollmentDraft[]
}

export interface CustomerDuplicateMatch {
  customer: Customer
  matchedBy: 'phone' | 'wechat' | 'nickname_exact' | 'nickname_fuzzy'
}

export interface CustomerDraftPreview {
  duplicates: CustomerDuplicateMatch[]
  updates: ProfileUpdate[]
  identity?: { result: 'EXACT_MATCH' | 'POSSIBLE_MATCH' | 'CONFLICT' | 'NEW_CUSTOMER'; matched_customer_id: string | null; match_reasons: string[]; confidence: number }
}
