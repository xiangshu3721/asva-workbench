import { beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FEISHU_SOURCE_RECORDS_TABLE_ID ||= 'tbl-source-save-test'
process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID ||= 'tbl-evidence-save-test'
process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID ||= 'tbl-proposal-save-test'
process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID ||= 'tbl-conflict-save-test'

const { createRecordMock, listRecordsMock, searchRecordsMock, updateRecordMock } = vi.hoisted(() => ({
  createRecordMock: vi.fn(),
  listRecordsMock: vi.fn(),
  searchRecordsMock: vi.fn(),
  updateRecordMock: vi.fn(),
}))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return { ...actual, createRecord: createRecordMock, listRecords: listRecordsMock, searchRecords: searchRecordsMock, updateRecord: updateRecordMock }
})

const { FeishuRepository } = await import('./repository.mjs')
const { config } = await import('./config.mjs')
const { createDialogueAnalysisToken, finalizeDialogueConfirmation } = await import('../shared/dialogue-gate.mjs')
const { contentHash } = await import('../shared/evidence-contract.mjs')

let activeDatabase
let sourceRow

function withDialogueConfirmation(input) {
  const hash = contentHash(input.rawText)
  const assessment = { classification: 'NOT_DIALOGUE', speakers: [], summary: 'synthetic non-dialogue', sourceCharCount: input.rawText.length, requiresHumanConfirmation: false }
  const analysisToken = createDialogueAnalysisToken({ contentHash: hash, targetCustomerId: input.customerId, customerOperationId: input.customerOperationId || '', assessment, secret: config.authSecret })
  const confirmation = finalizeDialogueConfirmation({ analysisToken, contentHash: hash, targetCustomerId: input.customerId, customerOperationId: input.customerOperationId || '', secret: config.authSecret })
  return { ...input, dialogueConfirmation: confirmation.dialogueConfirmation }
}

