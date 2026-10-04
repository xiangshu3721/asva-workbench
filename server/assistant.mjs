const fillerPattern = /帮我|请|查一下|查查|查询|查找|查一个|客户信息|客户资料|这个客户|的情况|是谁|叫|老师|女士|先生/g

function normalize(value) { return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\u3000]/g, '') }
function editDistance(a, b) { const row = Array.from({ length: b.length + 1 }, (_, index) => index); for (let i = 1; i <= a.length; i += 1) { let diagonal = row[0]; row[0] = i; for (let j = 1; j <= b.length; j += 1) { const previous = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = previous } } return row[b.length] }
function dateOnly(value) { return String(value ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '' }
function iso(date) { return date.toISOString().slice(0, 10) }
function addDays(date, amount) { const result = new Date(date); result.setUTCDate(result.getUTCDate() + amount); return result }
function monthEnd(year, month) { return new Date(Date.UTC(year, month + 1, 0)) }
function previousDate(value) { const parsed = new Date(value || Date.now()); return Number.isNaN(parsed.getTime()) ? new Date() : parsed }
function money(value) { return `¥${Number(value).toLocaleString('zh-CN')}` }
function inRange(value, range) { const date = dateOnly(value); return !range || Boolean(date && date >= range.start && date <= range.end) }
function mentorName(database, mentorId) { return database.staff.find((staff) => staff.id === mentorId)?.name || '待分配' }
function aliases(product) { return [product.name, ...(product.aliases || [])].filter(Boolean) }
function listQuestion(question) { return /哪些|名单|列出|列表|具体客户|谁/.test(question) }

export const DateRangeResolver = {
  resolve(question, nowInput) {
    const now = previousDate(nowInput)
    const year = now.getUTCFullYear(); const month = now.getUTCMonth()
    if (/上个月|上月/.test(question)) return { start: iso(new Date(Date.UTC(year, month - 1, 1))), end: iso(monthEnd(year, month - 1)), label: '上个月' }
    if (/去年/.test(question)) return { start: `${year - 1}-01-01`, end: `${year - 1}-12-31`, label: '去年' }
    if (/今年/.test(question)) return { start: `${year}-01-01`, end: `${year}-12-31`, label: '今年' }
    if (/上周/.test(question)) { const offset = now.getUTCDay() === 0 ? -6 : 1 - now.getUTCDay(); const monday = addDays(new Date(Date.UTC(year, month, now.getUTCDate())), offset); return { start: iso(addDays(monday, -7)), end: iso(addDays(monday, -1)), label: '上周' } }
    if (/本周/.test(question)) { const offset = now.getUTCDay() === 0 ? -6 : 1 - now.getUTCDay(); return { start: iso(addDays(now, offset)), end: iso(now), label: '本周' } }
    if (/本月/.test(question)) return { start: `${year}-${String(month + 1).padStart(2, '0')}-01`, end: iso(now), label: '本月' }
    const days = question.match(/最近\s*(\d+)\s*天/); if (days) { const count = Math.max(1, Number(days[1])); return { start: iso(addDays(now, -(count - 1))), end: iso(now), label: `最近${count}天` } }
    const months = question.match(/最近\s*(\d+)\s*个月/); if (months) { const count = Math.max(1, Number(months[1])); return { start: iso(new Date(Date.UTC(year, month - count + 1, 1))), end: iso(now), label: `最近${count}个月` } }
    if (/今天/.test(question)) return { start: iso(now), end: iso(now), label: '今天' }
    if (/昨天/.test(question)) { const yesterday = addDays(now, -1); return { start: iso(yesterday), end: iso(yesterday), label: '昨天' }
    }
    return null
  },
}

export const EntityResolver = {
  customers(database, question) {
    const full = normalize(question); const cleaned = normalize(question.replace(fillerPattern, ''))
    const scored = database.customers.map((customer) => { const keys = [customer.name, customer.phone, ...(customer.aliases || [])].map(normalize).filter((key) => key.length >= 2); const exact = keys.some((key) => full.includes(key)); const partial = keys.some((key) => cleaned && (cleaned.includes(key) || key.includes(cleaned))); const fuzzy = keys.some((key) => cleaned.length === key.length && cleaned.length >= 2 && editDistance(cleaned, key) <= 1); return { customer, score: exact ? 3 : partial ? 2 : fuzzy ? 1 : 0 } }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
    return scored.filter((item) => item.score === scored[0]?.score).map((item) => item.customer)
  },
  product(database, question) { const full = normalize(question); return database.products.find((product) => aliases(product).some((alias) => full.includes(normalize(alias)))) },
  mentor(database, question) { const full = normalize(question); return database.staff.find((staff) => staff.permissionRole === 'MENTOR' && full.includes(normalize(staff.name))) },
}

export const QueryPlanner = {
  plan(database, question, context = {}) {
    const previous = context.lastQuery; const followup = /把(他们|这些|上面这些)列出来|列出来|详细看看/.test(question) && previous?.queryType === 'ENROLLMENT_QUERY'; const timeRange = DateRangeResolver.resolve(question, context.now) || previous?.timeRange || null; const customers = EntityResolver.customers(database, question); const product = EntityResolver.product(database, question); const mentor = EntityResolver.mentor(database, question); const customer = customers.length === 1 ? customers[0] : undefined
    const base = { entity: customer ? { type: 'CUSTOMER', name: customer.name, id: customer.id } : product ? { type: 'PRODUCT', name: product.name, id: product.id } : { type: 'NONE' }, filters: {}, metrics: [], time_range: timeRange, joins: [], result_mode: 'SUMMARY' }
    if (followup) return { ...base, query_type: 'ENROLLMENT_QUERY', entity: product ? { type: 'PRODUCT', name: product.name, id: product.id } : { type: 'PRODUCT', name: previous?.productName }, filters: { productName: product?.name || previous?.productName, paid: true }, metrics: ['paid_customer_count'], joins: ['CustomerRepository', 'EnrollmentRepository', 'ProductRepository'], result_mode: 'LIST' }
    if (customer && /买过|购买|报名过|课程/.test(question)) return { ...base, query_type: 'CUSTOMER_PURCHASES', entity: { type: 'CUSTOMER', name: customer.name, id: customer.id }, filters: { customerId: customer.id, paid: true }, metrics: ['purchased_products'], joins: ['CustomerRepository', 'EnrollmentRepository', 'ProductRepository'], result_mode: 'LIST' }
    if (/营收|收入|成交金额|销售额/.test(question)) return { ...base, query_type: 'REVENUE_SUMMARY', entity: product ? { type: 'PRODUCT', name: product.name, id: product.id } : { type: 'NONE' }, filters: { productName: product?.name, paid: true }, metrics: ['revenue', 'paid_customer_count', 'deal_count'], joins: ['EnrollmentRepository', 'ProductRepository', 'CustomerRepository'], result_mode: 'SUMMARY' }
    if (/报名|报了名|课程/.test(question) && (product || /多少人|哪些客户|列出|报名/.test(question))) return { ...base, query_type: 'ENROLLMENT_QUERY', entity: product ? { type: 'PRODUCT', name: product.name, id: product.id } : { type: 'NONE' }, filters: { productName: product?.name, paid: true }, metrics: ['paid_customer_count'], joins: ['CustomerRepository', 'EnrollmentRepository', 'ProductRepository'], result_mode: listQuestion(question) ? 'LIST' : 'SUMMARY' }
    if (/哪个导师|导师.*最多|导师.*客户|负责多少客户|导师查询|现在负责/.test(question)) return { ...base, query_type: 'MENTOR_SUMMARY', entity: mentor ? { type: 'MENTOR', name: mentor.name, id: mentor.id } : { type: 'MENTOR' }, filters: { mentorId: mentor?.id }, metrics: ['customer_count'], joins: ['StaffRepository', 'CustomerRepository'], result_mode: 'LIST' }
    if (/待分配|跟进中|待反馈|已完成|预约状态|预约处理|有多少预约/.test(question)) return { ...base, query_type: 'STATUS_SUMMARY', metrics: ['appointment_count', 'status_counts'], joins: ['AppointmentRepository'], result_mode: 'SUMMARY' }
    const summary = /客户数据|客户情况|客户经营|新增客户|新增了多少客户|客户概况|新客户/.test(question) && Boolean(timeRange || /多少|数据|情况|概况/.test(question))
    if (summary && listQuestion(question) && !/多少|数量/.test(question)) return { ...base, query_type: 'CUSTOMER_LIST', filters: { createdInRange: true }, metrics: ['new_customer_count'], joins: ['CustomerRepository'], result_mode: 'LIST' }
    if (summary) return { ...base, query_type: 'CUSTOMER_SUMMARY', filters: { createdInRange: true }, metrics: ['new_customer_count', 'appointment_count', 'completed_count', 'paid_customer_count', 'revenue', 'status_counts'], joins: ['CustomerRepository', 'AppointmentRepository', 'EnrollmentRepository', 'ProductRepository'], result_mode: 'SUMMARY' }
    if (customer || context.customerId || /客户|查一下|查查|这个人|她|他/.test(question)) { const contextual = context.customerId ? database.customers.find((item) => item.id === context.customerId) : undefined; return { ...base, query_type: 'CUSTOMER_DETAIL', entity: customer ? { type: 'CUSTOMER', name: customer.name, id: customer.id } : contextual ? { type: 'CUSTOMER', name: contextual.name, id: contextual.id } : { type: 'CUSTOMER' }, filters: { customerId: customer?.id || contextual?.id }, metrics: ['customer_detail'], joins: ['CustomerRepository', 'CustomerProfileRepository', 'AppointmentRepository', 'ServiceRecordRepository', 'EnrollmentRepository', 'ProductRepository', 'StaffRepository'], result_mode: 'SINGLE_ENTITY' } }
    return { ...base, query_type: 'UNSUPPORTED', result_mode: 'SUMMARY' }
  },
}

function record(database, enrollment) { const customer = database.customers.find((item) => item.id === enrollment.customerId); const product = database.products.find((item) => item.id === enrollment.productId); return { id: enrollment.id, customerId: enrollment.customerId, name: customer?.name || '未命名客户', mentor: mentorName(database, customer?.mentorId), date: enrollment.date, amount: enrollment.amount, detail: `${product?.name || '课程'} · ${enrollment.status}` } }
function customerRecord(database, customer, fields) { return { id: customer.id, customerId: customer.id, name: customer.name, mentor: mentorName(database, customer.mentorId), detail: `${customer.need || '暂无当前困扰'} · ${customer.paid ? '已付费' : '暂未付费'}`, fields } }
function execute(database, plan, resolved) {
  const productId = resolved.product?.id || database.products.find((item) => item.name === plan.filters.productName)?.id; const customerId = plan.filters.customerId; const enrollments = database.enrollments.filter((item) => item.paid && (!productId || item.productId === productId) && (!customerId || item.customerId === customerId) && inRange(item.date, plan.time_range)); const customers = database.customers.filter((item) => (!plan.time_range || inRange(item.createdAt, plan.time_range)) && (!customerId || item.id === customerId)); const repos = plan.joins
  if (plan.query_type === 'CUSTOMER_DETAIL') { const customer = database.customers.find((item) => item.id === customerId); const appointments = database.appointments.filter((item) => item.customerId === customerId).sort((a, b) => dateOnly(b.createdAt).localeCompare(dateOnly(a.createdAt))); const sessions = database.sessions.filter((item) => item.customerId === customerId).sort((a, b) => dateOnly(b.date).localeCompare(dateOnly(a.date))); const customerEnrollments = database.enrollments.filter((item) => item.customerId === customerId && item.paid); return { rows: customer ? [customer] : [], repos, customer, profile: database.profiles.find((item) => item.customerId === customerId), appointments, sessions, enrollments: customerEnrollments } }
  if (plan.query_type === 'CUSTOMER_PURCHASES' || plan.query_type === 'ENROLLMENT_QUERY') return { rows: enrollments, repos, enrollments }
  if (plan.query_type === 'CUSTOMER_LIST') return { rows: customers, repos }
  if (plan.query_type === 'CUSTOMER_SUMMARY') { const completed = database.appointments.filter((item) => inRange(item.completedAt || item.createdAt, plan.time_range) && item.status === 'COMPLETED'); return { rows: customers, repos, aggregates: { new_customer_count: customers.length, appointment_count: database.appointments.filter((item) => inRange(item.createdAt, plan.time_range)).length, completed_count: completed.length, paid_customer_count: new Set(enrollments.map((item) => item.customerId)).size, revenue: enrollments.reduce((sum, item) => sum + Number(item.amount || 0), 0), wait_assign: database.appointments.filter((item) => item.status === 'WAIT_ASSIGN').length, following: database.appointments.filter((item) => item.status === 'FOLLOWING').length, wait_feedback: database.appointments.filter((item) => item.status === 'WAIT_FEEDBACK').length } } }
  if (plan.query_type === 'REVENUE_SUMMARY') return { rows: enrollments, repos, enrollments, aggregates: { revenue: enrollments.reduce((sum, item) => sum + Number(item.amount || 0), 0), paid_customer_count: new Set(enrollments.map((item) => item.customerId)).size, deal_count: enrollments.length } }
  if (plan.query_type === 'STATUS_SUMMARY') { const appointments = database.appointments; return { rows: appointments, repos, aggregates: { appointment_count: appointments.length, wait_assign: appointments.filter((item) => item.status === 'WAIT_ASSIGN').length, following: appointments.filter((item) => item.status === 'FOLLOWING').length, wait_feedback: appointments.filter((item) => item.status === 'WAIT_FEEDBACK').length, completed: appointments.filter((item) => item.status === 'COMPLETED').length } } }
  if (plan.query_type === 'MENTOR_SUMMARY') { const mentors = database.staff.filter((item) => item.permissionRole === 'MENTOR' && (!plan.filters.mentorId || item.id === plan.filters.mentorId)); return { rows: mentors, repos, aggregates: Object.fromEntries(mentors.map((item) => [item.id, database.customers.filter((customer) => customer.mentorId === item.id).length])) } }
  return { rows: [], repos }
}

function fields(database, customer, data) { const purchased = (data.enrollments || []).map((item) => database.products.find((product) => product.id === item.productId)?.name).filter(Boolean).join('、') || '暂无记录'; return [{ label: '基础信息', value: `${customer.phone || '暂无手机号'} · ${customer.status}` }, { label: '当前导师', value: mentorName(database, customer.mentorId) }, { label: '当前核心需求', value: customer.need || '暂无记录' }, { label: '介绍人', value: customer.referrerName || '未填写' }, { label: '是否付费', value: customer.paid ? '已付费' : '暂未付费' }, { label: 'SABC', value: customer.grade || '暂无' }, { label: '意向课程', value: customer.intendedCourse || '暂无记录' }, { label: '最近预约', value: data.appointments?.[0] ? `${data.appointments[0].topic} · ${data.appointments[0].status}` : '暂无记录' }, { label: '最近服务', value: data.sessions?.[0] ? `${data.sessions[0].topic} · ${data.sessions[0].date}` : '暂无记录' }, { label: '已购课程', value: purchased }] }

function validate(database, plan, data) {
  if (plan.query_type === 'UNSUPPORTED') return { status: 'INVALID_QUERY', reason: '无法识别查询意图' }
  if ((plan.query_type === 'REVENUE_SUMMARY' || plan.query_type === 'ENROLLMENT_QUERY' || plan.query_type === 'CUSTOMER_SUMMARY') && database._missingRepositories?.includes('EnrollmentRepository')) return { status: 'DATA_SOURCE_ERROR', reason: 'EnrollmentRepository 未配置' }
  const ids = data.rows.map((row) => row.id).filter(Boolean); if (new Set(ids).size !== ids.length) return { status: 'DATA_SOURCE_ERROR', reason: '查询结果包含重复记录' }
  for (const row of data.rows) { if (row.customerId && !database.customers.some((customer) => customer.id === row.customerId)) return { status: 'DATA_SOURCE_ERROR', reason: '查询结果包含不存在的 customer_id' }; if (row.amount !== undefined && typeof row.amount !== 'number') return { status: 'DATA_SOURCE_ERROR', reason: '付款金额不是数字' }; if (row.date && !inRange(row.date, plan.time_range)) return { status: 'DATA_SOURCE_ERROR', reason: '返回记录超出请求时间范围' } }
  if (data.aggregates && Object.values(data.aggregates).some((value) => !Number.isFinite(value) || value < 0)) return { status: 'DATA_SOURCE_ERROR', reason: '聚合结果不是合理数字' }
  if (!data.rows.length && !['STATUS_SUMMARY', 'CUSTOMER_SUMMARY'].includes(plan.query_type)) return { status: 'NO_DATA' }
  return { status: 'SUCCESS' }
}

function answer(database, plan, data, validation, resolved) {
  if (validation.status === 'DATA_SOURCE_ERROR') return { kind: plan.query_type, answer: `数据查询所需的数据源暂不可用：${validation.reason || '请稍后再试。'}` }
  if (plan.query_type === 'UNSUPPORTED') return { kind: 'UNSUPPORTED', answer: '我还不能确定你要查询什么。你可以问我：“查一下林知微”“上个月新增多少客户”或“现在有多少待分配预约”。' }
  if (validation.status === 'AMBIGUOUS') return { kind: plan.query_type, answer: `系统里找到 ${resolved.customers.length} 个可能匹配的客户，请确认。`, candidates: resolved.customers.map((item) => customerRecord(database, item)) }
  if (validation.status === 'NO_DATA') return { kind: plan.query_type, answer: plan.query_type === 'CUSTOMER_DETAIL' ? '系统当前没有查到这个客户。' : '系统当前没有查到符合条件的数据。' }
  if (plan.query_type === 'CUSTOMER_DETAIL' && data.customer) { const detailFields = fields(database, data.customer, data); const purchased = detailFields.find((item) => item.label === '已购课程')?.value; return { kind: 'CUSTOMER_QUERY', answer: `查到了。${data.customer.name}目前由${mentorName(database, data.customer.mentorId)}负责，当前主要关注${data.customer.need || '暂无记录'}，${purchased && purchased !== '暂无记录' ? `已购买${purchased}。` : '暂未记录已购课程。'}`, customerId: data.customer.id, records: [customerRecord(database, data.customer, detailFields)], continuation: { kind: 'CUSTOMER_QUERY', queryType: 'CUSTOMER_DETAIL', customerId: data.customer.id } } }
  if (plan.query_type === 'CUSTOMER_PURCHASES') { const records = (data.enrollments || []).map((item) => record(database, item)); return { kind: 'CUSTOMER_PURCHASES', answer: `${data.customer?.name || resolved.customer?.name || '该客户'}已购买 ${records.length} 门课程。`, records } }
  if (plan.query_type === 'CUSTOMER_LIST') { const records = data.rows.map((item) => customerRecord(database, item)); return { kind: 'CUSTOMER_LIST', answer: `根据系统当前已录入的数据，${plan.time_range?.label || '符合条件的时间范围内'}共有 ${records.length} 位新增客户。`, records } }
  if (plan.query_type === 'CUSTOMER_SUMMARY') { const a = data.aggregates || {}; return { kind: 'CUSTOMER_SUMMARY', answer: `根据系统当前已录入的数据，${plan.time_range?.label || '当前'}客户经营概览：新增客户 ${a.new_customer_count || 0}，预约 ${a.appointment_count || 0}，已完成 ${a.completed_count || 0}，付费客户 ${a.paid_customer_count || 0}，营收 ${money(a.revenue || 0)}。当前待分配 ${a.wait_assign || 0}，跟进中 ${a.following || 0}，待反馈 ${a.wait_feedback || 0}。你也可以继续让我列出具体客户名单。` } }
  if (plan.query_type === 'REVENUE_SUMMARY') { const a = data.aggregates || {}; return { kind: 'REVENUE_SUMMARY', answer: `${plan.time_range?.label || '当前'}实际营收为 ${money(a.revenue || 0)}，共 ${a.paid_customer_count || 0} 位付费客户、${a.deal_count || 0} 笔成交记录。`, records: plan.entity?.type === 'PRODUCT' ? (data.enrollments || []).map((item) => record(database, item)) : undefined } }
  if (plan.query_type === 'ENROLLMENT_QUERY') { const records = (data.enrollments || []).map((item) => record(database, item)); const productName = plan.filters.productName; return { kind: 'ENROLLMENT_QUERY', answer: `${plan.time_range?.label || '当前'}${productName || '课程'}共有 ${new Set(records.map((item) => item.customerId)).size} 位报名客户。`, records: plan.result_mode === 'LIST' ? records : undefined, continuation: { kind: 'ENROLLMENT_QUERY', queryType: 'ENROLLMENT_QUERY', productName, timeRange: plan.time_range, customerIds: records.map((item) => item.customerId).filter(Boolean) } } }
  if (plan.query_type === 'MENTOR_SUMMARY') { const records = data.rows.map((mentor) => ({ id: mentor.id, name: mentor.name, detail: `${data.aggregates?.[mentor.id] || 0} 位客户` })); return { kind: 'MENTOR_QUERY', answer: records[0] ? `目前${records[0].name}负责 ${records[0].detail}。` : '系统目前没有查到导师数据。', records } }
  if (plan.query_type === 'STATUS_SUMMARY') { const a = data.aggregates || {}; const rows = [['待分配', a.wait_assign], ['跟进中', a.following], ['待反馈', a.wait_feedback], ['已完成', a.completed]]; const requested = rows.find(([label]) => plan.filters.status === label); return { kind: 'STATUS_SUMMARY', answer: requested ? `目前${requested[0]}有 ${requested[1]} 个预约。` : `目前共有 ${a.appointment_count || 0} 个预约：${rows.map(([name, count]) => `${name} ${count} 个`).join('，')}。`, records: rows.map(([name, count]) => ({ id: name, name, detail: `${count} 个预约` })) } }
  return { kind: plan.query_type, answer: '系统当前没有查到符合条件的数据。' }
}

export function queryAssistant(database, question, context = {}, actorId = 'http-admin') {
  const plan = QueryPlanner.plan(database, String(question || '').trim(), context)
  const matched = EntityResolver.customers(database, question); const resolved = { customers: matched, customer: matched.length === 1 ? matched[0] : undefined, product: EntityResolver.product(database, question), ambiguous: matched.length > 1 }
  if (context.customerId && !resolved.customer) resolved.customer = database.customers.find((item) => item.id === context.customerId)
  if (resolved.ambiguous && plan.query_type === 'CUSTOMER_DETAIL') { const debug = { user_id: actorId, role: 'ADMIN', query_plan: plan, resolved_entities: { customers: matched.map((item) => item.id) }, repositories_used: plan.joins, row_count: matched.length, executed_at: new Date().toISOString(), status: 'AMBIGUOUS' }; return { kind: plan.query_type, answer: `系统里找到 ${matched.length} 个可能匹配的客户，请确认。`, candidates: matched.map((item) => customerRecord(database, item)), plan, debug } }
  if (resolved.customer) plan.filters.customerId = resolved.customer.id
  if (resolved.product) plan.filters.productName = resolved.product.name
  if (plan.query_type === 'STATUS_SUMMARY') { const requested = ['待分配', '跟进中', '待反馈', '已完成'].find((label) => String(question).includes(label)); if (requested) plan.filters.status = requested }
  const data = execute(database, plan, resolved); if (plan.query_type === 'CUSTOMER_PURCHASES') data.customer = resolved.customer
  const validation = validate(database, plan, data); const debug = { user_id: actorId, role: 'ADMIN', query_plan: plan, resolved_entities: { customer_id: resolved.customer?.id, customer_ids: matched.map((item) => item.id), product: resolved.product?.name }, repositories_used: data.repos, row_count: data.rows.length, executed_at: new Date().toISOString(), status: validation.status, error_reason: validation.reason }
  return { ...answer(database, plan, data, validation, resolved), plan, debug }
}
