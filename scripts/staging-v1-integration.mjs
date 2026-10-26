import crypto from 'node:crypto'
import { config } from '../server/config.mjs'
import { createRecord, deleteRecord, listRecords } from '../server/feishu.mjs'
import { fields as mapFields, read as readField } from '../server/field-mapping.mjs'
import { FeishuRepository } from '../server/repository.mjs'

const requiredTables = ['customers', 'staff', 'profileChanges', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']
if (config.appEnv !== 'staging' || config.dataMode !== 'staging' || config.productionWriteProtection !== 'ON') throw new Error('STAGING_GUARD_FAILED')
if (!config.features.automaticProfileArchiving) throw new Error('AUTOMATIC_PROFILE_ARCHIVING_TEST_FLAG_REQUIRED')
if (!config.deepseek.apiKey) throw new Error('DEEPSEEK_API_KEY_REQUIRED')
if (requiredTables.some((name) => !config.feishu.tables[name])) throw new Error('STAGING_REQUIRED_TABLES_MISSING')

const prefix = `V1_SYNTH_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
let customerId = ''
const phone = `139${String(Date.now()).slice(-8)}`
const rawText = '29岁，女性，在杭州工作。最近经常和男朋友吵架，感觉很累，睡眠一般，不确定这段关系是否应该继续。想做自己感兴趣的事业。'
const repository = new FeishuRepository()
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const rows = async (tableKey) => listRecords(config.feishu.tables[tableKey])
const rowCustomerId = (tableKey, row) => String(readField(tableKey, row.fields, 'customer_id') || '')

async function snapshot() {
  const result = {}
  for (const tableKey of requiredTables) result[tableKey] = await rows(tableKey)
  return result
}

async function cleanup() {
  const tableOrder = ['evidenceConflicts', 'profileUpdateProposals', 'evidenceItems', 'sourceRecords', 'profileChanges', 'customers']
  for (const tableKey of tableOrder) {
    const current = await rows(tableKey)
    for (const row of current.filter((item) => rowCustomerId(tableKey, item) === customerId)) await deleteRecord(config.feishu.tables[tableKey], row.record_id)
  }
}

async function waitForArchive(adminId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const database = await repository.load({ force: true })
    const source = database.sourceRecords.find((item) => item.customerId === customerId && String(item.notes || '').startsWith('AUTO_PROFILE_ORGANIZE:'))
    const customer = database.customers.find((item) => item.id === customerId)
    const workspace = await repository.sourceWorkspace(adminId, customerId)
    if (source && ['COMPLETED', 'REVIEW_REQUIRED'].includes(source.processingStatus) && workspace.evidenceItems.length > 0) return { database, source, customer, workspace }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error('AUTOMATIC_ARCHIVE_TIMEOUT')
}

let adminId = ''
let temporaryStaffRecordId = ''
try {
  const database = await repository.load({ force: true })
  const admin = database.staff.find((item) => item.permissionRole === 'ADMIN' && item.status === 'ACTIVE' && item.loginEnabled === true)
  if (admin) adminId = admin.id
  else {
    adminId = `${prefix}_ADMIN`
    const staffResult = await createRecord(config.feishu.tables.staff, mapFields('staff', { staff_id: adminId, nickname: adminId, name: adminId, phone: `138${String(Date.now()).slice(-8)}`, permission_role: 'ADMIN', role: 'ADMIN', status: 'ACTIVE', login_enabled: 'true' }), { operation: 'staging.synthetic.staff.create', operationId: adminId, entityType: 'staff', idempotency: { field: '人员ID', value: adminId } })
    temporaryStaffRecordId = staffResult.record_id
  }
  const created = await repository.createCustomer(adminId, { operationId: `${prefix}_CREATE`, nickname: `${prefix}_CUSTOMER`, phone, situation: rawText, confirmedNotSame: true, source: 'V1_SYNTHETIC' }, { compactResponse: true })
  customerId = created.customer?.id || created.createdCustomerId || ''
  assert(customerId, 'CUSTOMER_ID_NOT_RETURNED')
  const archived = await waitForArchive(adminId)
  const fields = archived.customer?.profileFields || {}
  const meta = archived.customer?.profileFieldMeta || {}
  assert(archived.source, 'AUTO_SOURCE_NOT_PERSISTED')
  assert(archived.workspace.evidenceItems.length > 0, 'EVIDENCE_NOT_PERSISTED')
  assert(Object.keys(fields).length > 0, 'CUSTOMERS_STRUCTURED_FIELDS_NOT_BACKFILLED')
  assert(Object.values(meta).some((item) => item?.source === 'AI_EXTRACTED' && item?.confirmed === false), 'AI_PENDING_METADATA_NOT_PERSISTED')
  const proposal = archived.workspace.proposals.find((item) => item.reviewStatus === 'PENDING_REVIEW')
  assert(proposal, 'PENDING_PROPOSAL_NOT_PERSISTED')
  await repository.reviewProposal(adminId, proposal.id, 'CONFIRM')
  const afterConfirm = await repository.load({ force: true })
  const confirmed = afterConfirm.customers.find((item) => item.id === customerId)
  assert(confirmed?.profileFieldMeta?.[proposal.fieldKey]?.confirmed === true, 'MANUAL_CONFIRMATION_NOT_READ_BACK')
  const beforeRepeat = await snapshot()
  await repository.updateCustomer(adminId, customerId, { operationId: `${prefix}_SAME_UPDATE`, nickname: customerId, phone, situation: rawText, confirmedNotSame: true }, { compactResponse: true })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const afterRepeat = await snapshot()
  assert(afterRepeat.sourceRecords.length === beforeRepeat.sourceRecords.length, 'DUPLICATE_SOURCE_CREATED')
  assert(afterRepeat.evidenceItems.length === beforeRepeat.evidenceItems.length, 'DUPLICATE_EVIDENCE_CREATED')
  const finalDatabase = await repository.load({ force: true })
  const finalCustomer = finalDatabase.customers.find((item) => item.id === customerId)
  console.log(JSON.stringify({ ok: true, customerId, sourceCount: afterRepeat.sourceRecords.filter((row) => rowCustomerId('sourceRecords', row) === customerId).length, evidenceCount: afterRepeat.evidenceItems.filter((row) => rowCustomerId('evidenceItems', row) === customerId).length, proposalCount: afterRepeat.profileUpdateProposals.filter((row) => rowCustomerId('profileUpdateProposals', row) === customerId).length, structuredFields: Object.keys(finalCustomer?.profileFields || {}), pendingFields: Object.entries(finalCustomer?.profileFieldMeta || {}).filter(([, item]) => item?.source === 'AI_EXTRACTED' && item?.confirmed === false).map(([field]) => field), confirmedField: proposal.fieldKey }))
} finally {
  await cleanup()
  if (temporaryStaffRecordId) await deleteRecord(config.feishu.tables.staff, temporaryStaffRecordId).catch(() => {})
}
