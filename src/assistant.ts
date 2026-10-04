import type { Customer, Database, Enrollment } from './domain'
import type { AssistantQueryContext, AssistantQueryResult, AssistantResultRecord } from './clientApi'

function monthKey(date: string) { return date.slice(0, 7) }
function previousMonthKey(now = new Date()) {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return month.toISOString().slice(0, 7)
}
function isPreviousMonthQuestion(question: string) { return question.includes('上个月') || question.includes('上月') }
function money(value: number) { return `¥${value.toLocaleString('zh-CN')}` }
function mentorName(database: Database, mentorId: string | null) { return database.staff.find((staff) => staff.id === mentorId)?.name ?? '待分配' }
function customerRecord(database: Database, customer: Customer): AssistantResultRecord {
  return { id: customer.id, customerId: customer.id, name: customer.name, mentor: mentorName(database, customer.mentorId), detail: `${customer.need || '暂无当前困扰'} · ${customer.paid ? '已付费' : '暂未付费'}` }
}
function enrollmentRecord(database: Database, enrollment: Enrollment): AssistantResultRecord {
  const customer = database.customers.find((item) => item.id === enrollment.customerId)
  const product = database.products.find((item) => item.id === enrollment.productId)
  return { id: enrollment.id, customerId: enrollment.customerId, name: customer?.name ?? '未命名客户', mentor: mentorName(database, customer?.mentorId ?? null), date: enrollment.date, amount: enrollment.amount, detail: `${product?.name ?? '课程'} · ${enrollment.status}` }
}

export function queryLocalAssistant(database: Database, question: string, context: AssistantQueryContext = {}): AssistantQueryResult {
  const query = question.trim()
  const previous = previousMonthKey()
  const month = isPreviousMonthQuestion(query) ? previous : ''
  const products = database.products
  const product = products.find((item) => query.includes(item.name))
  const isListFollowup = /把(他们|这些|上面这些)列出来|列出来|详细看看/.test(query) && context.lastQuery?.kind === 'ENROLLMENT_QUERY'
  const enrollmentProduct = product?.name ?? context.lastQuery?.productName

  if (isListFollowup) {
    const records = database.enrollments.filter((item) => (!enrollmentProduct || products.find((entry) => entry.id === item.productId)?.name === enrollmentProduct) && (!month || monthKey(item.date) === month) && item.paid).map((item) => enrollmentRecord(database, item))
    return { kind: 'ENROLLMENT_QUERY', answer: records.length ? `可以，${enrollmentProduct ? `上个月${enrollmentProduct}` : '上个月'}共有 ${records.length} 位报名客户。` : '系统目前没有查到相关报名记录。', records, continuation: { kind: 'ENROLLMENT_QUERY', productName: enrollmentProduct, customerIds: records.map((item) => item.customerId).filter(Boolean) as string[] } }
  }

  if (/营收|收入|成交金额|销售额/.test(query)) {
    const enrollments = database.enrollments.filter((item) => item.paid && (!month || monthKey(item.date) === month))
    if (!enrollments.length) return { kind: 'REVENUE_QUERY', answer: '目前系统还没有记录足够的付款金额，所以暂时无法准确统计。' }
    const total = enrollments.reduce((sum, item) => sum + item.amount, 0)
    return { kind: 'REVENUE_QUERY', answer: `根据系统当前已录入的付款记录，${month ? '上个月' : '当前'}总营收为 ${money(total)}，共 ${new Set(enrollments.map((item) => item.customerId)).size} 位付费客户、${enrollments.length} 笔成交记录。` }
  }

  if (/报名|报了名|课程/.test(query) && (product || /多少人|哪些客户|列出|报名/.test(query))) {
    const enrollments = database.enrollments.filter((item) => (!enrollmentProduct || products.find((entry) => entry.id === item.productId)?.name === enrollmentProduct) && (!month || monthKey(item.date) === month) && item.paid)
    const label = enrollmentProduct ? `${month ? '上个月' : ''}${enrollmentProduct}` : `${month ? '上个月' : ''}课程报名`
    const records = enrollments.map((item) => enrollmentRecord(database, item))
    return { kind: 'ENROLLMENT_QUERY', answer: `根据系统当前已录入的数据，${label}共有 ${records.length} 位报名客户。`, records: /哪些客户|列出|报名了哪些/.test(query) ? records : undefined, continuation: { kind: 'ENROLLMENT_QUERY', productName: enrollmentProduct, customerIds: records.map((item) => item.customerId).filter(Boolean) as string[] } }
  }

  if (/哪个导师|导师.*最多|导师.*客户|负责多少客户|导师查询/.test(query)) {
    const records = database.staff.filter((item) => item.permissionRole === 'MENTOR').map((mentor) => ({ id: mentor.id, name: mentor.name, detail: `${database.customers.filter((customer) => customer.mentorId === mentor.id).length} 位客户` })).sort((a, b) => Number(b.detail.split(' ')[0]) - Number(a.detail.split(' ')[0]))
    const top = records[0]
    return { kind: 'MENTOR_QUERY', answer: top ? `目前客户量最多的是 ${top.name}，负责 ${top.detail}。` : '系统目前没有查到导师数据。', records }
  }

  if (/待分配|跟进中|待反馈|已完成|预约状态|预约处理|有多少预约/.test(query)) {
    const labels: Array<[string, string]> = [['WAIT_ASSIGN', '待分配'], ['FOLLOWING', '跟进中'], ['WAIT_FEEDBACK', '待反馈'], ['COMPLETED', '已完成']]
    const records = labels.map(([status, name]) => ({ id: status, name, detail: `${database.appointments.filter((item) => item.status === status).length} 个预约` }))
    const requested = labels.find(([, name]) => query.includes(name))
    return { kind: 'STATUS_SUMMARY', answer: requested ? `目前${requested[1]}有 ${records.find((item) => item.name === requested[1])?.detail.split(' ')[0] ?? 0} 个预约。` : `目前共有 ${database.appointments.length} 个预约：${records.map((item) => `${item.name} ${item.detail.split(' ')[0]} 个`).join('，')}。`, records }
  }

  if (/客户|查一下|查查|这个人|她|他/.test(query)) {
    const contextualCustomer = context.customerId && (/这个客户|这个人|她|他/.test(query) || query.length < 8) ? database.customers.find((item) => item.id === context.customerId) : undefined
    const matches = contextualCustomer ? [contextualCustomer] : database.customers.filter((customer) => query.includes(customer.name) || customer.name.includes(query.replace(/查一下|查查|客户|是谁|的情况/g, '').trim()))
    if (matches.length === 1) {
      const customer = matches[0]
      return { kind: 'CUSTOMER_QUERY', answer: `${customer.name}目前由${mentorName(database, customer.mentorId)}负责，当前主要困扰是：${customer.need || '暂无记录'}。${customer.paid ? '目前已付费。' : '目前暂未记录付费。'}`, customerId: customer.id, records: [customerRecord(database, customer)], continuation: { kind: 'CUSTOMER_QUERY', customerId: customer.id } }
    }
    if (matches.length > 1) return { kind: 'CUSTOMER_QUERY', answer: `我找到 ${matches.length} 位可能匹配的客户，请选择要查看的对象。`, candidates: matches.map((customer) => customerRecord(database, customer)) }
    return { kind: 'CUSTOMER_QUERY', answer: '系统目前没有查到相关客户。' }
  }

  return { kind: 'UNSUPPORTED', answer: '我目前支持查询客户、预约状态、导师客户量、课程报名和基础营收。你可以直接问我：“现在有多少待分配预约？”' }
}
