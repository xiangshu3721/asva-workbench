/**
 * Two-phase new-customer AI archive (HTTP):
 * Phase1 createCustomer → PERSISTED, no setImmediate schedule.
 * Phase2 runCustomerAutoArchive → createSource + await processSource (no dual schedule).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contentHash } from '../shared/evidence-contract.mjs'

const state = vi.hoisted(() => {
  process.env.APP_ENV = 'mock'
  process.env.ASVA_ENVIRONMENT = 'mock'
  process.env.DATA_MODE = 'mock'
  process.env.ASVA_CONFIG_DIR = '/nonexistent/asva-two-phase-archive-test-config'
  process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
  process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'canary'
  process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY = 'true'
  process.env.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS = 'CUS-a61e57990749ae442014,CUS-86e6d67e5e4bbd047806,CUS-288f80a87468e5faccb1,CUS-5d54f38b220e30f5ad74'
  process.env.FEISHU_CUSTOMERS_TABLE_ID = 'tbl-tp-customers'
  process.env.FEISHU_STAFF_TABLE_ID = 'tbl-tp-staff'
  process.env.FEISHU_PRODUCTS_TABLE_ID = 'tbl-tp-products'
  process.env.FEISHU_ENROLLMENTS_TABLE_ID = 'tbl-tp-enrollments'
  process.env.FEISHU_PROFILE_CHANGES_TABLE_ID = 'tbl-tp-profile-changes'
  process.env.FEISHU_APPOINTMENTS_TABLE_ID = 'tbl-tp-appointments'
  process.env.FEISHU_SERVICE_RECORDS_TABLE_ID = 'tbl-tp-services'
  process.env.FEISHU_SOURCE_RECORDS_TABLE_ID = 'tbl-tp-sources'
  process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID = 'tbl-tp-evidence'
  process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID = 'tbl-tp-proposals'
  process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID = 'tbl-tp-conflicts'
  return {
    tableIds: {
      customers: 'tbl-tp-customers',
      staff: 'tbl-tp-staff',
      products: 'tbl-tp-products',
      enrollments: 'tbl-tp-enrollments',
      profileChanges: 'tbl-tp-profile-changes',
      appointments: 'tbl-tp-appointments',
      serviceRecords: 'tbl-tp-services',
      sourceRecords: 'tbl-tp-sources',
      evidenceItems: 'tbl-tp-evidence',
      profileUpdateProposals: 'tbl-tp-proposals',
      evidenceConflicts: 'tbl-tp-conflicts',
    },
    tables: new Map(),
    nextRecordId: 1,
    scheduleProcessCalls: [],
  }
})

const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)))
const table = (tableId) => {
  if (!state.tables.has(tableId)) state.tables.set(tableId, new Map())
  return state.tables.get(tableId)
}
const rowFields = (row) => row?.fields || {}
function matchSearchFilter(fields, filter) {
  const conditions = filter?.conditions || []
  if (!conditions.length) return true
  const results = conditions.map((condition) => {
    const actual = fields?.[condition.field_name]
    const expected = Array.isArray(condition.value) ? condition.value[0] : condition.value
    const actualText = Array.isArray(actual)
      ? actual.map((part) => (part && typeof part === 'object' ? part.text : part)).filter((v) => v != null && v !== '').join('')
      : String(actual ?? '')
    return condition.operator === 'is' ? actualText === String(expected ?? '') : false
  })
  return results.every(Boolean)
}
function toSearchShape(row) {
  const fields = {}
  for (const [key, value] of Object.entries(row.fields || {})) {
    if (typeof value === 'string') fields[key] = [{ text: value, type: 'text' }]
    else fields[key] = value
  }
  return { record_id: row.record_id, fields }
}

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return {
    ...actual,
    listRecords: async (tableId) => [...table(tableId).values()].map(clone),
    searchRecords: async (tableId, filter) => [...table(tableId).values()].filter((row) => matchSearchFilter(rowFields(row), filter)).map((row) => toSearchShape(clone(row))),
    getRecord: async (tableId, recordId) => {
      const row = table(tableId).get(recordId)
      return row ? clone(row) : null
    },
    createRecord: async (tableId, fields) => {
      const recordId = `rec-${state.nextRecordId++}`
      const row = { record_id: recordId, fields: clone(fields) }
      table(tableId).set(recordId, row)
      return { record: clone(row) }
    },
    updateRecord: async (tableId, recordId, fields) => {
      const existing = table(tableId).get(recordId)
      const row = { record_id: recordId, fields: { ...(existing?.fields || {}), ...fields } }
      table(tableId).set(recordId, row)
      return { record: clone(row) }
    },
  }
})

const { FeishuRepository, customerIdForOperation } = await import('./repository.mjs')
const { fields } = await import('./field-mapping.mjs')

const SYNTH_OPERATION_ID = 'ASVA-SYNTH-NEW-CUSTOMER-ARCHIVE-20261031'
const SYNTH_CUSTOMER_ID = 'CUS-a61e57990749ae442014'
const NOTES = '我是客户本人。最近在考虑转行做产品经理，希望系统梳理职业方向。'

function seedStaff() {
  state.tables = new Map()
  state.nextRecordId = 1
  state.scheduleProcessCalls = []
  table(state.tableIds.staff).set('rec-admin', {
    record_id: 'rec-admin',
    fields: fields('staff', {
      staff_id: 'ADMIN-1',
      nickname: '管理员',
      permission_role: 'ADMIN',
      status: 'ACTIVE',
      login_enabled: true,
    }),
  })
}

beforeEach(() => {
  seedStaff()
  vi.useRealTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('two-phase HTTP auto archive', () => {
  it('A: phase1 persists notes without scheduling; phase2 creates source and processes', async () => {
    const repository = new FeishuRepository()
    const scheduleSpy = vi.spyOn(repository, 'scheduleAutomaticCustomerProfile')
    const processScheduleSpy = vi.spyOn(repository, 'scheduleAutomaticProcessing').mockImplementation((actorId, sourceId) => {
      state.scheduleProcessCalls.push({ actorId, sourceId })
      return { status: 'QUEUED' }
    })

    const created = await repository.createCustomer('ADMIN-1', {
      operationId: SYNTH_OPERATION_ID,
      nickname: '两阶段验收客户',
      phone: '19900001031',
      wechat: '',
      situation: NOTES,
      enrollments: [],
    }, 'req-a', { compactResponse: true })

    expect(created.createdCustomerId).toBe(SYNTH_CUSTOMER_ID)
    expect(created.customer.notes).toBe(NOTES)
    expect(created.automaticProfile).toMatchObject({ status: 'PENDING', mode: 'HTTP_PHASE2' })
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(processScheduleSpy).not.toHaveBeenCalled()

    repository.processSource = vi.fn(async (_actor, sourceId) => ({
      source: { id: sourceId, customerId: SYNTH_CUSTOMER_ID, processingStatus: 'COMPLETED' },
      evidenceItems: [{ id: 'EV-1', customerId: SYNTH_CUSTOMER_ID, sourceId }],
      proposals: [],
      conflicts: [],
    }))

    const archived = await repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID)
    expect(archived.status).toBe('COMPLETED')
    expect(archived.sourceId).toBeTruthy()
    expect(archived.phase).toBe('DONE')
    // Phase2 must await processSource inline — not leave work only on setImmediate schedule.
    expect(repository.processSource).toHaveBeenCalledTimes(1)
    expect(state.scheduleProcessCalls).toHaveLength(0)

    const again = await repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID)
    expect(again.reused === true || again.phase === 'ALREADY_DONE' || again.sourceId === archived.sourceId).toBe(true)
  })

  it('C: same notes/operation produces one Source path via stable contentHash', async () => {
    const repository = new FeishuRepository()
    await repository.createCustomer('ADMIN-1', {
      operationId: SYNTH_OPERATION_ID,
      nickname: '幂等验收',
      phone: '19900001032',
      situation: NOTES,
      enrollments: [],
    }, '', { compactResponse: true })

    const createdSources = []
    const originalCreate = repository.createSource.bind(repository)
    repository.createSource = vi.fn(async (...args) => {
      const source = await originalCreate(...args)
      createdSources.push(source.id)
      return source
    })
    repository.processSource = vi.fn(async (_actor, sourceId) => ({
      source: { id: sourceId, customerId: SYNTH_CUSTOMER_ID, processingStatus: 'COMPLETED' },
      evidenceItems: [],
      proposals: [],
      conflicts: [],
    }))
    vi.spyOn(repository, 'scheduleAutomaticProcessing').mockImplementation(() => ({ status: 'DEFERRED_TO_HTTP' }))

    const first = await repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID)
    const second = await repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID)
    expect(first.sourceId).toBeTruthy()
    expect(second.sourceId).toBe(first.sourceId)
  })

  it('E: process failure keeps customer notes and returns FAILED with phase', async () => {
    const repository = new FeishuRepository()
    await repository.createCustomer('ADMIN-1', {
      operationId: SYNTH_OPERATION_ID,
      nickname: '失败可重试',
      phone: '19900001033',
      situation: NOTES,
      enrollments: [],
    }, '', { compactResponse: true })

    vi.spyOn(repository, 'scheduleAutomaticProcessing').mockImplementation(() => ({ status: 'DEFERRED_TO_HTTP' }))
    repository.processSource = vi.fn(async () => {
      throw Object.assign(new Error('DeepSeek unavailable'), { code: 'DEEPSEEK_UNAVAILABLE' })
    })
    const failed = await repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID)
    expect(failed.status).toBe('FAILED')
    expect(failed.phase).toBe('PROCESS_SOURCE')
    expect(failed.errorCode).toBe('DEEPSEEK_UNAVAILABLE')

    const customerRow = [...table(state.tableIds.customers).values()][0]
    const notesField = customerRow.fields[Object.keys(customerRow.fields).find((k) => String(customerRow.fields[k]).includes('客户本人') || String(customerRow.fields[k]).includes('转行')) || '']
    // notes persisted on create — raw situation remains on Customers record
    expect(JSON.stringify(customerRow.fields)).toContain('转行')
  })

  it('P0: concurrent customers do not monkey-patch shared scheduleAutomaticProcessing', async () => {
    const repository = new FeishuRepository()
    const originalSchedule = repository.scheduleAutomaticProcessing
    const scheduleCalls = []
    const scheduleSpy = vi.spyOn(repository, 'scheduleAutomaticProcessing').mockImplementation((actorId, sourceId) => {
      scheduleCalls.push({ actorId, sourceId })
      return { status: 'QUEUED' }
    })

    const createdA = await repository.createCustomer('ADMIN-1', {
      operationId: 'ASVA-SYNTH-CONCURRENT-A-20261031',
      nickname: '并发客户A',
      phone: '19900002001',
      situation: '客户A备注：想做产品经理转行规划。',
      enrollments: [],
    }, '', { compactResponse: true })
    const createdB = await repository.createCustomer('ADMIN-1', {
      operationId: 'ASVA-SYNTH-CONCURRENT-B-20261031',
      nickname: '并发客户B',
      phone: '19900002002',
      situation: '客户B备注：希望梳理职业方向与学习路径。',
      enrollments: [],
    }, '', { compactResponse: true })
    expect(createdA.createdCustomerId).toBe('CUS-86e6d67e5e4bbd047806')
    expect(createdB.createdCustomerId).toBe('CUS-288f80a87468e5faccb1')

    const processCalls = []
    repository.processSource = vi.fn(async (_actor, sourceId) => {
      processCalls.push(sourceId)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        source: { id: sourceId, processingStatus: 'COMPLETED' },
        evidenceItems: [{ id: `EV-${sourceId}`, sourceId }],
        proposals: [],
        conflicts: [],
      }
    })

    const [resultA, resultB] = await Promise.all([
      repository.runCustomerAutoArchive('ADMIN-1', createdA.createdCustomerId),
      repository.runCustomerAutoArchive('ADMIN-1', createdB.createdCustomerId),
    ])

    expect(resultA.status).toBe('COMPLETED')
    expect(resultB.status).toBe('COMPLETED')
    expect(resultA.sourceId).toBeTruthy()
    expect(resultB.sourceId).toBeTruthy()
    expect(resultA.sourceId).not.toBe(resultB.sourceId)
    expect(processCalls).toHaveLength(2)
    // Must never replace the instance method (shared concurrent customers).
    expect(repository.scheduleAutomaticProcessing).toBe(scheduleSpy)
    expect(scheduleCalls).toHaveLength(0)
    expect(typeof originalSchedule).toBe('function')
  })

  it('P0: same customer concurrent archive is idempotent and does not duplicate process thrash', async () => {
    const repository = new FeishuRepository()
    await repository.createCustomer('ADMIN-1', {
      operationId: SYNTH_OPERATION_ID,
      nickname: '同客并发',
      phone: '19900002003',
      situation: NOTES,
      enrollments: [],
    }, '', { compactResponse: true })

    let processCount = 0
    const evidenceBySource = new Map()
    repository.processSource = vi.fn(async (_actor, sourceId) => {
      processCount += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      if (!evidenceBySource.has(sourceId)) evidenceBySource.set(sourceId, [{ id: `EV-${sourceId}`, sourceId }])
      return {
        source: { id: sourceId, customerId: SYNTH_CUSTOMER_ID, processingStatus: 'COMPLETED' },
        evidenceItems: evidenceBySource.get(sourceId),
        proposals: [],
        conflicts: [],
      }
    })
    vi.spyOn(repository, 'scheduleAutomaticProcessing')

    const [first, second] = await Promise.all([
      repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID),
      repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID),
    ])
    expect(first.sourceId).toBeTruthy()
    expect(second.sourceId).toBe(first.sourceId)
    expect(first.status === 'COMPLETED' || second.status === 'COMPLETED').toBe(true)
    // Stable operationId/contentHash → one Source; process may run 1–2 times via lock, never N sources.
    expect(new Set([first.sourceId, second.sourceId]).size).toBe(1)
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalled()
    expect(evidenceBySource.get(first.sourceId)).toHaveLength(1)
  })

  it('P0: UPDATE old customer must not write pending or archive on profile status', async () => {
    const repository = new FeishuRepository()
    const created = await repository.createCustomer('ADMIN-1', {
      operationId: 'ASVA-SYNTH-UPDATE-OLD-20261031',
      nickname: '旧客户不补历史',
      phone: '19900002004',
      situation: '初次备注',
      enrollments: [],
    }, '', { compactResponse: true })
    const customerId = created.createdCustomerId
    expect(customerId).toBe('CUS-5d54f38b220e30f5ad74')

    // Simulate completed create-archive then clear pending by running archive once.
    repository.processSource = vi.fn(async (_actor, sourceId) => ({
      source: { id: sourceId, customerId, processingStatus: 'COMPLETED' },
      evidenceItems: [{ id: 'EV-DONE', sourceId }],
      proposals: [],
      conflicts: [],
    }))
    await repository.runCustomerAutoArchive('ADMIN-1', customerId)

    const updated = await repository.updateCustomer('ADMIN-1', customerId, {
      operationId: 'ASVA-SYNTH-UPDATE-OLD-PATCH-20261031',
      nickname: '旧客户不补历史',
      phone: '19900002004',
      situation: '编辑后的新备注，绝不触发补历史归档',
      enrollments: [],
    }, { compactResponse: true })

    expect(updated.automaticProfile).toMatchObject({ status: 'NOT_REQUIRED', reason: 'UPDATE_SKIPPED' })

    const database = await repository.load({ force: true })
    const customer = database.customers.find((item) => item.id === customerId)
    expect(customer.notes).toContain('编辑后的新备注')
    expect(customer.automaticProfilePending).toBeFalsy()

    const profile = await repository.customerProfile('ADMIN-1', customerId)
    // UPDATE must not surface PENDING that would cause frontend resume AI.
    expect(profile.autoOrganizeStatus).not.toBe('PENDING')
    expect(profile.autoOrganizeStatus).not.toBe('FAILED')

    const skipped = await repository.runCustomerAutoArchive('ADMIN-1', customerId)
    // Existing COMPLETED create source → idempotent ALREADY_DONE / COMPLETED, not a new UPDATE archive.
    expect(['COMPLETED', 'REVIEW_REQUIRED', 'NOT_REQUIRED'].includes(skipped.status)).toBe(true)
    if (skipped.phase === 'UPDATE_SKIPPED' || skipped.phase === 'CREATE_ONLY') {
      expect(skipped.status).toBe('NOT_REQUIRED')
    }
  })

  it('P0: leftover CUSTOMER_UPDATE pending is ignored by status and archive entry', async () => {
    const repository = new FeishuRepository()
    const customerId = 'CUS-a61e57990749ae442014'
    // Seed an "old" customer row with UPDATE pending only (no CREATE source).
    const notes = '历史客户被错误写了 UPDATE pending'
    table(state.tableIds.customers).set('rec-old-update', {
      record_id: 'rec-old-update',
      fields: fields('customers', {
        customer_id: customerId,
        nickname: '历史客户',
        phone: '19900002005',
        notes,
        created_by_staff_id: 'ADMIN-1',
        created_at: '2026-10-01T00:00:00.000Z',
        profile_field_meta_json: JSON.stringify({
          _profile_version: 1,
          _fields: {},
          _automatic_profile_pending: {
            contentHash: contentHash(notes),
            actorId: 'ADMIN-1',
            reason: 'CUSTOMER_UPDATE',
            createdAt: '2026-10-30T12:00:00.000Z',
            sourceReference: { kind: 'CUSTOMER_FIELDS', fields: ['notes'] },
          },
          _mutation_states: {},
        }),
      }),
    })

    const profile = await repository.customerProfile('ADMIN-1', customerId)
    expect(profile.autoOrganizeStatus).toBe('NOT_STARTED')

    const processSpy = vi.fn()
    repository.processSource = processSpy
    const result = await repository.runCustomerAutoArchive('ADMIN-1', customerId)
    expect(result).toMatchObject({ status: 'NOT_REQUIRED', phase: 'UPDATE_SKIPPED' })
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('BLOCKER: after physical fields filled, finalize must reuse primary Source and never create orphan', async () => {
    const repository = new FeishuRepository()
    await repository.createCustomer('ADMIN-1', {
      operationId: SYNTH_OPERATION_ID,
      nickname: '身份漂移验收',
      phone: '19900002007',
      situation: NOTES,
      enrollments: [],
    }, '', { compactResponse: true })

    const primaryHash = contentHash(NOTES)
    const primarySourceId = 'SRC-d179313a2dda70c92736e93a'
    table(state.tableIds.sourceRecords).set('rec-primary-src', {
      record_id: 'rec-primary-src',
      fields: fields('sourceRecords', {
        source_id: primarySourceId,
        customer_id: SYNTH_CUSTOMER_ID,
        subject_type: 'PERSON',
        subject_id: SYNTH_CUSTOMER_ID,
        source_type: 'TEXT_INPUT',
        title: '客户补充资料',
        raw_text: NOTES,
        content_hash: primaryHash,
        processing_status: 'COMPLETED',
        notes: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE',
        uploaded_by: 'ADMIN-1',
        created_at: '2026-10-31T10:00:00.000Z',
        uploaded_at: '2026-10-31T10:00:00.000Z',
        last_batch_id: 'EXT-PRIMARY-1',
      }),
    })
    table(state.tableIds.evidenceItems).set('rec-ev-1', {
      record_id: 'rec-ev-1',
      fields: fields('evidenceItems', {
        evidence_id: 'EVD-PRIMARY-1',
        customer_id: SYNTH_CUSTOMER_ID,
        subject_type: 'PERSON',
        subject_id: SYNTH_CUSTOMER_ID,
        source_id: primarySourceId,
        evidence_type: 'FACT',
        semantic_kind: 'NEED',
        field_key: 'current_core_issue',
        standard_value: JSON.stringify('转行产品经理'),
        display_text: '转行产品经理',
        source_excerpt: NOTES.slice(0, 40),
        confidence: 0.9,
        review_status: 'PENDING_REVIEW',
        extraction_batch_id: 'EXT-PRIMARY-1',
      }),
    })
    const driftedText = `${NOTES}\n当前困扰：转行产品经理\n希望获得帮助：系统梳理\n当前目标：明确方向`
    const driftedHash = contentHash(driftedText)
    table(state.tableIds.sourceRecords).set('rec-orphan-src', {
      record_id: 'rec-orphan-src',
      fields: fields('sourceRecords', {
        source_id: 'SRC-b6d4994db33bad45f52aa33f',
        customer_id: SYNTH_CUSTOMER_ID,
        subject_type: 'PERSON',
        subject_id: SYNTH_CUSTOMER_ID,
        source_type: 'TEXT_INPUT',
        title: '客户补充资料',
        raw_text: driftedText,
        content_hash: driftedHash,
        processing_status: 'UPLOADED',
        notes: 'AUTO_PROFILE_ORGANIZE:HTTP_AUTO_ARCHIVE',
        uploaded_by: 'ADMIN-1',
        created_at: '2026-10-31T12:00:00.000Z',
        uploaded_at: '2026-10-31T12:00:00.000Z',
      }),
    })
    const [custKey, custRow] = [...table(state.tableIds.customers).entries()][0]
    table(state.tableIds.customers).set(custKey, {
      ...custRow,
      fields: {
        ...custRow.fields,
        current_issue: '转行产品经理',
        help_expectation: '系统梳理',
        current_goal: '明确方向',
        profile_field_meta_json: JSON.stringify({
          _profile_version: 2,
          _fields: {
            current_core_issue: { confirmed: false, verificationLabel: 'AI整理·待核实', sourceRecordId: primarySourceId },
            current_goal: { confirmed: false, verificationLabel: 'AI整理·待核实', sourceRecordId: primarySourceId },
            current_expectation: { confirmed: false, verificationLabel: 'AI整理·待核实', sourceRecordId: primarySourceId },
          },
          _automatic_profile_pending: null,
          _mutation_states: {},
        }),
      },
    })

    const createSourceSpy = vi.spyOn(repository, 'createSource')
    repository.processSource = vi.fn(async (_actor, sourceId, opts = {}) => {
      expect(sourceId).toBe(primarySourceId)
      expect(opts.stage).toBe('finalize')
      return {
        source: { id: primarySourceId, customerId: SYNTH_CUSTOMER_ID, processingStatus: 'COMPLETED' },
        evidenceItems: [{ id: 'EVD-PRIMARY-1', customerId: SYNTH_CUSTOMER_ID, sourceId: primarySourceId, fieldKey: 'current_core_issue', reviewStatus: 'PENDING_REVIEW' }],
        proposals: [{ id: 'PROP-1', customerId: SYNTH_CUSTOMER_ID, sourceId: primarySourceId, evidenceId: 'EVD-PRIMARY-1', fieldKey: 'current_core_issue' }],
        conflicts: [],
      }
    })

    const finalized = await repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID, { stage: 'finalize', finalize: true })
    expect(finalized.sourceId).toBe(primarySourceId)
    expect(createSourceSpy).not.toHaveBeenCalled()

    const again = await repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID, {
      stage: 'finalize',
      finalize: true,
      sourceId: primarySourceId,
    })
    expect(again.sourceId).toBe(primarySourceId)
    expect(again.phase === 'ALREADY_DONE' || again.status === 'COMPLETED').toBe(true)
    expect(createSourceSpy).not.toHaveBeenCalled()

    createSourceSpy.mockClear()
    const extractAgain = await repository.runCustomerAutoArchive('ADMIN-1', SYNTH_CUSTOMER_ID, { stage: 'extract' })
    expect(extractAgain.sourceId).toBe(primarySourceId)
    expect(createSourceSpy).not.toHaveBeenCalled()
    expect([...table(state.tableIds.sourceRecords).values()]).toHaveLength(2)
  })

  it('BLOCKER: finalize without Source returns ARCHIVE_FINALIZE_NO_SOURCE and never createSource', async () => {
    const repository = new FeishuRepository()
    // Use canary-allowlisted id without CREATE pending / Source.
    const customerId = 'CUS-86e6d67e5e4bbd047806'
    table(state.tableIds.customers).set('rec-nosrc', {
      record_id: 'rec-nosrc',
      fields: fields('customers', {
        customer_id: customerId,
        nickname: '无Source收尾',
        phone: '19900002008',
        notes: NOTES,
        created_by_staff_id: 'ADMIN-1',
        created_at: '2026-10-31T10:00:00.000Z',
        profile_field_meta_json: JSON.stringify({
          _profile_version: 1,
          _fields: {},
          _automatic_profile_pending: null,
          _mutation_states: {},
        }),
      }),
    })
    const createSourceSpy = vi.spyOn(repository, 'createSource')
    const processSpy = vi.fn()
    repository.processSource = processSpy
    const result = await repository.runCustomerAutoArchive('ADMIN-1', customerId, { stage: 'finalize', finalize: true })
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'ARCHIVE_FINALIZE_NO_SOURCE' })
    expect(createSourceSpy).not.toHaveBeenCalled()
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('P0: queueAutomaticCustomerProfile scheduleProcessing:false never calls scheduleAutomaticProcessing', async () => {
    const repository = new FeishuRepository()
    await repository.createCustomer('ADMIN-1', {
      operationId: SYNTH_OPERATION_ID,
      nickname: '显式参数',
      phone: '19900002006',
      situation: NOTES,
      enrollments: [],
    }, '', { compactResponse: true })
    const scheduleSpy = vi.spyOn(repository, 'scheduleAutomaticProcessing')
    const queued = await repository.queueAutomaticCustomerProfile('ADMIN-1', SYNTH_CUSTOMER_ID, NOTES, 'HTTP_AUTO_ARCHIVE', { scheduleProcessing: false })
    expect(queued.status).toBe('QUEUED')
    expect(queued.sourceId).toBeTruthy()
    expect(scheduleSpy).not.toHaveBeenCalled()
  })
})
