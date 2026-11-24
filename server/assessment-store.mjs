// Assessment customer binding storage.
// Uses a dedicated Feishu bitable to track which assessment reports
// are bound to which customers, with full report snapshots for safety.
//
// Storage architecture:
// - assessmentReportDev PostgreSQL: authoritative full report storage (upstream)
// - ASVA Feishu "ASVA 测评客户绑定" table: customer binding index + local snapshot
// - Existing Feishu "ASVA 测评" table (tbljqgw8G2wzHLTU): upstream index (read-only from ASVA)
//
// The local snapshot ensures ASVA retains data even if upstream revokes access.
// ASVA is the authoritative source for customer binding relationships.

import crypto from 'node:crypto'

// Table schema for the binding table
const BINDING_TABLE_NAME = 'ASVA 测评客户绑定'
const BINDING_TABLE_FIELDS = [
  { field_name: '绑定 ID', type: 1 },        // text: unique binding ID
  { field_name: 'Provider', type: 1 },        // text: "mindtest-web"
  { field_name: '报告 ID', type: 1 },         // text: reportId (global unique with provider)
  { field_name: '测评 ID', type: 1 },         // text: assessmentId (star, sefs, etc.)
  { field_name: '测评名称', type: 1 },        // text: assessment display name
  { field_name: '客户 ID', type: 1 },         // text: ASVA customer ID
  { field_name: '客户姓名', type: 1 },        // text: customer display name
  { field_name: '报告署名', type: 1 },        // text: nickname on report
  { field_name: '完成时间', type: 5 },        // date: when assessment was completed
  { field_name: '绑定时间', type: 5 },        // date: when binding was created
  { field_name: '绑定人', type: 1 },          // text: mentor ID who created binding
  { field_name: '状态', type: 3, property: { options: [{ name: 'ACTIVE' }, { name: 'UNBOUND' }, { name: 'REVOKED' }, { name: 'TRANSFERRED' }] } },
  { field_name: '分享链接', type: 1 },        // text: original share URL (for reference)
  { field_name: '快照哈希', type: 1 },        // text: SHA256 of snapshot
  { field_name: '报告快照', type: 1 },        // text: full report JSON (for local safety)
  { field_name: '安全摘要', type: 1 },        // text: sanitized preview JSON
  { field_name: '备注', type: 1 },            // text: admin notes
]

/**
 * Ensure the binding table exists, creating it if necessary.
 * Returns the table ID.
 */
async function ensureBindingTable(feishu, config) {
  const configuredTableId = config.feishu.tables.assessmentBindings
  if (configuredTableId) return configuredTableId

  // Table not configured — create it
  const result = await feishu.createTable(BINDING_TABLE_NAME, BINDING_TABLE_FIELDS)
  const tableId = result?.table_id || result?.data?.table_id
  if (!tableId) throw Object.assign(new Error('创建测评绑定表失败'), { code: 'TABLE_CREATE_FAILED' })

  console.info('[ASSESSMENT_STORE]', JSON.stringify({ action: 'table_created', tableId }))
  return tableId
}

/**
 * Generate a unique binding ID.
 */
function generateBindingId() {
  return `ABD-${crypto.randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`
}

/**
 * Compute SHA256 hash of a JSON string (for snapshot integrity).
 */
function snapshotHash(jsonString) {
  return crypto.createHash('sha256').update(jsonString).digest('hex')
}

/**
 * Create the assessment store with all CRUD operations.
 */
