import { beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FEISHU_SOURCE_RECORDS_TABLE_ID ||= 'tbl-source-visibility-test'
process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID ||= 'tbl-evidence-visibility-test'
process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID ||= 'tbl-proposal-visibility-test'
process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID ||= 'tbl-conflict-visibility-test'

const { createRecordMock, getRecordMock, listRecordsMock, updateRecordMock } = vi.hoisted(() => ({
  createRecordMock: vi.fn(),
  getRecordMock: vi.fn(),
  listRecordsMock: vi.fn(),
  updateRecordMock: vi.fn(),
}))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return { ...actual, createRecord: createRecordMock, getRecord: getRecordMock, listRecords: listRecordsMock, updateRecord: updateRecordMock }
})

const { FeishuRepository } = await import('./repository.mjs')
const { config } = await import('./config.mjs')

describe('source save visibility readback', () => {
  let activeDatabase
  let sourceRow

  beforeEach(() => {
    activeDatabase = {
      staff: [{ id: 'ADMIN-1', name: 'Synthetic Admin', permissionRole: 'ADMIN', role: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{ id: 'CUS-VIS-1', name: 'Visibility Customer', mentorId: null, profileFields: {}, profileFieldMeta: {} }],
      appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
      _rows: { sourceRecords: [] },
    }
    sourceRow = null
    createRecordMock.mockReset().mockImplementation((tableId, fields) => {
      if (tableId === config.feishu.tables.sourceRecords) {
        sourceRow = { record_id: 'rec-source-vis-1', fields }
        return { record: { record_id: sourceRow.record_id } }
      }
      return { record: { record_id: 'rec-unused' } }
    })
    getRecordMock.mockReset().mockImplementation(async (tableId, recordId) => {
      if (tableId === config.feishu.tables.sourceRecords && sourceRow && recordId === sourceRow.record_id) return sourceRow
      return null
    })
    listRecordsMock.mockReset().mockImplementation(async () => {
      throw new Error('save path must not list entire sourceRecords table')
    })
    updateRecordMock.mockReset().mockImplementation(async (tableId, recordId, fields) => {
      if (tableId === config.feishu.tables.sourceRecords && sourceRow) sourceRow = { ...sourceRow, fields: { ...sourceRow.fields, ...fields } }
      return { record: { record_id: recordId } }
    })
  })

  it('confirms a saved source by record id without listing the whole table', async () => {
    const repository = new FeishuRepository()
    repository.load = async () => activeDatabase

    const source = await repository.createSource('ADMIN-1', {
      customerId: 'CUS-VIS-1',
      sourceType: 'TEXT_INPUT',
      rawText: '原始资料必须完整保存',
      operationId: 'visibility-op-1',
    })

    expect(source.rawText).toBe('原始资料必须完整保存')
    expect(source._persistenceStatus === 'COMMITTED' || source.processingStatus === 'UPLOADED').toBe(true)
    expect(createRecordMock).toHaveBeenCalledTimes(1)
    expect(getRecordMock).toHaveBeenCalledWith(config.feishu.tables.sourceRecords, 'rec-source-vis-1')
    expect(listRecordsMock).not.toHaveBeenCalled()
  })

  it('still reports success with original text when getRecord is briefly delayed', async () => {
    getRecordMock.mockResolvedValue(null)
    const repository = new FeishuRepository()
    repository.load = async () => activeDatabase

    const source = await repository.createSource('ADMIN-1', {
      customerId: 'CUS-VIS-1',
      sourceType: 'TEXT_INPUT',
      rawText: '延迟回读也要保留原文',
      operationId: 'visibility-delayed-1',
    })

    expect(createRecordMock).toHaveBeenCalledTimes(1)
    expect(source.rawText).toBe('延迟回读也要保留原文')
    expect(source).toMatchObject({ _persistenceStatus: 'COMMITTED', _dataFreshness: 'DELAYED' })
    expect(listRecordsMock).not.toHaveBeenCalled()
  })
})
