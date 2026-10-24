import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { findRecordsByFieldMock, listRecordsMock } = vi.hoisted(() => ({ findRecordsByFieldMock: vi.fn(), listRecordsMock: vi.fn() }))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return { ...actual, findRecordsByField: findRecordsByFieldMock, listRecords: listRecordsMock }
})

const { config } = await import('./config.mjs')
const { fields } = await import('./field-mapping.mjs')
const { FeishuRepository } = await import('./repository.mjs')

const originalTables = { ...config.feishu.tables }
const tableId = (name) => `r042-test-${name}`
const row = (table, recordId, values) => ({ record_id: recordId, fields: fields(table, values) })

const admin = { id: 'STAFF-ADMIN', name: '管理员', role: 'ADMIN', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }
const mentor = { id: 'STAFF-MENTOR', name: '导师', role: 'MENTOR', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true }
let activeRows
const fixtureRows = () => ({
  [tableId('customers')]: [
    row('customers', 'rec-c1', { customer_id: 'CUS-1', nickname: '客户一', current_mentor_id: mentor.id, city: '杭州' }),
    row('customers', 'rec-c2', { customer_id: 'CUS-2', nickname: '客户二', current_mentor_id: 'STAFF-OTHER' }),
  ],
  [tableId('staff')]: [row('staff', 'rec-admin', { staff_id: admin.id, name: admin.name, permission_role: 'ADMIN', status: 'ACTIVE', login_enabled: true }), row('staff', 'rec-mentor', { staff_id: mentor.id, name: mentor.name, permission_role: 'MENTOR', status: 'ACTIVE', login_enabled: true })],
  [tableId('products')]: [],
  [tableId('enrollments')]: [],
  [tableId('evidenceItems')]: [row('evidenceItems', 'rec-e1', { evidence_id: 'E-1', customer_id: 'CUS-1', source_id: 'SRC-1', review_status: 'CONFIRMED', semantic_kind: 'CURRENT_STATE', field_key: 'city', standard_value: '杭州', display_text: '客户一证据', source_excerpt: '客户一资料', confidence: 0.95 }), row('evidenceItems', 'rec-e-pending', { evidence_id: 'E-PENDING', customer_id: 'CUS-1', source_id: 'SRC-1', review_status: 'PENDING_REVIEW', semantic_kind: 'EVENT', field_key: 'occupation', evidence_type: 'SELF_MEANING', content_source: 'STAFF_TRANSCRIBED_CUSTOMER', information_nature: 'PERSONAL_STATEMENT', verification_status: 'SOURCE_SUPPORTED', display_text: '正在探索新的职业方向', source_excerpt: '她说正在探索新的职业方向', confidence: 0.7 }), row('evidenceItems', 'rec-e-high', { evidence_id: 'E-HIGH', customer_id: 'CUS-1', source_id: 'SRC-1', review_status: 'PENDING_REVIEW', semantic_kind: 'CURRENT_STATE', field_key: 'current_core_issue', privacy_level: 'HIGH_SENSITIVE', privacy_meta_json: JSON.stringify({ categories: ['SELF_HARM'], safetyFlags: ['SELF_HARM'], temporalType: 'CURRENT' }), display_text: '高敏安全原文', source_excerpt: '高敏安全原文' }), row('evidenceItems', 'rec-e2', { evidence_id: 'E-2', customer_id: 'CUS-2', source_id: 'SRC-2', review_status: 'CONFIRMED', display_text: '客户二证据' })],
  [tableId('appointments')]: [],
  [tableId('serviceRecords')]: [],
  [tableId('profileChanges')]: [],
  [tableId('sourceRecords')]: [row('sourceRecords', 'rec-s1', { source_id: 'SRC-1', customer_id: 'CUS-1', raw_text: '客户一资料' }), row('sourceRecords', 'rec-s2', { source_id: 'SRC-2', customer_id: 'CUS-2', raw_text: '客户二资料' })],
  [tableId('profileUpdateProposals')]: [],
  [tableId('evidenceConflicts')]: [],
})

