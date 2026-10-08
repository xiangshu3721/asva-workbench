import { config } from '../server/config.mjs'
import { listRecords } from '../server/feishu.mjs'
import { read } from '../server/field-mapping.mjs'

const targetIds = new Set([
  'CUS-9e920da53172eeec9366',
  'CUS-d5a670a5dc0998f84a38',
  'CUS-8585712890a5214799af',
  'CUS-2342abbe7b0c9734aaee',
  'CUS-78dd71ae6c5446fa19b7',
  'CUS-4a5296e1e7a334941b85',
  'CUS-CF-E2E-仅测试',
])

const [customers, enrollments, serviceRecords, profileChanges, appointments] = await Promise.all([
  listRecords(config.feishu.tables.customers),
  listRecords(config.feishu.tables.enrollments),
  listRecords(config.feishu.tables.serviceRecords),
  listRecords(config.feishu.tables.profileChanges),
  listRecords(config.feishu.tables.appointments),
])

const linked = (rows, table, customerId) => rows.filter((row) => read(table, row.fields, 'customer_id') === customerId).map((row) => ({
  record_id: row.record_id,
  table,
  source: read(table, row.fields, table === 'appointments' ? 'case_source' : table === 'profileChanges' ? 'source' : 'enrollment_source'),
  created_at: read(table, row.fields, 'created_at') || read(table, row.fields, 'changed_at') || read(table, row.fields, 'submitted_at'),
}))
const rows = customers.filter((row) => targetIds.has(read('customers', row.fields, 'customer_id'))).map((row) => {
  const customerId = read('customers', row.fields, 'customer_id')
  return {
    record_id: row.record_id,
    customer_id: customerId,
    nickname: read('customers', row.fields, 'nickname'),
    source: read('customers', row.fields, 'source'),
    created_at: read('customers', row.fields, 'created_at'),
    links: [
      ...linked(enrollments, 'enrollments', customerId),
      ...linked(serviceRecords, 'serviceRecords', customerId),
      ...linked(profileChanges, 'profileChanges', customerId),
      ...linked(appointments, 'appointments', customerId),
    ],
  }
})

console.log(JSON.stringify({
  ok: rows.length === targetIds.size,
  expected_target_count: targetIds.size,
  found_target_count: rows.length,
  targets: rows,
  unlinked_targets: rows.filter((row) => row.links.length === 0).map((row) => row.customer_id),
  missing_targets: [...targetIds].filter((id) => !rows.some((row) => row.customer_id === id)),
}, null, 2))