beforeEach(() => {
  activeDatabase = {
    staff: [{ id: 'ADMIN-1', name: 'Synthetic Admin', permissionRole: 'ADMIN', role: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
    customers: [{ id: 'CUS-SAVE-1', name: 'Synthetic Save Customer', mentorId: null, profileFields: {}, profileFieldMeta: {} }],
    appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [],
    _rows: { sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [] },
  }
  sourceRow = null
  createRecordMock.mockReset().mockImplementation((tableId, fields) => {
    if (tableId === config.feishu.tables.sourceRecords) {
      sourceRow = { record_id: 'rec-source-save-1', fields }
      return { record: { record_id: sourceRow.record_id } }
    }
    return { record: { record_id: 'rec-unused' } }
  })
  listRecordsMock.mockReset().mockImplementation(async (tableId) => tableId === config.feishu.tables.sourceRecords && sourceRow ? [sourceRow] : [])
  searchRecordsMock.mockReset().mockImplementation(async (tableId) => tableId === config.feishu.tables.sourceRecords && sourceRow ? [sourceRow] : [])
  updateRecordMock.mockReset().mockResolvedValue({ record: { record_id: sourceRow?.record_id || 'rec-source-save-1' } })
})

describe('source save idempotency', () => {
  it('allows manual text clients to save without a dialogue gate', async () => {
    const dialogueClassifier = vi.fn(async () => { throw new Error('manual text must not call dialogue identify') })
    const repository = new FeishuRepository({ dialogueClassifier })
    repository.load = async () => activeDatabase

    const source = await repository.createSource('ADMIN-1', { customerId: 'CUS-SAVE-1', sourceType: 'TEXT_INPUT', rawText: '我最近很困惑', operationId: 'legacy-plain-operation' })

    expect(source.customerId).toBe('CUS-SAVE-1')
    expect(createRecordMock).toHaveBeenCalledTimes(1)
    expect(dialogueClassifier).not.toHaveBeenCalled()
  })

  it('keeps the file upload gate fail-closed for legacy clients', async () => {
    const repository = new FeishuRepository({ dialogueClassifier: async () => ({ classification: 'ONE_SPEAKER', speakers: [{ id: 'A', excerpt: '我最近很困惑' }], summary: 'speaker requires confirmation' }) })
    repository.load = async () => activeDatabase

    await expect(repository.createSource('ADMIN-1', { customerId: 'CUS-SAVE-1', sourceType: 'FILE_UPLOAD', rawText: '我最近很困惑', operationId: 'legacy-dialogue-operation', document: { extractedText: '我最近很困惑' } })).rejects.toMatchObject({ code: 'DIALOGUE_CONFIRMATION_REQUIRED', status: 409 })
    expect(createRecordMock).not.toHaveBeenCalled()
  })

  it('returns a persisted legacy operation before re-running dialogue classification', async () => {
    const repository = new FeishuRepository({ dialogueClassifier: async () => { throw new Error('must not classify persisted operation') } })
    repository.load = async () => activeDatabase
    const input = withDialogueConfirmation({ customerId: 'CUS-SAVE-1', sourceType: 'TEXT_INPUT', rawText: 'persisted source', operationId: 'legacy-retry-operation' })
    const source = await repository.createSource('ADMIN-1', input)
    activeDatabase.sourceRecords.push(source)

    const result = await repository.createSource('ADMIN-1', { ...input, dialogueConfirmation: 'expired-or-invalid-token' })

    expect(result.id).toBe(source.id)
    expect(createRecordMock).toHaveBeenCalledTimes(1)
  })

  it('returns the existing source for a repeated operationId even after the first response succeeded', async () => {
    const repository = new FeishuRepository()
    repository.load = async () => activeDatabase
    const input = withDialogueConfirmation({ customerId: 'CUS-SAVE-1', sourceType: 'TEXT_INPUT', rawText: 'synthetic source content', operationId: 'stable-save-operation-1' })

    const first = await repository.createSource('ADMIN-1', input)
    activeDatabase.sourceRecords.push(first)
    const second = await repository.createSource('ADMIN-1', input)

    expect(second.id).toBe(first.id)
    expect(createRecordMock).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized raw text before creating a truncated source', async () => {
    const repository = new FeishuRepository()
    repository.load = async () => activeDatabase
    const input = { customerId: 'CUS-SAVE-1', sourceType: 'TEXT_INPUT', rawText: `${'甲'.repeat(500_001)}\n重要结尾`, operationId: 'oversized-source-operation' }

    await expect(repository.createSource('ADMIN-1', input)).rejects.toMatchObject({ code: 'SOURCE_TEXT_TOO_LARGE', status: 413 })
    expect(createRecordMock).not.toHaveBeenCalled()
  })

  it('rejects oversized extracted file text before creating a truncated source', async () => {
    const repository = new FeishuRepository()
    repository.load = async () => activeDatabase
    const input = { customerId: 'CUS-SAVE-1', sourceType: 'FILE_UPLOAD', rawText: '', operationId: 'oversized-file-operation', document: { filename: 'synthetic.txt', mimeType: 'text/plain', extension: '.txt', size: 1, fileHash: 'file-hash-1', charCount: 500_001, extractedText: '乙'.repeat(500_001) } }

    await expect(repository.createSource('ADMIN-1', input)).rejects.toMatchObject({ code: 'SOURCE_TEXT_TOO_LARGE', status: 413 })
    expect(createRecordMock).not.toHaveBeenCalled()
  })

  it('recovers a persisted source by customer and operationId within authorization scope', async () => {
    const repository = new FeishuRepository()
    repository.load = async () => activeDatabase
    const input = withDialogueConfirmation({ customerId: 'CUS-SAVE-1', sourceType: 'TEXT_INPUT', rawText: 'operation lookup source', operationId: 'operation-status-1' })
    const source = await repository.createSource('ADMIN-1', input)
    activeDatabase.sourceRecords.push(source)

    const result = await repository.sourceStatus('ADMIN-1', 'CUS-SAVE-1', input.operationId)

    expect(result.status).toBe('PERSISTED')
    expect(result.source?.id).toBe(source.id)
  })

  it('does not reveal a source status for another customer', async () => {
    const repository = new FeishuRepository()
    repository.load = async () => activeDatabase

    await expect(repository.sourceStatus('ADMIN-1', 'CUS-NOT-OWNED', 'operation-status-1')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
  })
})
