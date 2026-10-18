import { beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FEISHU_SOURCE_RECORDS_TABLE_ID ||= 'tbl-source-test'
process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID ||= 'tbl-evidence-test'
process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID ||= 'tbl-proposal-test'
process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID ||= 'tbl-conflict-test'
process.env.FEISHU_PROFILE_CHANGES_TABLE_ID ||= 'tbl-profile-change-test'

const { createRecordMock, updateRecordMock } = vi.hoisted(() => ({
  createRecordMock: vi.fn(),
  updateRecordMock: vi.fn(),
}))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return { ...actual, createRecord: createRecordMock, updateRecord: updateRecordMock }
})

const { config } = await import('./config.mjs')
const { FeishuRepository } = await import('./repository.mjs')

let activeDatabase
let recordSequence = 0
const json = (value) => { try { return JSON.parse(value) } catch { return value } }

function makeDatabase() {
  const customer = { id: 'CUS-SYNTH-1', name: 'Synthetic 客户', mentorId: 'MENTOR-A', profileFields: { city: '杭州', job_status: '在职' }, profileFieldMeta: {}, profileVersion: 1, profileSchemaVersion: 'v1.0', need: '', helpExpectation: '', goal: '', grade: 'C', paid: false, intendedCourse: '' }
  const source = { id: 'SRC-SYNTH-1', customerId: customer.id, subjectId: customer.id, sourceType: 'TEXT_INPUT', sourceRole: 'MENTOR', sourcePerspective: 'STAFF_REPORTED', rawText: '她目前已经长期住在深圳。', contentHash: 'hash-1', extractorVersion: 'evidence-v1', processingStatus: 'UPLOADED', processingVersion: 1, lastBatchId: '', _recordId: 'rec-source-1' }
  return { staff: [{ id: 'MENTOR-A', name: 'Synthetic Mentor A', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }, { id: 'MENTOR-B', name: 'Synthetic Mentor B', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }], customers: [customer], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [source], evidenceItems: [], _allEvidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: { customers: [{ record_id: 'rec-customer-1', fields: { '客户ID': customer.id } }], sourceRecords: [{ record_id: source._recordId, fields: {} }], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], profileChanges: [] } }
}

function appendCreated(tableId, fields) {
  const recordId = `rec-${++recordSequence}`
  if (tableId === config.feishu.tables.evidenceItems) {
    activeDatabase._allEvidenceItems.push({ id: fields['证据ID'], sourceId: fields['资料ID'], customerId: fields['客户ID'], subjectId: fields['主体ID'], evidenceType: fields['证据类型'], semanticKind: fields['语义类型'], fieldKey: fields['字段Key'], standardValue: json(fields['标准值']), displayText: fields['展示文本'], sourceExcerpt: fields['原文摘录'], locator: json(fields['资料定位']), occurredAt: fields['发生时间'], confidence: Number(fields['置信度']), reviewStatus: fields['审核状态'], extractionBatchId: fields['提取批次ID'], _recordId: recordId })
    activeDatabase._rows.evidenceItems.push({ record_id: recordId, fields })
  } else if (tableId === config.feishu.tables.profileUpdateProposals) {
    activeDatabase.profileUpdateProposals.push({ id: fields['建议ID'], customerId: fields['客户ID'], subjectId: fields['主体ID'], evidenceId: fields['证据ID'], sourceId: fields['资料ID'], fieldKey: fields['字段Key'], fieldName: fields['字段名称'], currentValue: json(fields['当前值']), proposedValue: json(fields['建议值']), action: fields['建议动作'], changeType: fields['变化类型'], reviewStatus: fields['审核状态'], confidence: Number(fields['置信度']), extractionBatchId: fields['批次ID'], _recordId: recordId })
    activeDatabase._rows.profileUpdateProposals.push({ record_id: recordId, fields })
  } else if (tableId === config.feishu.tables.evidenceConflicts) {
    activeDatabase.evidenceConflicts.push({ id: fields['冲突ID'], subjectId: fields['主体ID'], customerId: fields['客户ID'], fieldKey: fields['字段Key'], conflictType: fields['冲突类型'], currentValue: json(fields['当前值']), newValue: json(fields['新值']), currentEvidenceId: fields['当前证据ID'], newEvidenceId: fields['新证据ID'], status: fields['状态'], _recordId: recordId })
    activeDatabase._rows.evidenceConflicts.push({ record_id: recordId, fields })
  } else if (tableId === config.feishu.tables.profileChanges) activeDatabase.profileChanges.push({ id: recordId, customerId: fields['客户ID'], field: fields['字段'], oldValue: json(fields['旧值']), newValue: json(fields['新值']), source: fields['变更来源'], confirmed: fields['已确认'] })
  return { record: { record_id: recordId } }
}

