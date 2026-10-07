import { config } from './config.mjs'
import { createRecord, listRecords, updateRecord, FeishuUnavailableError } from './feishu.mjs'
import { createProfileDraft } from './deepseek.mjs'
import { queryAssistant } from './assistant.mjs'
import { field as mapField, fields as mapFields, read as readField } from './field-mapping.mjs'
import { parseDateFromFeishu, serializeDateForFeishu } from './date-contract.mjs'
import crypto from 'node:crypto'
import { LoginRateLimiter } from './login-rate-limit.mjs'

const statusMap = { 待分配: 'WAIT_ASSIGN', 已分配: 'WAIT_FOLLOW_UP', 已联系: 'WAIT_FOLLOW_UP', 待联系: 'WAIT_FOLLOW_UP', 待跟进: 'WAIT_FOLLOW_UP', 已接待: 'WAIT_FEEDBACK', 已完成: 'COMPLETED', FOLLOWING: 'WAIT_FOLLOW_UP' }
const text = (value) => Array.isArray(value) ? value.map(text).filter(Boolean).join('、') : typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const boolean = (value) => value === true || value === 'true' || value === '是'
const date = (value) => parseDateFromFeishu(value)
const normalizePhone = (value) => {
  const digits = text(value).replace(/\D/g, '')
  return digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits
}
const validPhone = (value) => /^1\d{10}$/.test(normalizePhone(value))
const now = () => new Date().toISOString()
const stableOperationId = (value, prefix) => `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`
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
const PROFILE_FIELD_KEYS = new Set('gender age birth_year city hometown marital_status education living_status children_summary occupation industry position work_years job_status income_range career_stage career_satisfaction career_problem career_goal entrepreneurship_experience family_summary parents_relationship father_summary mother_summary relationship_with_father relationship_with_mother siblings family_events family_support_level relationship_status partner_summary marriage_years relationship_satisfaction relationship_conflicts communication_pattern conflict_pattern relationship_goal children_detail parent_child_relationship parenting_problem parenting_values hobbies sports reading travel art_preferences social_preference sleep diet routine life_satisfaction self_description personality_traits communication_style decision_style emotion_expression stress_response conflict_style action_style strengths common_blocks core_values family_values career_values money_values relationship_values success_definition happiness_definition freedom_definition growth_attitude current_core_issue secondary_issues current_stressors current_goal current_expectation current_resources support_system current_barriers energy_state recent_major_changes ai_customer_summary'.split(' '))
const IMPORTANT_PROFILE_FIELDS = new Set(['age', 'city', 'occupation', 'marital_status', 'relationship_status', 'current_core_issue', 'current_goal', 'current_expectation', 'mentor_id', 'grade', 'paid', 'intended_course'])

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
  try { profileFieldMeta = JSON.parse(text(get('customers', f, 'profile_field_meta_json')) || '{}') } catch { profileFieldMeta = {} }
  const profileFields = {}
  for (const key of PROFILE_FIELD_KEYS) {
    const value = get('customers', f, key)
    if (value !== '' && value !== null && value !== undefined) profileFields[key] = profileCell(value)
  }
  profileFields.current_core_issue ||= text(get('customers', f, 'current_issue')) || null
  profileFields.current_expectation ||= text(get('customers', f, 'help_expectation')) || null
  profileFields.current_goal ||= text(get('customers', f, 'current_goal')) || null
  profileFields.grade = text(get('customers', f, 'sabc')) || 'C'
  profileFields.paid = boolean(get('customers', f, 'is_paid'))
  profileFields.mentor_id = text(get('customers', f, 'mentor_id')) || null
  return { id: text(get('customers', f, 'customer_id')) || row.record_id, createdAt: date(get('customers', f, 'created_at')) || date(get('customers', f, 'submitted_at')), name, initials: name.slice(0, 1), phone: text(get('customers', f, 'phone')), wechat: text(get('customers', f, 'wechat')), source: text(get('customers', f, 'source')) || '历史数据导入', status: '活跃', grade: text(get('customers', f, 'sabc')) || 'C', gradeSource: '导师确认', mentorId: text(get('customers', f, 'mentor_id')) || null, referrerName: text(get('customers', f, 'referrer_name')), need: text(get('customers', f, 'current_issue')), helpExpectation: text(get('customers', f, 'help_expectation')), goal: text(get('customers', f, 'current_goal')), brief: text(get('customers', f, 'brief')), intendedCourse: text(get('customers', f, 'intended_course')) || null, confirmedFacts: [], aiQuestions: [], paid: boolean(get('customers', f, 'is_paid')), lastActivity: '', nextFollowup: null, lastFollowupAt: null, nextFollowupAt: null, followupStatus: '待跟进', notes: text(get('customers', f, 'notes')), profileFields, profileFieldMeta, profileUpdatedAt: date(get('customers', f, 'profile_updated_at')) || null, profileSchemaVersion: text(get('customers', f, 'profile_schema_version')) || 'v0.5', _recordId: row.record_id }
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
  const status = text(get('enrollments', f, 'status'))
  return { id: text(get('enrollments', f, 'enrollment_id')) || row.record_id, customerId: text(get('enrollments', f, 'customer_id')), productId: text(get('enrollments', f, 'product_id')) || text(get('enrollments', f, 'product_name')), paid: paymentStatus === 'PAID' || boolean(get('enrollments', f, 'paid')), amount: Number.isFinite(rawAmount) ? rawAmount : Number.NaN, date: paidAt || enrolledAt, status: status === 'CANCELLED' ? 'CANCELLED' : status || '学习中', paymentStatus: ['PAID', 'UNPAID', 'UNRECORDED'].includes(paymentStatus) ? paymentStatus : boolean(get('enrollments', f, 'paid')) ? 'PAID' : 'UNRECORDED', enrollmentSource: text(get('enrollments', f, 'enrollment_source')), enrolledAt, paidAt, operatorId: text(get('enrollments', f, 'operator_id')), _recordId: row.record_id }
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
  const source = ['USER_EXPLICIT', 'MENTOR_CONFIRMED', 'MENTOR_OBSERVATION', 'AI_INFERENCE'].includes(text(get('profileChanges', f, 'source'))) ? text(get('profileChanges', f, 'source')) : 'MENTOR_OBSERVATION'
  return { id: text(get('profileChanges', f, 'change_id')) || row.record_id, customerId: text(get('profileChanges', f, 'customer_id')), field: text(get('profileChanges', f, 'field_key')) || text(get('profileChanges', f, 'field')), fieldName: text(get('profileChanges', f, 'field_name')) || text(get('profileChanges', f, 'field_key')) || text(get('profileChanges', f, 'field')), oldValue, newValue, source, confidence: Number(get('profileChanges', f, 'confidence') ?? 0.9), confirmed: boolean(get('profileChanges', f, 'confirmed')), updatedAt: date(get('profileChanges', f, 'changed_at')) || date(get('profileChanges', f, 'updated_at')), operatorId: text(get('profileChanges', f, 'operator_id')) || undefined, serviceRecordId: text(get('profileChanges', f, 'service_record_id')) || undefined, _recordId: row.record_id }
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
  return updates.filter((item) => item && typeof item.field === 'string' && (PROFILE_FIELD_KEYS.has(item.field) || ['grade', 'paid', 'mentor_id', 'intended_course'].includes(item.field))).map((item) => {
    const previousValue = profileRecord?.profileFields?.[item.field] ?? null
    const source = confirmed ? 'MENTOR_CONFIRMED' : item.source === 'AI_INFERENCE' ? 'AI_INFERENCE' : 'MENTOR_OBSERVATION'
    return { field: item.field, value: jsonValue(item.value), previousValue, source, confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.9))), confirmed: confirmed && source === 'MENTOR_CONFIRMED', conflict: previousValue !== null && !sameProfileValue(previousValue, item.value) }
  }).filter((item) => item.value !== null)
}

