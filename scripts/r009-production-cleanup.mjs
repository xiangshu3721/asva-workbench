import { config } from '../server/config.mjs'
import { deleteRecord, listRecords, updateRecord } from '../server/feishu.mjs'
import { fields, read as readField } from '../server/field-mapping.mjs'

const apply = process.argv.includes('--apply')
const text = (value) => value === null || value === undefined ? '' : String(value).trim()
const value = (table, row, key) => text(readField(table, row.fields, key))
const tableKeys = ['customers', 'staff', 'authCredentials', 'appointments', 'serviceRecords', 'enrollments', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts', 'profileChanges']
const customerScoped = ['appointments', 'serviceRecords', 'enrollments', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts', 'profileChanges']
const safeDelete = async (tableId, recordId) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await deleteRecord(tableId, recordId); return } catch (error) {
      if (String(error?.providerCode) === '1254043') return
      if (String(error?.providerCode) !== '1254607') throw error
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
    }
  }
  throw new Error(`DELETE_NOT_READY:${recordId}`)
}

if (config.dataMode !== 'production' || config.environment !== 'production') throw new Error('R009 cleanup requires production environment')
for (const key of tableKeys) if (!config.feishu.tables[key]) throw new Error(`Missing table configuration: ${key}`)

const rows = Object.fromEntries(await Promise.all(tableKeys.map(async (key) => [key, await listRecords(config.feishu.tables[key])])))
const customerRows = rows.customers
const keepCustomerRows = ['丽丽', '杜姥爷'].map((name) => {
  const matches = customerRows.filter((row) => value('customers', row, 'nickname') === name)
  if (matches.length !== 1) throw new Error(`KEEP_CUSTOMER_NOT_UNIQUE:${name}:${matches.length}`)
  return matches[0]
})
const keepCustomerIds = new Set(keepCustomerRows.map((row) => value('customers', row, 'customer_id') || row.record_id))
const staffRows = rows.staff
const protectedStaff = staffRows.filter((row) => value('staff', row, 'phone') === '15021512537' || value('staff', row, 'login_phone') === '15021512537')
if (protectedStaff.length !== 1) throw new Error(`PROTECTED_ADMIN_NOT_UNIQUE:${protectedStaff.length}`)
const admin = protectedStaff[0]
if (value('staff', admin, 'nickname') !== '翔叔' && value('staff', admin, 'name') !== '翔叔') throw new Error('PROTECTED_ADMIN_NAME_MISMATCH')
if (value('staff', admin, 'role') !== 'ADMIN' || value('staff', admin, 'status') !== 'ACTIVE' || value('staff', admin, 'login_enabled') !== 'true') throw new Error('PROTECTED_ADMIN_STATE_INVALID')
const protectedStaffId = value('staff', admin, 'staff_id') || admin.record_id
const credentials = rows.authCredentials.filter((row) => value('authCredentials', row, 'staff_id') === protectedStaffId || value('authCredentials', row, 'login_phone') === '15021512537')
if (credentials.length !== 1) throw new Error(`PROTECTED_CREDENTIAL_NOT_UNIQUE:${credentials.length}`)
const protectedCredential = credentials[0]
if (!value('authCredentials', protectedCredential, 'password_hash') || value('authCredentials', protectedCredential, 'password_algorithm') !== 'scrypt' || value('authCredentials', protectedCredential, 'credential_status') !== 'ACTIVE') throw new Error('PROTECTED_CREDENTIAL_INVALID')

