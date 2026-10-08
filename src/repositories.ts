import { seedDatabase } from './data'
import type { Appointment, AppointmentWorkflowStatus, Customer, CustomerDraftPreview, CustomerDuplicateMatch, CustomerProfileState, Database, Enrollment, EnrollmentDraft, FeedbackInput, ManualCustomerInput, MentorAccountInput, NewAppointmentInput, Product, ProfileChange, ProfileDraft, ProfileUpdate, Staff } from './domain'
import { extractLocalProfile, PROFILE_FIELD_KEYS, profileUpdateLabel, updateValue } from './profile'
import { contactRequired, normalizePhone as foundationNormalizePhone, normalizeWechat, resolveCustomerIdentity } from '../shared/customer-foundation'

const STORAGE_KEY = 'asva-workbench-demo-db-v9'
const LEGACY_STORAGE_KEY = 'asva-workbench-demo-db-v8'
const TRACK_PROFILE_FIELDS = new Set(['phone', 'wechat', 'birth_date', 'gender', 'age', 'city', 'marital_status', 'children_summary', 'family_summary', 'occupation', 'job_status', 'relationship_status', 'support_system', 'current_resources', 'current_barriers', 'current_core_issue', 'current_goal', 'current_expectation', 'current_mentor_id'])
const CUSTOMER_PROFILE_SCHEMA_VERSION = 'v1.0'

function cloneSeed(): Database {
  return structuredClone(seedDatabase)
}

function permissionRole(staff: Staff): 'ADMIN' | 'MENTOR' {
  return staff.permissionRole ?? (staff.role === 'MENTOR' ? 'MENTOR' : 'ADMIN')
}

const normalizePhone = foundationNormalizePhone
function assertValidPhone(phone: string) { const normalized = normalizePhone(phone); if (!/^1\d{10}$/.test(normalized) && !normalized.startsWith('+')) throw new Error('请输入有效手机号') }

function normalize(database: Database): Database {
  const legacyProfiles = ((database as Database & { profiles?: CustomerProfileState[] }).profiles ?? []).map((profile) => ({ ...profile, fields: profile.fields ?? {}, fieldMeta: profile.fieldMeta ?? {}, updatedAt: profile.updatedAt ?? null, schemaVersion: profile.schemaVersion ?? 'v0.4' }))
  const customers = database.customers.map((customer) => {
    const legacy = legacyProfiles.find((profile) => profile.customerId === customer.id)
    const profileFields = { ...(legacy?.fields ?? {}), ...(customer.profileFields ?? {}) }
    profileFields.current_core_issue ??= customer.need ?? null
    profileFields.current_expectation ??= customer.helpExpectation ?? null
    profileFields.current_goal ??= customer.goal ?? null
    profileFields.grade ??= customer.grade ?? null
    profileFields.paid ??= customer.paid ?? false
    profileFields.current_mentor_id ??= customer.mentorId ?? null
    profileFields.mentor_id ??= profileFields.current_mentor_id
    profileFields.phone ??= customer.phone ?? null
    profileFields.wechat ??= customer.wechat ?? null
    return { ...customer, wechat: customer.wechat ?? '', source: customer.source ?? '历史数据导入', referrerName: customer.referrerName ?? '', createdAt: customer.createdAt ?? '2026-10-01', notes: customer.notes ?? '', lastFollowupAt: customer.lastFollowupAt ?? null, nextFollowupAt: customer.nextFollowupAt ?? null, followupStatus: String((customer as Customer & { followupStatus?: string }).followupStatus) === '跟进中' ? '待跟进' : customer.followupStatus ?? '待跟进', profileFields, profileFieldMeta: { ...(legacy?.fieldMeta ?? {}), ...(customer.profileFieldMeta ?? {}) }, profileUpdatedAt: customer.profileUpdatedAt ?? legacy?.updatedAt ?? null, profileVersion: customer.profileVersion ?? 0, profileSchemaVersion: customer.profileSchemaVersion ?? legacy?.schemaVersion ?? CUSTOMER_PROFILE_SCHEMA_VERSION }
  })
  const { profiles: _legacyProfiles, ...withoutLegacyProfiles } = database as Database & { profiles?: CustomerProfileState[] }
  return {
    ...withoutLegacyProfiles,
    staff: database.staff.map((staff) => { const role = permissionRole(staff); return { ...staff, role, permissionRole: role, status: staff.status ?? 'ACTIVE', loginEnabled: role === 'ADMIN' ? staff.loginEnabled !== false : false, displayRole: role === 'ADMIN' ? '管理员' : '导师', title: role === 'ADMIN' ? '管理员' : '导师' } }),
    customers,
    profileChanges: database.profileChanges ?? [],
    appointments: database.appointments.map((appointment) => {
      const statusMap: Record<string, AppointmentWorkflowStatus> = { 待分配: 'WAIT_ASSIGN', 已分配: 'WAIT_FOLLOW_UP', 待跟进: 'WAIT_FOLLOW_UP', 已接待: 'WAIT_FEEDBACK', 已完成: 'COMPLETED', FOLLOWING: 'WAIT_FOLLOW_UP' }
      const status = statusMap[appointment.status] ?? appointment.status as AppointmentWorkflowStatus
      return { ...appointment, status, assignedMentorId: appointment.assignedMentorId ?? appointment.mentorId ?? null, followupHandled: appointment.followupHandled ?? ['WAIT_FEEDBACK', 'COMPLETED'].includes(status), followupInfoCompleted: appointment.followupInfoCompleted ?? status === 'COMPLETED', createdAt: appointment.createdAt ?? '2026-10-01', completedAt: appointment.completedAt ?? null }
    }),
  }
}

