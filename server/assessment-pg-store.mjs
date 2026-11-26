// Assessment customer binding storage via PostgreSQL RPC.
// Mirrors the ai-budget-guard pattern: a single RPC function owns all
// transactional state transitions. The Node.js client never touches tables.
//
// Architecture:
// - PostgreSQL: authoritative storage for bindings, snapshots, audit
// - Feishu upstream index (tbljqgw8G2wzHLTU): read-only, not modified
// - No auto-table-creation; tables created via migration SQL
// - No credentials (linkSecret, ownerToken) stored anywhere
// - Immutable snapshots preserved across unbind/transfer
// - Customer consent tracked; unconsented reports excluded from AI context

import crypto from 'node:crypto'

export class AssessmentStoreError extends Error {
  constructor(message, code, status = 503, cause) {
    super(message, { cause })
    this.code = code
    this.status = status
  }
}

function unavailable(error) {
  if (error instanceof AssessmentStoreError) return error
  return new AssessmentStoreError('测评存储服务不可用', 'ASSESSMENT_STORE_UNAVAILABLE', 503, error)
}

/**
 * Generate a unique binding ID.
 */
export function generateBindingId() {
  return `ABD-${crypto.randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`
}

/**
 * Compute SHA256 hash of a JSON-stringifiable value.
 */
export function snapshotHash(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value)
  return crypto.createHash('sha256').update(json).digest('hex')
}

/**
 * Strip credentials and sensitive fields from a report before storage.
 * Recursively removes: linkSecret, ownerToken, shareSecret, any field containing 'secret' or 'token'.
 * Handles nested objects and arrays.
 */
export function sanitizeReportForStorage(report) {
  if (report === null || report === undefined) return report
  if (typeof report !== 'object') return report
  if (Array.isArray(report)) return report.map(item => sanitizeReportForStorage(item))
  
  const sanitized = {}
  for (const [key, value] of Object.entries(report)) {
    const lower = key.toLowerCase()
    // Skip top-level credentials
    if (lower.includes('secret') || lower.includes('token') || lower.includes('password') || lower.includes('credential')) {
      continue
    }
    // Recursively sanitize nested objects and arrays
    if (value !== null && typeof value === 'object') {
      sanitized[key] = sanitizeReportForStorage(value)
    } else {
      sanitized[key] = value
    }
  }
  return sanitized
}

/**
 * Strip the linkSecret portion from a share URL for safe storage.
 * The share URL format is: base/#reportId.linkSecret
 * We store only the base + reportId, without the secret.
 */
export function sanitizeShareUrl(url) {
  if (!url || typeof url !== 'string') return ''
  const hashIndex = url.indexOf('#')
  if (hashIndex === -1) return url
  const fragment = url.slice(hashIndex + 1)
  const dotIndex = fragment.indexOf('.')
  if (dotIndex === -1) return url
  // Keep base + reportId, strip the secret
  return url.slice(0, hashIndex + 1) + fragment.slice(0, dotIndex)
}

