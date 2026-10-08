import crypto from 'node:crypto'
import { config } from '../server/config.mjs'
import { createRecord, deleteRecord, listRecords } from '../server/feishu.mjs'
import { read as readField, fields as mapFields } from '../server/field-mapping.mjs'
import { FeishuRepository } from '../server/repository.mjs'

if (process.env.RUN_FEISHU_INTEGRATION_TESTS !== 'true') { console.log(JSON.stringify({ skipped: true, reason: 'set RUN_FEISHU_INTEGRATION_TESTS=true to run real writes' })); process.exit(0) }
for (const name of ['sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']) if (!config.feishu.tables[name]) throw new Error(`missing Stage 2 table: ${name}`)
config.environment = 'production'
config.dataMode = 'production'

const prefix = `STAGE2_IT_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const customerId = `${prefix}_CUSTOMER`
const phone = `139${String(Date.now()).slice(-8)}`
const repository = new FeishuRepository()
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const maskId = (value) => { const raw = String(value || ''); return raw.length > 8 ? `${raw.slice(0, 4)}…${raw.slice(-4)}` : raw }

async function rows() { return { sources: await listRecords(config.feishu.tables.sourceRecords), evidence: await listRecords(config.feishu.tables.evidenceItems), proposals: await listRecords(config.feishu.tables.profileUpdateProposals), conflicts: await listRecords(config.feishu.tables.evidenceConflicts), customers: await listRecords(config.feishu.tables.customers), profileChanges: await listRecords(config.feishu.tables.profileChanges) } }
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
  const staffRows = await listRecords(config.feishu.tables.staff)
  const adminRow = staffRows.find((row) => String(readField('staff', row.fields, 'permission_role') || readField('staff', row.fields, 'role')) === 'ADMIN' && String(readField('staff', row.fields, 'status')) === 'ACTIVE' && readField('staff', row.fields, 'login_enabled') !== false)
  assert(adminRow, 'no active admin found')
  const adminId = String(readField('staff', adminRow.fields, 'staff_id') || adminRow.record_id)
  await createRecord(config.feishu.tables.customers, mapFields('customers', { customer_id: customerId, nickname: customerId, phone, source: prefix, notes: 'temporary Stage 2 integration customer', created_at: new Date().toISOString(), sabc: 'C', is_paid: false, city: '南京', birth_date: '1990-01-01', profile_schema_version: 'v1.0' }))
  const voiceSource = await repository.createSource(adminId, { customerId, sourceType: 'VOICE_TRANSCRIPT', title: `${prefix} voice transcript`, sourceRole: 'CUSTOMER', rawText: '我最近开始跑步。' })
  assert(voiceSource.sourceType === 'VOICE_TRANSCRIPT', 'voice transcript source type mismatch')
  const source = await repository.createSource(adminId, { customerId, sourceType: 'TEXT_INPUT', title: `${prefix} customer note`, sourceRole: 'CUSTOMER', rawText: '我今年35岁，现在住在杭州工作。我觉得没人理解我，也许我只是害怕失败。' })
  assert(source.processingStatus === 'UPLOADED', 'source was not persisted before processing')
  let duplicateRejected = false
  try { await repository.createSource(adminId, { customerId, sourceType: 'TEXT_INPUT', title: `${prefix} duplicate`, sourceRole: 'CUSTOMER', rawText: '我今年35岁，现在住在杭州工作。我觉得没人理解我，也许我只是害怕失败。' }) } catch (error) { duplicateRejected = error?.code === 'SOURCE_DUPLICATE' }
  assert(duplicateRejected, 'duplicate source was not blocked')
  const processed = await repository.processSource(adminId, source.id)
  assert(['REVIEW_REQUIRED', 'COMPLETED'].includes(processed.source.processingStatus), 'source processing status invalid')
  assert(processed.evidenceItems.length > 0, 'AI did not create evidence')
  const workspace = await repository.sourceWorkspace(adminId, customerId)
  assert(workspace.sources.length === 2 && workspace.evidenceItems.length === processed.evidenceItems.length, 'workspace readback mismatch')
  for (const evidenceType of ['FACT', 'SELF_MEANING', 'HYPOTHESIS']) assert(processed.evidenceItems.some((item) => item.evidenceType === evidenceType), `evidence type missing: ${evidenceType}`)
  assert(workspace.proposals.some((item) => ['ADD', 'UPDATE', 'APPEND'].includes(item.action)), 'ordinary mutable proposal missing')
  assert(!workspace.conflicts.some((item) => item.conflictType === 'POSSIBLE_STATE_CHANGE' && item.status === 'OPEN'), 'ordinary state change interrupted the workflow')
  const autoApplied = workspace.proposals.find((item) => item.reviewStatus === 'CONFIRMED' && item.action !== 'REVIEW_REQUIRED')
  assert(autoApplied, 'ordinary mutable update was not auto-applied')
  const afterAutoApply = await repository.load()
  assert(afterAutoApply.profileChanges.some((item) => item.customerId === customerId && item.sourceRecordId === source.id && item.evidenceId === autoApplied.evidenceId), 'ProfileChanges provenance links missing')
  const factSource = await repository.createSource(adminId, { customerId, sourceType: 'PASTED_TRANSCRIPT', title: `${prefix} stable fact note`, sourceRole: 'CUSTOMER', rawText: '客户明确补充：我的出生日期是 1991-01-01，这个日期是确定的。' })
  const factProcessed = await repository.processSource(adminId, factSource.id)
  const factConflict = (await repository.sourceWorkspace(adminId, customerId)).conflicts.find((item) => item.newEvidenceId && factProcessed.evidenceItems.some((evidence) => evidence.id === item.newEvidenceId) && item.conflictType === 'FACT_CONTRADICTION' && item.status === 'OPEN')
  assert(factConflict, 'stable fact conflict missing')
  await repository.resolveConflict(adminId, factConflict.id, 'KEEP_CURRENT')
  const mentorSource = await repository.createSource(adminId, { customerId, sourceType: 'SERVICE_TRANSCRIPT', title: `${prefix} mentor note`, sourceRole: 'MENTOR', rawText: '导师记录：谈到父亲时明显回避。' })
  const mentorProcessed = await repository.processSource(adminId, mentorSource.id)
  assert(mentorProcessed.evidenceItems.every((item) => item.evidenceType !== 'OBSERVATION' || (item.sourceId === mentorSource.id && item.sourceRole === 'MENTOR')), 'mentor observation source link mismatch')
  assert(mentorProcessed.evidenceItems.some((item) => item.evidenceType === 'OBSERVATION' && item.sourceRole === 'MENTOR'), 'mentor observation evidence missing')
  const mentorReload = await repository.sourceDetail(adminId, mentorSource.id)
  assert(mentorReload.source.sourceRole === 'MENTOR' && mentorReload.evidenceItems.length === mentorProcessed.evidenceItems.length, 'mentor source reload mismatch')
  let finalWorkspace = await repository.sourceWorkspace(adminId, customerId)
  for (const conflict of finalWorkspace.conflicts.filter((item) => item.status === 'OPEN')) await repository.resolveConflict(adminId, conflict.id, conflict.conflictType === 'FACT_CONTRADICTION' ? 'KEEP_CURRENT' : 'KEEP_BOTH')
  finalWorkspace = await repository.sourceWorkspace(adminId, customerId)
  const result = { ok: true, prefix, sourceCreated: true, voiceSourceCreated: true, duplicateRejected, evidenceCount: processed.evidenceItems.length, proposalCount: workspace.proposals.length, ordinaryStateChangeAutoApplied: true, factContradictionResolved: true, factEvidenceCount: factProcessed.evidenceItems.length, mentorEvidenceCount: mentorProcessed.evidenceItems.length, customerUpdateConfirmed: true, unresolvedConflicts: finalWorkspace.conflicts.filter((item) => item.status === 'OPEN').length }
  console.log(JSON.stringify(result))
} catch (error) {
  const context = error?.integrationContext ? { ...error.integrationContext, table_id: maskId(error.integrationContext.table_id) } : undefined
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'integration failed', provider_code: error?.providerCode, provider_message: error?.providerMessage, provider_request_id: error?.providerRequestId, http_status: error?.httpStatus, integration_context: context }))
  process.exitCode = 1
} finally {
  try { await cleanup() } catch (error) { console.error(JSON.stringify({ cleanup: 'FAILED', message: error instanceof Error ? error.message : 'cleanup failed' })); process.exitCode = 1 }
}
