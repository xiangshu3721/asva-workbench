export const PROFILE_COMPLETENESS_THRESHOLD = 60
const TIME_ZONE = 'Asia/Shanghai'

function pad(value) { return String(value).padStart(2, '0') }

function dateParts(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
  return { year: values.year, month: values.month, day: values.day }
}

function dateKey(value) {
  const parts = dateParts(value)
  return parts ? `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` : ''
}

function weekRange(now) {
  const parts = dateParts(now)
  if (!parts) return { start: '', end: '' }
  const current = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const day = current.getUTCDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const start = new Date(current)
  start.setUTCDate(current.getUTCDate() + mondayOffset)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 6)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

function inRange(value, range) {
  const key = dateKey(value)
  return Boolean(key && range.start && key >= range.start && key <= range.end)
}

function previousWeekRange(range) {
  const start = new Date(`${range.start}T00:00:00Z`)
  const end = new Date(`${range.end}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - 7)
  end.setUTCDate(end.getUTCDate() - 7)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

function coverage(customer) {
  const value = Number(customer?.profileMaterialization?.coverage?.percentage)
  return Number.isFinite(value) ? value : null
}

export function buildBasicDashboard(database, now = new Date()) {
  const customers = Array.isArray(database?.customers) ? database.customers : []
  const enrollments = Array.isArray(database?.enrollments) ? database.enrollments : []
  const staff = Array.isArray(database?.staff) ? database.staff : []
  const products = Array.isArray(database?.products) ? database.products : []
  const range = weekRange(now)
  const previousRange = previousWeekRange(range)
  const activeEnrollments = enrollments.filter((item) => item.status !== 'CANCELLED')
  const productMap = new Map(products.map((item) => [item.id, item]))
  const courseCounts = new Map()
  for (const enrollment of activeEnrollments) {
    const courseId = String(enrollment.productId || '').trim()
    if (!courseId) continue
    const current = courseCounts.get(courseId) || { course_id: courseId, course_name: productMap.get(courseId)?.name || courseId, enrollment_count: 0 }
    current.enrollment_count += 1
    courseCounts.set(courseId, current)
  }
  const courseRows = [...courseCounts.values()].sort((left, right) => right.enrollment_count - left.enrollment_count || left.course_name.localeCompare(right.course_name, 'zh-CN'))
  const totalEnrollments = activeEnrollments.length
  const visibleCourses = courseRows.length > 5 ? [...courseRows.slice(0, 5), { course_id: '__OTHER__', course_name: '其他', enrollment_count: courseRows.slice(5).reduce((sum, item) => sum + item.enrollment_count, 0) }] : courseRows
  const courseDistribution = visibleCourses.map((item) => ({ ...item, percentage: totalEnrollments ? Math.round(item.enrollment_count / totalEnrollments * 100) : 0 }))
  const staffMap = new Map(staff.map((item) => [item.id, item]))
  const ownerCounts = new Map()
  for (const customer of customers) {
    const staffId = String(customer.createdByStaffId || '').trim()
    const owner = staffMap.get(staffId)
    const key = owner ? owner.id : '__UNKNOWN__'
    const current = ownerCounts.get(key) || { staff_id: owner?.id || '', staff_name: owner ? `${owner.name}${owner.permissionRole === 'ADMIN' ? '（管理员）' : ''}` : '历史/未识别', role: owner?.permissionRole || 'UNKNOWN', customer_count: 0 }
    current.customer_count += 1
    ownerCounts.set(key, current)
  }
  const customerOwnerDistribution = [...ownerCounts.values()].sort((left, right) => right.customer_count - left.customer_count || left.staff_name.localeCompare(right.staff_name, 'zh-CN'))
  const customerTotal = customers.length
  const newCustomersThisWeek = customers.filter((item) => inRange(item.createdAt, range)).length
  const previousWeekNewCustomers = customers.filter((item) => inRange(item.createdAt, previousRange)).length
  const enrolledCustomerTotal = new Set(activeEnrollments.map((item) => item.customerId).filter(Boolean)).size
  const profilePendingTotal = customers.filter((item) => { const value = coverage(item); return value === null || value < PROFILE_COMPLETENESS_THRESHOLD }).length
  const mentorCounts = customerOwnerDistribution.filter((item) => item.role === 'MENTOR')
  const mentorCustomerTotal = mentorCounts.reduce((sum, item) => sum + item.customer_count, 0)
  const managementInsights = []
  managementInsights.push(newCustomersThisWeek === 0 ? { type: 'NEW_CUSTOMERS', text: '本周暂无新增客户，可关注新客户来源。' } : { type: 'NEW_CUSTOMERS', text: `本周新增 ${newCustomersThisWeek} 位客户。` })
  if (profilePendingTotal > 0) managementInsights.push({ type: 'PROFILE_PENDING', text: `有 ${profilePendingTotal} 位客户档案待补充，可优先完善基础信息。` })
  if (customerTotal > 0) managementInsights.push({ type: 'ENROLLMENT', text: `当前 ${enrolledCustomerTotal} / ${customerTotal} 位客户已有课程报名。` })
  if (mentorCounts.length >= 2 && mentorCustomerTotal > 0) {
    const concentrated = mentorCounts.find((item) => item.customer_count / mentorCustomerTotal > 0.7)
    if (concentrated) managementInsights.push({ type: 'MENTOR_DISTRIBUTION', text: `客户目前较集中在${concentrated.staff_name}名下，可关注后续承载情况。` })
  }
  return {
    customer_total: customerTotal,
    new_customers_this_week: newCustomersThisWeek,
    previous_week_new_customers: previousWeekNewCustomers,
    enrolled_customer_total: enrolledCustomerTotal,
    active_enrollment_total: totalEnrollments,
    profile_pending_total: profilePendingTotal,
    course_enrollment_distribution: courseDistribution,
    customer_owner_distribution: customerOwnerDistribution,
    management_insights: managementInsights.slice(0, 3),
    generated_at: new Date(now).toISOString(),
  }
}
