/**
 * New-customer AI archive read-path fixes (no production writes):
 * 1) Feishu records/search Text cells arrive as [{text,type}]; list uses plain strings.
 *    Scoped recover must map customer.id to CUS-* (not record_id).
 * 2) Customers-only list fallback when search misses (post-create index lag).
 * 3) Formal open: customer UPDATEs must not auto-schedule historical backfill.
 * 4) Deterministic synth canary customer id via customerIdForOperation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contentHash } from '../shared/evidence-contract.mjs'

const SYNTH_OPERATION_ID = 'ASVA-SYNTH-NEW-CUSTOMER-ARCHIVE-20261031'
const SYNTH_CUSTOMER_ID = 'CUS-a61e57990749ae442014'

const state = vi.hoisted(() => {
  process.env.APP_ENV = 'mock'
  process.env.ASVA_ENVIRONMENT = 'mock'
  process.env.DATA_MODE = 'mock'
  process.env.ASVA_CONFIG_DIR = '/nonexistent/asva-new-customer-archive-test-config'
  process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
  process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'canary'
  process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY = 'true'
  process.env.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS = 'CUS-a61e57990749ae442014'
  process.env.FEISHU_CUSTOMERS_TABLE_ID = 'tbl-nc-customers'
  process.env.FEISHU_STAFF_TABLE_ID = 'tbl-nc-staff'
  process.env.FEISHU_PRODUCTS_TABLE_ID = 'tbl-nc-products'
  process.env.FEISHU_ENROLLMENTS_TABLE_ID = 'tbl-nc-enrollments'
  process.env.FEISHU_PROFILE_CHANGES_TABLE_ID = 'tbl-nc-profile-changes'
  process.env.FEISHU_APPOINTMENTS_TABLE_ID = 'tbl-nc-appointments'
  process.env.FEISHU_SERVICE_RECORDS_TABLE_ID = 'tbl-nc-services'
  process.env.FEISHU_SOURCE_RECORDS_TABLE_ID = 'tbl-nc-sources'
  process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID = 'tbl-nc-evidence'
  process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID = 'tbl-nc-proposals'
  process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID = 'tbl-nc-conflicts'
  return {
    tableIds: {
      customers: 'tbl-nc-customers',
      staff: 'tbl-nc-staff',
      products: 'tbl-nc-products',
      enrollments: 'tbl-nc-enrollments',
      profileChanges: 'tbl-nc-profile-changes',
      appointments: 'tbl-nc-appointments',
      serviceRecords: 'tbl-nc-services',
      sourceRecords: 'tbl-nc-sources',
      evidenceItems: 'tbl-nc-evidence',
      profileUpdateProposals: 'tbl-nc-proposals',
      evidenceConflicts: 'tbl-nc-conflicts',
    },
    tables: new Map(),
    nextRecordId: 1,
    searchMissCustomers: false,
    listCalls: [],
    searchCalls: [],
    scheduleCalls: [],
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
  const conjunction = String(filter?.conjunction || 'and').toLowerCase()
  const results = conditions.map((condition) => {
    const actual = fields?.[condition.field_name]
    const expected = Array.isArray(condition.value) ? condition.value[0] : condition.value
    const actualText = Array.isArray(actual)
      ? actual.map((part) => (part && typeof part === 'object' ? part.text : part)).filter((v) => v != null && v !== '').join('')
      : String(actual ?? '')
    if (condition.operator === 'is') return actualText === String(expected ?? '')
    return false
  })
  return conjunction === 'or' ? results.some(Boolean) : results.every(Boolean)
}

/** Simulate Feishu search response shape for Text cells. */
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
    listRecords: async (tableId) => {
      state.listCalls.push(tableId)
      return [...table(tableId).values()].map(clone)
    },
    searchRecords: async (tableId, filter) => {
      state.searchCalls.push({ tableId, filter })
      if (state.searchMissCustomers && tableId === state.tableIds.customers) return []
      return [...table(tableId).values()]
        .filter((row) => matchSearchFilter(rowFields(row), filter))
        .map((row) => toSearchShape(clone(row)))
    },
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
const { config } = await import('./config.mjs')

