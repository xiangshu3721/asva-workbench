import { config } from './config.mjs'
import { createRecord, listRecords, updateRecord } from './feishu.mjs'
import { createProfileDraft } from './deepseek.mjs'
import { queryAssistant } from './assistant.mjs'

const statusMap = { 待分配: 'WAIT_ASSIGN', 已分配: 'FOLLOWING', 已联系: 'FOLLOWING', 待联系: 'FOLLOWING', 待跟进: 'WAIT_FEEDBACK', 已接待: 'WAIT_FEEDBACK', 已完成: 'COMPLETED' }
const text = (value) => Array.isArray(value) ? value.map(text).filter(Boolean).join('、') : typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const boolean = (value) => value === true || value === 'true' || value === '是'
const date = (value) => typeof value === 'number' ? new Date(value).toISOString() : text(value)
const normalizePhone = (value) => text(value).replace(/\s+/g, '')
const validPhone = (value) => /^1\d{10}$/.test(normalizePhone(value))
const now = () => new Date().toISOString()

function appointment(row) {
  const f = row.fields || {}
  const status = statusMap[text(f.status)] || text(f.status) || statusMap[text(f['处理状态'])] || 'WAIT_ASSIGN'
  return { id: text(f['预约编号']) || row.record_id, customerId: text(f.customer_id), topic: text(f['希望获得什么帮助']) || '首次沟通', submittedAt: date(f['提交时间']), description: text(f['当前困扰描述']), expectation: text(f['希望获得什么帮助']), status, mentorId: text(f.assigned_mentor_id) || null, assignedMentorId: text(f.assigned_mentor_id) || null, followupHandled: boolean(f.followup_handled), followupInfoCompleted: boolean(f.followup_info_completed), createdAt: date(f.created_at) || date(f['提交时间']), completedAt: date(f.completed_at) || null, source: text(f.source) || '解忧小屋', _recordId: row.record_id }
}

function customer(row) {
  const f = row.fields || {}
  const name = text(f['昵称']) || '未命名客户'
  return { id: text(f.customer_id) || row.record_id, createdAt: date(f.created_at), name, initials: name.slice(0, 1), phone: text(f['联系电话']), status: '活跃', grade: text(f.SABC) || 'C', gradeSource: '导师确认', mentorId: text(f['当前导师ID']) || null, referrerName: text(f.referrer_name), need: text(f['当前困扰']), helpExpectation: text(f['希望获得帮助']), goal: '', brief: text(f['AI接待前Brief']), intendedCourse: text(f['意向课程']) || null, confirmedFacts: [], aiQuestions: [], paid: boolean(f['是否付费']), lastActivity: '', nextFollowup: null, lastFollowupAt: null, nextFollowupAt: null, followupStatus: '待跟进', notes: text(f['备注']), _recordId: row.record_id }
}

function staff(row) {
  const f = row.fields || {}
  const permissionRole = text(f.role) === 'MENTOR' || text(f.permission_role) === 'MENTOR' ? 'MENTOR' : 'ADMIN'
  const status = text(f.status) === 'INACTIVE' || text(f['状态']) === '停用' ? 'INACTIVE' : 'ACTIVE'
  const name = text(f.nickname) || text(f['姓名']) || '未命名人员'
  const phone = normalizePhone(f.phone || f['手机号'])
  const rawLoginEnabled = f.login_enabled ?? f['允许登录']
  const loginEnabled = permissionRole === 'ADMIN' ? rawLoginEnabled === '' || rawLoginEnabled === undefined || rawLoginEnabled === null ? true : boolean(rawLoginEnabled) : false
  return { id: text(f.staff_id) || row.record_id, name, role: permissionRole, permissionRole, status, loginEnabled, displayRole: permissionRole === 'MENTOR' ? '导师' : '管理员', title: permissionRole === 'MENTOR' ? '导师' : '管理员', phone, specialty: text(f['专业方向']), avatar: name.slice(0, 1), _recordId: row.record_id }
}

function product(row) {
  const f = row.fields || {}
  return { id: text(f.product_id) || row.record_id, name: text(f['课程名称']), system: '', audience: '', cycle: '', format: '', status: text(f['状态']) === '停用' ? '筹备中' : '在售', summary: text(f['描述']), fit: [], _recordId: row.record_id }
}

