// PostgreSQL-backed assessment store for integration testing.
// Uses real PostgreSQL (local) and the asva_assessment_guard RPC function.
// This is NOT a mock — it executes real SQL via the real RPC function.

import pg from 'pg'
const { Pool } = pg

export class PgTestAssessmentStore {
  constructor(dbName = 'asva_assessment_test', dbUser = process.env.USER || 'postgres') {
    this.pool = new Pool({ database: dbName, user: dbUser })
  }

  async close() {
    await this.pool.end()
  }

  async rpc(action, payload = {}) {
    const result = await this.pool.query(
      'SELECT public.asva_assessment_guard($1::jsonb)',
      [JSON.stringify({ action, table: 'asva_assessment_bindings', ...payload })]
    )
    const data = result.rows[0].asva_assessment_guard
    if (data?.error) {
      const err = new Error(data.error.message || 'PG RPC error')
      err.code = data.error.code
      err.status = data.error.status || 500
      throw err
    }
    return data
  }

  configured() { return true }

  async bindReport(params) {
    const result = await this.rpc('bind', {
      bindingId: params.bindingId || `ABD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      provider: params.provider,
      reportId: params.reportId,
      assessmentId: params.assessmentId || '',
      assessmentName: params.assessmentName || '',
      assessmentVersion: params.assessmentVersion || '',
      schemaVersion: params.schemaVersion || '',
      customerId: params.customerId,
      customerName: params.customerName || '',
      reportNickname: params.reportNickname || '',
      completedAt: params.completedAt || '',
      boundBy: params.boundBy || '',
      snapshot: params.fullReport || {},
      snapshotHash: params.snapshotHash || '',
      preview: params.safePreview || {},
      nameMismatch: Boolean(params.nameMismatch),
      nameConfirmedBy: params.nameConfirmedBy || '',
      nameConfirmedReason: params.nameConfirmedReason || '',
      archiveConfirmedBy: params.boundBy || '',
      archiveConfirmedAt: new Date().toISOString(),
      customerConsent: Boolean(params.customerConsent),
      customerConsentRecord: params.customerConsentRecord || '',
      now: new Date().toISOString(),
    })
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.error.status })
    return {
      bindingId: result.binding?.id || result.newBindingId,
      idempotent: result.idempotent || false,
      alreadyBound: result.alreadyBound || false,
      status: result.binding?.status || 'ACTIVE',
      existingCustomerId: result.error?.existingCustomerId,
      existingCustomerName: result.error?.existingCustomerName,
    }
  }

  async unbindReport(bindingId, actorId, reason) {
    const result = await this.rpc('unbind', { bindingId, actorId: actorId || '', reason: reason || '', now: new Date().toISOString() })
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.error.status })
    return { bindingId, status: 'UNBOUND' }
  }

  async transferBinding(bindingId, targetCustomerId, targetCustomerName, actorId, reason) {
    const newBindingId = `ABD-TR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await this.rpc('transfer', {
      bindingId, targetCustomerId, targetCustomerName: targetCustomerName || '',
      newBindingId, actorId: actorId || '', reason: reason || '', now: new Date().toISOString(),
    })
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.error.status })
    return { oldBindingId: bindingId, newBindingId, status: 'TRANSFERRED' }
  }

  async revokeLocal(bindingId, actorId, reason) {
    const result = await this.rpc('revoke_local', { bindingId, actorId: actorId || '', reason: reason || '', now: new Date().toISOString() })
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.error.status })
    return { bindingId, status: 'REVOKED' }
  }

  async confirmName(bindingId, confirmedBy, reason) {
    const result = await this.rpc('confirm_name', { bindingId, confirmedBy: confirmedBy || '', reason: reason || '', now: new Date().toISOString() })
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.error.status })
    return { bindingId, nameConfirmed: true }
  }

  async grantConsent(bindingId, actorId, consentRecord) {
    const result = await this.rpc('grant_consent', { bindingId, actorId: actorId || '', consentRecord: consentRecord || '', now: new Date().toISOString() })
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.error.status })
    return { bindingId, consentGranted: true }
  }

  async revokeConsent(bindingId, actorId, reason) {
    const result = await this.rpc('revoke_consent', { bindingId, actorId: actorId || '', reason: reason || '', now: new Date().toISOString() })
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.error.status })
    return { bindingId, consentRevoked: true }
  }

  async getCustomerAssessments(customerId) {
    const result = await this.rpc('get', { customerId })
    return (result.bindings || []).map(b => ({
      bindingId: b.id,
      provider: b.provider,
      reportId: b.reportId,
      assessmentId: b.assessmentId,
      assessmentName: b.assessmentName,
      customerId: b.customerId,
      customerName: b.customerName,
      reportNickname: b.reportNickname,
      completedAt: b.completedAt,
      boundAt: b.boundAt,
      boundBy: b.boundBy,
      status: b.status,
      snapshotHash: b.snapshotHash,
      preview: b.preview,
      nameMismatch: b.nameMismatch,
      customerConsent: b.customerConsent,
      sourceRevoked: b.sourceRevoked,
      localRevoked: b.localRevoked,
    }))
  }

  async getCustomerAssessmentHistory(customerId, assessmentId) {
    const result = await this.rpc('history', { customerId, assessmentId: assessmentId || '' })
    return result.bindings || []
  }

  async findBindingById(bindingId) {
    const result = await this.rpc('get', { bindingId })
    if (!result.binding) return null
    const b = result.binding
    return {
      bindingId: b.id,
      provider: b.provider,
      reportId: b.reportId,
      assessmentId: b.assessmentId,
      customerId: b.customerId,
      customerName: b.customerName,
      status: b.status,
      snapshot: b.snapshot,
      preview: b.preview,
      shareUrl: '',
      nameMismatch: b.nameMismatch,
      customerConsent: b.customerConsent,
      sourceRevoked: b.sourceRevoked,
      localRevoked: b.localRevoked,
    }
  }

  async getBindingEvents(bindingId) {
    const result = await this.rpc('events', { bindingId })
    return result.events || []
  }

  // V1.0.1: New methods for UX optimization
  async getShareUrlForViewing(bindingId) {
    const result = await this.rpc('get_share_url', { bindingId })
    return result.encryptedShareUrl || null
  }

  async supplementShareUrl(bindingId, shareUrl, supplementedBy) {
    const result = await this.rpc('supplement_share_url', {
      bindingId,
      shareUrl,
      supplementedBy,
      supplementedAt: new Date().toISOString(),
    })
    return result.binding ? normalizeBinding(result.binding) : null
  }

  async updateReport(params) {
    const result = await this.rpc('update_report', params)
    return result.binding ? normalizeBinding(result.binding) : null
  }
}