function profileFieldsForWrite(customerRecord, updates) {
  const values = { profile_field_meta_json: JSON.stringify(customerRecord.profileFieldMeta || {}), profile_schema_version: customerRecord.profileSchemaVersion || 'v0.5', profile_updated_at: customerRecord.profileUpdatedAt || now() }
  for (const update of updates) {
    if (['paid', 'grade', 'mentor_id', 'intended_course'].includes(update.field)) continue
    values[update.field] = Array.isArray(update.value) ? JSON.stringify(update.value) : typeof update.value === 'number' || typeof update.value === 'boolean' ? String(update.value) : update.value ?? ''
  }
  if (customerRecord.need !== undefined) values.current_issue = customerRecord.need
  if (customerRecord.helpExpectation !== undefined) values.help_expectation = customerRecord.helpExpectation
  if (customerRecord.goal !== undefined) values.current_goal = customerRecord.goal
  values.sabc = customerRecord.grade
  values.is_paid = customerRecord.paid
  values.intended_course = customerRecord.intendedCourse || ''
  values.mentor_id = customerRecord.mentorId || ''
  return mapFields('customers', values)
}

function validateManualCustomer(input) {
  const nickname = text(input?.nickname).trim()
  const phone = normalizePhone(input?.phone)
  const wechat = text(input?.wechat).trim()
  if (!nickname) throw new Error('客户昵称不能为空')
  if (phone && !validPhone(phone)) throw new Error('请输入有效手机号')
  if (!phone && !wechat) throw new Error('手机号或微信号至少填写一个')
  return { nickname, phone, wechat, situation: text(input?.situation).trim() }
}

