export type Role = 'ADMIN' | 'MENTOR'
export type PermissionRole = 'ADMIN' | 'MENTOR'
export type StaffStatus = 'ACTIVE' | 'INACTIVE'
export type AppointmentWorkflowStatus = 'WAIT_ASSIGN' | 'FOLLOWING' | 'WAIT_FEEDBACK' | 'COMPLETED'
export type ProfileSource = 'USER_EXPLICIT' | 'MENTOR_CONFIRMED' | 'MENTOR_OBSERVATION' | 'AI_INFERENCE'
export type ProfileValue = string | number | string[] | null

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

export interface Customer {
  id: string
  createdAt: string
  name: string
  initials: string
  phone: string
  status: CustomerStatus
  grade: CustomerGrade
  gradeSource: 'AI建议' | '导师确认'
  mentorId: string | null
  referrerName: string
  need: string
  helpExpectation: string
  goal: string
  brief: string
  intendedCourse: string | null
  confirmedFacts: string[]
  aiQuestions: string[]
  paid: boolean
  lastActivity: string
  nextFollowup: string | null
  lastFollowupAt: string | null
  nextFollowupAt: string | null
  followupStatus: '待跟进' | '跟进中' | '已完成'
  notes: string
}

export interface ProfileFieldMeta {
  source: ProfileSource
  confidence: number
  confirmed: boolean
  updatedAt: string
}

export interface CustomerProfile {
  id: string
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
  oldValue: ProfileValue
  newValue: ProfileValue
  source: ProfileSource
  confidence: number
  confirmed: boolean
  updatedAt: string
  serviceRecordId?: string
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
  summary: string
  fit: string[]
}

export interface Enrollment {
  id: string
  customerId: string
  productId: string
  paid: boolean
  amount: number
  date: string
  status: '学习中' | '已完成'
}

export interface Database {
  staff: Staff[]
  customers: Customer[]
  appointments: Appointment[]
  sessions: ServiceSession[]
  followups: Followup[]
  products: Product[]
  enrollments: Enrollment[]
  profiles: CustomerProfile[]
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
}