function service(row) {
  const f = row.fields || {}
  let profileUpdates = []
  try { profileUpdates = JSON.parse(text(f.profile_updates_json) || '[]') } catch { profileUpdates = [] }
  return { id: text(f.service_record_id) || row.record_id, customerId: text(f.customer_id), mentorId: text(f.mentor_id), operatorId: text(f.operator_id), type: '跟进反馈', date: date(f.created_at), duration: 0, topic: text(f['本次主要聊了什么']), note: text(f['备注']) || text(f['当前核心需求']), result: text(f['本次结果']), nextStep: text(f['AI下一步建议']), followupDate: null, aiSummary: text(f['AI本次总结']), profileText: text(f.profile_text), profileUpdates, _recordId: row.record_id }
}

function jsonValue(value) {
  if (value === null || value === undefined || value === '') return null
  if (Array.isArray(value) || typeof value === 'object') return value
  return value
}

function profile(row) {
  const f = row.fields || {}
  let fields = {}
  let fieldMeta = {}
  try { fields = JSON.parse(text(f.profile_json) || '{}') } catch { fields = {} }
  try { fieldMeta = JSON.parse(text(f.field_meta_json) || '{}') } catch { fieldMeta = {} }
  for (const [key, value] of Object.entries(f)) {
    if (!['customer_id', 'profile_json', 'field_meta_json', 'schema_version', 'updated_at'].includes(key) && !(key in fields) && value !== '' && value !== null && value !== undefined) fields[key] = jsonValue(value)
  }
  return { id: row.record_id, customerId: text(f.customer_id), fields, fieldMeta, updatedAt: date(f.updated_at) || null, schemaVersion: text(f.schema_version) || 'v0.4', _recordId: row.record_id }
}

function profileChange(row) {
  const f = row.fields || {}
  let oldValue = null
  let newValue = null
  try { oldValue = JSON.parse(text(f.old_value) || 'null') } catch { oldValue = text(f.old_value) || null }
  try { newValue = JSON.parse(text(f.new_value) || 'null') } catch { newValue = text(f.new_value) || null }
  const source = ['USER_EXPLICIT', 'MENTOR_CONFIRMED', 'MENTOR_OBSERVATION', 'AI_INFERENCE'].includes(text(f.source)) ? text(f.source) : 'MENTOR_OBSERVATION'
  return { id: text(f.change_id) || row.record_id, customerId: text(f.customer_id), field: text(f.field), oldValue, newValue, source, confidence: Number(f.confidence ?? 0.9), confirmed: boolean(f.confirmed), updatedAt: date(f.updated_at), serviceRecordId: text(f.service_record_id) || undefined, _recordId: row.record_id }
}

function scope(database, actorId) {
  const actor = database.staff.find((item) => item.id === actorId)
  if (!actor) throw new Error('账号不存在')
  if (actor.status !== 'ACTIVE') throw new Error('该账户已停用，请联系管理员。')
  if (actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
  return database
}

function sameProfileValue(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) }
function normalizeProfileUpdates(updates, profileRecord, confirmed = false) {
  if (!Array.isArray(updates)) return []
  return updates.filter((item) => item && typeof item.field === 'string' && item.field.length > 0).map((item) => {
    const previousValue = profileRecord?.fields?.[item.field] ?? null
    const source = confirmed ? 'MENTOR_CONFIRMED' : item.source === 'AI_INFERENCE' ? 'AI_INFERENCE' : 'MENTOR_OBSERVATION'
    return { field: item.field, value: jsonValue(item.value), previousValue, source, confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.9))), confirmed: confirmed && source === 'MENTOR_CONFIRMED', conflict: previousValue !== null && !sameProfileValue(previousValue, item.value) }
  }).filter((item) => item.value !== null)
}

function profileFieldsForWrite(profileRecord) {
  const fields = { customer_id: profileRecord.customerId, profile_json: JSON.stringify(profileRecord.fields), field_meta_json: JSON.stringify(profileRecord.fieldMeta), schema_version: profileRecord.schemaVersion || 'v0.4', updated_at: profileRecord.updatedAt || now() }
  for (const [key, value] of Object.entries(profileRecord.fields)) fields[key] = Array.isArray(value) ? JSON.stringify(value) : value ?? ''
  return fields
}