function updateExisting(tableId, recordId, fields) {
  if (tableId === config.feishu.tables.sourceRecords) { const source = activeDatabase.sourceRecords.find((item) => item._recordId === recordId); if (source) { if (fields['处理状态']) source.processingStatus = fields['处理状态']; if (fields['处理版本'] !== undefined) source.processingVersion = Number(fields['处理版本']) || source.processingVersion; if (fields['最近提取批次ID'] !== undefined) source.lastBatchId = fields['最近提取批次ID'] || '' } }
  if (tableId === config.feishu.tables.evidenceItems) { const evidence = activeDatabase._allEvidenceItems.find((item) => item._recordId === recordId); if (evidence && fields['审核状态']) evidence.reviewStatus = fields['审核状态'] }
  if (tableId === config.feishu.tables.profileUpdateProposals) { const proposal = activeDatabase.profileUpdateProposals.find((item) => item._recordId === recordId); if (proposal && fields['审核状态']) proposal.reviewStatus = fields['审核状态'] }
  if (tableId === config.feishu.tables.evidenceConflicts) { const conflict = activeDatabase.evidenceConflicts.find((item) => item._recordId === recordId); if (conflict) { if (fields['状态']) conflict.status = fields['状态']; if (fields['解决结果']) conflict.resolution = fields['解决结果'] } }
  return { record: { record_id: recordId } }
}

beforeEach(() => {
  activeDatabase = makeDatabase()
  recordSequence = 0
  createRecordMock.mockReset().mockImplementation((tableId, fields) => appendCreated(tableId, fields))
  updateRecordMock.mockReset().mockImplementation((tableId, recordId, fields) => updateExisting(tableId, recordId, fields))
})

function setupRepository(extractor = async () => [{ evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'living_status', value: '深圳', display_text: '当前居住地为深圳', source_excerpt: '她目前已经长期住在深圳。', confidence: 0.96, locator: { paragraph_index: 0 } }]) {
  const repository = new FeishuRepository({ evidenceExtractor: extractor })
  repository.load = async () => {
    const allEvidence = activeDatabase._allEvidenceItems
    const currentSource = activeDatabase.sourceRecords.find((item) => item.id === 'SRC-SYNTH-1')
    const evidenceItems = allEvidence.filter((item) => item.reviewStatus === 'CONFIRMED' || (item.reviewStatus === 'PENDING_REVIEW' && (!currentSource?.lastBatchId || currentSource.lastBatchId === item.extractionBatchId)))
    const evidenceIds = new Set(evidenceItems.map((item) => item.id))
    return { ...activeDatabase, evidenceItems, _allEvidenceItems: allEvidence, profileUpdateProposals: activeDatabase.profileUpdateProposals.filter((item) => evidenceIds.has(item.evidenceId)), evidenceConflicts: activeDatabase.evidenceConflicts.filter((item) => evidenceIds.has(item.newEvidenceId) || evidenceIds.has(item.currentEvidenceId)) }
  }
  repository.markSafetyStale = async () => {}
  repository.scheduleCustomerUnderstandingRefresh = () => {}
  return repository
}

