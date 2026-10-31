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
  process.env.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS = 'CUS-a61e57990749ae442014'
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
})