beforeEach(() => {
  for (const name of Object.keys(originalTables)) config.feishu.tables[name] = tableId(name)
  activeRows = fixtureRows()
  listRecordsMock.mockReset().mockImplementation(async (id) => activeRows[id] || [])
  findRecordsByFieldMock.mockReset().mockImplementation(async (id, fieldName, value) => (activeRows[id] || []).filter((item) => String(item?.fields?.[fieldName] ?? '') === String(value)))
})

afterEach(() => {
  Object.assign(config.feishu.tables, originalTables)
})

describe('R043 progressive read paths', () => {
  it('deduplicates concurrent directory reads and reuses the directory cache', async () => {
    const repository = new FeishuRepository()
    const [first, second] = await Promise.all([repository.customerDirectory(admin.id), repository.customerDirectory(admin.id)])

    expect(first.customers).toHaveLength(2)
    expect(second.customers).toHaveLength(2)
    expect(listRecordsMock).toHaveBeenCalledTimes(4)
    await repository.customerDirectory(admin.id)
    expect(listRecordsMock).toHaveBeenCalledTimes(4)
  })

  it('loads only customer-relevant detail tables and protects mentor scope', async () => {
    const repository = new FeishuRepository()
    const directory = await repository.loadDirectory()
    const detail = await repository.loadCustomerDetailFresh('CUS-1', directory)

    expect(detail.customers).toHaveLength(1)
    expect(detail.sourceRecords).toEqual([])
    expect(detail.evidenceItems).toEqual([])
    expect(listRecordsMock).toHaveBeenCalledTimes(7)

    const mentorDetail = await repository.customerDetail(mentor.id, 'CUS-1')
    expect(mentorDetail.customers.map((item) => item.id)).toEqual(['CUS-1'])
    expect(JSON.stringify(mentorDetail)).not.toContain('CUS-2')
    await expect(repository.customerDetail(mentor.id, 'CUS-2')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
  })

  it('keeps authentication staff-only instead of forcing the full business read', async () => {
    const repository = new FeishuRepository()
    const staff = await repository.staff(admin.id)
    expect(staff.id).toBe(admin.id)
    expect(listRecordsMock).toHaveBeenCalledTimes(1)
    expect(listRecordsMock).toHaveBeenCalledWith(tableId('staff'), expect.objectContaining({ readContext: expect.any(Object) }))
  })

  it('records the reduced customer-save context without loading unrelated tables', async () => {
    const repository = new FeishuRepository()
    const context = await repository.loadCustomerMutationContext({ scene: 'A1' })

    expect(context.customers).toHaveLength(2)
    expect(listRecordsMock).toHaveBeenCalledTimes(4)
    expect(repository.readMetricsSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scene: 'A1', mode: 'FULL', table: 'customers', logicalReads: 1, providerRequests: 1 }),
      expect.objectContaining({ scene: 'A1', mode: 'FULL', table: 'staff', logicalReads: 1, providerRequests: 1 }),
      expect.objectContaining({ scene: 'A1', mode: 'FULL', table: 'products', logicalReads: 1, providerRequests: 1 }),
      expect.objectContaining({ scene: 'A1', mode: 'FULL', table: 'enrollments', logicalReads: 1, providerRequests: 1 }),
    ]))
  })

  it('loads complete customer profile history for compact mutation responses', async () => {
    activeRows[tableId('profileChanges')] = Array.from({ length: 10 }, (_, index) => row('profileChanges', `rec-history-${index + 1}`, {
      change_id: `PC-${index + 1}`, customer_id: 'CUS-1', field_key: `field_${index + 1}`, field_name: `字段${index + 1}`,
      old_value: '', new_value: `值${index + 1}`, source: 'MANUAL', confidence: 1, confirmed: true,
      changed_at: `2026-01-${String(index + 1).padStart(2, '0')}`,
    }))
    const repository = new FeishuRepository()
    const current = await repository.loadCustomerMutationContext({ scene: 'A2', customerId: 'CUS-1' })
    expect(current.profileChanges).toHaveLength(10)
    expect(current._readCoverage.profileChanges).toBe('CUSTOMER_FILTERED')

    activeRows[tableId('profileChanges')].push(row('profileChanges', 'rec-history-11', {
      change_id: 'PC-11', customer_id: 'CUS-1', field_key: 'field_11', field_name: '字段11',
      old_value: '', new_value: '值11', source: 'MANUAL', confidence: 1, confirmed: true, changed_at: '2026-01-11',
    }))
    const refreshed = await repository.reloadAfterEnrollmentMutation(current, 'CUS-1', true, 'A2')
    expect(refreshed.profileChanges).toHaveLength(11)
    expect(refreshed._profileChangesLoadedFor).toEqual(['CUS-1'])
  })

  it('loads the customer profile materialization on demand without returning raw workspace tables', async () => {
    const repository = new FeishuRepository()
    const profile = await repository.customerProfile(mentor.id, 'CUS-1')

    expect(profile.customerId).toBe('CUS-1')
    expect(profile.profileMaterialization.sections.some((section) => section.items.length > 0)).toBe(true)
    expect(profile).not.toHaveProperty('sourceRecords')
    expect(profile).not.toHaveProperty('evidenceItems')
    await expect(repository.customerProfile(mentor.id, 'CUS-2')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 })
  })

  it('auto-archives ordinary evidence while excluding high-sensitive evidence from the profile projection', async () => {
    const repository = new FeishuRepository()
    const profile = await repository.customerProfile(admin.id, 'CUS-1')
    expect(profile.profileMaterialization.provisionalItems).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: 'E-PENDING', sectionTitle: '职业与事业' })]))
    expect(profile.profileMaterialization.provisionalItems).not.toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: 'E-HIGH' })]))
    const mentorProfile = await repository.customerProfile(mentor.id, 'CUS-1')
    expect(mentorProfile.profileMaterialization.provisionalItems).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: 'E-PENDING' })]))
    expect(JSON.stringify(mentorProfile.profileMaterialization)).not.toContain('高敏安全原文')
  })

  it('uses customer-scoped source filters when no shared full read is active', async () => {
    const repository = new FeishuRepository()
    const workspace = await repository.sourceWorkspace(mentor.id, 'CUS-1')

    expect(workspace.sources.map((item) => item.id)).toEqual(['SRC-1'])
    expect(workspace.evidenceItems.map((item) => item.id)).toEqual(['E-1', 'E-PENDING', 'E-HIGH'])
    expect(listRecordsMock).toHaveBeenCalledTimes(4)
    expect(findRecordsByFieldMock).toHaveBeenCalledTimes(4)
    expect(repository.readMetricsSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scene: 'A3_SOURCE', mode: 'TARGETED', table: 'sourceRecords', logicalReads: 1, providerRequests: 1 }),
      expect.objectContaining({ scene: 'A3_SOURCE', mode: 'TARGETED', table: 'evidenceItems', logicalReads: 1, providerRequests: 1 }),
    ]))
  })

  it('keeps Source save context narrower than Source workspace context', async () => {
    const repository = new FeishuRepository()
    const context = await repository.loadSourceMutationContext('CUS-1')

    expect(context.sourceRecords.map((item) => item.id)).toEqual(['SRC-1'])
    expect(listRecordsMock).toHaveBeenCalledTimes(4)
    expect(findRecordsByFieldMock).toHaveBeenCalledTimes(1)
  })

  it('loads source-scoped proposals and conflicts before processing', async () => {
    activeRows[tableId('profileUpdateProposals')] = [row('profileUpdateProposals', 'rec-proposal-1', {
      proposal_id: 'PROP-1', customer_id: 'CUS-1', subject_id: 'CUS-1', evidence_id: 'E-1', source_id: 'SRC-1',
      field_key: 'city', field_name: '所在城市', current_value: '杭州', proposed_value: '杭州', action: 'REVIEW_REQUIRED', change_type: 'NO_CHANGE',
      review_status: 'PENDING_REVIEW', reason: '已有建议', confidence: 0.8, extraction_batch_id: 'EXT-1',
    })]
    activeRows[tableId('evidenceConflicts')] = [row('evidenceConflicts', 'rec-conflict-1', {
      conflict_id: 'CONFLICT-1', subject_id: 'CUS-1', customer_id: 'CUS-1', field_key: 'city', conflict_type: 'VALUE_CONFLICT',
      current_value: '杭州', new_value: '上海', current_evidence_id: 'E-1', new_evidence_id: 'E-PENDING', status: 'OPEN',
    })]
    const repository = new FeishuRepository()
    const context = await repository.loadSourceProcessingContext('SRC-1')

    expect(context.profileUpdateProposals).toHaveLength(1)
    expect(context.evidenceConflicts).toHaveLength(1)
    expect(context._allProfileUpdateProposals).toHaveLength(1)
    expect(context._allEvidenceConflicts).toHaveLength(1)
    expect(context._readCoverage).toMatchObject({ profileUpdateProposals: 'SOURCE_FILTERED_ALL', evidenceConflicts: 'SOURCE_FILTERED_ALL' })
    expect(findRecordsByFieldMock).toHaveBeenCalledTimes(4)
  })

  it('fails closed when a source processing dependency is incomplete', async () => {
    findRecordsByFieldMock.mockImplementation(async (id, fieldName, value) => {
      if (id === tableId('profileUpdateProposals')) throw Object.assign(new Error('synthetic proposal read failure'), { code: 'FEISHU_TIMEOUT', retryable: true })
      return (activeRows[id] || []).filter((item) => String(item?.fields?.[fieldName] ?? '') === String(value))
    })
    const repository = new FeishuRepository()
    await expect(repository.loadSourceProcessingContext('SRC-1')).rejects.toMatchObject({ code: 'FEISHU_TIMEOUT' })
  })

  it('fails closed when a source-scoped query fails instead of treating it as missing', async () => {
    findRecordsByFieldMock.mockRejectedValueOnce(Object.assign(new Error('synthetic read failure'), { code: 'FEISHU_TIMEOUT', retryable: true }))
    const repository = new FeishuRepository()

    await expect(repository.sourceWorkspace(mentor.id, 'CUS-1')).rejects.toMatchObject({ code: 'FEISHU_TIMEOUT' })
  })

  it('reuses one permission-scoped database read across customer detail resources', async () => {
    const repository = new FeishuRepository()
    await Promise.all([
      repository.customerProfile(mentor.id, 'CUS-1'),
      repository.getCustomerUnderstanding(mentor.id, 'CUS-1'),
      repository.getCustomerSalesUnderstanding(mentor.id, 'CUS-1'),
      repository.sourceWorkspace(mentor.id, 'CUS-1'),
    ])

    expect(listRecordsMock).toHaveBeenCalledTimes(11)
    expect(findRecordsByFieldMock).toHaveBeenCalledTimes(0)
    await Promise.all([
      repository.customerProfile(mentor.id, 'CUS-1'),
      repository.getCustomerUnderstanding(mentor.id, 'CUS-1'),
      repository.getCustomerSalesUnderstanding(mentor.id, 'CUS-1'),
      repository.sourceWorkspace(mentor.id, 'CUS-1'),
    ])
    expect(listRecordsMock).toHaveBeenCalledTimes(11)
    expect(findRecordsByFieldMock).toHaveBeenCalledTimes(0)
  })
})