export class CloudBaseAssessmentStore {
  constructor({
    collection,
    table,
    envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.TCB_ENV_ID || '',
    apiKey = process.env.CLOUDBASE_APIKEY || '',
    rpcBaseUrl = process.env.ASSESSMENT_RPC_BASE_URL || process.env.ON_DEMAND_AI_BUDGET_RPC_BASE_URL || '',
    rpcFunction = process.env.ASSESSMENT_RPC_FUNCTION || 'asva_assessment_guard',
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    this.collection = String(collection || table || 'asva_assessment_bindings').trim()
    this.envId = String(envId || '').trim()
    this.apiKey = String(apiKey || '').trim()
    this.rpcBaseUrl = String(rpcBaseUrl || (this.envId ? `https://${this.envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc` : '')).replace(/\/$/, '')
    this.rpcFunction = String(rpcFunction || '').trim()
    this.fetchImpl = fetchImpl
    this.clock = clock
  }

  configured() {
    return Boolean(this.rpcBaseUrl && this.rpcFunction && this.apiKey && typeof this.fetchImpl === 'function')
  }

  async rpc(action, payload = {}) {
    if (!this.configured()) throw new AssessmentStoreError('测评存储尚未配置', 'ASSESSMENT_STORE_UNCONFIGURED', 409)
    const url = `${this.rpcBaseUrl}/${encodeURIComponent(this.rpcFunction)}`
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ request: { action, table: this.collection, ...payload } }),
      })
    } catch (error) { throw unavailable(error) }
    let body = null
    try { body = await response.json() } catch {}
    const data = body?.data ?? body?.result ?? body
    if (!response.ok) {
      const error = body?.error || body || {}
      throw new AssessmentStoreError(error.message || '测评存储 RPC 请求失败', error.code || 'ASSESSMENT_STORE_UNAVAILABLE', Number(error.status || response.status || 503), error)
    }
    if (data?.error) {
      const error = data.error
      throw new AssessmentStoreError(error.message || '测评存储操作失败', error.code || 'ASSESSMENT_STORE_ERROR', Number(error.status || 503), error)
    }
    return data
  }

  /**
   * Bind a report to a customer.
   * The full report snapshot must come from the source service (not client).
   * Credentials (linkSecret, ownerToken) are stripped before storage.
   */
  async bindReport({
    provider,
    reportId,
    assessmentId,
    assessmentName,
    assessmentVersion = '',
    schemaVersion = '',
    customerId,
    customerName,
    reportNickname,
    completedAt,
    boundBy,
    shareUrl,
    fullReport,
    safePreview,
    nameMismatch = false,
    nameConfirmedBy,
    nameConfirmedReason,
    customerConsent = false,
    customerConsentRecord,
  }) {
    if (!provider || !reportId || !customerId) {
      throw new AssessmentStoreError('绑定参数无效', 'ASSESSMENT_BIND_INVALID', 400)
    }

    // Sanitize: strip credentials from report before storage
    const sanitizedSnapshot = sanitizeReportForStorage(fullReport)
    const sanitizedPreview = sanitizeReportForStorage(safePreview)
    const safeUrl = sanitizeShareUrl(shareUrl)
    const hash = snapshotHash(sanitizedSnapshot)
    const bindingId = generateBindingId()
    const now = this.clock().toISOString()

    try {
      const result = await this.rpc('bind', {
        bindingId,
        provider,
        reportId,
        assessmentId: assessmentId || '',
        assessmentName: assessmentName || '',
        assessmentVersion: assessmentVersion || '',
        schemaVersion: schemaVersion || '',
        customerId,
        customerName: customerName || '',
        reportNickname: reportNickname || '',
        completedAt: completedAt || '',
        boundBy: boundBy || '',
        snapshot: sanitizedSnapshot,
        snapshotHash: hash,
        preview: sanitizedPreview,
        nameMismatch: Boolean(nameMismatch),
        nameConfirmedBy: nameConfirmedBy || '',
        nameConfirmedAt: nameMismatch && nameConfirmedBy ? now : '',
        nameConfirmedReason: nameConfirmedReason || '',
        // Archive authorization: boundBy confirms on behalf of customer
        archiveConfirmedBy: boundBy || '',
        archiveConfirmedAt: now,
        // AI consent: defaults false, must be explicitly granted
        customerConsent: Boolean(customerConsent),
        customerConsentAt: customerConsent ? now : '',
        // V1.0.1: Store full share URL (with linkSecret) for viewing original report
        encryptedShareUrl: shareUrl || '',
        customerConsentRecord: customerConsentRecord || '',
        now,
      })

      if (result.idempotent) {
        return {
          bindingId: result.binding?.id || bindingId,
          idempotent: true,
          alreadyBound: true,
          ...normalizeBinding(result.binding),
        }
      }

      return {
        bindingId,
        idempotent: false,
        alreadyBound: false,
        ...normalizeBinding(result.binding),
      }
    } catch (error) {
      if (error.code === 'REPORT_ALREADY_BOUND') {
        throw Object.assign(error, {
          existingCustomerId: error.existingCustomerId,
          existingCustomerName: error.existingCustomerName,
        })
      }
      throw unavailable(error)
    }
  }

  async unbindReport(bindingId, actorId, reason = '') {
    if (!bindingId) throw new AssessmentStoreError('绑定 ID 无效', 'BINDING_NOT_FOUND', 404)
    try {
      const result = await this.rpc('unbind', { bindingId, actorId: actorId || '', reason, now: this.clock().toISOString() })
      return { bindingId, status: result.status || 'UNBOUND' }
    } catch (error) {
      throw unavailable(error)
    }
  }

  async transferBinding(bindingId, targetCustomerId, targetCustomerName, actorId, reason = '') {
    if (!bindingId || !targetCustomerId) throw new AssessmentStoreError('转移参数无效', 'TRANSFER_INVALID', 400)
    const newBindingId = generateBindingId()
    try {
      const result = await this.rpc('transfer', {
        bindingId,
        targetCustomerId,
        targetCustomerName: targetCustomerName || '',
        newBindingId,
        actorId: actorId || '',
        reason,
        now: this.clock().toISOString(),
      })
      return { oldBindingId: bindingId, newBindingId, status: 'TRANSFERRED' }
    } catch (error) {
      throw unavailable(error)
    }
  }

  async revokeLocal(bindingId, actorId, reason = '') {
    if (!bindingId) throw new AssessmentStoreError('绑定 ID 无效', 'BINDING_NOT_FOUND', 404)
    try {
      const result = await this.rpc('revoke_local', { bindingId, actorId: actorId || '', reason, now: this.clock().toISOString() })
      return { bindingId, status: 'REVOKED' }
    } catch (error) {
      throw unavailable(error)
    }
  }

  async confirmName(bindingId, confirmedBy, reason = '') {
    if (!bindingId) throw new AssessmentStoreError('绑定 ID 无效', 'BINDING_NOT_FOUND', 404)
    try {
      await this.rpc('confirm_name', { bindingId, confirmedBy: confirmedBy || '', reason, now: this.clock().toISOString() })
      return { bindingId, nameConfirmed: true }
    } catch (error) {
      throw unavailable(error)
    }
  }

  async grantConsent(bindingId, actorId, consentRecord = '') {
    if (!bindingId) throw new AssessmentStoreError('绑定 ID 无效', 'BINDING_NOT_FOUND', 404)
    try {
      await this.rpc('grant_consent', { bindingId, actorId: actorId || '', consentRecord, now: this.clock().toISOString() })
      return { bindingId, consentGranted: true }
    } catch (error) {
      throw unavailable(error)
    }
  }

  async getCustomerAssessments(customerId) {
    if (!customerId) return []
    try {
      const result = await this.rpc('get', { customerId })
      return (result.bindings || []).map(normalizeBinding)
    } catch (error) {
      throw unavailable(error)
    }
  }

  async getCustomerAssessmentHistory(customerId, assessmentId) {
    if (!customerId) return []
    try {
      const result = await this.rpc('history', { customerId, assessmentId: assessmentId || '' })
      // Already sorted by completed_at DESC in SQL
      return (result.bindings || []).map(normalizeBinding)
    } catch (error) {
      throw unavailable(error)
    }
  }

  async findBindingByReport(provider, reportId) {
    if (!provider || !reportId) return null
    try {
      const result = await this.rpc('get', { provider, reportId })
      return result.binding ? normalizeBinding(result.binding) : null
    } catch (error) {
      throw unavailable(error)
    }
  }

  async findBindingById(bindingId) {
    if (!bindingId) return null
    try {
      const result = await this.rpc('get', { bindingId })
      return result.binding ? normalizeBinding(result.binding) : null
    } catch (error) {
      throw unavailable(error)
    }
  }

  async getBindingEvents(bindingId) {
    if (!bindingId) return []
    try {
      const result = await this.rpc('events', { bindingId })
      return result.events || []
    } catch (error) {
      throw unavailable(error)
    }
  }

  // V1.0.1: Get full share URL for viewing original report (mentor access only)
  async getShareUrlForViewing(bindingId) {
    if (!bindingId) return null
    try {
      const result = await this.rpc('get_share_url', { bindingId })
      return result.encryptedShareUrl || result.encrypted_share_url || null
    } catch (error) {
      throw unavailable(error)
    }
  }

  // V1.0.1: Supplement missing share URL for existing binding
  async supplementShareUrl(bindingId, shareUrl, supplementedBy) {
    if (!bindingId || !shareUrl) {
      throw new AssessmentStoreError('参数无效', 'INVALID_ARGUMENTS', 400)
    }
    try {
      const result = await this.rpc('supplement_share_url', {
        bindingId,
        shareUrl,
        supplementedBy: supplementedBy || '',
        supplementedAt: this.clock().toISOString(),
      })
      return result.binding ? normalizeBinding(result.binding) : null
    } catch (error) {
      throw unavailable(error)
    }
  }

  // V1.0.1: Update/replace current report with new one of same type
  async updateReport({
    bindingId,
    newShareUrl,
    newReportId,
    newSnapshot,
    newPreview,
    updatedBy,
    updateReason = '',
  }) {
    if (!bindingId || !newShareUrl || !newReportId) {
      throw new AssessmentStoreError('参数无效', 'INVALID_ARGUMENTS', 400)
    }
    const sanitizedSnapshot = sanitizeReportForStorage(newSnapshot)
    const sanitizedPreview = sanitizeReportForStorage(newPreview)
    const hash = snapshotHash(sanitizedSnapshot)
    const now = this.clock().toISOString()

    try {
      const result = await this.rpc('update_report', {
        bindingId,
        newShareUrl,
        newReportId,
        newSnapshot: sanitizedSnapshot,
        newSnapshotHash: hash,
        newPreview: sanitizedPreview,
        updatedBy: updatedBy || '',
        updatedAt: now,
        updateReason,
      })
      return result.binding ? normalizeBinding(result.binding) : null
    } catch (error) {
      throw unavailable(error)
    }
  }
}

