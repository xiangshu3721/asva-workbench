import { config } from '../server/config.mjs'
import { listRecords } from '../server/feishu.mjs'
import { read as readField } from '../server/field-mapping.mjs'

if (config.dataMode !== 'production' || config.environment !== 'production') throw new Error('orphan check requires production environment')
const keys = ['customers', 'staff', 'authCredentials', 'appointments', 'serviceRecords', 'enrollments', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts', 'profileChanges']
const rows = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, config.feishu.tables[key] ? await listRecords(config.feishu.tables[key]) : []])))
const text = (value) => value === null || value === undefined ? '' : String(value).trim()
const value = (table, row, key) => text(readField(table, row.fields, key))
const customerIds = new Set(rows.customers.map((row) => value('customers', row, 'customer_id') || row.record_id))
const staffIds = new Set(rows.staff.map((row) => value('staff', row, 'staff_id') || row.record_id))
const customerRefs = { appointments: 'customer_id', serviceRecords: 'customer_id', enrollments: 'customer_id', sourceRecords: 'customer_id', evidenceItems: 'customer_id', profileUpdateProposals: 'customer_id', evidenceConflicts: 'customer_id', profileChanges: 'customer_id' }
const staffRefs = { customers: ['current_mentor_id'], appointments: ['assigned_mentor_id'], serviceRecords: ['mentor_id', 'operator_id'], enrollments: ['operator_id'], sourceRecords: ['uploaded_by'], profileChanges: ['operator_id'], authCredentials: ['staff_id'] }
const issues = []
for (const [table, key] of Object.entries(customerRefs)) for (const row of rows[table]) { const id = value(table, row, key); if (id && !customerIds.has(id)) issues.push({ entity: table, recordId: row.record_id, reference: key }) }
for (const [table, keysForTable] of Object.entries(staffRefs)) for (const row of rows[table]) for (const key of keysForTable) { const id = value(table, row, key); if (id && !staffIds.has(id)) issues.push({ entity: table, recordId: row.record_id, reference: key }) }
const result = { ok: issues.length === 0, counts: Object.fromEntries(keys.map((key) => [key, rows[key].length])), orphanCount: issues.length, issues }
console.log(JSON.stringify(result))
if (!result.ok) process.exitCode = 1
