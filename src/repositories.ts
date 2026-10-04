import { seedDatabase } from './data'
import type { Appointment, AppointmentWorkflowStatus, Customer, CustomerProfile, Database, FeedbackInput, MentorAccountInput, NewAppointmentInput, Product, ProfileChange, ProfileDraft, ProfileUpdate, Staff } from './domain'
import { emptyProfile, extractLocalProfile, PROFILE_FIELD_KEYS, updateValue } from './profile'

const STORAGE_KEY = 'asva-workbench-demo-db-v8'

function cloneSeed(): Database {
  return structuredClone(seedDatabase)
}

function permissionRole(staff: Staff): 'ADMIN' | 'MENTOR' {
  return staff.permissionRole ?? (staff.role === 'MENTOR' ? 'MENTOR' : 'ADMIN')
}

function normalizePhone(phone: string) { return phone.replace(/\s+/g, '') }
function assertValidPhone(phone: string) { if (!/^1\d{10}$/.test(normalizePhone(phone))) throw new Error('请输入有效手机号') }

function normalize(database: Database): Database {
  const customers = database.customers.map((customer) => ({ ...customer, referrerName: customer.referrerName ?? '', createdAt: customer.createdAt ?? '2026-10-01', notes: customer.notes ?? '', lastFollowupAt: customer.lastFollowupAt ?? null, nextFollowupAt: customer.nextFollowupAt ?? null, followupStatus: customer.followupStatus ?? '待跟进' }))
  const existingProfiles = (database.profiles ?? []).map((profile) => ({ ...profile, fields: profile.fields ?? {}, fieldMeta: profile.fieldMeta ?? {}, updatedAt: profile.updatedAt ?? null, schemaVersion: profile.schemaVersion ?? 'v0.4' }))
  const profiles = customers.map((customer) => existingProfiles.find((profile) => profile.customerId === customer.id) ?? emptyProfile(customer.id))
  return {
    ...database,
    staff: database.staff.map((staff) => { const role = permissionRole(staff); return { ...staff, role, permissionRole: role, status: staff.status ?? 'ACTIVE', displayRole: role === 'ADMIN' ? '管理员' : '导师', title: role === 'ADMIN' ? '管理员' : '导师' } }),
    customers,
    profiles,
    profileChanges: database.profileChanges ?? [],
    appointments: database.appointments.map((appointment) => {
      const statusMap: Record<string, AppointmentWorkflowStatus> = { 待分配: 'WAIT_ASSIGN', 已分配: 'FOLLOWING', 待跟进: 'WAIT_FEEDBACK', 已接待: 'WAIT_FEEDBACK', 已完成: 'COMPLETED' }
      const status = statusMap[appointment.status] ?? appointment.status as AppointmentWorkflowStatus
      return { ...appointment, status, assignedMentorId: appointment.assignedMentorId ?? appointment.mentorId ?? null, followupHandled: appointment.followupHandled ?? ['WAIT_FEEDBACK', 'COMPLETED'].includes(status), followupInfoCompleted: appointment.followupInfoCompleted ?? status === 'COMPLETED', createdAt: appointment.createdAt ?? '2026-10-01', completedAt: appointment.completedAt ?? null }
    }),
  }
}

function readDatabase(): Database {
  const saved = window.localStorage.getItem(STORAGE_KEY)
  return normalize(saved ? JSON.parse(saved) as Database : cloneSeed())
}

function writeDatabase(database: Database) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database))
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
  if (permissionRole(staff) !== 'ADMIN') throw new Error('只有 ADMIN 可以执行这个操作')
}

function assertAppointmentAccess(staff: Staff, appointment: Appointment) {
  if (permissionRole(staff) === 'ADMIN') return
  if (appointment.assignedMentorId !== staff.id) throw new Error('无权访问其他导师的预约')
}