describe('R036 source-scoped evidence replacement and conflict confirmation', () => {
  it('serializes concurrent retries and keeps source/evidence counts stable across three retries', async () => {
    const repository = setupRepository()
    const first = await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    expect(first.evidenceItems).toHaveLength(1)
    expect(activeDatabase.evidenceConflicts).toHaveLength(1)
    expect(activeDatabase.evidenceConflicts[0].fieldKey).toBe('city')
    const sourceCount = activeDatabase.sourceRecords.length
    const evidenceCount = activeDatabase._allEvidenceItems.length
    await Promise.all([repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true }), repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })])
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    expect(activeDatabase.sourceRecords).toHaveLength(sourceCount)
    expect(activeDatabase._allEvidenceItems).toHaveLength(evidenceCount + 4)
    expect(activeDatabase._allEvidenceItems.filter((item) => item.reviewStatus !== 'SUPERSEDED')).toHaveLength(1)
    const finalDatabase = await repository.load()
    expect(finalDatabase.profileUpdateProposals).toHaveLength(1)
    expect(finalDatabase.evidenceConflicts).toHaveLength(1)
  })

  it('lets the assigned mentor overwrite once, preserves history, and makes resolution double-click idempotent', async () => {
    const repository = setupRepository()
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const conflict = activeDatabase.evidenceConflicts[0]
    const beforeChanges = activeDatabase.profileChanges.length
    await repository.resolveConflict('MENTOR-A', conflict.id, 'USE_NEW')
    expect(activeDatabase.customers[0].profileFields.city).toBe('深圳')
    expect(activeDatabase.customers[0].profileFieldMeta.city).toMatchObject({ source: 'MENTOR_CONFIRMED', confirmed: true })
    expect(activeDatabase.profileChanges.length).toBe(beforeChanges + 1)
    expect(activeDatabase.evidenceConflicts[0].status).toBe('RESOLVED')
    await repository.resolveConflict('MENTOR-A', conflict.id, 'USE_NEW')
    expect(activeDatabase.profileChanges.length).toBe(beforeChanges + 1)
    const oldEvidenceCount = activeDatabase._allEvidenceItems.length
    const retryWithOldValue = setupRepository(async () => [{ evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'city', value: '杭州', display_text: '当前居住地为杭州', source_excerpt: '她现在又说住在杭州', confidence: 0.96, locator: { paragraph_index: 0 } }])
    activeDatabase.sourceRecords[0].processingStatus = 'COMPLETED'
    activeDatabase.sourceRecords[0].rawText = '她目前已经长期住在深圳。她现在又说住在杭州'
    await retryWithOldValue.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    expect(activeDatabase.customers[0].profileFields.city).toBe('深圳')
    expect(activeDatabase._allEvidenceItems.length).toBe(oldEvidenceCount + 1)
    expect(activeDatabase._allEvidenceItems.filter((item) => item.reviewStatus === 'CONFIRMED')).toHaveLength(1)
  })

  it('keeps the current profile while retaining new source and evidence', async () => {
    const repository = setupRepository()
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const conflict = activeDatabase.evidenceConflicts[0]
    const evidenceId = conflict.newEvidenceId
    await repository.resolveConflict('MENTOR-A', conflict.id, 'KEEP_CURRENT')
    expect(activeDatabase.customers[0].profileFields.city).toBe('杭州')
    expect(activeDatabase._allEvidenceItems.some((item) => item.id === evidenceId)).toBe(true)
    expect(activeDatabase.evidenceConflicts[0].status).toBe('RESOLVED')
    expect(activeDatabase._allEvidenceItems.find((item) => item.id === evidenceId).reviewStatus).toBe('REJECTED')
  })

  it('preserves old evidence when a forced retry fails after prior success', async () => {
    const repository = setupRepository()
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const evidenceCount = activeDatabase._allEvidenceItems.length
    activeDatabase.sourceRecords[0].processingStatus = 'COMPLETED'
    const failingRepository = setupRepository(async () => { throw new Error('synthetic retry failure') })
    await expect(failingRepository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })).rejects.toThrow('synthetic retry failure')
    expect(activeDatabase._allEvidenceItems).toHaveLength(evidenceCount)
  })

  it('preserves the previous active generation when a replacement batch is empty', async () => {
    const repository = setupRepository()
    const first = await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const previousBatchId = first.source.lastBatchId
    const previousActiveCount = (await repository.load()).evidenceItems.length
    activeDatabase.sourceRecords[0].processingStatus = 'COMPLETED'

    const emptyRepository = setupRepository(async () => [])
    const result = await emptyRepository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })

    expect(result.source.processingStatus).toBe('REVIEW_REQUIRED')
    expect(result.source.lastBatchId).toBe(previousBatchId)
    expect((await emptyRepository.load()).evidenceItems).toHaveLength(previousActiveCount)
    expect(activeDatabase._allEvidenceItems.filter((item) => item.reviewStatus === 'SUPERSEDED')).toHaveLength(0)
  })

  it('preserves the previous active generation when all replacement candidates fail grounding', async () => {
    const repository = setupRepository()
    const first = await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const previousBatchId = first.source.lastBatchId
    const previousActiveCount = (await repository.load()).evidenceItems.length
    activeDatabase.sourceRecords[0].processingStatus = 'COMPLETED'

    const groundingFailureRepository = setupRepository(async () => [{ evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'city', value: '深圳', display_text: '当前居住地为深圳', source_excerpt: '这段话不在当前资料中', confidence: 0.96, locator: { paragraph_index: 0 } }])
    const result = await groundingFailureRepository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })

    expect(result.source.processingStatus).toBe('REVIEW_REQUIRED')
    expect(result.source.lastBatchId).toBe(previousBatchId)
    expect((await groundingFailureRepository.load()).evidenceItems).toHaveLength(previousActiveCount)
    expect(activeDatabase._allEvidenceItems.filter((item) => item.reviewStatus === 'SUPERSEDED')).toHaveLength(0)
  })

  it('does not expose another mentor customer conflicts', async () => {
    const repository = setupRepository()
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    await expect(repository.resolveConflict('MENTOR-B', activeDatabase.evidenceConflicts[0].id, 'USE_NEW')).rejects.toThrow('冲突不存在')
  })

  it('does not create a conflict for a future plan event', async () => {
    const repository = setupRepository(async () => [{ evidence_type: 'FACT', semantic_kind: 'EVENT', field_key: 'city', value: '深圳', display_text: '计划下个月去深圳', source_excerpt: '她计划下个月去深圳看看', confidence: 0.95, locator: { paragraph_index: 0 } }])
    activeDatabase.sourceRecords[0].rawText = '她计划下个月去深圳看看，目前工作和居住都没有变化。'
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    expect(activeDatabase.customers[0].profileFields.city).toBe('杭州')
    expect(activeDatabase.evidenceConflicts).toHaveLength(0)
  })

  it('keeps valid candidates when one candidate fails source grounding', async () => {
    const repository = setupRepository(async () => [
      { evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'living_status', value: '深圳', display_text: '当前居住地为深圳', source_excerpt: '她目前已经长期住在深圳。', confidence: 0.96, locator: { paragraph_index: 0 } },
      { evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'job_status', value: '已离职', display_text: '当前工作状态为已离职', source_excerpt: '这段话并不在原始资料中', confidence: 0.9, locator: { paragraph_index: 0 } },
    ])
    const result = await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    expect(result.source.processingStatus).toBe('REVIEW_REQUIRED')
    expect(result.evidenceItems.filter((item) => item.reviewStatus !== 'SUPERSEDED')).toHaveLength(1)
    expect(result.evidenceItems[0].fieldKey).toBe('city')
  })

  it('keeps an unknown canonical candidate auditable without failing the source', async () => {
    const repository = setupRepository(async () => [
      { evidence_type: 'SELF_MEANING', semantic_kind: 'OTHER', field_key: 'unknown_internal_field', value: '希望慢一点', display_text: '客户希望节奏慢一点', source_excerpt: '她希望慢一点', confidence: 0.9, locator: { paragraph_index: 0 } },
      { evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'living_status', value: '深圳', display_text: '当前居住地为深圳', source_excerpt: '她目前已经长期住在深圳。', confidence: 0.96, locator: { paragraph_index: 0 } },
    ])
    activeDatabase.sourceRecords[0].rawText = '她希望慢一点。她目前已经长期住在深圳。'
    const result = await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    expect(result.source.processingStatus).toBe('REVIEW_REQUIRED')
    expect(result.evidenceItems).toHaveLength(2)
    expect(result.evidenceItems.some((item) => !item.fieldKey)).toBe(true)
    expect(result.evidenceItems.some((item) => item.fieldKey === 'city')).toBe(true)
  })

  it('replaces wording-drifted AI evidence without creating a second active item', async () => {
    const repository = setupRepository()
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const drifted = setupRepository(async () => [{ evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'city', value: '深圳', display_text: '现居住地为深圳', source_excerpt: '她目前已经长期住在深圳。', confidence: 0.91, locator: { paragraph_index: 0, char_start: 0, char_end: 12 } }])
    await drifted.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const current = await drifted.load()
    expect(current.evidenceItems.filter((item) => item.sourceId === 'SRC-SYNTH-1')).toHaveLength(1)
    expect(activeDatabase._allEvidenceItems).toHaveLength(2)
    expect(activeDatabase._allEvidenceItems.filter((item) => item.reviewStatus === 'SUPERSEDED')).toHaveLength(1)
  })

  it('reconciles a four-item set down to three items', async () => {
    let candidates = ['a', 'b', 'c', 'd'].map((value) => ({ evidence_type: 'SELF_MEANING', semantic_kind: 'OTHER', field_key: 'goal', value, display_text: `事件${value}`, source_excerpt: value, confidence: 0.9, locator: { paragraph_index: 0 } }))
    activeDatabase.sourceRecords[0].rawText = 'a b c d e'
    const repository = setupRepository(async () => candidates)
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    candidates = ['a', 'b', 'c'].map((value) => ({ evidence_type: 'SELF_MEANING', semantic_kind: 'OTHER', field_key: 'goal', value, display_text: `事件${value}`, source_excerpt: value, confidence: 0.9, locator: { paragraph_index: 0 } }))
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    expect((await repository.load()).evidenceItems.filter((item) => item.sourceId === 'SRC-SYNTH-1')).toHaveLength(3)
  })

  it('reconciles a three-item set up to five items without retaining stale active evidence', async () => {
    let candidates = ['a', 'b', 'c'].map((value) => ({ evidence_type: 'FACT', semantic_kind: 'EVENT', field_key: 'goal', value, display_text: `事件${value}`, source_excerpt: value, confidence: 0.9, locator: { paragraph_index: 0 } }))
    activeDatabase.sourceRecords[0].rawText = 'a b c d e'
    const repository = setupRepository(async () => candidates)
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    candidates = ['a', 'b', 'c', 'd', 'e'].map((value) => ({ evidence_type: 'FACT', semantic_kind: 'EVENT', field_key: 'goal', value, display_text: `事件${value}`, source_excerpt: value, confidence: 0.9, locator: { paragraph_index: 0 } }))
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    expect((await repository.load()).evidenceItems.filter((item) => item.sourceId === 'SRC-SYNTH-1')).toHaveLength(5)
  })

  it('keeps the previous active batch when the replacement write partially fails', async () => {
    const repository = setupRepository()
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const previousBatch = activeDatabase.sourceRecords[0].lastBatchId
    const previousActiveCount = (await repository.load()).evidenceItems.length
    createRecordMock.mockImplementation((tableId, fields) => {
      if (tableId === config.feishu.tables.evidenceItems) throw new Error('synthetic partial write failure')
      return appendCreated(tableId, fields)
    })
    await expect(repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })).rejects.toThrow('synthetic partial write failure')
    expect(activeDatabase.sourceRecords[0].lastBatchId).toBe(previousBatch)
    expect((await repository.load()).evidenceItems).toHaveLength(previousActiveCount)
  })

  it('does not expose proposals or conflicts that point to superseded evidence', async () => {
    const repository = setupRepository()
    await repository.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const firstEvidenceId = activeDatabase.evidenceConflicts[0].newEvidenceId
    activeDatabase.sourceRecords[0].rawText = '她目前已经长期住在深圳。她现在又说住在杭州'
    const drifted = setupRepository(async () => [{ evidence_type: 'FACT', semantic_kind: 'CURRENT_STATE', field_key: 'city', value: '杭州', display_text: '当前居住地为杭州', source_excerpt: '她现在又说住在杭州', confidence: 0.9, locator: { paragraph_index: 0 } }])
    await drifted.processSource('MENTOR-A', 'SRC-SYNTH-1', { force: true })
    const current = await drifted.load()
    expect(current.evidenceItems.some((item) => item.id === firstEvidenceId)).toBe(false)
    expect(current.profileUpdateProposals.every((item) => current.evidenceItems.some((evidence) => evidence.id === item.evidenceId))).toBe(true)
    expect(current.evidenceConflicts.every((item) => current.evidenceItems.some((evidence) => evidence.id === item.newEvidenceId || evidence.id === item.currentEvidenceId))).toBe(true)
  })
})