function seedStaffAndSynthCustomer({ notes = '合成客户希望梳理职业方向。' } = {}) {
  state.tables = new Map()
  state.nextRecordId = 1
  state.searchMissCustomers = false
  state.listCalls = []
  state.searchCalls = []
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
  table(state.tableIds.customers).set('rec-synth', {
    record_id: 'rec-synth',
    fields: fields('customers', {
      customer_id: SYNTH_CUSTOMER_ID,
      nickname: '合成归档验收-20261031',
      notes,
      created_by_staff_id: 'ADMIN-1',
      sabc: 'C',
      is_paid: false,
      created_at: '2026-10-31T02:00:00.000Z',
      profile_field_meta_json: JSON.stringify({
        _profile_version: 1,
        _fields: {},
        _automatic_profile_pending: {
          contentHash: contentHash(notes),
          actorId: 'ADMIN-1',
          reason: 'CUSTOMER_SAVE',
          createdAt: '2026-10-31T02:00:00.000Z',
        },
        _mutation_states: {},
      }),
    }),
  })
}

beforeEach(() => {
  config.features.automaticProfileArchiving = true
  config.features.automaticProfileArchivingMode = 'canary'
  config.features.automaticProfileArchivingCanary = true
  config.features.automaticProfileCanaryCustomerIds = new Set([SYNTH_CUSTOMER_ID])
  seedStaffAndSynthCustomer()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('new customer archive read path', () => {
  it('precomputes the synth canary customer id deterministically', () => {
    expect(customerIdForOperation(SYNTH_OPERATION_ID)).toBe(SYNTH_CUSTOMER_ID)
  })

  it('loadCustomerScoped maps search rich-text customer_id to CUS-* (not record_id)', async () => {
    const repository = new FeishuRepository()
    const database = await repository.loadCustomerScoped(SYNTH_CUSTOMER_ID, { force: true, scene: 'TEST_SEARCH_SHAPE' })
    expect(database.customers).toHaveLength(1)
    expect(database.customers[0].id).toBe(SYNTH_CUSTOMER_ID)
    expect(database.customers[0].id).not.toBe('rec-synth')
    expect(database.customers[0].name).toContain('合成归档验收')
    expect(state.searchCalls.some((call) => call.tableId === state.tableIds.customers)).toBe(true)
  })

  it('recoverAutomaticCustomerProfile finds the customer after search-shaped read', async () => {
    const repository = new FeishuRepository()
    repository.queueAutomaticCustomerProfile = vi.fn(async () => ({ status: 'QUEUED', sourceId: 'SRC-TEST' }))
    repository.processSource = vi.fn(async () => ({ source: { processingStatus: 'COMPLETED' } }))
    // recover will create source if missing; stub createSource path via queue/create
    repository.createSource = vi.fn(async () => ({ id: 'SRC-TEST', customerId: SYNTH_CUSTOMER_ID, processingStatus: 'UPLOADED', notes: 'AUTO_PROFILE_ORGANIZE:x' }))
    const result = await repository.recoverAutomaticCustomerProfile('ADMIN-1', SYNTH_CUSTOMER_ID)
    expect(result.customerId).toBe(SYNTH_CUSTOMER_ID)
    expect(result.status).not.toBe('FAILED')
    expect(result.errorCode).not.toBe('CUSTOMER_NOT_FOUND')
  })

  it('falls back to Customers list when search misses the known customer', async () => {
    state.searchMissCustomers = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repository = new FeishuRepository()
    const database = await repository.loadCustomerScoped(SYNTH_CUSTOMER_ID, { force: true, scene: 'TEST_LIST_FALLBACK' })
    expect(database.customers).toHaveLength(1)
    expect(database.customers[0].id).toBe(SYNTH_CUSTOMER_ID)
    expect(state.listCalls).toContain(state.tableIds.customers)
    expect(warn).toHaveBeenCalledWith('[ASVA_CUSTOMER_SCOPED_READ_CONSISTENCY]', expect.stringContaining('LIST_FALLBACK_AFTER_SEARCH_MISS'))
  })

  it('create defers AI to HTTP phase-2 (no setImmediate schedule); update does not auto-schedule', async () => {
    const repository = new FeishuRepository()
    state.tables.get(state.tableIds.customers).clear()
    repository.scheduleAutomaticCustomerProfile = vi.fn(() => ({ status: 'QUEUED' }))
    const created = await repository.createCustomer('ADMIN-1', {
      operationId: SYNTH_OPERATION_ID,
      nickname: '合成归档验收-20261031',
      phone: '19900001031',
      wechat: 'asva_synth_1031',
      situation: '合成客户希望梳理职业方向，准备做产品。',
      enrollments: [],
    }, '', { compactResponse: true })
    expect(created.createdCustomerId || created.customer?.id).toBe(SYNTH_CUSTOMER_ID)
    expect(repository.scheduleAutomaticCustomerProfile).not.toHaveBeenCalled()
    expect(created.automaticProfile).toMatchObject({ status: 'PENDING', mode: 'HTTP_PHASE2', reason: 'CUSTOMER_SAVE' })
    expect(created.customer?.notes || created.customer?.need || '').toEqual(expect.any(String))

    repository.scheduleAutomaticCustomerProfile.mockClear()
    const updated = await repository.updateCustomer('ADMIN-1', SYNTH_CUSTOMER_ID, {
      operationId: `${SYNTH_OPERATION_ID}-update-1`,
      nickname: '合成归档验收-20261031',
      phone: '19900001031',
      wechat: 'asva_synth_1031',
      situation: '旧客户资料更新：不应自动触发历史补归档。',
      enrollments: [],
    }, { compactResponse: true })
    expect(updated.customer?.notes).toContain('不应自动触发历史补归档')
    expect(repository.scheduleAutomaticCustomerProfile).not.toHaveBeenCalled()
    // Formal open/update may expose deferred marker but must not schedule setImmediate.
    expect(updated.automaticProfile?.mode === 'HTTP_PHASE2' || ['PENDING', 'DISABLED', 'NOT_REQUIRED'].includes(updated.automaticProfile?.status || 'NOT_REQUIRED')).toBe(true)
  })

  it('blocks non-allowlisted customers in canary mode', async () => {
    const repository = new FeishuRepository()
    expect(repository.scheduleAutomaticCustomerProfile('ADMIN-1', 'CUS-other', '资料', 'CUSTOMER_SAVE')).toEqual({ status: 'DISABLED' })
    expect(repository.scheduleAutomaticCustomerProfile('ADMIN-1', SYNTH_CUSTOMER_ID, '资料', 'CUSTOMER_SAVE')).toMatchObject({ status: 'QUEUED' })
  })

  it('scoped search unwraps Evidence confidence Text segments so isSnapshotEvidence can pass', async () => {
    const { isSnapshotEvidence } = await import('../shared/profile-materialization.mjs')
    table(state.tableIds.sourceRecords).set('rec-src', {
      record_id: 'rec-src',
      fields: fields('sourceRecords', {
        source_id: 'SRC-CONF-1',
        customer_id: SYNTH_CUSTOMER_ID,
        subject_id: SYNTH_CUSTOMER_ID,
        subject_type: 'PERSON',
        source_type: 'TEXT_INPUT',
        title: '客户补充资料',
        raw_text: '职业目标是转行做产品经理',
        processing_status: 'REVIEW_REQUIRED',
        processing_version: '2',
        source_version: '1',
        last_batch_id: 'EXT-CONF-1',
        uploaded_by: 'ADMIN-1',
        source_role: 'ADMIN',
      }),
    })
    table(state.tableIds.evidenceItems).set('rec-evd', {
      record_id: 'rec-evd',
      fields: fields('evidenceItems', {
        evidence_id: 'EVD-CONF-1',
        customer_id: SYNTH_CUSTOMER_ID,
        subject_id: SYNTH_CUSTOMER_ID,
        subject_type: 'PERSON',
        source_id: 'SRC-CONF-1',
        evidence_type: 'FACT',
        semantic_kind: 'CURRENT_STATE',
        field_key: 'career_goal',
        standard_value: '"转行做产品经理"',
        display_text: '职业目标是转行做产品经理',
        source_excerpt: '职业目标是转行做产品经理',
        confidence: '0.9',
        review_status: 'PENDING_REVIEW',
        extraction_batch_id: 'EXT-CONF-1',
        content_source: 'UNKNOWN',
        information_nature: 'PERSONAL_STATEMENT',
        verification_status: 'SOURCE_SUPPORTED',
        privacy_level: 'NORMAL',
      }),
    })
    const repository = new FeishuRepository()
    const database = await repository.loadCustomerScoped(SYNTH_CUSTOMER_ID, { force: true, scene: 'TEST_CONFIDENCE_UNWRAP' })
    const evidence = database.evidenceItems.find((item) => item.id === 'EVD-CONF-1')
    expect(evidence).toBeTruthy()
    expect(evidence.confidence).toBe(0.9)
    expect(Number.isNaN(evidence.confidence)).toBe(false)
    expect(isSnapshotEvidence(evidence)).toBe(true)
    const source = database.sourceRecords.find((item) => item.id === 'SRC-CONF-1')
    expect(source?.processingVersion).toBe(2)
    expect(source?.sourceVersion).toBe(1)
  })
})