function sameProfileValue(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function normalizedProfileUpdates(updates: ProfileUpdate[] | undefined, profile: CustomerProfile, confirmed = false): ProfileUpdate[] {
  if (!Array.isArray(updates)) return []
  return updates.filter((update) => PROFILE_FIELD_KEYS.includes(update.field as typeof PROFILE_FIELD_KEYS[number])).map((update) => {
    const source = confirmed ? 'MENTOR_CONFIRMED' : update.source === 'AI_INFERENCE' ? 'AI_INFERENCE' : update.source ?? 'MENTOR_OBSERVATION'
    const value = updateValue(update.value)
    const previousValue = profile.fields[update.field] ?? null
    return { ...update, value, previousValue, source, confidence: Math.max(0, Math.min(1, Number(update.confidence ?? 0.9))), confirmed: confirmed && source === 'MENTOR_CONFIRMED', conflict: !sameProfileValue(previousValue, value) && previousValue !== null }
  })
}

function applyProfileUpdates(database: Database, customerId: string, updates: ProfileUpdate[], serviceRecordId?: string): CustomerProfile {
  const profile = database.profiles.find((item) => item.customerId === customerId) ?? emptyProfile(customerId)
  if (!database.profiles.some((item) => item.customerId === customerId)) database.profiles.push(profile)
  const updatedAt = new Date().toISOString()
  for (const update of updates) {
    const oldValue = profile.fields[update.field] ?? null
    const source = update.confirmed ? 'MENTOR_CONFIRMED' : update.source ?? 'MENTOR_OBSERVATION'
    profile.fields[update.field] = update.value
    profile.fieldMeta[update.field] = { source, confidence: update.confidence ?? 0.9, confirmed: update.confirmed === true, updatedAt }
    if (!sameProfileValue(oldValue, update.value)) {
      const change: ProfileChange = { id: 'PC-' + Date.now() + '-' + database.profileChanges.length, customerId, field: update.field, oldValue, newValue: update.value, source, confidence: update.confidence ?? 0.9, confirmed: update.confirmed === true, updatedAt, serviceRecordId }
      database.profileChanges.unshift(change)
    }
  }
  profile.updatedAt = updatedAt
  return profile
}

function scopedDatabase(database: Database, staff: Staff): Database {
  if (permissionRole(staff) === 'ADMIN') return database
  const appointments = database.appointments.filter((item) => item.assignedMentorId === staff.id)
  const customerIds = new Set(appointments.map((item) => item.customerId))
  return {
    ...database,
    staff: database.staff.filter((item) => item.id === staff.id),
    customers: database.customers.filter((item) => customerIds.has(item.id)),
    appointments,
    sessions: database.sessions.filter((item) => customerIds.has(item.customerId)),
    followups: database.followups.filter((item) => customerIds.has(item.customerId)),
    enrollments: database.enrollments.filter((item) => customerIds.has(item.customerId)),
  }
}

export interface AsvaRepository {
  getDatabase(): Database
  getDatabaseForUser(staffId: string): Database
  authenticate(phone: string, code: string): Staff
  createAppointment(input: NewAppointmentInput): Database
  assignAppointment(actorId: string, appointmentId: string, mentorId: string): Database
  markFollowupDone(actorId: string, appointmentId: string): Database
  saveFeedback(actorId: string, feedback: FeedbackInput): Database
  profile(actorId: string, customerId: string): CustomerProfile | undefined
  profileDraft(actorId: string, customerId: string, text: string): ProfileDraft
  confirmProfile(actorId: string, customerId: string, updates: ProfileUpdate[]): CustomerProfile
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
      const account = database.staff.find((item) => normalizePhone(item.phone) === normalized && item.status === 'ACTIVE')
      if (account) return account
      if (database.staff.some((item) => normalizePhone(item.phone) === normalized && item.status === 'INACTIVE')) throw new Error('该账户已停用，请联系管理员。')
      throw new Error('手机号或验证码错误')
    },
    createAppointment(input) {
      const database = readDatabase()
      if (!database.customers.some((item) => item.id === input.customerId)) throw new Error('客户不存在')
      database.appointments.push({ id: `A-${Date.now()}`, ...input, status: 'WAIT_ASSIGN', mentorId: null, assignedMentorId: null, followupHandled: false, followupInfoCompleted: false })
      writeDatabase(database)
      return database
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
      appointment.status = 'FOLLOWING'
      appointment.followupHandled = false
      appointment.followupInfoCompleted = false
      const customer = database.customers.find((item) => item.id === appointment.customerId)
      if (customer) customer.mentorId = mentor.id
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
      if (appointment.status !== 'FOLLOWING') throw new Error('只有跟进中的预约可以完成跟进')
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
      database.sessions.unshift({ id: serviceRecordId, customerId: customer.id, mentorId: appointment.assignedMentorId ?? actor.id, type: '跟进反馈', date: new Date().toISOString().slice(0, 16).replace('T', ' '), duration: 0, topic: feedback.topic, note: feedback.notes || feedback.coreNeed, result: feedback.result, nextStep: '本次预约已完成，后续如有新预约将重新进入流程。', followupDate: null, aiSummary: feedback.aiSummary || 'AI 已根据本次反馈整理本次客户状态与下一步建议。', profileText: feedback.profileText, profileUpdates: feedback.profileUpdates })
      if (feedback.profileUpdates?.length) applyProfileUpdates(database, customer.id, normalizedProfileUpdates(feedback.profileUpdates, database.profiles.find((item) => item.customerId === customer.id) ?? emptyProfile(customer.id), true), serviceRecordId)
      customer.need = feedback.coreNeed || customer.need
      customer.paid = feedback.paid
      customer.grade = feedback.grade
      customer.intendedCourse = feedback.intendedCourse
      customer.notes = feedback.notes
      appointment.followupInfoCompleted = true
      appointment.status = 'COMPLETED'
      appointment.completedAt = new Date().toISOString().slice(0, 10)
      writeDatabase(database)
      return scopedDatabase(database, actor)
    },
    profile(actorId, customerId) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      if (!scopedDatabase(database, actor).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
      return database.profiles.find((item) => item.customerId === customerId)
    },
    profileDraft(actorId, customerId, text) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      if (!scopedDatabase(database, actor).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
      return extractLocalProfile(text, database.profiles.find((item) => item.customerId === customerId) ?? emptyProfile(customerId))
    },
    confirmProfile(actorId, customerId, updates) {
      const database = readDatabase()
      const actor = getStaff(database, actorId)
      assertActive(actor)
      if (!scopedDatabase(database, actor).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
      const profile = database.profiles.find((item) => item.customerId === customerId) ?? emptyProfile(customerId)
      applyProfileUpdates(database, customerId, normalizedProfileUpdates(updates, profile, true))
      writeDatabase(database)
      return database.profiles.find((item) => item.customerId === customerId)!
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
      if (database.staff.some((item) => item.status === 'ACTIVE' && normalizePhone(item.phone) === phone)) throw new Error('该手机号已绑定账户')
      let id = `M${Date.now()}`
      while (database.staff.some((item) => item.id === id)) id = `M${Date.now()}${Math.floor(Math.random() * 10)}`
      const mentor: Staff = { id, name, role: 'MENTOR', permissionRole: 'MENTOR', status: 'ACTIVE', displayRole: '导师', title: '导师', phone, specialty: '', avatar: name.slice(0, 1) }
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
      if (database.staff.some((item) => item.id !== mentorId && item.status === 'ACTIVE' && normalizePhone(item.phone) === phone)) throw new Error('该手机号已绑定账户')
      mentor.name = name
      mentor.phone = phone
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
      const following = database.appointments.filter((item) => item.assignedMentorId === mentorId && item.status === 'FOLLOWING').length
      const waitFeedback = database.appointments.filter((item) => item.assignedMentorId === mentorId && item.status === 'WAIT_FEEDBACK').length
      if (following || waitFeedback) throw new Error(`该导师还有未完成客户，请先重新分配后再注销。跟进中 ${following}，待反馈 ${waitFeedback}`)
      mentor.status = 'INACTIVE'
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
