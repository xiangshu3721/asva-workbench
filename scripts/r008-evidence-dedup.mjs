import { config } from '../server/config.mjs'
import { deleteRecord, listRecords, updateRecord } from '../server/feishu.mjs'
import { fields, read as readField } from '../server/field-mapping.mjs'
import { evidenceEquivalent, normalizeEvidenceLocator, normalizeEvidenceValue, normalizeEvidenceEventTime } from '../shared/evidence-contract.mjs'

const TARGET_SOURCE_IDS = new Set(['SRC-532f450395121352b046cb72', 'SRC-8887e8a8cb90122f254d8d3b'])
const apply = process.argv.includes('--apply')

function text(value) { return value === null || value === undefined ? '' : String(value).trim() }
function json(value) { try { return JSON.parse(text(value) || 'null') } catch { return null } }
function value(table, row, key) { return readField(table, row.fields, key) }
function evidence(row) {
  return {
    id: text(value('evidenceItems', row, 'evidence_id')) || row.record_id,
    recordId: row.record_id,
    sourceId: text(value('evidenceItems', row, 'source_id')),
    evidenceType: text(value('evidenceItems', row, 'evidence_type')),
    semanticKind: text(value('evidenceItems', row, 'semantic_kind')),
    fieldKey: text(value('evidenceItems', row, 'field_key')),
    standardValue: json(value('evidenceItems', row, 'standard_value')),
    occurredAt: text(value('evidenceItems', row, 'occurred_at')),
    locator: json(value('evidenceItems', row, 'locator_json')) || {},
    reviewStatus: text(value('evidenceItems', row, 'review_status')),
    createdAt: text(value('evidenceItems', row, 'created_at')),
  }
}

function referenceCount(item, proposals, conflicts, profileChanges) {
  return proposals.filter((row) => text(value('profileUpdateProposals', row, 'evidence_id')) === item.id).length
    + conflicts.filter((row) => [text(value('evidenceConflicts', row, 'current_evidence_id')), text(value('evidenceConflicts', row, 'new_evidence_id'))].includes(item.id)).length
    + profileChanges.filter((row) => text(value('profileChanges', row, 'evidence_id')) === item.id).length
}

function locatorCompleteness(locator) {
  const normalized = normalizeEvidenceLocator(locator)
  return [normalized.paragraphIndex, normalized.charStart, normalized.charEnd].filter((item) => item !== null).length
}

function canonicalFor(group, proposals, conflicts, profileChanges) {
  return [...group].sort((left, right) => {
    const refDelta = referenceCount(right, proposals, conflicts, profileChanges) - referenceCount(left, proposals, conflicts, profileChanges)
    if (refDelta) return refDelta
    const confirmedDelta = Number(right.reviewStatus === 'CONFIRMED') - Number(left.reviewStatus === 'CONFIRMED')
    if (confirmedDelta) return confirmedDelta
    const createdDelta = String(left.createdAt).localeCompare(String(right.createdAt))
    if (createdDelta) return createdDelta
    return locatorCompleteness(right.locator) - locatorCompleteness(left.locator)
  })[0]
}

function groupEvidence(items) {
  const groups = []
  for (const item of items) {
    const group = groups.find((candidate) => evidenceEquivalent(candidate[0], item))
    if (group) group.push(item)
    else groups.push([item])
  }
  return groups.filter((group) => group.length > 1)
}

function summary(item, references) {
  return { source_id: item.sourceId, evidence_id: item.id, evidence_type: item.evidenceType, semantic_kind: item.semanticKind, field_key: item.fieldKey, normalized_value: normalizeEvidenceValue(item.standardValue), event_time: normalizeEvidenceEventTime(item.occurredAt), source_locator: normalizeEvidenceLocator(item.locator), review_status: item.reviewStatus, created_at: item.createdAt, references }
}

const [sourceRows, evidenceRows, proposalRows, conflictRows, profileChangeRows] = await Promise.all([
  listRecords(config.feishu.tables.sourceRecords),
  listRecords(config.feishu.tables.evidenceItems),
  listRecords(config.feishu.tables.profileUpdateProposals),
  listRecords(config.feishu.tables.evidenceConflicts),
  listRecords(config.feishu.tables.profileChanges),
])
const targetSources = new Set(sourceRows.map((row) => text(value('sourceRecords', row, 'source_id')) || row.record_id).filter((id) => TARGET_SOURCE_IDS.has(id)))
const allEvidence = evidenceRows.map(evidence)
const results = []

for (const sourceId of TARGET_SOURCE_IDS) {
  const sourceEvidence = allEvidence.filter((item) => item.sourceId === sourceId)
  const groups = groupEvidence(sourceEvidence)
  const actions = groups.map((group) => {
    const canonical = canonicalFor(group, proposalRows, conflictRows, profileChangeRows)
    const duplicates = group.filter((item) => item.id !== canonical.id)
    return { canonical, duplicates, items: group.map((item) => summary(item, { proposals: referenceCount(item, proposalRows, [], []), conflicts: referenceCount(item, [], conflictRows, []), profileChanges: referenceCount(item, [], [], profileChangeRows) })) }
  })
  results.push({ sourceId, sourceFound: targetSources.has(sourceId), evidenceCount: sourceEvidence.length, duplicateGroups: actions.length, duplicateExtraRows: actions.reduce((sum, action) => sum + action.duplicates.length, 0), actions })
}

console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', results }))
if (!apply) process.exit(0)

for (const result of results) {
  for (const action of result.actions) {
    const canonicalId = action.canonical.id
    for (const row of proposalRows.filter((candidate) => action.duplicates.some((duplicate) => duplicate.id === text(value('profileUpdateProposals', candidate, 'evidence_id'))))) {
      await updateRecord(config.feishu.tables.profileUpdateProposals, row.record_id, fields('profileUpdateProposals', { evidence_id: canonicalId }))
    }
    for (const row of conflictRows) {
      const currentId = text(value('evidenceConflicts', row, 'current_evidence_id'))
      const newId = text(value('evidenceConflicts', row, 'new_evidence_id'))
      const updates = {}
      if (action.duplicates.some((duplicate) => duplicate.id === currentId)) updates.current_evidence_id = canonicalId
      if (action.duplicates.some((duplicate) => duplicate.id === newId)) updates.new_evidence_id = canonicalId
      if (Object.keys(updates).length) await updateRecord(config.feishu.tables.evidenceConflicts, row.record_id, fields('evidenceConflicts', updates))
    }
    for (const row of profileChangeRows.filter((candidate) => action.duplicates.some((duplicate) => duplicate.id === text(value('profileChanges', candidate, 'evidence_id'))))) {
      await updateRecord(config.feishu.tables.profileChanges, row.record_id, fields('profileChanges', { evidence_id: canonicalId }))
    }
    for (const duplicate of action.duplicates) {
      const row = evidenceRows.find((candidate) => candidate.record_id === duplicate.recordId)
      if (row) await deleteRecord(config.feishu.tables.evidenceItems, row.record_id)
    }
  }
}

console.log(JSON.stringify({ applied: true, deletedEvidence: results.reduce((sum, result) => sum + result.duplicateExtraRows, 0) }))