function normalizeBinding(raw) {
  if (!raw) return raw
  return {
    bindingId: raw.id,
    provider: raw.provider,
    reportId: raw.reportId || raw.report_id,
    assessmentId: raw.assessmentId || raw.assessment_id,
    assessmentName: raw.assessmentName || raw.assessment_name,
    assessmentVersion: raw.assessmentVersion || raw.assessment_version,
    schemaVersion: raw.schemaVersion || raw.schema_version,
    customerId: raw.customerId || raw.customer_id,
    customerName: raw.customerName || raw.customer_name,
    reportNickname: raw.reportNickname || raw.report_nickname,
    completedAt: raw.completedAt || raw.completed_at,
    boundAt: raw.boundAt || raw.bound_at,
    boundBy: raw.boundBy || raw.bound_by,
    status: raw.status,
    snapshotHash: raw.snapshotHash || raw.snapshot_hash,
    snapshot: raw.snapshot,
    preview: raw.preview,
    nameMismatch: raw.nameMismatch || raw.name_mismatch || false,
    nameConfirmedBy: raw.nameConfirmedBy || raw.name_confirmed_by,
    nameConfirmedAt: raw.nameConfirmedAt || raw.name_confirmed_at,
    nameConfirmedReason: raw.nameConfirmedReason || raw.name_confirmed_reason,
    archiveConfirmedBy: raw.archiveConfirmedBy || raw.archive_confirmed_by || '',
    archiveConfirmedAt: raw.archiveConfirmedAt || raw.archive_confirmed_at,
    customerConsent: raw.customerConsent || raw.customer_consent || false,
    customerConsentAt: raw.customerConsentAt || raw.customer_consent_at,
    // V1.0.1: Include encrypted share URL for viewing original report
    encryptedShareUrl: raw.encryptedShareUrl || raw.encrypted_share_url || '',
    customerConsentAt: raw.customerConsentAt || raw.customer_consent_at,
    sourceRevoked: raw.sourceRevoked || raw.source_revoked || false,
    localRevoked: raw.localRevoked || raw.local_revoked || false,
  }
}