function readDatabase(): Database {
  const saved = window.localStorage.getItem(STORAGE_KEY) || window.localStorage.getItem(LEGACY_STORAGE_KEY)
  const database = normalize(saved ? JSON.parse(saved) as Database : cloneSeed())
  if (saved) writeDatabase(database)
  return database
}

function writeDatabase(database: Database) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database))
}

function validateManualCustomer(input: ManualCustomerInput) {
  const nickname = input.nickname.trim()
  const phone = normalizePhone(input.phone ?? '')
  const wechat = input.wechat?.trim() ?? ''
  if (!nickname) throw new Error('客户昵称不能为空')
  if (phone && !/^1\d{10}$/.test(phone) && !phone.startsWith('+')) throw new Error('请输入有效手机号')
  if (!contactRequired({ phone, wechat })) throw Object.assign(new Error('手机号或微信号至少填写一个'), { code: 'CUSTOMER_CONTACT_REQUIRED' })
  return { nickname, phone, wechat }
}

function customerDuplicates(database: Database, input: ManualCustomerInput): CustomerDuplicateMatch[] {
  const { nickname, phone, wechat } = validateManualCustomer(input)
  const identity = resolveCustomerIdentity(database.customers, { nickname, phone, wechat })
  return identity.matches.map((customer) => ({ customer: customer as Customer, matchedBy: identity.match_reasons.includes('PHONE_EXACT') ? 'phone' : identity.match_reasons.includes('WECHAT_EXACT') ? 'wechat' : identity.match_reasons.includes('NICKNAME_EXACT') ? 'nickname_exact' : 'nickname_fuzzy' }))
}

function emptyProfile(customerId: string): CustomerProfileState {
  return { customerId, fields: {}, fieldMeta: {}, updatedAt: null, schemaVersion: CUSTOMER_PROFILE_SCHEMA_VERSION }
}