async function persistProfile(database, customerId, updates, serviceRecordId) {
  const current = database.profiles.find((item) => item.customerId === customerId) || { id: `profile-${customerId}`, customerId, fields: {}, fieldMeta: {}, updatedAt: null, schemaVersion: 'v0.4' }
  const profileRecord = { ...current, fields: { ...current.fields }, fieldMeta: { ...current.fieldMeta } }
  const changed = []
  const updatedAt = now()
  for (const update of updates) {
    const oldValue = profileRecord.fields[update.field] ?? null
    profileRecord.fields[update.field] = update.value
    profileRecord.fieldMeta[update.field] = { source: update.source, confidence: update.confidence, confirmed: update.confirmed, updatedAt }
    if (!sameProfileValue(oldValue, update.value)) changed.push({ ...update, oldValue, updatedAt })
  }
  profileRecord.updatedAt = updatedAt
  const row = database._rows.profiles.find((item) => text(item.fields?.customer_id) === customerId)
  if (row) await updateRecord(config.feishu.tables.profiles, row.record_id, profileFieldsForWrite(profileRecord))
  else await createRecord(config.feishu.tables.profiles, profileFieldsForWrite(profileRecord))
  for (const change of changed) {
    await createRecord(config.feishu.tables.profileChanges, { change_id: `PC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, customer_id: customerId, field: change.field, old_value: JSON.stringify(change.oldValue ?? null), new_value: JSON.stringify(change.value ?? null), source: change.source, confidence: change.confidence, confirmed: change.confirmed, updated_at: updatedAt, service_record_id: serviceRecordId || '' })
  }
  return profileRecord
}

export class FeishuRepository {
  async load() {
    const [appointmentRows, customerRows, serviceRows, staffRows, productRows, profileRows, profileChangeRows] = await Promise.all(Object.values(config.feishu.tables).map(listRecords))
    const customers = customerRows.map(customer)
    return {
      staff: staffRows.map(staff), customers, appointments: appointmentRows.map(appointment), sessions: serviceRows.map(service), followups: [], products: productRows.map(product), enrollments: [], profiles: profileRows.map(profile), profileChanges: profileChangeRows.map(profileChange),
      _rows: { appointments: appointmentRows, customers: customerRows, services: serviceRows, staff: staffRows, products: productRows, profiles: profileRows, profileChanges: profileChangeRows },
    }
  }

  async dashboard(staffId) { return scope(await this.load(), staffId) }
  async assistantQuery(actorId, question, context) {
    const database = await this.load()
    scope(database, actorId)
    return queryAssistant(database, question, context)
  }
  async staff(staffId) {
    const record = (await this.load()).staff.find((item) => item.id === staffId)
    if (!record) throw new Error('账号不存在')
    if (record.status !== 'ACTIVE') throw new Error('该账户已停用，请联系管理员。')
    if (record.permissionRole !== 'ADMIN' || record.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
    return record
  }
  async authenticate(phone, code) {
    if (code !== '888888') throw new Error('手机号或验证码错误')
    const database = await this.load()
    const normalized = normalizePhone(phone)
    const account = database.staff.find((item) => normalizePhone(item.phone) === normalized)
    if (account?.status === 'INACTIVE') throw new Error('该账户已停用，请联系管理员。')
    if (account?.permissionRole === 'MENTOR') throw new Error('导师端暂未开放，请联系管理员。')
    if (account?.status === 'ACTIVE' && account.loginEnabled === true) return account
    throw new Error('手机号或验证码错误')
  }
  async customer(actorId, customerId) { return (await this.dashboard(actorId)).customers.find((item) => item.id === customerId) }
  async profile(actorId, customerId) { return (await this.dashboard(actorId)).profiles.find((item) => item.customerId === customerId) }
  async profileDraft(actorId, customerId, textInput) {
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const current = database.profiles.find((item) => item.customerId === customerId) || { customerId, fields: {}, fieldMeta: {}, schemaVersion: 'v0.4' }
    return createProfileDraft({ text: textInput, existing: current.fields })
  }
  async confirmProfile(actorId, customerId, updates) {
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const current = database.profiles.find((item) => item.customerId === customerId) || { customerId, fields: {}, fieldMeta: {}, schemaVersion: 'v0.4' }
    await persistProfile(database, customerId, normalizeProfileUpdates(updates, current, true))
    return (await this.load()).profiles.find((item) => item.customerId === customerId)
  }
  async saveBrief(actorId, customerId, brief) {
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const row = database._rows.customers.find((item) => text(item.fields?.customer_id) === customerId)
    if (!row) throw new Error('客户不存在')
    await updateRecord(config.feishu.tables.customers, row.record_id, { 'AI接待前Brief': brief })
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
    if (database.staff.some((item) => item.status === 'ACTIVE' && normalizePhone(item.phone) === phone)) throw Object.assign(new Error('该手机号已绑定账户'), { status: 409 })
    const createdAt = now()
    const staffId = `M${Date.now()}`
    await createRecord(config.feishu.tables.staff, { staff_id: staffId, nickname: name, phone, role: 'MENTOR', status: 'ACTIVE', login_enabled: false, created_at: createdAt, updated_at: createdAt, deactivated_at: null, '姓名': name, '手机号': phone, permission_role: 'MENTOR', '状态': '在职', display_role: '导师', mentor_id: staffId, '专业方向': '' })
    return (await this.load()).staff.find((item) => item.id === staffId)
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
    if (database.staff.some((item) => item.id !== mentorId && item.status === 'ACTIVE' && normalizePhone(item.phone) === phone)) throw Object.assign(new Error('该手机号已绑定账户'), { status: 409 })
    await updateRecord(config.feishu.tables.staff, row.record_id, { nickname: name, phone, role: 'MENTOR', status: 'ACTIVE', login_enabled: false, updated_at: now(), '姓名': name, '手机号': phone, permission_role: 'MENTOR', '状态': '在职', display_role: '导师' })
    return (await this.load()).staff.find((item) => item.id === mentorId)
  }

  async deactivateMentor(actorId, mentorId) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以管理导师账户')
    const mentor = database.staff.find((item) => item.id === mentorId && item.permissionRole === 'MENTOR')
    const row = database._rows.staff.find((item) => item.record_id === mentor?._recordId)
    if (!mentor || !row) throw new Error('导师不存在')
    if (mentor.status !== 'ACTIVE') throw new Error('导师账户已注销')
    const following = database.appointments.filter((item) => item.assignedMentorId === mentorId && item.status === 'FOLLOWING').length
    const waitFeedback = database.appointments.filter((item) => item.assignedMentorId === mentorId && item.status === 'WAIT_FEEDBACK').length
    if (following || waitFeedback) throw new Error(`该导师还有未完成客户，请先重新分配后再注销。跟进中 ${following}，待反馈 ${waitFeedback}`)
    const deactivatedAt = now()
    await updateRecord(config.feishu.tables.staff, row.record_id, { status: 'INACTIVE', login_enabled: false, '状态': '停用', updated_at: deactivatedAt, deactivated_at: deactivatedAt })
    return (await this.load()).staff.find((item) => item.id === mentorId)
  }

  async updateCustomerReferrer(actorId, customerId, referrerName) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以修改介绍人')
    const row = database._rows.customers.find((item) => text(item.fields?.customer_id) === customerId)
    if (!row) throw new Error('客户不存在')
    const value = typeof referrerName === 'string' ? referrerName.trim() : ''
    await updateRecord(config.feishu.tables.customers, row.record_id, { referrer_name: value })
    return (await this.dashboard(actorId)).customers.find((item) => item.id === customerId)
  }

  async assignAppointment(actorId, appointmentId, mentorId) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('只有 ADMIN 可以分配导师')
    const appointment = database.appointments.find((item) => item.id === appointmentId)
    const mentor = database.staff.find((item) => item.id === mentorId && item.permissionRole === 'MENTOR' && item.status === 'ACTIVE')
    if (!appointment || !mentor) throw new Error('预约或导师不存在')
    await updateRecord(config.feishu.tables.appointments, appointment._recordId, { assigned_mentor_id: mentorId, status: 'FOLLOWING', followup_handled: false, followup_info_completed: false, '分配导师': mentor.name })
    const customerRow = database._rows.customers.find((row) => text(row.fields?.customer_id) === appointment.customerId)
    if (customerRow) await updateRecord(config.feishu.tables.customers, customerRow.record_id, { '当前导师ID': mentorId })
    return scope(await this.load(), actorId)
  }

  async markFollowupDone(actorId, appointmentId) {
    const database = await this.load()
    const actor = database.staff.find((item) => item.id === actorId)
    const appointment = database.appointments.find((item) => item.id === appointmentId)
    if (!actor || actor.status !== 'ACTIVE' || actor.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
    if (!appointment) throw new Error('预约不存在')
    if (appointment.status !== 'FOLLOWING') throw new Error('只有跟进中的预约可以完成跟进')
    await updateRecord(config.feishu.tables.appointments, appointment._recordId, { followup_handled: true, status: 'WAIT_FEEDBACK' })
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
    const serviceRecordId = `SR-${appointment.id}-${Date.now()}`
    const profileUpdates = normalizeProfileUpdates(input.profileUpdates, database.profiles.find((item) => item.customerId === appointment.customerId), Boolean(input.profileUpdates?.length))
    await createRecord(config.feishu.tables.serviceRecords, { service_record_id: serviceRecordId, customer_id: appointment.customerId, appointment_id: appointment.id, mentor_id: appointment.assignedMentorId || actorId, operator_id: actorId, '本次主要聊了什么': input.topic, '本次结果': input.result, '当前核心需求': input.coreNeed, '是否付费': input.paid, SABC: input.grade, '意向课程': input.intendedCourse || '', '备注': input.notes, profile_text: input.profileText || '', profile_updates_json: JSON.stringify(profileUpdates), profile_update_confirmed: profileUpdates.length > 0, 'AI本次总结': input.aiSummary || '', 'AI当前客户状态': input.aiStatus || '', 'AI下一步建议': input.aiNextStep || '', '导师已确认': true, created_at: now })
    if (profileUpdates.length) await persistProfile(database, appointment.customerId, profileUpdates, serviceRecordId)
    await updateRecord(config.feishu.tables.appointments, appointment._recordId, { followup_info_completed: true, status: 'COMPLETED', completed_at: now })
    const customerRow = database._rows.customers.find((row) => text(row.fields?.customer_id) === appointment.customerId)
    if (customerRow) await updateRecord(config.feishu.tables.customers, customerRow.record_id, { '当前困扰': input.coreNeed, '是否付费': input.paid, SABC: input.grade, '意向课程': input.intendedCourse || '', '备注': input.notes })
    return scope(await this.load(), actorId)
  }

  async createAppointment(input) {
    await createRecord(config.feishu.tables.appointments, { '预约编号': input.requestId || `A-${Date.now()}`, customer_id: input.customerId, '当前困扰描述': input.description, '希望获得什么帮助': input.expectation, '提交时间': input.submittedAt || new Date().toISOString(), status: 'WAIT_ASSIGN', assigned_mentor_id: '', followup_handled: false, followup_info_completed: false, created_at: input.createdAt || new Date().toISOString(), source: input.source || '解忧小屋' })
    return this.load()
  }

  async teamSnapshot(actorId) {
    const database = await this.dashboard(actorId)
    const actor = database.staff.find((item) => item.id === actorId)
    if (actor?.permissionRole !== 'ADMIN' || actor.loginEnabled !== true) throw new Error('无权查看团队数据')
    const all = await this.load()
    return all.staff.filter((item) => item.permissionRole === 'MENTOR').map((mentor) => ({ mentor, customerCount: all.customers.filter((item) => item.mentorId === mentor.id).length, following: all.appointments.filter((item) => item.assignedMentorId === mentor.id && item.status === 'FOLLOWING').length, waitFeedback: all.appointments.filter((item) => item.assignedMentorId === mentor.id && item.status === 'WAIT_FEEDBACK').length, completed: all.appointments.filter((item) => item.assignedMentorId === mentor.id && item.status === 'COMPLETED').length }))
  }

  async dashboardSnapshot(actorId) {
    const database = await this.dashboard(actorId)
    if (database.staff.find((item) => item.id === actorId)?.permissionRole !== 'ADMIN' || database.staff.find((item) => item.id === actorId)?.loginEnabled !== true) throw new Error('无权查看数据看板')
    const all = await this.load()
    const appointments = all.appointments
    const statusCounts = Object.fromEntries(['WAIT_ASSIGN', 'FOLLOWING', 'WAIT_FEEDBACK', 'COMPLETED'].map((status) => [status, appointments.filter((item) => item.status === status).length]))
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
