import crypto from 'node:crypto'
import { config } from '../server/config.mjs'
import { createRecord, deleteRecord, listRecords } from '../server/feishu.mjs'
import { fields as mapFields, read as readField } from '../server/field-mapping.mjs'
import { FeishuRepository } from '../server/repository.mjs'

const requiredTables = ['customers', 'staff', 'profileChanges', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']
if (config.appEnv !== 'staging' || config.dataMode !== 'staging' || config.productionWriteProtection !== 'ON') throw new Error('STAGING_GUARD_FAILED')
if (!config.features.automaticProfileArchiving) throw new Error('AUTOMATIC_PROFILE_ARCHIVING_TEST_FLAG_REQUIRED')
if (requiredTables.some((name) => !config.feishu.tables[name])) throw new Error('STAGING_REQUIRED_TABLES_MISSING')

const prefix = `PR45_SYNTH_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const phone = `137${String(Date.now()).slice(-8)}`
let customerId = ''
let temporaryStaffRecordId = ''
let mode = 'age-current'
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const rows = async (tableKey) => listRecords(config.feishu.tables[tableKey])
const customerRowId = (row) => String(readField('customers', row.fields, 'customer_id') || '')
const repository = new FeishuRepository({ evidenceExtractor: async () => {
  if (mode === 'age-current') return [{ evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'age', value: 24, display_text: '客户目前24岁', source_excerpt: '客户今年24岁', content_source: 'STAFF_TRANSCRIBED_CUSTOMER', information_nature: 'OBJECTIVE_RECORD', verification_status: 'SOURCE_SUPPORTED', confidence: 0.98, locator: { paragraph_index: 0 } }]
  if (mode === 'age-historical') return [{ evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'age', value: 23, display_text: '历史资料记载客户23岁', source_excerpt: '历史资料记载客户23岁', occurred_at: '2020-01-01T00:00:00.000Z', content_source: 'STAFF_TRANSCRIBED_CUSTOMER', information_nature: 'OBJECTIVE_RECORD', verification_status: 'SOURCE_SUPPORTED', confidence: 0.98, locator: { paragraph_index: 0 } }]
  if (mode === 'supplementary') return [{ evidence_type: 'SELF_MEANING', semantic_kind: 'OTHER', field_key: '', value: '希望生活节奏慢一点', display_text: '客户希望生活节奏慢一点', source_excerpt: '客户希望生活节奏慢一点', content_source: 'STAFF_TRANSCRIBED_CUSTOMER', information_nature: 'PERSONAL_STATEMENT', verification_status: 'SOURCE_SUPPORTED', confidence: 0.88, locator: { paragraph_index: 0 } }]
  return [{ evidence_type: 'FACT', semantic_kind: 'OTHER', field_key: '', value: '家庭暴力经历', display_text: '客户曾遭受家庭暴力', source_excerpt: '客户曾遭受家庭暴力', content_source: 'STAFF_TRANSCRIBED_CUSTOMER', information_nature: 'PERSONAL_STATEMENT', verification_status: 'SOURCE_SUPPORTED', privacy_level: 'HIGH_SENSITIVE', confidence: 0.88, locator: { paragraph_index: 0 } }]
} })
// This script validates Evidence/Profile persistence only. Do not start the
// unrelated delayed understanding refresh while the Feishu test is running.
repository.scheduleCustomerUnderstandingRefresh = () => {}

async function cleanup() {
  if (!customerId) {
    if (temporaryStaffRecordId) await deleteRecord(config.feishu.tables.staff, temporaryStaffRecordId).catch(() => {})
    return
  }
  const tableOrder = ['evidenceConflicts', 'profileUpdateProposals', 'evidenceItems', 'sourceRecords', 'profileChanges', 'customers']
  for (const tableKey of tableOrder) {
    const current = await rows(tableKey)
    for (const row of current.filter((item) => String(readField(tableKey, item.fields, 'customer_id') || '') === customerId)) await deleteRecord(config.feishu.tables[tableKey], row.record_id)
  }
  if (temporaryStaffRecordId) await deleteRecord(config.feishu.tables.staff, temporaryStaffRecordId).catch(() => {})
}

async function saveAndProcess(adminId, rawText, operationId) {
  const source = await repository.createSource(adminId, { customerId, sourceType: 'TEXT_INPUT', sourceRole: 'CUSTOMER', title: `${prefix}-${operationId}`, rawText, notes: `AUTO_PROFILE_ORGANIZE:PR45_${operationId}`, operationId })
  await repository.processSource(adminId, source.id, { force: true })
}

try {
  const database = await repository.load({ force: true })
  const admin = database.staff.find((item) => item.permissionRole === 'ADMIN' && item.status === 'ACTIVE' && item.loginEnabled === true)
  let adminId = admin?.id
  if (!adminId) {
    adminId = `${prefix}_ADMIN`
    const result = await createRecord(config.feishu.tables.staff, mapFields('staff', { staff_id: adminId, nickname: adminId, name: adminId, phone: `138${String(Date.now()).slice(-8)}`, permission_role: 'ADMIN', role: 'ADMIN', status: 'ACTIVE', login_enabled: 'true' }), { operation: 'staging.pr45.staff.create', operationId: adminId, entityType: 'staff', idempotency: { field: '人员ID', value: adminId } })
    temporaryStaffRecordId = result.record_id
  }

  const created = await repository.createCustomer(adminId, { operationId: `${prefix}_CREATE`, nickname: `${prefix}_CUSTOMER`, phone, situation: '', profileUpdates: [{ field: 'age', value: 23 }], confirmedNotSame: true, source: 'PR45_SYNTHETIC' }, { compactResponse: true })
  customerId = created.customer?.id || created.createdCustomerId || ''
  assert(customerId, 'CUSTOMER_ID_NOT_RETURNED')

  mode = 'age-current'
  await saveAndProcess(adminId, '客户今年24岁', `${prefix}_AGE_CURRENT`)
  let after = await repository.load({ force: true })
  let customer = after.customers.find((item) => item.id === customerId)
  assert(customer?.profileFields?.age === 24, 'CURRENT_STATE_AUTO_OVERWRITE_FAILED')
  assert(customer?.profileFieldMeta?.age?.confirmed === false, 'AUTO_OVERWRITE_NOT_PENDING')
  assert(after.profileChanges.some((item) => item.customerId === customerId && item.field === 'age' && item.oldValue === 23 && item.newValue === 24), 'PROFILE_CHANGE_PROVENANCE_MISSING')

  mode = 'age-historical'
  await saveAndProcess(adminId, '历史资料记载客户23岁', `${prefix}_AGE_HISTORICAL`)
  after = await repository.load({ force: true })
  customer = after.customers.find((item) => item.id === customerId)
  assert(customer?.profileFields?.age === 24, 'STALE_TASK_OVERWROTE_CURRENT_STATE')

  mode = 'supplementary'
  await saveAndProcess(adminId, '客户希望生活节奏慢一点', `${prefix}_SUPPLEMENTARY`)
  after = await repository.load({ force: true })
  customer = after.customers.find((item) => item.id === customerId)
  assert(customer?.supplementaryItems?.some((item) => item.text === '客户希望生活节奏慢一点'), 'SUPPLEMENTARY_FIELD_NOT_READ_BACK')
  const customerRows = await rows('customers')
  const customerRow = customerRows.find((row) => customerRowId(row) === customerId)
  const supplementaryRaw = String(readField('customers', customerRow?.fields, 'supplementary_info') || '')
  const metadataRaw = String(readField('customers', customerRow?.fields, 'profile_field_meta_json') || '')
  assert(supplementaryRaw.includes('客户希望生活节奏慢一点'), 'SUPPLEMENTARY_FIELD_TEXT_MISSING')
  assert(!metadataRaw.includes('客户希望生活节奏慢一点'), 'RAW_TEXT_LEAKED_IN_PROFILE_METADATA')

  mode = 'sensitive'
  await saveAndProcess(adminId, '客户曾遭受家庭暴力', `${prefix}_SENSITIVE`)
  after = await repository.load({ force: true })
  customer = after.customers.find((item) => item.id === customerId)
  assert(!customer?.supplementaryItems?.some((item) => item.text.includes('家庭暴力')), 'SENSITIVE_FALLBACK_EXPOSED')
  console.log(JSON.stringify({ ok: true, customerId, age: customer?.profileFields?.age, ageConfirmed: customer?.profileFieldMeta?.age?.confirmed, supplementaryCount: customer?.supplementaryItems?.length || 0, profileChangeCount: after.profileChanges.filter((item) => item.customerId === customerId).length, stalePreserved: customer?.profileFields?.age === 24, metadataContainsSupplementaryText: metadataRaw.includes('客户希望生活节奏慢一点') }))
} finally {
  await cleanup()
}