function createManualCustomer(database: Database, input: ManualCustomerInput, updates: ProfileUpdate[]): Customer {
  const { nickname, phone, wechat } = validateManualCustomer(input)
  const id = `C-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const createdAt = new Date().toISOString()
  const customer: Customer = { id, createdAt: createdAt.slice(0, 10), name: nickname, initials: nickname.slice(0, 1), phone, wechat, source: input.source ?? '管理员手动录入', status: '活跃', grade: 'C', gradeSource: 'AI建议', mentorId: null, referrerName: '', need: '', helpExpectation: '', goal: '', brief: '', intendedCourse: null, confirmedFacts: [], aiQuestions: [], paid: false, lastActivity: '刚刚', nextFollowup: null, lastFollowupAt: null, nextFollowupAt: null, followupStatus: '待跟进', notes: input.situation.trim(), profileFields: { phone, wechat: wechat || null }, profileFieldMeta: { phone: { source: 'STRUCTURED_INPUT', confidence: 1, confirmed: true, updatedAt: createdAt }, ...(wechat ? { wechat: { source: 'STRUCTURED_INPUT', confidence: 1, confirmed: true, updatedAt: createdAt } } : {}) }, profileUpdatedAt: createdAt, profileVersion: 1, profileSchemaVersion: CUSTOMER_PROFILE_SCHEMA_VERSION }
  database.customers.unshift(customer)
  if (updates.length) applyProfileUpdates(database, customer.id, normalizedProfileUpdates(updates, emptyProfile(customer.id), true), undefined, 'admin')
  return customer
}

function getStaff(database: Database, staffId: string) {
  const staff = database.staff.find((item) => item.id === staffId)
  if (!staff) throw new Error('账号不存在')
  return staff
}

function assertActive(staff: Staff) {
  if (staff.status !== 'ACTIVE') throw new Error('该账户已停用，请联系管理员。')
}

function assertAdmin(staff: Staff) {
  if (permissionRole(staff) !== 'ADMIN' || staff.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
}

function assertAppointmentAccess(staff: Staff, _appointment: Appointment) {
  assertAdmin(staff)
}

function sameProfileValue(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function derivedAge(value: unknown) {
  if (!value) return null
  const birth = new Date(String(value))
  if (Number.isNaN(birth.getTime())) return null
  const today = new Date()
  let age = today.getUTCFullYear() - birth.getUTCFullYear()
  const monthDelta = today.getUTCMonth() - birth.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < birth.getUTCDate())) age -= 1
  return age >= 0 ? age : null
}

function customerProfileState(customer: Customer): CustomerProfileState {
  return { customerId: customer.id, fields: customer.profileFields ?? {}, fieldMeta: customer.profileFieldMeta ?? {}, updatedAt: customer.profileUpdatedAt ?? null, schemaVersion: customer.profileSchemaVersion ?? 'v0.5' }
}

function normalizedProfileUpdates(updates: ProfileUpdate[] | undefined, profile: CustomerProfileState, confirmed = false): ProfileUpdate[] {
  if (!Array.isArray(updates)) return []
  return updates.filter((update) => PROFILE_FIELD_KEYS.includes(update.field as typeof PROFILE_FIELD_KEYS[number])).map((update) => {
    const source = confirmed ? 'MENTOR_CONFIRMED' : update.source === 'AI_INFERENCE' ? 'AI_INFERENCE' : update.source ?? 'MENTOR_OBSERVATION'
    const value = updateValue(update.value)
    const previousValue = profile.fields[update.field] ?? null
    return { ...update, value, previousValue, source, confidence: Math.max(0, Math.min(1, Number(update.confidence ?? 0.9))), confirmed: confirmed && source === 'MENTOR_CONFIRMED', conflict: !sameProfileValue(previousValue, value) && previousValue !== null }
  })
}

function applyProfileUpdates(database: Database, customerId: string, updates: ProfileUpdate[], serviceRecordId?: string, operatorId?: string): Customer {
  const customer = database.customers.find((item) => item.id === customerId)
  if (!customer) throw new Error('客户不存在')
  const profile = customerProfileState(customer)
  const updatedAt = new Date().toISOString()
  let changed = false
  for (const update of updates) {
    const oldValue = profile.fields[update.field] ?? null
    const field = update.field === 'mentor_id' ? 'current_mentor_id' : update.field
    const source = update.confirmed ? update.source === 'AI_INFERENCE' ? 'AI_EXTRACTED_CONFIRMED' : update.source === 'USER_EXPLICIT' ? 'ADMIN_CONFIRMED' : 'MENTOR_FACTUAL_INPUT' : update.source ?? 'MENTOR_OBSERVATION'
    profile.fields[field] = update.value
    profile.fieldMeta[field] = { source, confidence: update.confidence ?? 0.9, confirmed: update.confirmed === true, updatedAt }
    customer.profileFields = profile.fields
    customer.profileFieldMeta = profile.fieldMeta
    if (update.field === 'current_core_issue' && typeof update.value === 'string') customer.need = update.value
    if (update.field === 'current_expectation' && typeof update.value === 'string') customer.helpExpectation = update.value
    if (update.field === 'current_goal' && typeof update.value === 'string') customer.goal = update.value
    if (update.field === 'intended_course') customer.intendedCourse = typeof update.value === 'string' ? update.value : null
    if (update.field === 'paid' && typeof update.value === 'boolean') customer.paid = update.value
    if (update.field === 'grade' && typeof update.value === 'string' && ['S', 'A', 'B', 'C'].includes(update.value)) customer.grade = update.value as Customer['grade']
    if (field === 'current_mentor_id' && typeof update.value === 'string') customer.mentorId = update.value
    if (field === 'birth_date') {
      const age = derivedAge(update.value)
      if (age !== null) profile.fields.age = age
      const birthYear = new Date(String(update.value)).getUTCFullYear()
      if (Number.isFinite(birthYear)) profile.fields.birth_year = birthYear
    }
    if ((field === 'age' || field === 'birth_year') && profile.fields.birth_date) continue
    if (!sameProfileValue(oldValue, update.value) && TRACK_PROFILE_FIELDS.has(field)) {
      const change: ProfileChange = { id: 'PC-' + Date.now() + '-' + database.profileChanges.length, customerId, field, fieldName: profileUpdateLabel({ ...update, field }), oldValue, newValue: update.value, source, confidence: update.confidence ?? 0.9, confirmed: update.confirmed === true, updatedAt, operatorId, serviceRecordId }
      database.profileChanges.unshift(change)
    }
    if (!sameProfileValue(oldValue, update.value)) changed = true
  }
  customer.profileUpdatedAt = updatedAt
  if (changed) customer.profileVersion = (customer.profileVersion ?? 0) + 1
  customer.profileSchemaVersion = CUSTOMER_PROFILE_SCHEMA_VERSION
  return customer
}

function scopedDatabase(database: Database, staff: Staff): Database {
  assertAdmin(staff)
  return database
}

function activeProduct(database: Database, productId: string) {
  return database.products.find((product) => product.id === productId && product.active !== false && product.status === '在售')
}

function mergeEnrollments(database: Database, customerId: string, drafts: EnrollmentDraft[] | undefined, operatorId: string) {
  if (!drafts?.length) return
  const uniqueDrafts = new Map(drafts.map((draft) => [draft.productId, draft]))
  for (const draft of uniqueDrafts.values()) {
    const product = activeProduct(database, draft.productId)
    if (!product) throw new Error('只能选择 ASVA 产品中的有效课程')
    const existing = database.enrollments.find((item) => item.customerId === customerId && item.productId === product.id && item.status !== 'CANCELLED')
    const cancelled = database.enrollments.find((item) => item.customerId === customerId && item.productId === product.id && item.status === 'CANCELLED')
    if (existing) {
      if (draft.paymentStatus) {
        existing.paymentStatus = draft.paymentStatus
        existing.paid = draft.paymentStatus === 'PAID'
      }
      if (draft.amount !== undefined && draft.amount !== null) existing.amount = draft.amount
      if (draft.enrolledAt) existing.enrolledAt = draft.enrolledAt
      if (draft.paidAt) existing.paidAt = draft.paidAt
      continue
    }
    if (cancelled) {
      cancelled.status = '学习中'
      if (draft.paymentStatus) { cancelled.paymentStatus = draft.paymentStatus; cancelled.paid = draft.paymentStatus === 'PAID' }
      if (draft.amount !== undefined && draft.amount !== null) cancelled.amount = draft.amount
      continue
    }
    const paymentStatus = draft.paymentStatus ?? 'UNRECORDED'
    const enrolledAt = draft.enrolledAt ?? new Date().toISOString()
    const enrollment: Enrollment = { id: `E-${Date.now()}-${Math.floor(Math.random() * 1000)}`, customerId, productId: product.id, paid: paymentStatus === 'PAID', amount: draft.amount ?? Number.NaN, date: draft.paidAt ?? enrolledAt, status: '学习中', paymentStatus, enrollmentSource: 'MANUAL', enrolledAt, paidAt: draft.paidAt ?? null, operatorId }
    database.enrollments.push(enrollment)
  }
}

export interface AsvaRepository {
  getDatabase(): Database
  getDatabaseForUser(staffId: string): Database
  authenticate(phone: string, code: string): Staff
  createAppointment(input: NewAppointmentInput): Database
  previewCustomer(actorId: string, input: ManualCustomerInput): CustomerDraftPreview
  createCustomer(actorId: string, input: ManualCustomerInput): Database
  updateCustomer(actorId: string, customerId: string, input: ManualCustomerInput): Database
  updateCustomerEnrollments(actorId: string, customerId: string, enrollments: EnrollmentDraft[]): Database
  assignAppointment(actorId: string, appointmentId: string, mentorId: string): Database
  markFollowupDone(actorId: string, appointmentId: string): Database
  saveFeedback(actorId: string, feedback: FeedbackInput): Database
  profileDraft(actorId: string, customerId: string, text: string): ProfileDraft
  confirmProfile(actorId: string, customerId: string, updates: ProfileUpdate[]): Customer
  createMentor(actorId: string, input: MentorAccountInput): Staff
  updateMentor(actorId: string, mentorId: string, input: MentorAccountInput): Staff
  deactivateMentor(actorId: string, mentorId: string): Staff
  updateCustomerReferrer(actorId: string, customerId: string, referrerName: string): Customer
  getCustomer(customerId: string): Customer | undefined
  getStaff(staffId: string): Staff | undefined
  getAppointment(appointmentId: string): Appointment | undefined
  getProduct(productId: string): Product | undefined
}

export function createLocalRepository(): AsvaRepository {
  return {
    getDatabase: readDatabase,
    getDatabaseForUser(staffId) {
      const database = readDatabase()
      const actor = getStaff(database, staffId)
      assertActive(actor)
      return scopedDatabase(database, actor)
    },
    authenticate(phone, code) {
      if (code !== '888888') throw new Error('手机号或验证码错误')
      const database = readDatabase()
      const normalized = normalizePhone(phone)
      const account = database.staff.find((item) => normalizePhone(item.phone) === normalized)
      if (account?.status === 'INACTIVE') throw new Error('该账户已停用，请联系管理员。')
      if (account?.permissionRole === 'MENTOR') throw new Error('导师端暂未开放，请联系管理员。')
      if (account?.status === 'ACTIVE' && account.loginEnabled === true) return account
      throw new Error('手机号或验证码错误')
    },
    createAppointment(input) {
      const database = readDatabase()
      let customerId = input.customerId
      if (!database.customers.some((item) => item.id === customerId)) {
        if (!input.nickname || (!input.phone && !input.wechat)) throw new Error('客户不存在，且缺少新客户的昵称与联系方式')
        customerId = createManualCustomer(database, { nickname: input.nickname, phone: input.phone, wechat: input.wechat, situation: input.customerSituation || input.description, needsFollowup: true, source: '解忧小屋' }, []).id
      }
      database.appointments.push({ id: `A-${Date.now()}`, ...input, customerId, status: 'WAIT_ASSIGN', mentorId: null, assignedMentorId: null, followupHandled: false, followupInfoCompleted: false, caseSource: input.caseSource ?? input.source, source: input.caseSource ?? input.source })
      writeDatabase(database)
      return database
    },
    previewCustomer(actorId, input) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      validateManualCustomer(input)
      const draft = input.situation.trim() ? extractLocalProfile(input.situation, emptyProfile('preview')) : { updates: [] }
      const identity = resolveCustomerIdentity(database.customers, input)
      return { duplicates: customerDuplicates(database, input), identity: { result: identity.result, matched_customer_id: identity.matched_customer_id, match_reasons: identity.match_reasons, confidence: identity.confidence }, updates: draft.updates }
    },
    createCustomer(actorId, input) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      const identity = resolveCustomerIdentity(database.customers, input)
      if (identity.result === 'CONFLICT') throw Object.assign(new Error('手机号和微信号分别匹配到了不同客户，请人工确认。'), { code: 'IDENTITY_CONFLICT' })
      if (identity.result === 'EXACT_MATCH') throw Object.assign(new Error('该联系方式已匹配到现有客户，请打开原档案更新。'), { code: 'CUSTOMER_DUPLICATE' })
      const duplicates = customerDuplicates(database, input)
      if (identity.result === 'POSSIBLE_MATCH' && !input.confirmedNotSame) throw Object.assign(new Error('检测到可能重复的客户，请先确认是否为同一人'), { code: 'CUSTOMER_POSSIBLE_MATCH' })
      const updates = input.profileUpdates ?? []
      const customer = createManualCustomer(database, input, updates)
      mergeEnrollments(database, customer.id, input.enrollments, actor.id)
      // Stage 1 Customer creation never creates an Appointment.
      writeDatabase(database)
      return scopedDatabase(database, actor)
    },
    updateCustomer(actorId, customerId, input) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      const customer = database.customers.find((item) => item.id === customerId)
      if (!customer) throw new Error('客户不存在')
      const { nickname, phone, wechat } = validateManualCustomer({ ...input, nickname: input.nickname || customer.name, phone: input.phone || customer.phone, wechat: input.wechat || customer.wechat })
      const identity = resolveCustomerIdentity(database.customers.filter((item) => item.id !== customerId), { ...input, nickname, phone, wechat })
      if (identity.result === 'CONFLICT') throw Object.assign(new Error('手机号和微信号分别匹配到了不同客户，请人工确认。'), { code: 'IDENTITY_CONFLICT' })
      if (identity.result === 'EXACT_MATCH') throw Object.assign(new Error('该联系方式已绑定其他客户，不能覆盖。'), { code: 'CUSTOMER_DUPLICATE' })
      const oldPhone = customer.phone
      const oldWechat = customer.wechat
      customer.name = nickname
      customer.initials = nickname.slice(0, 1)
      customer.phone = phone
      customer.wechat = wechat
      if (oldPhone !== phone) applyProfileUpdates(database, customerId, [{ field: 'phone', value: phone, source: 'USER_EXPLICIT', confidence: 1, confirmed: true }], undefined, actor.id)
      if (normalizeWechat(oldWechat) !== normalizeWechat(wechat)) applyProfileUpdates(database, customerId, [{ field: 'wechat', value: wechat, source: 'USER_EXPLICIT', confidence: 1, confirmed: true }], undefined, actor.id)
      if (input.situation.trim()) customer.notes = input.situation.trim()
      if (input.profileUpdates?.length) applyProfileUpdates(database, customerId, normalizedProfileUpdates(input.profileUpdates, customerProfileState(customer), true), undefined, actorId)
      mergeEnrollments(database, customerId, input.enrollments, actor.id)
      // Stage 1 Customer updates never create or mutate Appointment.
      writeDatabase(database)
      return scopedDatabase(database, actor)
    },
    updateCustomerEnrollments(actorId, customerId, drafts) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      const customer = database.customers.find((item) => item.id === customerId)
      if (!customer) throw new Error('客户不存在')
      const selected = new Map(drafts.map((draft) => [draft.productId, draft]))
      for (const enrollment of database.enrollments.filter((item) => item.customerId === customerId && item.status !== 'CANCELLED')) {
        if (!selected.has(enrollment.productId)) enrollment.status = 'CANCELLED'
      }
      mergeEnrollments(database, customerId, drafts, actor.id)
      writeDatabase(database)
      return scopedDatabase(database, actor)
    },
    assignAppointment(actorId, appointmentId, mentorId) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      const appointment = database.appointments.find((item) => item.id === appointmentId)
      const mentor = getStaff(database, mentorId)
      if (!appointment) throw new Error('预约不存在')
      assertActive(mentor)
      if (permissionRole(mentor) !== 'MENTOR') throw new Error('只能分配给导师账号')
      appointment.assignedMentorId = mentor.id
      appointment.mentorId = mentor.id
      if (!['WAIT_ASSIGN', 'WAIT_FOLLOW_UP', 'WAIT_FEEDBACK'].includes(appointment.status)) throw new Error('已完成的预约不能更换导师')
      appointment.status = appointment.status === 'WAIT_ASSIGN' ? 'WAIT_FOLLOW_UP' : appointment.status
      appointment.followupHandled = appointment.status === 'WAIT_FEEDBACK'
      appointment.followupInfoCompleted = false
      const customer = database.customers.find((item) => item.id === appointment.customerId)
      if (customer) {
        const oldMentor = customer.mentorId
        customer.mentorId = mentor.id
        if (oldMentor !== mentor.id) applyProfileUpdates(database, customer.id, [{ field: 'mentor_id', value: mentor.id, source: 'USER_EXPLICIT', confidence: 1, confirmed: true }], undefined, actor.id)
      }
      writeDatabase(database)
      return scopedDatabase(database, actor)
    },
    markFollowupDone(actorId, appointmentId) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      const appointment = database.appointments.find((item) => item.id === appointmentId)
      if (!appointment) throw new Error('预约不存在')
      assertAppointmentAccess(actor, appointment)
      if (appointment.status !== 'WAIT_FOLLOW_UP') throw new Error('只有待跟进的预约可以完成跟进')
      appointment.followupHandled = true
      appointment.status = 'WAIT_FEEDBACK'
      writeDatabase(database)
      return scopedDatabase(database, actor)
    },
    saveFeedback(actorId, feedback) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      const appointment = database.appointments.find((item) => item.id === feedback.appointmentId)
      if (!appointment) throw new Error('预约不存在')
      assertAppointmentAccess(actor, appointment)
      if (appointment.status !== 'WAIT_FEEDBACK') throw new Error('当前预约还不能提交反馈')
      const customer = database.customers.find((item) => item.id === appointment.customerId)
      if (!customer) throw new Error('客户不存在')
      const serviceRecordId = 'S-' + Date.now()
      database.sessions.unshift({ id: serviceRecordId, customerId: customer.id, mentorId: appointment.assignedMentorId ?? actor.id, operatorId: actor.id, type: '跟进反馈', date: new Date().toISOString().slice(0, 16).replace('T', ' '), duration: 0, topic: feedback.topic, note: feedback.notes || feedback.coreNeed, result: feedback.result, nextStep: '本次预约已完成，后续如有新预约将重新进入流程。', followupDate: null, aiSummary: feedback.aiSummary || 'AI 已根据本次反馈整理本次客户状态与下一步建议。', profileText: feedback.profileText, profileUpdates: feedback.profileUpdates })
      if (feedback.profileUpdates?.length) applyProfileUpdates(database, customer.id, normalizedProfileUpdates(feedback.profileUpdates, customerProfileState(customer), true), serviceRecordId, actor.id)
      const directUpdates: ProfileUpdate[] = []
      if (feedback.coreNeed && feedback.coreNeed !== customer.need) directUpdates.push({ field: 'current_core_issue', value: feedback.coreNeed, source: 'MENTOR_CONFIRMED', confidence: 1, confirmed: true })
      if (feedback.paid !== customer.paid) directUpdates.push({ field: 'paid', value: feedback.paid, source: 'MENTOR_CONFIRMED', confidence: 1, confirmed: true })
      if (feedback.grade !== customer.grade) directUpdates.push({ field: 'grade', value: feedback.grade, source: 'MENTOR_CONFIRMED', confidence: 1, confirmed: true })
      if (feedback.intendedCourse !== customer.intendedCourse) directUpdates.push({ field: 'intended_course', value: feedback.intendedCourse, source: 'MENTOR_CONFIRMED', confidence: 1, confirmed: true })
      if (directUpdates.length) applyProfileUpdates(database, customer.id, directUpdates, serviceRecordId, actor.id)
      customer.need = feedback.coreNeed || customer.need
      customer.profileFields = { ...(customer.profileFields ?? {}), current_core_issue: customer.need }
      customer.paid = feedback.paid
      customer.profileFields.paid = feedback.paid
      customer.grade = feedback.grade
      customer.profileFields.grade = feedback.grade
      customer.intendedCourse = feedback.intendedCourse
      customer.notes = feedback.notes
      appointment.followupInfoCompleted = true
      appointment.status = 'COMPLETED'
      appointment.completedAt = new Date().toISOString().slice(0, 10)
      writeDatabase(database)
      return scopedDatabase(database, actor)
    },
    profileDraft(actorId, customerId, text) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      if (!scopedDatabase(database, actor).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
      const customer = database.customers.find((item) => item.id === customerId)
      if (!customer) throw new Error('客户不存在')
      return extractLocalProfile(text, customerProfileState(customer))
    },
    confirmProfile(actorId, customerId, updates) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      if (!scopedDatabase(database, actor).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
      const customer = database.customers.find((item) => item.id === customerId)
      if (!customer) throw new Error('客户不存在')
      applyProfileUpdates(database, customerId, normalizedProfileUpdates(updates, customerProfileState(customer), true), undefined, actor.id)
      writeDatabase(database)
      return database.customers.find((item) => item.id === customerId)!
    },
    createMentor(actorId, input) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      const name = input.name.trim()
      const phone = normalizePhone(input.phone)
      if (!name) throw new Error('导师昵称不能为空')
      assertValidPhone(phone)
      const duplicate = database.staff.find((item) => normalizePhone(item.phone) === phone)
      if (duplicate?.status === 'ACTIVE') throw new Error('该手机号已绑定账户')
      if (duplicate?.status === 'INACTIVE') throw new Error('该手机号对应一个已停用导师，请编辑原导师记录，不要重复创建')
      let id = `M${Date.now()}`
      while (database.staff.some((item) => item.id === id)) id = `M${Date.now()}${Math.floor(Math.random() * 10)}`
      const mentor: Staff = { id, name, role: 'MENTOR', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: false, displayRole: '导师', title: '导师', phone, specialty: '', avatar: name.slice(0, 1) }
      database.staff.push(mentor)
      writeDatabase(database)
      return mentor
    },
    updateMentor(actorId, mentorId, input) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      const mentor = database.staff.find((item) => item.id === mentorId && item.permissionRole === 'MENTOR')
      if (!mentor) throw new Error('导师不存在')
      if (mentor.status !== 'ACTIVE') throw new Error('已注销导师只能查看历史信息')
      const name = input.name.trim()
      const phone = normalizePhone(input.phone)
      if (!name) throw new Error('导师昵称不能为空')
      assertValidPhone(phone)
      const duplicate = database.staff.find((item) => item.id !== mentorId && normalizePhone(item.phone) === phone)
      if (duplicate?.status === 'ACTIVE') throw new Error('该手机号已绑定账户')
      if (duplicate?.status === 'INACTIVE') throw new Error('该手机号对应一个已停用导师，请使用未占用的手机号')
      mentor.name = name
      mentor.phone = phone
      mentor.loginEnabled = false
      mentor.avatar = name.slice(0, 1)
      writeDatabase(database)
      return mentor
    },
    deactivateMentor(actorId, mentorId) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      const mentor = database.staff.find((item) => item.id === mentorId && item.permissionRole === 'MENTOR')
      if (!mentor) throw new Error('导师不存在')
      if (mentor.status !== 'ACTIVE') throw new Error('导师账户已注销')
      const following = database.appointments.filter((item) => item.assignedMentorId === mentorId && item.status === 'WAIT_FOLLOW_UP').length
      const waitFeedback = database.appointments.filter((item) => item.assignedMentorId === mentorId && item.status === 'WAIT_FEEDBACK').length
      if (following || waitFeedback) throw new Error(`该导师还有未完成客户，请先重新分配后再注销。待跟进 ${following}，待反馈 ${waitFeedback}`)
      mentor.status = 'INACTIVE'
      mentor.loginEnabled = false
      writeDatabase(database)
      return mentor
    },
    updateCustomerReferrer(actorId, customerId, referrerName) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      assertAdmin(actor)
      const customer = database.customers.find((item) => item.id === customerId)
      if (!customer) throw new Error('客户不存在')
      customer.referrerName = referrerName.trim()
      writeDatabase(database)
      return customer
    },
    getCustomer: (id) => readDatabase().customers.find((item) => item.id === id),
    getStaff: (id) => readDatabase().staff.find((item) => item.id === id),
    getAppointment: (id) => readDatabase().appointments.find((item) => item.id === id),
    getProduct: (id) => readDatabase().products.find((item) => item.id === id),
  }
}

export const repositoryContract = {
  productionAdapter: 'FeishuRepository',
  futureAdapter: 'PostgresRepository',
  rule: 'API / Repository 根据 permissionRole 做数据授权，H5 不直接访问飞书字段。',
}