function duplicateMatches(database, input) {
  const { nickname, phone, wechat } = validateManualCustomer(input)
  const normalizedName = nickname.toLowerCase()
  return database.customers.flatMap((item) => {
    const matchedBy = phone && item.phone && normalizePhone(item.phone) === phone ? 'phone' : wechat && item.wechat && item.wechat.trim() === wechat ? 'wechat' : item.name.trim() === nickname ? 'nickname_exact' : item.name.toLowerCase().includes(normalizedName) || normalizedName.includes(item.name.toLowerCase()) ? 'nickname_fuzzy' : null
    return matchedBy ? [{ customer: item, matchedBy }] : []
  })
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

async function mergeEnrollments(database, customerId, drafts, operatorId, operationId) {
  if (!drafts?.length) return
  if (!config.feishu.tables.enrollments) throw new Error('报名记录表尚未配置，暂时不能保存已报名课程')
  validateEnrollmentDrafts(database, drafts)
  const uniqueDrafts = new Map(drafts.map((draft) => [draft.productId, draft]))
  for (const draft of uniqueDrafts.values()) {
    const product = activeProduct(database, draft.productId)
    if (!product) throw new Error('只能选择 ASVA 产品中的有效课程')
    const existing = database.enrollments.find((item) => item.customerId === customerId && item.productId === product.id && item.status !== 'CANCELLED')
    const paymentStatus = draft.paymentStatus || existing?.paymentStatus || 'UNRECORDED'
    const fields = { payment_status: paymentStatus, paid: paymentStatus === 'PAID' }
    if (draft.amount !== undefined && draft.amount !== null) fields.amount = draft.amount
    if (draft.enrolledAt) fields.enrolled_at = draft.enrolledAt
    if (draft.paidAt) fields.paid_at = draft.paidAt
    if (existing?._recordId) {
      await updateRecord(config.feishu.tables.enrollments, existing._recordId, mapFields('enrollments', fields))
      continue
    }
    const enrolledAt = draft.enrolledAt || now()
    await createRecord(config.feishu.tables.enrollments, mapFields('enrollments', { enrollment_id: operationId ? stableOperationId(`${operationId}:${product.id}`, 'ENR') : `E-${Date.now()}-${Math.floor(Math.random() * 1000)}`, customer_id: customerId, product_id: product.id, product_name: product.name, enrollment_source: 'MANUAL', payment_status: paymentStatus, paid: paymentStatus === 'PAID', amount: draft.amount ?? null, enrolled_at: enrolledAt, paid_at: draft.paidAt || null, operator_id: operatorId, created_at: now(), status: 'ACTIVE' }))
  }
}

async function persistCustomerProfile(database, customerId, updates, serviceRecordId, operatorId) {
  const customerRecord = database.customers.find((item) => item.id === customerId)
  const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
  if (!customerRecord || !row) throw new Error('客户不存在')
  customerRecord.profileFields = { ...(customerRecord.profileFields || {}) }
  customerRecord.profileFieldMeta = { ...(customerRecord.profileFieldMeta || {}) }
  const changed = []
  const updatedAt = now()
  const changedAt = feishuDate()
  for (const update of updates) {
    const oldValue = customerRecord.profileFields[update.field] ?? null
    customerRecord.profileFields[update.field] = update.value
    customerRecord.profileFieldMeta[update.field] = { source: update.source, confidence: update.confidence, confirmed: update.confirmed, updatedAt }
    if (update.field === 'current_core_issue' && typeof update.value === 'string') customerRecord.need = update.value
    if (update.field === 'current_expectation' && typeof update.value === 'string') customerRecord.helpExpectation = update.value
    if (update.field === 'current_goal' && typeof update.value === 'string') customerRecord.goal = update.value
    if (update.field === 'intended_course') customerRecord.intendedCourse = typeof update.value === 'string' ? update.value : null
    if (update.field === 'paid' && typeof update.value === 'boolean') customerRecord.paid = update.value
    if (update.field === 'grade' && typeof update.value === 'string') customerRecord.grade = update.value
    if (update.field === 'mentor_id' && typeof update.value === 'string') customerRecord.mentorId = update.value
    if (!sameProfileValue(oldValue, update.value)) changed.push({ ...update, oldValue, updatedAt })
  }
  customerRecord.profileUpdatedAt = updatedAt
  customerRecord.profileSchemaVersion = 'v0.5'
  await updateRecord(config.feishu.tables.customers, row.record_id, profileFieldsForWrite(customerRecord, changed))
  for (const change of changed.filter((item) => IMPORTANT_PROFILE_FIELDS.has(item.field))) {
    await createRecord(config.feishu.tables.profileChanges, mapFields('profileChanges', { customer_id: customerId, field: change.field, field_key: change.field, field_name: mapField('customers', change.field), old_value: JSON.stringify(change.oldValue ?? null), new_value: JSON.stringify(change.value ?? null), source: change.source, confidence: change.confidence, confirmed: change.confirmed, updated_at: changedAt, changed_at: changedAt, operator_id: operatorId || '', service_record_id: serviceRecordId || '' }))
  }
  return customerRecord
}

export class FeishuRepository {
  constructor() { this.queryLogs = []; this.auditLogs = [] }
  audit(operation, targetId, operatorId, result = 'SUCCESS', error = '') {
    const entry = { operation, target_id: targetId || '', operator_id: operatorId || '', result, error_code: error ? 'OPERATION_FAILED' : undefined, timestamp: now() }
    this.auditLogs.unshift(entry)
    if (this.auditLogs.length > 200) this.auditLogs.length = 200
    console.info('[ASVA_AUDIT]', JSON.stringify(entry))
  }
  async load() {
    const entries = [['appointments', config.feishu.tables.appointments], ['customers', config.feishu.tables.customers], ['serviceRecords', config.feishu.tables.serviceRecords], ['staff', config.feishu.tables.staff], ['products', config.feishu.tables.products], ['enrollments', config.feishu.tables.enrollments], ['profileChanges', config.feishu.tables.profileChanges]]
    const rows = await Promise.all(entries.map(([, tableId]) => tableId ? listRecords(tableId) : Promise.resolve([])))
    const [appointmentRows, customerRows, serviceRows, staffRows, productRows, enrollmentRows, profileChangeRows] = rows
    const customers = customerRows.map(customer)
    return {
      staff: staffRows.map(staff), customers, appointments: appointmentRows.map(appointment), sessions: serviceRows.map(service), followups: [], products: productRows.map(product), enrollments: enrollmentRows.map(enrollment), profileChanges: profileChangeRows.map(profileChange),
      _missingRepositories: config.feishu.tables.enrollments ? [] : ['EnrollmentRepository'],
      _rows: { appointments: appointmentRows, customers: customerRows, services: serviceRows, staff: staffRows, products: productRows, enrollments: enrollmentRows, profileChanges: profileChangeRows },
    }
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
  async staff(staffId) {
    const record = (await this.load()).staff.find((item) => item.id === staffId)
    if (!record) throw new Error('账号不存在')
    if (record.status !== 'ACTIVE') throw new Error('该账户已停用，请联系管理员。')
    if (record.permissionRole !== 'ADMIN' || record.loginEnabled !== true) throw new Error('导师端暂未开放，请联系管理员。')
    return record
  }
  async authenticate(phone, code, ip = 'unknown') {
    if (loginRateLimiter.isBlocked(phone, ip)) throw Object.assign(new Error('登录尝试过于频繁，请稍后再试'), { code: 'AUTH_RATE_LIMITED', status: 429 })
    if (config.dataMode === 'production' && !config.adminLoginCode) throw Object.assign(new Error('生产认证未配置'), { code: 'AUTH_NOT_CONFIGURED', status: 503 })
    const controlledProductionCode = config.dataMode === 'production' && config.authMode === 'ADMIN_CODE' && safeEqual(code, config.adminLoginCode)
    const controlledDemoCode = config.dataMode !== 'production' && config.allowDevOtp && safeEqual(code, '888888')
    const database = await this.load()
    const normalized = normalizePhone(phone)
    const account = database.staff.find((item) => normalizePhone(item.phone) === normalized)
    const validStaff = account?.permissionRole === 'ADMIN' && account.status === 'ACTIVE' && account.loginEnabled === true
    if ((!controlledProductionCode && !controlledDemoCode) || !validStaff) {
      loginRateLimiter.recordFailure(phone, ip)
      throw invalidLogin()
    }
    loginRateLimiter.clear(phone, ip)
    return account
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
    const updates = normalized.situation ? (await createProfileDraft({ text: normalized.situation, existing: {} })).updates : []
    return { duplicates: duplicateMatches(database, input), updates }
  }
  async createCustomer(actorId, input) {
    const database = await this.load()
    scope(database, actorId)
    const normalized = validateManualCustomer(input)
    const duplicates = duplicateMatches(database, input)
    if (duplicates.length && !input.confirmedNotSame) throw Object.assign(new Error('检测到可能重复的客户，请先确认是否为同一人'), { status: 409, code: 'CUSTOMER_DUPLICATE', matches: duplicates })
    validateEnrollmentDrafts(database, input.enrollments)
    const operationId = text(input?.operationId).trim()
    if (operationId) {
      const existing = database.customers.find((item) => item.id === stableOperationId(operationId, 'CUS'))
      if (existing) return this.dashboard(actorId)
    }
    const customerId = operationId ? stableOperationId(operationId, 'CUS') : `CUS-${Date.now()}`
    const createdAt = now()
    await createRecord(config.feishu.tables.customers, mapFields('customers', { customer_id: customerId, nickname: normalized.nickname, phone: normalized.phone, wechat: normalized.wechat, source: input.source || '管理员手动录入', notes: normalized.situation, current_issue: '', help_expectation: '', current_goal: '', sabc: 'C', is_paid: false, created_at: createdAt, profile_schema_version: 'v0.5', profile_updated_at: createdAt }))
    let current = await this.load()
    if (input.profileUpdates?.length) {
      await persistCustomerProfile(current, customerId, normalizeProfileUpdates(input.profileUpdates, current.customers.find((item) => item.id === customerId), true), undefined, actorId)
      current = await this.load()
    }
    await mergeEnrollments(current, customerId, input.enrollments, actorId, operationId)
    if (input.needsFollowup) {
      let assignedMentorId = ''
      if (input.mentorId) {
        const mentor = current.staff.find((item) => item.id === input.mentorId && item.permissionRole === 'MENTOR')
        if (!mentor || mentor.status !== 'ACTIVE') throw new Error('只能选择 ACTIVE 导师')
        assignedMentorId = mentor.id
        const customerRow = current._rows.customers.find((row) => text(get('customers', row.fields, 'customer_id')) === customerId)
        if (customerRow) await updateRecord(config.feishu.tables.customers, customerRow.record_id, mapFields('customers', { mentor_id: assignedMentorId }))
      }
      await createRecord(config.feishu.tables.appointments, mapFields('appointments', { appointment_id: `A-${Date.now()}`, customer_id: customerId, current_issue_description: normalized.situation, expectation: current.customers.find((item) => item.id === customerId)?.helpExpectation || '', submitted_at: createdAt, status: 'WAIT_FOLLOW_UP', assigned_mentor_id: assignedMentorId, followup_handled: false, followup_info_completed: false, created_at: createdAt, case_source: input.caseSource || 'ADMIN_MANUAL' }))
    }
    return this.dashboard(actorId)
  }
  async updateCustomer(actorId, customerId, input) {
    const database = await this.load()
    scope(database, actorId)
    const current = database.customers.find((item) => item.id === customerId)
    const row = database._rows.customers.find((item) => text(get('customers', item.fields, 'customer_id')) === customerId)
    if (!current || !row) throw new Error('客户不存在')
    validateEnrollmentDrafts(database, input.enrollments)
    const normalized = validateManualCustomer({ ...input, nickname: input.nickname || current.name, phone: input.phone || current.phone, wechat: input.wechat || current.wechat })
    await updateRecord(config.feishu.tables.customers, row.record_id, mapFields('customers', { nickname: normalized.nickname, phone: normalized.phone, wechat: normalized.wechat, source: input.source || current.source, notes: normalized.situation || current.notes }))
    let latest = await this.load()
    if (input.profileUpdates?.length) await persistCustomerProfile(latest, customerId, normalizeProfileUpdates(input.profileUpdates, latest.customers.find((item) => item.id === customerId), true), undefined, actorId)
    latest = await this.load()
    await mergeEnrollments(latest, customerId, input.enrollments, actorId, text(input?.operationId).trim())
    if (input.needsFollowup && !latest.appointments.some((item) => item.customerId === customerId && item.status !== 'COMPLETED')) {
      let assignedMentorId = ''
      if (input.mentorId) {
        const mentor = latest.staff.find((item) => item.id === input.mentorId && item.permissionRole === 'MENTOR' && item.status === 'ACTIVE')
        if (!mentor) throw new Error('只能选择 ACTIVE 导师')
        assignedMentorId = mentor.id
      }
      await createRecord(config.feishu.tables.appointments, mapFields('appointments', { appointment_id: `A-${Date.now()}`, customer_id: customerId, current_issue_description: normalized.situation, expectation: latest.customers.find((item) => item.id === customerId)?.helpExpectation || '', submitted_at: now(), status: 'WAIT_FOLLOW_UP', assigned_mentor_id: assignedMentorId, followup_handled: false, followup_info_completed: false, created_at: now(), case_source: input.caseSource || 'ADMIN_MANUAL' }))
    }
    return this.dashboard(actorId)
  }
  async confirmProfile(actorId, customerId, updates) {
    const database = await this.load()
    if (!scope(database, actorId).customers.some((item) => item.id === customerId)) throw new Error('无权访问该客户')
    const current = database.customers.find((item) => item.id === customerId)
    if (!current) throw new Error('客户不存在')
    await persistCustomerProfile(database, customerId, normalizeProfileUpdates(updates, current, true), undefined, actorId)
    return (await this.load()).customers.find((item) => item.id === customerId)
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
