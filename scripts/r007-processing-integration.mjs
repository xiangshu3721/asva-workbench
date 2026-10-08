import crypto from 'node:crypto'
import { config } from '../server/config.mjs'
import { createRecord, deleteRecord, listRecords } from '../server/feishu.mjs'
import { fields as mapFields, read as readField } from '../server/field-mapping.mjs'
import { FeishuRepository } from '../server/repository.mjs'

if (process.env.RUN_FEISHU_INTEGRATION_TESTS !== 'true') {
  console.log(JSON.stringify({ skipped: true, reason: 'set RUN_FEISHU_INTEGRATION_TESTS=true to run real writes' }))
  process.exit(0)
}

const prefix = `R007_PROCESS_IT_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const customerId = `${prefix}_CUSTOMER`
const phone = `139${String(Date.now()).slice(-8)}`
const repository = new FeishuRepository()
const assert = (condition, message) => { if (!condition) throw new Error(message) }

async function rows() {
  return {
    sources: await listRecords(config.feishu.tables.sourceRecords),
    evidence: await listRecords(config.feishu.tables.evidenceItems),
    proposals: await listRecords(config.feishu.tables.profileUpdateProposals),
    conflicts: await listRecords(config.feishu.tables.evidenceConflicts),
    customers: await listRecords(config.feishu.tables.customers),
    profileChanges: await listRecords(config.feishu.tables.profileChanges),
  }
}

async function cleanup() {
  const current = await rows()
  const remove = async (tableKey, records) => { for (const row of records) await deleteRecord(config.feishu.tables[tableKey], row.record_id) }
  await remove('evidenceConflicts', current.conflicts.filter((row) => String(readField('evidenceConflicts', row.fields, 'customer_id') || '') === customerId))
  await remove('profileUpdateProposals', current.proposals.filter((row) => String(readField('profileUpdateProposals', row.fields, 'customer_id') || '') === customerId))
  await remove('evidenceItems', current.evidence.filter((row) => String(readField('evidenceItems', row.fields, 'customer_id') || '') === customerId))
  await remove('sourceRecords', current.sources.filter((row) => String(readField('sourceRecords', row.fields, 'customer_id') || '') === customerId))
  await remove('profileChanges', current.profileChanges.filter((row) => String(readField('profileChanges', row.fields, 'customer_id') || '') === customerId))
  await remove('customers', current.customers.filter((row) => String(readField('customers', row.fields, 'customer_id') || '') === customerId))
}

try {
  config.environment = 'production'
  config.dataMode = 'production'
  const staffRows = await listRecords(config.feishu.tables.staff)
  const adminRow = staffRows.find((row) => String(readField('staff', row.fields, 'permission_role') || readField('staff', row.fields, 'role')) === 'ADMIN' && String(readField('staff', row.fields, 'status')) === 'ACTIVE' && readField('staff', row.fields, 'login_enabled') !== false)
  assert(adminRow, 'no active admin found')
  const adminId = String(readField('staff', adminRow.fields, 'staff_id') || adminRow.record_id)
  await createRecord(config.feishu.tables.customers, mapFields('customers', { customer_id: customerId, nickname: customerId, phone, source: prefix, notes: 'temporary R007 processing integration customer', created_at: new Date().toISOString(), sabc: 'C', is_paid: false, birth_date: '1992-03-22', profile_schema_version: 'v1.0' }))

  const sourceA = await repository.createSource(adminId, { customerId, sourceType: 'TEXT_INPUT', title: `${prefix} A`, sourceRole: 'CUSTOMER', rawText: '1992年3月22日出生，目前住南京。' })
  const processedA = await repository.processSource(adminId, sourceA.id)
  assert(processedA.source.processingStatus !== 'PROCESSING', 'source A remained PROCESSING')
  const afterA = await repository.load()
  assert(afterA.customers.find((item) => item.id === customerId)?.profileFields?.city === '南京', 'source A did not materialize 南京')

  const sourceB = await repository.createSource(adminId, { customerId, sourceType: 'TEXT_INPUT', title: `${prefix} B`, sourceRole: 'CUSTOMER', rawText: '1993年3月22日出生，我现在已经搬到杭州。' })
  const processedB = await repository.processSource(adminId, sourceB.id)
  assert(processedB.source.processingStatus === 'REVIEW_REQUIRED', 'source B did not require review')
  assert(processedB.conflicts.some((item) => item.conflictType === 'FACT_CONTRADICTION' && item.status === 'OPEN'), 'birth_date conflict missing')
  const afterB = await repository.load()
  assert(afterB.customers.find((item) => item.id === customerId)?.profileFields?.city === '杭州', 'source B did not auto-update city')

  const beforeRetry = await repository.sourceWorkspace(adminId, customerId)
  const retried = await repository.processSource(adminId, sourceB.id)
  const afterRetry = await repository.sourceWorkspace(adminId, customerId)
  assert(retried.source.processingStatus === 'REVIEW_REQUIRED', 'retry changed review status')
  assert(afterRetry.evidenceItems.length === beforeRetry.evidenceItems.length, 'retry duplicated evidence')
  assert(afterRetry.proposals.length === beforeRetry.proposals.length, 'retry duplicated proposals')
  assert(afterRetry.conflicts.length === beforeRetry.conflicts.length, 'retry duplicated conflicts')
  assert(afterRetry.sources.every((source) => source.processingStatus !== 'PROCESSING'), 'a source remained PROCESSING')

  console.log(JSON.stringify({ ok: true, prefix, sourceAStatus: processedA.source.processingStatus, sourceBStatus: processedB.source.processingStatus, cityMaterialized: true, birthDateConflict: true, evidenceCount: afterRetry.evidenceItems.length, proposalCount: afterRetry.proposals.length, conflictCount: afterRetry.conflicts.length, retryIdempotent: true }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'R007 integration failed' }))
  process.exitCode = 1
} finally {
  try { await cleanup() } catch (error) { console.error(JSON.stringify({ cleanup: 'FAILED', message: error instanceof Error ? error.message : 'cleanup failed' })); process.exitCode = 1 }
}
