import { FeishuRepository } from '../server/repository.mjs'
import { normalizePhone, normalizeWechat } from '../shared/customer-foundation.mjs'

const database = await new FeishuRepository().load()
const issues = {
  missingCustomerId: database.customers.filter((item) => !item.id).length,
  duplicateCustomerId: database.customers.length - new Set(database.customers.map((item) => item.id)).size,
  duplicatePhone: 0,
  duplicateWechat: 0,
  missingContact: database.customers.filter((item) => !normalizePhone(item.phone) && !normalizeWechat(item.wechat)).length,
  missingNickname: database.customers.filter((item) => !String(item.name || '').trim()).length,
  danglingMentor: database.customers.filter((item) => item.mentorId && !database.staff.some((staff) => staff.id === item.mentorId)).length,
  danglingEnrollmentCustomer: database.enrollments.filter((item) => !database.customers.some((customer) => customer.id === item.customerId)).length,
  danglingEnrollmentProduct: database.enrollments.filter((item) => !database.products.some((product) => product.id === item.productId)).length,
}
const countDuplicates = (values) => values.filter((value, index) => value && values.indexOf(value) !== index).length
issues.duplicatePhone = countDuplicates(database.customers.map((item) => normalizePhone(item.phone)))
issues.duplicateWechat = countDuplicates(database.customers.map((item) => normalizeWechat(item.wechat)))
const result = { ok: Object.values(issues).every((value) => value === 0), checked: { customers: database.customers.length, staff: database.staff.length, products: database.products.length, enrollments: database.enrollments.length, serviceRecords: database.sessions.length, profileChanges: database.profileChanges.length, appointments: database.appointments.length }, issues }
console.log(JSON.stringify(result))
if (!result.ok) process.exitCode = 1
