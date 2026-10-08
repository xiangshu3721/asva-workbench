import { config } from '../server/config.mjs'
import { listRecords } from '../server/feishu.mjs'
import { EVIDENCE_REVIEW_STATUSES, EVIDENCE_TYPES, SEMANTIC_KINDS, SOURCE_STATUSES, SOURCE_TYPES, PROPOSAL_ACTIONS, CHANGE_TYPES, CONFLICT_STATUSES, CONFLICT_TYPES } from '../shared/evidence-contract.mjs'
import { read as readField } from '../server/field-mapping.mjs'

const names = ['sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']
if (names.some((name) => !config.feishu.tables[name])) {
  console.log(JSON.stringify({ ok: false, status: 'NOT_CONFIGURED', missingTables: names.filter((name) => !config.feishu.tables[name]) }))
  process.exit(0)
}
const rows = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await listRecords(config.feishu.tables[name])])))
const value = (table, row, key) => readField(table, row.fields, key)
const sources = rows.sourceRecords
const evidence = rows.evidenceItems
const proposals = rows.profileUpdateProposals
const conflicts = rows.evidenceConflicts
const sourceIds = new Set(sources.map((row) => String(value('sourceRecords', row, 'source_id') || row.record_id)))
const evidenceIds = new Set(evidence.map((row) => String(value('evidenceItems', row, 'evidence_id') || row.record_id)))
const sourceHashes = new Set()
const issues = []
for (const row of sources) {
  const id = String(value('sourceRecords', row, 'source_id') || row.record_id)
  const customerId = String(value('sourceRecords', row, 'customer_id') || '')
  const hash = String(value('sourceRecords', row, 'content_hash') || '')
  const type = String(value('sourceRecords', row, 'source_type') || '')
  const status = String(value('sourceRecords', row, 'processing_status') || '')
  if (!customerId) issues.push(`SOURCE_NO_CUSTOMER:${id}`)
  if (!hash) issues.push(`SOURCE_NO_HASH:${id}`)
  const duplicate = `${customerId}:${hash}`
  if (sourceHashes.has(duplicate)) issues.push(`DUPLICATE_CONTENT_HASH:${duplicate}`)
  sourceHashes.add(duplicate)
  if (!SOURCE_TYPES.has(type) || !SOURCE_STATUSES.has(status)) issues.push(`INVALID_SOURCE_ENUM:${id}`)
}
for (const row of evidence) {
  const id = String(value('evidenceItems', row, 'evidence_id') || row.record_id)
  if (!String(value('evidenceItems', row, 'source_id') || '') || !sourceIds.has(String(value('evidenceItems', row, 'source_id')))) issues.push(`EVIDENCE_NO_SOURCE:${id}`)
  if (!String(value('evidenceItems', row, 'subject_id') || '')) issues.push(`EVIDENCE_NO_SUBJECT:${id}`)
  if (!EVIDENCE_TYPES.has(String(value('evidenceItems', row, 'evidence_type') || '')) || !SEMANTIC_KINDS.has(String(value('evidenceItems', row, 'semantic_kind') || '')) || !EVIDENCE_REVIEW_STATUSES.has(String(value('evidenceItems', row, 'review_status') || ''))) issues.push(`INVALID_EVIDENCE_ENUM:${id}`)
  if (['CONFIRMED'].includes(String(value('evidenceItems', row, 'review_status') || '')) && !String(value('evidenceItems', row, 'reviewer_id') || '')) issues.push(`CONFIRMED_EVIDENCE_NO_REVIEWER:${id}`)
}
for (const row of proposals) {
  const id = String(value('profileUpdateProposals', row, 'proposal_id') || row.record_id)
  if (!evidenceIds.has(String(value('profileUpdateProposals', row, 'evidence_id') || ''))) issues.push(`PROPOSAL_NO_EVIDENCE:${id}`)
  if (!PROPOSAL_ACTIONS.has(String(value('profileUpdateProposals', row, 'action') || '')) || !CHANGE_TYPES.has(String(value('profileUpdateProposals', row, 'change_type') || ''))) issues.push(`INVALID_PROPOSAL_ENUM:${id}`)
}
for (const row of conflicts) {
  const id = String(value('evidenceConflicts', row, 'conflict_id') || row.record_id)
  for (const key of ['current_evidence_id', 'new_evidence_id']) { const ref = String(value('evidenceConflicts', row, key) || ''); if (ref && !evidenceIds.has(ref)) issues.push(`CONFLICT_EVIDENCE_NOT_FOUND:${id}:${key}`) }
  if (!CONFLICT_TYPES.has(String(value('evidenceConflicts', row, 'conflict_type') || '')) || !CONFLICT_STATUSES.has(String(value('evidenceConflicts', row, 'status') || ''))) issues.push(`INVALID_CONFLICT_ENUM:${id}`)
}
console.log(JSON.stringify({ ok: issues.length === 0, status: 'PASS', counts: Object.fromEntries(names.map((name) => [name, rows[name].length])), issues }))
if (issues.length) process.exitCode = 1