const deleteCustomerRows = customerRows.filter((row) => !keepCustomerIds.has(value('customers', row, 'customer_id') || row.record_id))
const deleteCustomerIds = new Set(deleteCustomerRows.map((row) => value('customers', row, 'customer_id') || row.record_id))
const cascade = Object.fromEntries(customerScoped.map((key) => [key, rows[key].filter((row) => !keepCustomerIds.has(value(key, row, 'customer_id')))]))
const deleteStaffRows = staffRows.filter((row) => (value('staff', row, 'staff_id') || row.record_id) !== protectedStaffId)
const deleteCredentialRows = rows.authCredentials.filter((row) => row.record_id !== protectedCredential.record_id)
const deletedStaffIds = new Set(deleteStaffRows.map((row) => value('staff', row, 'staff_id') || row.record_id))
const referenceFields = { customers: ['current_mentor_id'], appointments: ['assigned_mentor_id'], serviceRecords: ['mentor_id', 'operator_id'], enrollments: ['operator_id'], sourceRecords: ['uploaded_by'], profileChanges: ['operator_id'] }
const clearReferences = {}
for (const [table, keys] of Object.entries(referenceFields)) {
  clearReferences[table] = rows[table].filter((row) => !deleteCustomerIds.has(value(table, row, 'customer_id')) && keys.some((key) => deletedStaffIds.has(value(table, row, key))))
}

const summary = {
  mode: apply ? 'APPLY' : 'DRY_RUN',
  staff: { keep: [protectedStaffId], deleteCount: deleteStaffRows.length, deleteIds: deleteStaffRows.map((row) => value('staff', row, 'staff_id') || row.record_id) },
  credentials: { keep: [protectedCredential.record_id], deleteCount: deleteCredentialRows.length, deleteIds: deleteCredentialRows.map((row) => row.record_id) },
  customers: { keep: keepCustomerRows.map((row) => value('customers', row, 'customer_id') || row.record_id), deleteCount: deleteCustomerRows.length, deleteIds: deleteCustomerRows.map((row) => value('customers', row, 'customer_id') || row.record_id) },
  cascade: Object.fromEntries(Object.entries(cascade).map(([key, candidates]) => [key, { deleteCount: candidates.length, deleteIds: candidates.map((row) => row.record_id) }])),
  clearReferences: Object.fromEntries(Object.entries(clearReferences).map(([key, candidates]) => [key, { count: candidates.length, recordIds: candidates.map((row) => row.record_id) }])),
}
console.log(JSON.stringify(summary))
if (!apply) process.exit(0)

for (const [table, candidates] of Object.entries(clearReferences)) {
  const keys = referenceFields[table]
  for (const row of candidates) {
    const updates = Object.fromEntries(keys.filter((key) => deletedStaffIds.has(value(table, row, key))).map((key) => [key, '']))
    if (Object.keys(updates).length) await updateRecord(config.feishu.tables[table], row.record_id, fields(table, updates))
  }
}
for (const key of ['evidenceConflicts', 'profileUpdateProposals', 'evidenceItems', 'sourceRecords', 'profileChanges', 'enrollments', 'serviceRecords', 'appointments', 'customers']) {
  const candidates = key === 'customers' ? deleteCustomerRows : cascade[key]
  for (const row of candidates) await safeDelete(config.feishu.tables[key], row.record_id)
}
await Promise.all(deleteCredentialRows.map((row) => safeDelete(config.feishu.tables.authCredentials, row.record_id)))
await Promise.all(deleteStaffRows.map((row) => safeDelete(config.feishu.tables.staff, row.record_id)))

const finalRows = Object.fromEntries(await Promise.all(tableKeys.map(async (key) => [key, await listRecords(config.feishu.tables[key])])))
const finalCustomerNames = finalRows.customers.map((row) => value('customers', row, 'nickname')).sort()
const finalStaffIds = finalRows.staff.map((row) => value('staff', row, 'staff_id') || row.record_id)
if (finalRows.customers.length !== 2 || JSON.stringify(finalCustomerNames) !== JSON.stringify(['丽丽', '杜姥爷']) || finalRows.staff.length !== 1 || finalStaffIds[0] !== protectedStaffId || finalRows.authCredentials.length !== 1) throw new Error('R009_CLEANUP_POSTCHECK_FAILED')
console.log(JSON.stringify({ ok: true, final: { staffCount: finalRows.staff.length, adminCount: 1, mentorCount: 0, customerCount: finalRows.customers.length, customerNames: finalCustomerNames, authCredentialCount: finalRows.authCredentials.length } }))