export function createAssessmentStore({ feishu, config }) {
  let tableIdPromise = null

  function getTableId() {
    if (!tableIdPromise) {
      tableIdPromise = ensureBindingTable(feishu, config)
    }
    return tableIdPromise
  }

  /**
   * Bind a report to a customer.
   * Enforces:
   * - Same report cannot be bound to multiple customers
   * - Same report + same customer is idempotent (returns existing binding)
   * - Stores full snapshot for safety
   */
  async function bindReport({
    provider,
    reportId,
    assessmentId,
    assessmentName,
    customerId,
    customerName,
    reportNickname,
    completedAt,
    boundBy,
    shareUrl,
    fullReport,
    safePreview,
    notes = '',
  }) {
    const tableId = await getTableId()
    const bindingId = generateBindingId()
    const now = Date.now()

    // Check for existing binding for this report (global uniqueness)
    const existingBindings = await feishu.searchRecords(tableId, {
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: 'Provider', operator: 'is', value: [provider] },
          { field_name: '报告 ID', operator: 'is', value: [reportId] },
          { field_name: '状态', operator: 'is', value: ['ACTIVE'] },
        ]
      }
    })

    const activeBinding = existingBindings?.items?.[0]
    if (activeBinding) {
      const existingCustomerId = activeBinding.fields?.['客户 ID']
      if (existingCustomerId === customerId) {
        // Same customer — idempotent, return existing binding
        return {
          bindingId: activeBinding.fields?.['绑定 ID'],
          idempotent: true,
          alreadyBound: true,
          recordId: activeBinding.record_id,
          ...normalizeRecord(activeBinding),
        }
      }
      // Different customer — reject
      throw Object.assign(
        new Error(`此报告已绑定到其他客户（${activeBinding.fields?.['客户姓名'] || '未知'}）。如需转移，请先解绑。`),
        { code: 'REPORT_ALREADY_BOUND', existingCustomerId, existingBindingId: activeBinding.fields?.['绑定 ID'] }
      )
    }

    // Store full report snapshot
    const snapshotJson = typeof fullReport === 'string' ? fullReport : JSON.stringify(fullReport)
    const hash = snapshotHash(snapshotJson)
    const previewJson = JSON.stringify(safePreview)

    // Create binding record
    const fields = {
      '绑定 ID': bindingId,
      'Provider': provider,
      '报告 ID': reportId,
      '测评 ID': assessmentId,
      '测评名称': assessmentName,
      '客户 ID': customerId,
      '客户姓名': customerName,
      '报告署名': reportNickname || '',
      '完成时间': Date.parse(completedAt) || now,
      '绑定时间': now,
      '绑定人': boundBy,
      '状态': 'ACTIVE',
      '分享链接': shareUrl || '',
      '快照哈希': hash,
      '报告快照': snapshotJson,
      '安全摘要': previewJson,
      '备注': notes,
    }

    const result = await feishu.createRecord(tableId, fields, { operation: 'bind_assessment' })
    const recordId = result?.record?.record_id || result?.record_id

    console.info('[ASSESSMENT_STORE]', JSON.stringify({
      action: 'bound',
      bindingId,
      reportId,
      customerId,
      assessmentId,
      recordId,
    }))

    return {
      bindingId,
      recordId,
      idempotent: false,
      alreadyBound: false,
      provider,
      reportId,
      assessmentId,
      assessmentName,
      customerId,
      customerName,
      reportNickname,
      completedAt,
      boundAt: now,
      boundBy,
      status: 'ACTIVE',
    }
  }

  /**
   * Unbind a report from a customer (soft-delete).
   */
  async function unbindReport(bindingId, unboundBy, reason = '') {
    const tableId = await getTableId()
    const record = await findBindingById(tableId, bindingId)
    if (!record) throw Object.assign(new Error('绑定记录不存在'), { code: 'BINDING_NOT_FOUND' })
    if (record.fields?.['状态'] !== 'ACTIVE') {
      throw Object.assign(new Error('该绑定已不在活跃状态'), { code: 'BINDING_NOT_ACTIVE' })
    }

    // Update status to UNBOUND
    await feishu.updateRecord(tableId, record.record_id, {
      fields: {
        '状态': 'UNBOUND',
        '备注': [record.fields?.['备注'] || '', `【解绑】${unboundBy} @ ${new Date().toISOString()}${reason ? `：${reason}` : ''}`].filter(Boolean).join('\n'),
      }
    }, { operation: 'unbind_assessment' })

    console.info('[ASSESSMENT_STORE]', JSON.stringify({ action: 'unbound', bindingId, unboundBy, reason }))
    return { bindingId, status: 'UNBOUND' }
  }

  /**
   * Transfer a binding from one customer to another.
   */
  async function transferBinding(bindingId, newCustomerId, newCustomerName, transferredBy, reason = '') {
    const tableId = await getTableId()
    const record = await findBindingById(tableId, bindingId)
    if (!record) throw Object.assign(new Error('绑定记录不存在'), { code: 'BINDING_NOT_FOUND' })
    if (record.fields?.['状态'] !== 'ACTIVE') {
      throw Object.assign(new Error('该绑定已不在活跃状态'), { code: 'BINDING_NOT_ACTIVE' })
    }

    const oldCustomerId = record.fields?.['客户 ID']
    const oldCustomerName = record.fields?.['客户姓名']

    // Check if target customer already has this report
    const existingBindings = await feishu.searchRecords(tableId, {
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: 'Provider', operator: 'is', value: [record.fields?.['Provider']] },
          { field_name: '报告 ID', operator: 'is', value: [record.fields?.['报告 ID']] },
          { field_name: '客户 ID', operator: 'is', value: [newCustomerId] },
          { field_name: '状态', operator: 'is', value: ['ACTIVE'] },
        ]
      }
    })
    if (existingBindings?.items?.length > 0) {
      throw Object.assign(new Error('目标客户已绑定此报告'), { code: 'TARGET_ALREADY_BOUND' })
    }

    // Mark old binding as TRANSFERRED
    await feishu.updateRecord(tableId, record.record_id, {
      fields: {
        '状态': 'TRANSFERRED',
        '备注': [record.fields?.['备注'] || '', `【转移】${transferredBy} @ ${new Date().toISOString()}：${oldCustomerName}(${oldCustomerId}) → ${newCustomerName}(${newCustomerId})${reason ? `。原因：${reason}` : ''}`].filter(Boolean).join('\n'),
      }
    }, { operation: 'transfer_assessment_old' })

    // Create new binding for target customer (preserving snapshot)
    const newBindingId = generateBindingId()
    const now = Date.now()
    await feishu.createRecord(tableId, {
      '绑定 ID': newBindingId,
      'Provider': record.fields?.['Provider'],
      '报告 ID': record.fields?.['报告 ID'],
      '测评 ID': record.fields?.['测评 ID'],
      '测评名称': record.fields?.['测评名称'],
      '客户 ID': newCustomerId,
      '客户姓名': newCustomerName,
      '报告署名': record.fields?.['报告署名'],
      '完成时间': record.fields?.['完成时间'],
      '绑定时间': now,
      '绑定人': transferredBy,
      '状态': 'ACTIVE',
      '分享链接': record.fields?.['分享链接'],
      '快照哈希': record.fields?.['快照哈希'],
      '报告快照': record.fields?.['报告快照'],
      '安全摘要': record.fields?.['安全摘要'],
      '备注': `从 ${oldCustomerName}(${oldCustomerId}) 转移`,
    }, { operation: 'transfer_assessment_new' })

    console.info('[ASSESSMENT_STORE]', JSON.stringify({
      action: 'transferred', bindingId, newBindingId,
      from: oldCustomerId, to: newCustomerId, transferredBy,
    }))

    return { oldBindingId: bindingId, newBindingId, status: 'TRANSFERRED' }
  }

  /**
   * Get all active assessments for a customer.
   */
  async function getCustomerAssessments(customerId) {
    const tableId = await getTableId()
    const results = await feishu.searchRecords(tableId, {
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: '客户 ID', operator: 'is', value: [customerId] },
          { field_name: '状态', operator: 'is', value: ['ACTIVE'] },
        ]
      }
    })

    return (results?.items || []).map(normalizeRecord)
  }

  /**
   * Get all assessments (active) of a specific type for a customer (for version history).
   */
  async function getCustomerAssessmentHistory(customerId, assessmentId) {
    const tableId = await getTableId()
    const results = await feishu.searchRecords(tableId, {
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: '客户 ID', operator: 'is', value: [customerId] },
          { field_name: '测评 ID', operator: 'is', value: [assessmentId] },
          { field_name: '状态', operator: 'is', value: ['ACTIVE'] },
        ]
      }
    })

    // Sort by completedAt descending (most recent first)
    return (results?.items || []).map(normalizeRecord).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
  }

  /**
   * Find a specific binding by provider + reportId.
   */
  async function findBindingByReport(provider, reportId) {
    const tableId = await getTableId()
    const results = await feishu.searchRecords(tableId, {
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: 'Provider', operator: 'is', value: [provider] },
          { field_name: '报告 ID', operator: 'is', value: [reportId] },
          { field_name: '状态', operator: 'is', value: ['ACTIVE'] },
        ]
      }
    })

    const record = results?.items?.[0]
    return record ? normalizeRecord(record) : null
  }

  /**
   * Find a specific binding by binding ID.
   */
  async function findBindingById(bindingId) {
    const tableId = await getTableId()
    return findBindingById(tableId, bindingId)
  }

  // Internal: find binding record by binding ID
  async function findBindingById(tableId, bindingId) {
    const results = await feishu.searchRecords(tableId, {
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: '绑定 ID', operator: 'is', value: [bindingId] },
        ]
      }
    })
    return results?.items?.[0] || null
  }

  /**
   * Normalize a Feishu record into a clean assessment binding object.
   */
  function normalizeRecord(record) {
    const f = record.fields || {}
    let snapshot = null
    let preview = null
    try {
      if (f['报告快照']) snapshot = JSON.parse(f['报告快照'])
    } catch {}
    try {
      if (f['安全摘要']) preview = JSON.parse(f['安全摘要'])
    } catch {}

    return {
      bindingId: f['绑定 ID'],
      recordId: record.record_id,
      provider: f['Provider'],
      reportId: f['报告 ID'],
      assessmentId: f['测评 ID'],
      assessmentName: f['测评名称'],
      customerId: f['客户 ID'],
      customerName: f['客户姓名'],
      reportNickname: f['报告署名'],
      completedAt: f['完成时间'] || null,
      boundAt: f['绑定时间'] || null,
      boundBy: f['绑定人'],
      status: f['状态'],
      shareUrl: f['分享链接'],
      snapshotHash: f['快照哈希'],
      snapshot,
      preview,
      notes: f['备注'],
    }
  }

  return {
    bindReport,
    unbindReport,
    transferBinding,
    getCustomerAssessments,
    getCustomerAssessmentHistory,
    findBindingByReport,
    findBindingById,
    // Expose for testing
    _ensureBindingTable: () => getTableId(),
  }
}
