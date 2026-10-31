import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { normalizeEvidenceCandidate } from '../shared/evidence-contract.mjs'

describe('PR56 closed-loop unit gates', () => {
  it('never keeps CUSTOMER_DIRECT without trusted submission; staff attribution becomes STAFF_TRANSCRIBED_CUSTOMER', () => {
    const base = {
      evidence_type: 'FACT',
      semantic_kind: 'NEED',
      field_key: 'current_core_issue',
      value: '不会写PRD',
      display_text: '不会写PRD',
      source_excerpt: '当前最大困扰是不会写 PRD',
      confidence: 0.9,
      content_source: 'CUSTOMER_DIRECT',
      information_nature: 'PERSONAL_STATEMENT',
      verification_status: 'SOURCE_SUPPORTED',
    }
    const unknown = normalizeEvidenceCandidate(base, { sourceId: 'SRC-1', trustedCustomerSubmission: false })
    expect(unknown.contentSource).toBe('UNKNOWN')

    const staff = normalizeEvidenceCandidate(base, {
      sourceId: 'SRC-1',
      trustedCustomerSubmission: false,
      staffReportedAttribution: 'STAFF_TRANSCRIBED_CUSTOMER',
    })
    expect(staff.contentSource).toBe('STAFF_TRANSCRIBED_CUSTOMER')
    expect(staff.contentSource).not.toBe('CUSTOMER_DIRECT')
  })

  it('remaps UNKNOWN staff-entered grounded notes to staff attribution, not CUSTOMER_DIRECT', () => {
    const result = normalizeEvidenceCandidate({
      evidence_type: 'SELF_MEANING',
      semantic_kind: 'GOAL',
      field_key: 'current_goal',
      value: '90天学习路径',
      display_text: '希望梳理90天学习路径',
      source_excerpt: '希望梳理能力缺口与 90 天学习路径',
      confidence: 0.88,
      content_source: 'UNKNOWN',
      information_nature: 'PERSONAL_STATEMENT',
      verification_status: 'SOURCE_SUPPORTED',
    }, {
      sourceId: 'SRC-1',
      trustedCustomerSubmission: false,
      staffReportedAttribution: 'STAFF_TRANSCRIBED_CUSTOMER',
    })
    expect(result.contentSource).toBe('STAFF_TRANSCRIBED_CUSTOMER')
  })
})

describe('PR56 customerProfile GET is read-only', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'mock'
    process.env.ASVA_ENVIRONMENT = 'mock'
    process.env.DATA_MODE = 'mock'
    process.env.ASVA_CONFIG_DIR = '/nonexistent/asva-pr56-closed-loop-unit'
    process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
    process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'canary'
    process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY = 'true'
    process.env.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS = 'CUS-UNIT-1'
    process.env.FEISHU_CUSTOMERS_TABLE_ID = 'tbl-u-customers'
    process.env.FEISHU_STAFF_TABLE_ID = 'tbl-u-staff'
    process.env.FEISHU_PRODUCTS_TABLE_ID = 'tbl-u-products'
    process.env.FEISHU_ENROLLMENTS_TABLE_ID = 'tbl-u-enrollments'
    process.env.FEISHU_PROFILE_CHANGES_TABLE_ID = 'tbl-u-profile-changes'
    process.env.FEISHU_APPOINTMENTS_TABLE_ID = 'tbl-u-appointments'
    process.env.FEISHU_SERVICE_RECORDS_TABLE_ID = 'tbl-u-services'
    process.env.FEISHU_SOURCE_RECORDS_TABLE_ID = 'tbl-u-sources'
    process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID = 'tbl-u-evidence'
    process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID = 'tbl-u-proposals'
    process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID = 'tbl-u-conflicts'
  })

  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('does not call maybeResumeAutomaticCustomerProfile on GET', async () => {
    vi.resetModules()
    const { FeishuRepository } = await import('./repository.mjs')
    const repository = new FeishuRepository()
    const resume = vi.spyOn(repository, 'maybeResumeAutomaticCustomerProfile').mockResolvedValue({ status: 'RUNNING' })
    vi.spyOn(repository, 'loadProfileRead').mockResolvedValue({
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      customers: [{
        id: 'CUS-UNIT-1',
        profileFields: {},
        profileFieldMeta: {},
        automaticProfilePending: { contentHash: 'abc', reason: 'CUSTOMER_SAVE' },
        aiSummaryMeta: null,
      }],
      sourceRecords: [{ id: 'SRC-1', customerId: 'CUS-UNIT-1', notes: '[AUTO_PROFILE] x', processingStatus: 'UPLOADED', rawText: 'hi' }],
      evidenceItems: [],
      profileUpdateProposals: [],
      evidenceConflicts: [],
      appointments: [],
      sessions: [],
      enrollments: [],
      products: [],
      profileChanges: [],
      followups: [],
      _rows: { customers: [] },
    })
    const profile = await repository.customerProfile('ADMIN-1', 'CUS-UNIT-1')
    expect(profile.customerId).toBe('CUS-UNIT-1')
    expect(resume).not.toHaveBeenCalled()
  })
})
