import http from 'node:http'
import crypto from 'node:crypto'
import { config, configurationStatus } from './config.mjs'
import { createBrief, createCustomerIntelligence, createServiceSummary, DeepSeekUnavailableError } from './deepseek.mjs'
import { FeishuRepository } from './repository.mjs'
import { FeishuUnavailableError, feishuGateway } from './feishu.mjs'
import { AuthError, bearerToken, issueSession, verifySession } from './auth.mjs'
import { generateInitialPassword } from './password-auth.mjs'
import { featureFlags, releaseMetadata } from './release.mjs'
import { responseHeaders } from './cors.mjs'
import { importAssessmentFromShareUrl, readAssessmentReport } from './assessment-import.mjs'
import { CloudBaseAssessmentStore, generateBindingId, sanitizeReportForStorage, sanitizeShareUrl, snapshotHash } from './assessment-pg-store.mjs'
import { parseStarShareUrl } from '../shared/assessment-import-star-contract.mjs'
import { normalizeStarReportPreview } from '../shared/assessment-import-star-contract.mjs'
import { getAssessmentAdapter } from './assessment-adapters.mjs'

// V1.3: Enrich preview from stored snapshot when displayPayload is missing.
// This backfills V1.3 display enhancements for reports imported before V1.3,
// without requiring re-import. Returns the (possibly enriched) preview.
function enrichPreviewFromSnapshot(preview, snapshot) {
  if (!preview || !snapshot || typeof snapshot !== 'object') return preview
  // Only enrich if displayPayload is missing and the preview has an assessmentId
  if (preview.displayPayload) return preview
  const assessmentId = preview.assessmentId || snapshot.assessmentId
  if (!assessmentId) return preview
  try {
    const adapter = getAssessmentAdapter(assessmentId)
    if (!adapter || typeof adapter.parsePreview !== 'function') return preview
    const enriched = adapter.parsePreview(snapshot)
    if (enriched?.displayPayload) {
      return { ...preview, displayPayload: enriched.displayPayload }
    }
  } catch {
    // Silently fall back to stored preview
  }
  return preview
}

function memorySnapshot(phase, requestId, extra = {}) {
  const memory = process.memoryUsage()
  console.info('[ASVA_MEMORY]', JSON.stringify({
    phase,
    request_id: requestId || undefined,
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    heap_total_bytes: memory.heapTotal,
    ...extra,
  }))
}

memorySnapshot('startup_before_repository', 'module')
// Assessment store: PostgreSQL-backed binding storage.
// Uses the existing CloudBase PG via RPC function (asva_assessment_guard).
// No auto-table-creation; tables created via migration SQL.
// V1.2: Created eagerly so the repository can use it for understanding integration.
let assessmentStoreInstance = null
function getAssessmentStore() {
  if (!assessmentStoreInstance) {
    assessmentStoreInstance = new CloudBaseAssessmentStore()
  }
  return assessmentStoreInstance
}
const repository = new FeishuRepository({ assessmentStore: getAssessmentStore() })
// Test-only: allow injecting a custom store (e.g., real PG for integration tests)
export function __setAssessmentStoreForTesting(store) {
  assessmentStoreInstance = store
}
// Do not start full-database recovery scans from the HTTP module entrypoint.
// Explicit customer/source writes remain event-driven; targeted recovery is
// still available through the existing request paths.
memorySnapshot('startup_after_repository', 'module')

function send(request, response, statusCode, body, requestId) {
  if (request.__asvaMemoryTracked) memorySnapshot('request_end', requestId, { path: (request.url || '').split('?')[0], status: statusCode })
  if (config.appEnv === 'development' && /^\/api\/(staff\/me|dashboard(?:\/basic)?|customers(?:\/directory|\/[^/]+\/detail)?|staff\/mentors)/.test(request.url || '')) {
    console.info('[ASVA_PERF_API]', JSON.stringify({ path: (request.url || '').split('?')[0], status: statusCode, handler_ms: Date.now() - (request.__asvaStartedAt || Date.now()), request_id: requestId }))
  }
  response.writeHead(statusCode, responseHeaders(request, requestId))
  response.end(JSON.stringify(body))
}

function fail(message, code = 'REQUEST_FAILED', status = 400) { throw Object.assign(new Error(message), { code, status }) }

async function readBody(request) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 30_000_000) fail('请求体过大', 'REQUEST_TOO_LARGE', 413)
  }
  try {
    const body = JSON.parse(raw || '{}')
    const operationId = request.headers['x-operation-id'] || request.headers['x-idempotency-key']
    if (operationId && body && typeof body === 'object' && !Array.isArray(body) && !body.operationId) body.operationId = String(operationId)
    return body
  } catch { fail('请求格式无效', 'INVALID_JSON', 400) }
}

async function actorId(request) {
  const token = bearerToken(request)
  if (token) {
    const claims = verifySession(token)
    const session = await repository.validateSession(String(claims.sub), claims.auth_version, claims.amr)
    const path = request.url?.split('?')[0]
    if ((claims.purpose === 'PASSWORD_CHANGE' || session.credential?.mustChangePassword) && path !== '/api/auth/change-password') throw Object.assign(new Error('请先修改密码后继续使用'), { code: 'PASSWORD_CHANGE_REQUIRED', status: 403 })
    return String(claims.sub)
  }
  if (config.dataMode !== 'production' && typeof request.headers['x-staff-id'] === 'string') return request.headers['x-staff-id']
  return ''
}

async function guard(request) {
  const id = await actorId(request)
  if (!id) fail('请先登录', 'AUTH_REQUIRED', 401)
  return id
}

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim()
  return request.socket.remoteAddress || 'unknown'
}

function status(error) {
  if (error?.status) return error.status
  if (error instanceof AuthError) return 401
  if (error instanceof FeishuUnavailableError || error instanceof DeepSeekUnavailableError) return 502
  if (/无权|账号不存在|只有 ADMIN|账户已停用|导师端暂未开放/.test(error?.message || '')) return 403
  return 400
}

function errorCode(error) {
  if (error?.code) return error.code
  if (error instanceof FeishuUnavailableError) return 'FEISHU_UNAVAILABLE'
  if (error instanceof DeepSeekUnavailableError) return 'DEEPSEEK_UNAVAILABLE'
  return 'REQUEST_FAILED'
}

function safeMessage(error, code) {
  if (code === 'CUSTOMER_SAVE_NOT_STARTED') return '客户尚未保存，请稍后重试。'
  if (code === 'ACCOUNT_ALREADY_EXISTS') return error?.message || '该手机号已绑定完整导师账户，无需重复创建。若未保存初始密码，请使用重置密码。'
  if (code === 'ACCOUNT_INCONSISTENT' || code === 'PARTIAL_INCONSISTENT') return error?.message || '导师账户资料不完整，请联系管理员处理。'
  if ((code || '').startsWith('FEISHU_') && /^\/api\/staff\/mentors/.test(error?.operationPath || '')) return '导师账号暂时没有创建完成，当前填写的信息仍保留，请稍后重试。'
  if (typeof code === 'string' && code.startsWith('FEISHU_')) return error?.retryable ? '保存暂时没有完成，内容仍保留在当前页面，请稍后重试。' : '数据同步暂时没有完成，请联系管理员处理。'
  if (code === 'DEEPSEEK_UNAVAILABLE') return 'AI 服务暂时不可用，请稍后重试。'
  return error instanceof Error ? error.message : '请求未完成，请稍后重试。'
}

async function guardAdmin(request) {
  const id = await guard(request)
  const account = await repository.staff(id)
  if (account.permissionRole !== 'ADMIN' || account.loginEnabled !== true) fail('只有 ADMIN 可以执行此操作', 'ADMIN_REQUIRED', 403)
  return id
}

async function handle(request, response, requestId) {
  if (request.method === 'OPTIONS') return send(request, response, 204, {}, requestId)
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
  request.__asvaMemoryTracked = url.pathname === '/api/customers/directory' || url.pathname === '/api/customers' || /^\/api\/customers\/[^/]+\/auto-archive$/.test(url.pathname)
  if (request.__asvaMemoryTracked) memorySnapshot('request_start', requestId, { path: url.pathname })
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return send(request, response, 200, { ok: true, service: 'asva-api', ...releaseMetadata, ...configurationStatus(), feishuProviderStatus: feishuGateway.providerStatus(), featureFlags: featureFlags(), tables: config.feishu.tables }, requestId)
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(request)
    const account = await repository.authenticate(body.phone, config.authMode === 'PASSWORD' ? body.password : body.code, clientIp(request))
    const token = config.authSecret ? issueSession(account.id, account.authVersion, account.authMode, account.mustChangePassword ? 'PASSWORD_CHANGE' : 'SESSION') : ''
    return send(request, response, 200, { ...account, token: token || undefined }, requestId)
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/change-password') { const body = await readBody(request); const id = await guard(request); const changed = await repository.changePassword(id, body.currentPassword, body.newPassword); return send(request, response, 200, { ...changed, token: config.authSecret ? issueSession(id, changed.authVersion, 'PASSWORD') : undefined }, requestId) }
  const passwordReset = url.pathname.match(/^\/api\/staff\/([^/]+)\/reset-password$/)
  if (request.method === 'POST' && passwordReset) { await readBody(request); return send(request, response, 200, await repository.resetPassword(await guardAdmin(request), decodeURIComponent(passwordReset[1])), requestId) }
  if (request.method === 'POST' && url.pathname === '/api/staff/mentor-initial-password') {
    await guardAdmin(request)
    const body = await readBody(request)
    const phone = String(body.phone || '').replace(/[\s-]/g, '')
    return send(request, response, 200, { initial_password: generateInitialPassword({ phone }) }, requestId)
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/ai-processing/control') return send(request, response, 200, await repository.onDemandAiControl(await guardAdmin(request)), requestId)
  if (request.method === 'POST' && url.pathname === '/api/admin/ai-processing/control') {
    const body = await readBody(request)
    return send(request, response, 200, await repository.setOnDemandAiControl(await guardAdmin(request), body.mode), requestId)
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/ai-processing/daily-stats') {
    const day = url.searchParams.get('day') || undefined
    return send(request, response, 200, await repository.onDemandAiDailyStats(await guardAdmin(request), day), requestId)
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/ai-processing/anomaly-check') {
    const day = url.searchParams.get('day') || undefined
    return send(request, response, 200, await repository.onDemandAiAnomalyCheck(await guardAdmin(request), day), requestId)
  }
  if (request.method === 'GET' && url.pathname === '/api/dashboard') return send(request, response, 200, await repository.dashboard(await guard(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/dashboard/basic') return send(request, response, 200, await repository.basicDashboard(await guard(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/customers/directory') return send(request, response, 200, await repository.customerDirectory(await guard(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/customer-save-status') return send(request, response, 200, await repository.customerSaveStatus(await guard(request), '', url.searchParams.get('operationId') || ''), requestId)
  const customerDetailPath = url.pathname.match(/^\/api\/customers\/([^/]+)\/detail$/)
  if (request.method === 'GET' && customerDetailPath) return send(request, response, 200, await repository.customerDetail(await guard(request), decodeURIComponent(customerDetailPath[1])), requestId)
  const customerProfilePath = url.pathname.match(/^\/api\/customers\/([^/]+)\/profile$/)
  if (request.method === 'GET' && customerProfilePath) return send(request, response, 200, await repository.customerProfile(await guard(request), decodeURIComponent(customerProfilePath[1])), requestId)
  if (request.method === 'GET' && url.pathname === '/api/staff/me') return send(request, response, 200, await repository.staff(await guard(request)), requestId)
  if (request.method === 'POST' && url.pathname === '/api/dialogue/identify') return send(request, response, 200, await repository.identifyDialogue(await guard(request), await readBody(request)), requestId)
  if (request.method === 'POST' && url.pathname === '/api/dialogue/confirm') return send(request, response, 200, await repository.confirmDialogue(await guard(request), await readBody(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/staff/mentors') {
    const filter = url.searchParams.get('status') || ''
    if (filter && !['ACTIVE', 'INACTIVE'].includes(filter)) fail('status 只支持 ACTIVE 或 INACTIVE', 'INVALID_STATUS', 400)
    return send(request, response, 200, await repository.teamSnapshot(await guardAdmin(request), filter), requestId)
  }
  if (request.method === 'POST' && url.pathname === '/api/staff/mentors') return send(request, response, 201, await repository.createMentor(await guardAdmin(request), await readBody(request)), requestId)
  const mentorEdit = url.pathname.match(/^\/api\/staff\/mentors\/([^/]+)$/)
  if (request.method === 'PATCH' && mentorEdit) return send(request, response, 200, await repository.updateMentor(await guardAdmin(request), decodeURIComponent(mentorEdit[1]), await readBody(request)), requestId)
  const mentorDeactivate = url.pathname.match(/^\/api\/staff\/mentors\/([^/]+)\/deactivate$/)
  if (request.method === 'POST' && mentorDeactivate) return send(request, response, 200, await repository.deactivateMentor(await guardAdmin(request), decodeURIComponent(mentorDeactivate[1])), requestId)
  const profileExtract = url.pathname.match(/^\/api\/customers\/([^/]+)\/profile\/extract$/)
  if (request.method === 'POST' && profileExtract) { const body = await readBody(request); return send(request, response, 200, await repository.profileDraft(await guard(request), decodeURIComponent(profileExtract[1]), body.text), requestId) }
  const profileConfirm = url.pathname.match(/^\/api\/customers\/([^/]+)\/profile\/confirm$/)
  if (request.method === 'POST' && profileConfirm) { const body = await readBody(request); return send(request, response, 200, await repository.confirmProfile(await guard(request), decodeURIComponent(profileConfirm[1]), body.updates), requestId) }
  if (request.method === 'POST' && url.pathname === '/api/documents/extract') { const body = await readBody(request); return send(request, response, 200, await repository.extractDocument(await guard(request), body.document), requestId) }
  const customerSources = url.pathname.match(/^\/api\/customers\/([^/]+)\/sources$/)
  if (request.method === 'GET' && customerSources) return send(request, response, 200, await repository.sourceWorkspace(await guard(request), decodeURIComponent(customerSources[1])), requestId)
  if (request.method === 'POST' && url.pathname === '/api/sources') {
    const actorId = await guard(request)
    const source = await repository.createSource(actorId, await readBody(request))
    // R048.17: AUTO trigger is now ASYNCHRONOUS — decoupled from HTTP response.
    // The save endpoint returns immediately after persisting the source.
    // A background promise continues processing; the SCF event loop keeps the
    // function alive until the promise resolves or the 120s timeout expires.
    // PG reservation ensures idempotency; duplicate AUTO requests are rejected.
    // Frontend polls source status to show progress.
    if (config.features.onDemandAiProcessing && config.features.onDemandAiAutoTrigger && config.features.onDemandAiDailyLimit > 0) {
      // Fire-and-forget background processing.
      // The SCF runtime keeps the function alive as long as the event loop is not empty.
      // If the function times out (120s), the PG reservation stays active, preventing duplicate calls.
      repository.processSourceOnDemand(actorId, source.id, { trigger: 'AUTO' })
        .then(result => console.info('[ASVA_AUTO_TRIGGER]', JSON.stringify({ sourceId: source.id, status: result?.source?.processingStatus })))
        .catch(error => console.error('[ASVA_AUTO_TRIGGER]', JSON.stringify({ sourceId: source.id, error: error.code || error.message })))
    }
    return send(request, response, 201, source, requestId)
  }
  const sourceProcess = url.pathname.match(/^\/api\/sources\/([^/]+)\/process$/)
  if (request.method === 'POST' && sourceProcess) {
    // Legacy clients retain the URL, but must not bypass the on-demand AI gate.
    await readBody(request)
    return send(request, response, 200, await repository.processSourceOnDemand(await guard(request), decodeURIComponent(sourceProcess[1]), { trigger: 'MANUAL' }), requestId)
  }
  const onDemandSourceProcess = url.pathname.match(/^\/api\/sources\/([^/]+)\/on-demand-process$/)
  if (request.method === 'POST' && onDemandSourceProcess) {
    const body = await readBody(request)
    return send(request, response, 200, await repository.processSourceOnDemand(await guard(request), decodeURIComponent(onDemandSourceProcess[1]), { trigger: body.trigger === 'AUTO' ? 'AUTO' : 'MANUAL' }), requestId)
  }
  const sourceDetail = url.pathname.match(/^\/api\/sources\/([^/]+)$/)
  if (request.method === 'GET' && sourceDetail) return send(request, response, 200, await repository.sourceDetail(await guard(request), decodeURIComponent(sourceDetail[1])), requestId)
  const sourceStatus = url.pathname.match(/^\/api\/customers\/([^/]+)\/source-status$/)
  if (request.method === 'GET' && sourceStatus) return send(request, response, 200, await repository.sourceStatus(await guard(request), decodeURIComponent(sourceStatus[1]), url.searchParams.get('operationId') || '', url.searchParams.get('sourceId') || ''), requestId)
  const customerSaveStatus = url.pathname.match(/^\/api\/customers\/([^/]+)\/save-status$/)
  if (request.method === 'GET' && customerSaveStatus) return send(request, response, 200, await repository.customerSaveStatus(await guard(request), decodeURIComponent(customerSaveStatus[1]), url.searchParams.get('operationId') || ''), requestId)
  if (request.method === 'POST' && url.pathname === '/api/privacy/service-necessity') return send(request, response, 200, await repository.overrideServiceNecessity(await guardAdmin(request), await readBody(request)), requestId)
  const proposalReview = url.pathname.match(/^\/api\/profile-proposals\/([^/]+)\/review$/)
  if (request.method === 'POST' && proposalReview) { const body = await readBody(request); return send(request, response, 200, await repository.reviewProposal(await guard(request), decodeURIComponent(proposalReview[1]), body.decision), requestId) }
  const conflictResolve = url.pathname.match(/^\/api\/evidence-conflicts\/([^/]+)\/resolve$/)
  if (request.method === 'POST' && conflictResolve) { const body = await readBody(request); return send(request, response, 200, await repository.resolveConflict(await guard(request), decodeURIComponent(conflictResolve[1]), body.resolution), requestId) }
  if (request.method === 'POST' && url.pathname === '/api/customers/preview') return send(request, response, 200, await repository.previewCustomer(await guard(request), await readBody(request)), requestId)
  if (request.method === 'POST' && url.pathname === '/api/customers') {
    const compactResponse = request.headers['x-asva-response-mode'] === 'customer-mutation-v1'
    return send(request, response, 201, await repository.createCustomer(await guard(request), await readBody(request), requestId, { compactResponse }), requestId)
  }
  const customerAutoArchive = url.pathname.match(/^\/api\/customers\/([^/]+)\/auto-archive$/)
  if (request.method === 'POST' && customerAutoArchive) {
    const actorId = await guard(request)
    const body = await readBody(request)
    const stage = body?.stage || 'extract'
    if (!['extract', 'finalize'].includes(stage)) return send(request, response, 400, { success: false, code: 'AUTO_ARCHIVE_STAGE_INVALID', message: '不支持的自动归档阶段。' }, requestId)
    const result = await repository.runCustomerAutoArchive(actorId, decodeURIComponent(customerAutoArchive[1]), { stage })
    return send(request, response, result?.errorCode === 'CUSTOMER_NOT_FOUND' ? 404 : 200, { ...result, requestId }, requestId)
  }
  // Admin manual recovery endpoint for failed enrollments (after 5 retries)
  const manualRecoveryMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/enrollments\/recover$/)
  if (request.method === 'POST' && manualRecoveryMatch) {
    const actorId = await guardAdmin(request)
    const customerId = decodeURIComponent(manualRecoveryMatch[1])
    const body = await readBody(request)
    const operationId = body.operationId
    if (!operationId) {
      return send(request, response, 400, { code: 'OPERATION_ID_REQUIRED', message: '手动恢复需要提供 operationId' }, requestId)
    }
    try {
      const result = await repository.recoverPendingEnrollmentsForCustomer(customerId, operationId)
      return send(request, response, 200, { success: true, ...result }, requestId)
    } catch (error) {
      return send(request, response, status(error), { success: false, code: error.code || 'MANUAL_RECOVERY_FAILED', message: error.message }, requestId)
    }
  }
  const customerEdit = url.pathname.match(/^\/api\/customers\/([^/]+)$/)
  if (request.method === 'PATCH' && customerEdit) {
    const compactResponse = request.headers['x-asva-response-mode'] === 'customer-mutation-v1'
    return send(request, response, 200, await repository.updateCustomer(await guard(request), decodeURIComponent(customerEdit[1]), await readBody(request), { compactResponse }), requestId)
  }
  const customerEnrollments = url.pathname.match(/^\/api\/customers\/([^/]+)\/enrollments$/)
  if (request.method === 'PUT' && customerEnrollments) { const body = await readBody(request); return send(request, response, 200, await repository.updateCustomerEnrollments(await guard(request), decodeURIComponent(customerEnrollments[1]), body.enrollments, body.operationId), requestId) }
  const understandingCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/understanding(?:\/refresh)?$/)
  if (understandingCustomer && request.method === 'GET' && url.pathname.endsWith('/understanding')) return send(request, response, 200, await repository.getCustomerUnderstanding(await guard(request), decodeURIComponent(understandingCustomer[1])), requestId)
  if (understandingCustomer && request.method === 'POST' && url.pathname.endsWith('/understanding/refresh')) { const body = await readBody(request); return send(request, response, 200, await repository.refreshCustomerUnderstanding(await guard(request), decodeURIComponent(understandingCustomer[1]), { force: body.force === true }), requestId) }
  const salesUnderstandingCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/sales-understanding(?:\/refresh)?$/)
  if (salesUnderstandingCustomer && request.method === 'GET' && url.pathname.endsWith('/sales-understanding')) return send(request, response, 200, await repository.getCustomerSalesUnderstanding(await guard(request), decodeURIComponent(salesUnderstandingCustomer[1])), requestId)
  if (salesUnderstandingCustomer && request.method === 'POST' && url.pathname.endsWith('/sales-understanding/refresh')) { const body = await readBody(request); return send(request, response, 200, await repository.refreshCustomerSalesUnderstanding(await guard(request), decodeURIComponent(salesUnderstandingCustomer[1]), { force: body.force === true }), requestId) }
  const safetyCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/safety-assessment(?:\/refresh)?$/)
  if (safetyCustomer && request.method === 'GET' && url.pathname.endsWith('/safety-assessment')) return send(request, response, 200, await repository.getCustomerSafetyAssessment(await guard(request), decodeURIComponent(safetyCustomer[1])), requestId)
  if (safetyCustomer && request.method === 'POST' && url.pathname.endsWith('/safety-assessment/refresh')) { const body = await readBody(request); return send(request, response, 200, await repository.refreshCustomerSafetyAssessment(await guardAdmin(request), decodeURIComponent(safetyCustomer[1]), { force: body.force === true }), requestId) }
  if (request.method === 'GET' && /^\/api\/customers\/[^/]+$/.test(url.pathname)) return send(request, response, 200, await repository.customer(await guard(request), decodeURIComponent(url.pathname.slice('/api/customers/'.length))), requestId)
  const briefCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/brief$/)
  if (request.method === 'POST' && briefCustomer) { const body = await readBody(request); return send(request, response, 200, await repository.saveBrief(await guard(request), decodeURIComponent(briefCustomer[1]), body.brief), requestId) }
  const summaryCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/summary\/refresh$/)
  if (request.method === 'POST' && summaryCustomer) { const body = await readBody(request); return send(request, response, 200, await repository.refreshCustomerSummary(await guardAdmin(request), decodeURIComponent(summaryCustomer[1]), { force: body.force === true }), requestId) }
  const referrerCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/referrer$/)
  if (request.method === 'POST' && referrerCustomer) { const body = await readBody(request); return send(request, response, 200, await repository.updateCustomerReferrer(await guard(request), decodeURIComponent(referrerCustomer[1]), body.referrerName), requestId) }
  if (request.method === 'GET' && url.pathname === '/api/team') return send(request, response, 200, await repository.teamSnapshot(await guard(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/dashboard/snapshot') return send(request, response, 200, await repository.dashboardSnapshot(await guard(request)), requestId)
  const assign = url.pathname.match(/^\/api\/(?:appointments|cases)\/([^/]+)\/(?:assign|reassign)$/)
  if (request.method === 'POST' && assign) { const body = await readBody(request); return send(request, response, 200, await repository.assignAppointment(await guardAdmin(request), decodeURIComponent(assign[1]), body.mentorId), requestId) }
  const complete = url.pathname.match(/^\/api\/appointments\/([^/]+)\/complete-followup$/)
  if (request.method === 'POST' && complete) return send(request, response, 200, await repository.markFollowupDone(await guard(request), decodeURIComponent(complete[1])), requestId)
  if (request.method === 'POST' && url.pathname === '/api/ai/query') { const body = await readBody(request); return send(request, response, 200, await repository.assistantQuery(await guardAdmin(request), body.question, body.context), requestId) }
  if (request.method === 'GET' && url.pathname === '/api/ai/query-logs') return send(request, response, 200, await repository.assistantQueryLogs(await guardAdmin(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/debug/save-traces') return send(request, response, 200, await repository.savePerformanceTraces(await guardAdmin(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/debug/evidence') return send(request, response, 200, await repository.evidenceDebug(await guardAdmin(request)), requestId)
  if (request.method === 'POST' && url.pathname === '/api/ai/service-summary') { await guardAdmin(request); return send(request, response, 200, await createServiceSummary(await readBody(request)), requestId) }
  if (request.method === 'POST' && url.pathname === '/api/ai/brief') { await guardAdmin(request); return send(request, response, 200, { brief: await createBrief(await readBody(request)) }, requestId) }
  if (request.method === 'POST' && url.pathname === '/api/ai/customer-intelligence') { await guardAdmin(request); return send(request, response, 200, await createCustomerIntelligence(await readBody(request)), requestId) }
  const feedback = url.pathname.match(/^\/api\/appointments\/([^/]+)\/feedback$/)
  if (request.method === 'POST' && feedback) { const body = await readBody(request); return send(request, response, 200, await repository.saveFeedback(await guard(request), { ...body, appointmentId: decodeURIComponent(feedback[1]) }), requestId) }
  if (request.method === 'POST' && url.pathname === '/api/appointments') {
    if (!config.features.externalAppointment) fail('外部预约入口当前已冻结', 'FEATURE_DISABLED', 403)
    return send(request, response, 200, await repository.createAppointment(await readBody(request)), requestId)
  }
  // Assessment import: mentor pastes a star share URL → ASVA proxies the read
  // Step 1: Preview (no binding yet) — returns safe preview only
  if (request.method === 'POST' && url.pathname === '/api/assessments/import') {
    const actorId = await guard(request)
    const body = await readBody(request)
    if (!body.shareUrl || typeof body.shareUrl !== 'string') fail('缺少分享链接', 'INVALID_ARGUMENTS', 400)
    try {
      const preview = await importAssessmentFromShareUrl(body.shareUrl)
      // Return preview only — no credentials stored, no binding created
      return send(request, response, 200, {
        reportId: preview.reportId,
        assessmentId: preview.assessmentId,
        assessmentName: preview.assessmentName,
        assessmentVersion: preview.assessmentVersion,
        completedAt: preview.completedAt,
        nickname: preview.nickname,
        keyMetrics: preview.keyMetrics,
        headline: preview.headline,
        summary: preview.summary,
        caution: preview.caution,
        provider: 'mindtest-web',
        // Share URL sanitized: strip linkSecret before returning to client
        safeShareUrl: sanitizeShareUrl(body.shareUrl),
        importedAt: preview.importedAt,
      }, requestId)
    } catch (error) {
      const status = error.code === 'REPORT_NOT_FOUND' ? 404 : error.code === 'TIMEOUT' ? 504 : 400
      throw error.code ? Object.assign(error, { status }) : error
    }
  }
  // Step 2: Confirm binding — server re-reads from source, does NOT trust client report data
  const confirmBindPath = url.pathname.match(/^\/api\/customers\/([^/]+)\/assessments\/confirm$/)
  if (request.method === 'POST' && confirmBindPath) {
    const actorId = await guard(request)
    const customerId = decodeURIComponent(confirmBindPath[1])
    const body = await readBody(request)

    // Only accept the share URL from client — NOT reportId, provider, or preview data
    if (!body.shareUrl || typeof body.shareUrl !== 'string') fail('缺少分享链接，请重新导入', 'INVALID_ARGUMENTS', 400)

    // Parse share URL server-side
    let parsed
    try {
      parsed = parseStarShareUrl(body.shareUrl)
    } catch (error) {
      fail('分享链接格式不正确', 'INVALID_SHARE_URL', 400)
    }
    const { reportId, linkSecret } = parsed

    // Re-read the FULL report from source service (not from client)
    let fullReport
    try {
      fullReport = await readAssessmentReport(reportId, linkSecret)
    } catch (error) {
      if (error.code === 'REPORT_NOT_FOUND') fail('报告不存在或链接已失效', 'REPORT_NOT_FOUND', 404)
      if (error.code === 'TIMEOUT') fail('报告服务请求超时', 'TIMEOUT', 504)
      throw error
    }

    // Verify reportId from source matches
    if (fullReport.reportId !== reportId) {
      fail('报告标识不匹配，可能存在伪造', 'REPORT_ID_MISMATCH', 400)
    }

    // Generate preview server-side from the source report (not from client)
    let serverPreview
    try {
      const adapter = getAssessmentAdapter(fullReport.assessmentId)
      if (!adapter) {
        fail('暂不支持该测评类型', 'UNSUPPORTED_ASSESSMENT', 400)
      }
      serverPreview = adapter.parsePreview(fullReport)
    } catch (error) {
      fail('报告内容不符合预期格式', 'INVALID_REPORT_CONTENT', 400)
    }

    // Fetch customer info
    const customer = await repository.customer(actorId, customerId)
    if (!customer) fail('客户不存在或无权访问', 'CUSTOMER_NOT_FOUND', 404)

    // Check name mismatch (Issue #113)
    const reportNickname = serverPreview.nickname || ''
    const customerName = customer.name || customer.nickname || customer.id
    const nameMismatch = reportNickname && customerName && reportNickname !== customerName

    // By default, name mismatch shows warning but allows mentor to confirm
    // V1.0.1: Remove strict blocking, allow mentor confirmation
    let nameConfirmedBy = ''
    let nameConfirmedReason = ''
    if (nameMismatch) {
      // Mentor can confirm if they have customer access
      if (body.nameConfirmedBy) {
        // Verify the actor has access to the customer
        const hasAccess = await repository.customer(actorId, customerId).then(c => !!c)
        if (!hasAccess) {
          fail('无权确认此报告的归属', 'ACCESS_DENIED', 403)
        }
        nameConfirmedBy = actorId
        nameConfirmedReason = (body.nameConfirmedReason || '导师确认报告归属').trim()
      }
      // If not confirmed, continue with warning (don't block)
    }

    // Sanitize report for storage (strip credentials)
    const sanitizedSnapshot = sanitizeReportForStorage(fullReport)
    const sanitizedPreview = sanitizeReportForStorage(serverPreview)
    const safeUrl = sanitizeShareUrl(body.shareUrl)
    const hash = snapshotHash(sanitizedSnapshot)

    const store = getAssessmentStore()
    try {
      const result = await store.bindReport({
        provider: 'mindtest-web',
        reportId: fullReport.reportId,
        assessmentId: serverPreview.assessmentId || fullReport.assessmentId || 'star',
        assessmentName: serverPreview.assessmentName || fullReport.assessmentName || '职业六芒星',
        assessmentVersion: serverPreview.assessmentVersion || fullReport.assessmentVersion || '',
        schemaVersion: fullReport.schemaVersion || '',
        customerId: customer.id,
        customerName: customerName,
        reportNickname: reportNickname,
        completedAt: serverPreview.completedAt || fullReport.completedAt || '',
        boundBy: actorId,
        shareUrl: body.shareUrl, // V1.0.1: Pass full share URL (with linkSecret) for encrypted storage
        fullReport: sanitizedSnapshot,
        safePreview: sanitizedPreview,
        snapshotHash: hash,
        nameMismatch: Boolean(nameMismatch),
        nameConfirmedBy,
        nameConfirmedReason,
        customerConsent: Boolean(body.customerConsent),
        customerConsentRecord: body.customerConsentRecord || '',
      })
      return send(request, response, result.idempotent ? 200 : 201, {
        bindingId: result.bindingId,
        idempotent: result.idempotent,
        status: result.status,
        // Return server-verified preview, not client data
        preview: {
          reportId: serverPreview.reportId,
          assessmentId: serverPreview.assessmentId,
          assessmentName: serverPreview.assessmentName,
          nickname: serverPreview.nickname,
          completedAt: serverPreview.completedAt,
          headline: serverPreview.headline,
          summary: serverPreview.summary,
          caution: serverPreview.caution,
        },
        safeShareUrl: safeUrl,
        nameMismatch: Boolean(nameMismatch),
        // Archive authorization: persisted in DB with who confirmed and when
        archiveConfirmedBy: actorId,
        archiveConfirmedAt: new Date().toISOString(),
        // AI usage consent: defaults to false, must be explicitly granted later
        customerConsent: Boolean(body.customerConsent),
      }, requestId)
    } catch (error) {
      if (error.code === 'REPORT_ALREADY_BOUND') {
        // Do NOT leak the other customer's name or ID to unauthorized mentors
        const actor = await repository.staff(actorId)
        const safeMessage = actor?.permissionRole === 'ADMIN'
          ? `此报告已绑定到其他客户（${error.existingCustomerName || '未知'}）。如需转移，请先解绑。`
          : '此报告已绑定到其他客户。如需转移，请联系管理员。'
        return send(request, response, 409, { error: safeMessage, code: error.code }, requestId)
      }
      throw error
    }
  }
  // Get customer's assessments
  const customerAssessments = url.pathname.match(/^\/api\/customers\/([^/]+)\/assessments$/)
  if (request.method === 'GET' && customerAssessments) {
    const actorId = await guard(request)
    const customerId = decodeURIComponent(customerAssessments[1])
    const customer = await repository.customer(actorId, customerId)
    if (!customer) fail('客户不存在或无权访问', 'CUSTOMER_NOT_FOUND', 404)

    const store = getAssessmentStore()
    try {
      const assessments = await store.getCustomerAssessments(customerId)
      // V1.3: Enrich stored previews from snapshots when displayPayload is missing.
      // This backfills V1.3 visualizations for reports imported before the upgrade.
      // snapshot is stripped before sending to frontend (not exposed to client).
      const enriched = (assessments || []).map(a => {
        const enrichedPreview = enrichPreviewFromSnapshot(a.preview, a.snapshot)
        const { snapshot: _omit, ...rest } = a
        return { ...rest, preview: enrichedPreview }
      })
      const body = { customerId, assessments: enriched }
      return send(request, response, 200, body, requestId)
    } catch (error) {
      if (error.code === 'ASSESSMENT_STORE_UNCONFIGURED') return send(request, response, 200, { customerId, assessments: [] }, requestId)
      if (error.status) return send(request, response, error.status, { error: error.message, code: error.code }, requestId)
      return send(request, response, 200, { customerId, assessments: [] }, requestId)
    }
  }
  // Get assessment history (includes all statuses)
  const assessmentHistory = url.pathname.match(/^\/api\/customers\/([^/]+)\/assessments\/history$/)
  if (request.method === 'GET' && assessmentHistory) {
    const actorId = await guard(request)
    const customerId = decodeURIComponent(assessmentHistory[1])
    const customer = await repository.customer(actorId, customerId)
    if (!customer) fail('客户不存在或无权访问', 'CUSTOMER_NOT_FOUND', 404)

    const assessmentId = url.searchParams.get('assessmentId') || ''
    const store = getAssessmentStore()
    const bindings = await store.getCustomerAssessmentHistory(customerId, assessmentId)
    // Strip sensitive preview fields for non-ACTIVE bindings
    const sanitizedBindings = bindings.map(b => {
      if (b.status !== 'ACTIVE') {
        // Keep basic metadata but remove summary/headline/caution for privacy
        return {
          ...b,
          preview: b.preview ? {
            reportId: b.preview.reportId,
            assessmentId: b.preview.assessmentId,
            assessmentName: b.preview.assessmentName,
            completedAt: b.preview.completedAt,
            // Remove: headline, summary, caution, nickname
          } : null,
        }
      }
      return b
    })
    return send(request, response, 200, { customerId, bindings: sanitizedBindings }, requestId)
  }
  // Unbind assessment (admin only)
  const unbindPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/unbind$/)
  if (request.method === 'POST' && unbindPath) {
    const actorId = await guard(request)
    const bindingId = decodeURIComponent(unbindPath[1])
    const body = await readBody(request)
    const store = getAssessmentStore()

    // Verify binding exists and actor has customer access
    const binding = await store.findBindingById(bindingId)
    if (!binding) return send(request, response, 404, { error: '绑定记录不存在' }, requestId)
    const hasAccess = binding.customerId && await repository.customer(actorId, binding.customerId).then(c => !!c)
    if (!hasAccess) fail('无权解绑此报告', 'ACCESS_DENIED', 403)

    try {
      const result = await store.unbindReport(bindingId, actorId, body.reason || '')
      return send(request, response, 200, result, requestId)
    } catch (error) {
      if (error.code === 'BINDING_NOT_FOUND') return send(request, response, 404, { error: error.message }, requestId)
      if (error.status) return send(request, response, error.status, { error: error.message, code: error.code }, requestId)
      throw error
    }
  }
  // Transfer binding (admin only)
  const transferPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/transfer$/)
  if (request.method === 'POST' && transferPath) {
    const actorId = await guardAdmin(request)
    const bindingId = decodeURIComponent(transferPath[1])
    const body = await readBody(request)
    if (!body.targetCustomerId) fail('缺少目标客户', 'INVALID_ARGUMENTS', 400)

    const targetCustomer = await repository.customer(actorId, body.targetCustomerId)
    if (!targetCustomer) fail('目标客户不存在或无权访问', 'CUSTOMER_NOT_FOUND', 404)

    const store = getAssessmentStore()
    try {
      const result = await store.transferBinding(bindingId, targetCustomer.id, targetCustomer.name || targetCustomer.id, actorId, body.reason || '')
      return send(request, response, 200, result, requestId)
    } catch (error) {
      if (error.code === 'BINDING_NOT_FOUND') return send(request, response, 404, { error: error.message }, requestId)
      if (error.status) return send(request, response, error.status, { error: error.message, code: error.code }, requestId)
      throw error
    }
  }
  // Revoke local access (admin only) — source-revoke vs local-revoke:
  // - Source revoke: upstream assessmentReportDev revokes the linkSecret
  // - Local revoke: ASVA revokes access independently, preserving snapshot for audit
  const revokePath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/revoke$/)
  if (request.method === 'POST' && revokePath) {
    const actorId = await guardAdmin(request)
    const bindingId = decodeURIComponent(revokePath[1])
    const body = await readBody(request)
    const store = getAssessmentStore()
    try {
      const result = await store.revokeLocal(bindingId, actorId, body.reason || '')
      return send(request, response, 200, result, requestId)
    } catch (error) {
      if (error.code === 'BINDING_NOT_FOUND') return send(request, response, 404, { error: error.message }, requestId)
      if (error.status) return send(request, response, error.status, { error: error.message, code: error.code }, requestId)
      throw error
    }
  }
  // Confirm name mismatch (admin only)
  const confirmNamePath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/confirm-name$/)
  if (request.method === 'POST' && confirmNamePath) {
    const actorId = await guardAdmin(request)
    const bindingId = decodeURIComponent(confirmNamePath[1])
    const body = await readBody(request)
    const store = getAssessmentStore()
    try {
      const result = await store.confirmName(bindingId, actorId, body.reason || '')
      return send(request, response, 200, result, requestId)
    } catch (error) {
      if (error.code === 'BINDING_NOT_FOUND') return send(request, response, 404, { error: error.message }, requestId)
      if (error.status) return send(request, response, error.status, { error: error.message, code: error.code }, requestId)
      throw error
    }
  }
  // Grant customer consent for AI usage
  const consentPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/consent$/)
  if (request.method === 'POST' && consentPath) {
    const actorId = await guard(request)
    const bindingId = decodeURIComponent(consentPath[1])
    const body = await readBody(request)
    const store = getAssessmentStore()
    
    // Verify binding exists and actor has access to the customer
    const binding = await store.findBindingById(bindingId)
    if (!binding) return send(request, response, 404, { error: '绑定记录不存在' }, requestId)
    
    // Check customer access permission
    const customer = await repository.customer(actorId, binding.customerId)
    if (!customer) fail('无权操作此客户的测评授权', 'CUSTOMER_ACCESS_DENIED', 403)
    
    try {
      // Support both grant and revoke
      if (body.action === 'revoke') {
        const result = await store.rpc('revoke_consent', { bindingId, actorId, reason: body.reason || '', now: new Date().toISOString() })
        return send(request, response, 200, { bindingId, consentRevoked: true }, requestId)
      } else {
        const result = await store.grantConsent(bindingId, actorId, body.consentRecord || '')
        return send(request, response, 200, result, requestId)
      }
    } catch (error) {
      if (error.code === 'BINDING_NOT_FOUND') return send(request, response, 404, { error: error.message }, requestId)
      if (error.status) return send(request, response, error.status, { error: error.message, code: error.code }, requestId)
      throw error
    }
  }
  // Get binding audit events
  const eventsPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/events$/)
  if (request.method === 'GET' && eventsPath) {
    const actorId = await guardAdmin(request)
    const bindingId = decodeURIComponent(eventsPath[1])
    const store = getAssessmentStore()
    try {
      const events = await store.getBindingEvents(bindingId)
      return send(request, response, 200, { bindingId, events }, requestId)
    } catch (error) {
      if (error.status) return send(request, response, error.status, { error: error.message, code: error.code }, requestId)
      throw error
    }
  }
  // Read full snapshot (controlled access)
  // - Admin: always allowed (for audit, error correction) — can see ALL statuses
  // - Mentor/staff with customer access: allowed for ACTIVE bindings (professional viewing)
  // - AI usage consent (customerConsent) is separate — required only for AI context inclusion
  // - UNBOUND/TRANSFERRED/REVOKED bindings: blocked for non-admin
  const snapshotPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/snapshot$/)
  if (request.method === 'GET' && snapshotPath) {
    const actorId = await guard(request)
    const bindingId = decodeURIComponent(snapshotPath[1])
    const store = getAssessmentStore()
    const binding = await store.findBindingById(bindingId)
    if (!binding) return send(request, response, 404, { error: '绑定记录不存在' }, requestId)

    const actor = await repository.staff(actorId)
    const isAdmin = actor?.permissionRole === 'ADMIN'

    // Non-ACTIVE bindings are only accessible to admin (audit)
    if (!isAdmin && binding.status !== 'ACTIVE') {
      return send(request, response, 403, {
        error: '此报告已不在活跃状态，无法查看',
        code: 'BINDING_NOT_ACTIVE',
      }, requestId)
    }

    // Non-admin staff must have access to the customer
    // Note: AI consent (customerConsent) is NOT required for human viewing
    // It's only required for AI context inclusion (handled elsewhere)
    if (!isAdmin) {
      const isOwner = binding.customerId && await repository.customer(actorId, binding.customerId).then(c => !!c)
      if (!isOwner) fail('无权查看此报告', 'ACCESS_DENIED', 403)
    }

    // Source status: since linkSecret is stripped at storage time, we CANNOT
    // re-read from source. The status is genuinely UNKNOWN — not verified.
    // sourceRevoked is only set when we get explicit signal (e.g. source returns 404
    // during a re-read that includes the secret, which we no longer have).
    // So the default truthful status is 'UNKNOWN'.
    const sourceStatus = binding.sourceRevoked ? 'REVOKED' : 'UNKNOWN'

    return send(request, response, 200, {
      bindingId,
      status: binding.status,
      snapshot: binding.snapshot,
      preview: binding.preview,
      sourceRevoked: binding.sourceRevoked,
      localRevoked: binding.localRevoked,
      customerConsent: binding.customerConsent,
      archiveConfirmedBy: binding.archiveConfirmedBy || '',
      archiveConfirmedAt: binding.archiveConfirmedAt || null,
      sourceStatus,
      sourceStatusMessage: binding.sourceRevoked
        ? '源链接已被上游撤销，此为绑定时保存的不可变快照'
        : '源报告状态未知（分享密钥已剥离，无法重新验证）。此为绑定时从源服务读取并存储的不可变快照。',
    }, requestId)
  }

  // V1.0.1: Get share URL for viewing original report (mentor access only)
  const shareUrlPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/share-url$/)
  if (request.method === 'GET' && shareUrlPath) {
    const actorId = await guard(request)
    const bindingId = decodeURIComponent(shareUrlPath[1])
    const store = getAssessmentStore()
    const binding = await store.findBindingById(bindingId)
    if (!binding) return send(request, response, 404, { error: '绑定记录不存在' }, requestId)

    // Only ACTIVE bindings can share URL
    if (binding.status !== 'ACTIVE') {
      return send(request, response, 403, {
        error: '此报告已不在活跃状态，无法获取分享链接',
        code: 'BINDING_NOT_ACTIVE',
      }, requestId)
    }

    // Staff must have access to the customer
    const hasAccess = binding.customerId && await repository.customer(actorId, binding.customerId).then(c => !!c)
    if (!hasAccess) fail('无权获取此报告的分享链接', 'ACCESS_DENIED', 403)

    let shareUrl
    try {
      shareUrl = await store.getShareUrlForViewing(bindingId)
    } catch (err) {
      if (err.code === 'SHARE_URL_NOT_FOUND') {
        return send(request, response, 404, {
          error: '此报告未保存分享链接，请补充后查看',
          code: 'SHARE_URL_NOT_FOUND',
        }, requestId)
      }
      if (err.code === 'BINDING_NOT_ACTIVE') {
        return send(request, response, 403, {
          error: '此报告已不在活跃状态，无法获取分享链接',
          code: 'BINDING_NOT_ACTIVE',
        }, requestId)
      }
      throw err
    }
    if (!shareUrl) {
      return send(request, response, 404, {
        error: '此报告未保存分享链接，请补充后查看',
        code: 'SHARE_URL_NOT_FOUND',
      }, requestId)
    }

    return send(request, response, 200, {
      bindingId,
      shareUrl,
    }, requestId)
  }

  // V1.0.1: Supplement missing share URL for existing binding
  const supplementUrlPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/supplement-url$/)
  if (request.method === 'POST' && supplementUrlPath) {
    const actorId = await guard(request)
    const bindingId = decodeURIComponent(supplementUrlPath[1])
    const body = await readBody(request)
    const shareUrl = body?.shareUrl
    if (!shareUrl || typeof shareUrl !== 'string') {
      return send(request, response, 400, { error: '缺少分享链接' }, requestId)
    }

    const store = getAssessmentStore()
    const binding = await store.findBindingById(bindingId)
    if (!binding) return send(request, response, 404, { error: '绑定记录不存在' }, requestId)

    // Only ACTIVE bindings can be supplemented
    if (binding.status !== 'ACTIVE') {
      return send(request, response, 403, {
        error: '此报告已不在活跃状态，无法补充分享链接',
        code: 'BINDING_NOT_ACTIVE',
      }, requestId)
    }

    // Staff must have access to the customer
    const hasAccess = binding.customerId && await repository.customer(actorId, binding.customerId).then(c => !!c)
    if (!hasAccess) fail('无权补充此报告的分享链接', 'ACCESS_DENIED', 403)

    // Check if share URL already exists
    if (binding.hasEncryptedShareUrl) {
      return send(request, response, 409, {
        error: '此报告已存在分享链接，无需重复补充',
        code: 'SHARE_URL_ALREADY_EXISTS',
      }, requestId)
    }

    const updated = await store.supplementShareUrl(bindingId, shareUrl, actorId)
    return send(request, response, 200, {
      ok: true,
      bindingId,
    }, requestId)
  }

  // V1.0.1: Update/replace current report with new one of same type
  const updateReportPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/update$/)
  if (request.method === 'POST' && updateReportPath) {
    const actorId = await guard(request)
    const bindingId = decodeURIComponent(updateReportPath[1])
    const body = await readBody(request)
    const newShareUrl = body?.shareUrl
    if (!newShareUrl || typeof newShareUrl !== 'string') {
      return send(request, response, 400, { error: '缺少新的分享链接' }, requestId)
    }

    const store = getAssessmentStore()
    const binding = await store.findBindingById(bindingId)
    if (!binding) return send(request, response, 404, { error: '绑定记录不存在' }, requestId)

    // Permission: staff must have access to the customer
    const hasAccess = binding.customerId && await repository.customer(actorId, binding.customerId).then(c => !!c)
    if (!hasAccess) fail('无权更新此报告', 'ACCESS_DENIED', 403)

    // Only ACTIVE bindings can be updated
    if (binding.status !== 'ACTIVE') {
      return send(request, response, 403, {
        error: '此报告已不在活跃状态，无法更新',
        code: 'BINDING_NOT_ACTIVE',
      }, requestId)
    }

    // Parse new share URL to get reportId
    let parsed
    try {
      parsed = parseStarShareUrl(newShareUrl)
    } catch (error) {
      return send(request, response, 400, {
        error: '分享链接格式不正确',
        code: 'INVALID_SHARE_URL',
      }, requestId)
    }

    // Idempotency: if same reportId as current binding, return existing
    if (parsed.reportId === binding.reportId) {
      return send(request, response, 200, {
        success: true,
        idempotent: true,
        bindingId: binding.bindingId,
        status: 'ACTIVE',
      }, requestId)
    }

    // Read full report from source service
    let fullReport
    try {
      fullReport = await readAssessmentReport(parsed.reportId, parsed.linkSecret)
    } catch (err) {
      if (err.code === 'REPORT_NOT_FOUND') return send(request, response, 404, { error: '报告不存在或链接已失效', code: 'REPORT_NOT_FOUND' }, requestId)
      if (err.code === 'TIMEOUT') return send(request, response, 504, { error: '报告服务请求超时', code: 'TIMEOUT' }, requestId)
      return send(request, response, 400, { error: err.message || '无法读取新的测评报告', code: 'IMPORT_FAILED' }, requestId)
    }

    // Verify reportId from source matches
    if (fullReport.reportId !== parsed.reportId) {
      return send(request, response, 400, { error: '报告标识不匹配', code: 'REPORT_ID_MISMATCH' }, requestId)
    }

    // Generate preview
    let serverPreview
    try {
      const adapter = getAssessmentAdapter(fullReport.assessmentId)
      if (!adapter) {
        return send(request, response, 400, { error: '暂不支持该测评类型', code: 'UNSUPPORTED_ASSESSMENT' }, requestId)
      }
      serverPreview = adapter.parsePreview(fullReport)
    } catch (error) {
      return send(request, response, 400, { error: '报告内容不符合预期格式', code: 'INVALID_REPORT_CONTENT' }, requestId)
    }

    // Verify same assessment type
    const newAssessmentId = serverPreview.assessmentId || fullReport.assessmentId || 'star'
    if (newAssessmentId !== binding.assessmentId) {
      return send(request, response, 400, {
        error: `新报告类型与原标题报告不一致，无法更新`,
        code: 'ASSESSMENT_TYPE_MISMATCH',
      }, requestId)
    }

    // Sanitize report for storage
    const sanitizedSnapshot = sanitizeReportForStorage(fullReport)
    const sanitizedPreview = sanitizeReportForStorage(serverPreview)

    // Perform the atomic update (supersede old + create new)
    const newBindingId = generateBindingId()
    const result = await store.updateReport({
      bindingId,
      newBindingId,
      newShareUrl,
      newReportId: fullReport.reportId,
      newSnapshot: sanitizedSnapshot,
      newPreview: sanitizedPreview,
      newReportNickname: serverPreview.nickname || '',
      newCompletedAt: serverPreview.completedAt || fullReport.completedAt || '',
      newAssessmentVersion: serverPreview.assessmentVersion || fullReport.assessmentVersion || '',
      updatedBy: actorId,
      updateReason: body?.reason || '导师手动更新报告',
    })

    return send(request, response, 200, {
      success: true,
      idempotent: result.idempotent,
      oldBindingId: bindingId,
      newBindingId: result.newBindingId || newBindingId,
      status: result.status || 'ACTIVE',
    }, requestId)
  }

  // V1.0.1: Get update history for a binding chain
  const updateHistoryPath = url.pathname.match(/^\/api\/assessments\/bindings\/([^/]+)\/update-history$/)
  if (request.method === 'GET' && updateHistoryPath) {
    const actorId = await guard(request)
    const bindingId = decodeURIComponent(updateHistoryPath[1])
    const store = getAssessmentStore()

    // Verify binding exists and actor has customer access
    const binding = await store.findBindingById(bindingId)
    if (!binding) return send(request, response, 404, { error: '绑定记录不存在' }, requestId)

    // Staff must have access to the customer
    const hasAccess = binding.customerId && await repository.customer(actorId, binding.customerId).then(c => !!c)
    if (!hasAccess) fail('无权查看此报告的更新记录', 'ACCESS_DENIED', 403)

    // Get events for this binding
    const events = await store.getBindingEvents(bindingId)

    // Filter to update-related events
    const updateEvents = events.filter(e =>
      ['REPORT_UPDATED', 'REPORT_SUPERSEDED', 'SHARE_URL_SUPPLEMENTED'].includes(e.eventType)
    )

    return send(request, response, 200, {
      bindingId,
      history: updateEvents.map(e => ({
        eventType: e.eventType,
        actorId: e.actorId,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    }, requestId)
  }

  fail('接口不存在', 'NOT_FOUND', 404)
}

export const server = http.createServer((request, response) => {
  const requestId = typeof request.headers['x-request-id'] === 'string' && request.headers['x-request-id'].length < 100 ? request.headers['x-request-id'] : crypto.randomUUID()
  const startedAt = Date.now()
  request.__asvaStartedAt = startedAt
  handle(request, response, requestId).catch(async (error) => {
    const code = error?.code || (error instanceof FeishuUnavailableError ? 'FEISHU_UNAVAILABLE' : error instanceof DeepSeekUnavailableError ? 'DEEPSEEK_UNAVAILABLE' : 'REQUEST_FAILED')
    const statusCode = status(error)
    const operatorId = await (async () => { try { return await actorId(request) } catch { return '' } })()
    console.error('[ASVA_API_ERROR]', JSON.stringify({ timestamp: new Date().toISOString(), request_id: requestId, operator_id: operatorId || undefined, operation: `${request.method} ${request.url}`, provider_operation: error?.operation, entity: 'api', status: statusCode, duration: Date.now() - startedAt, error_code: code, provider_code: error?.providerCode, provider_message: typeof error?.providerMessage === 'string' ? error.providerMessage.slice(0, 160) : undefined, provider_request_id: error?.providerRequestId, provider_http_status: error?.httpStatus, retryable: error?.retryable, write_status: error?.writeStatus, readback_status: error?.readbackStatus }))
    const message = code === 'AUTH_INVALID' ? '登录信息验证失败' : code === 'AUTH_RATE_LIMITED' ? '登录尝试过于频繁，请稍后再试' : safeMessage(error, code)
    const errorBody = { success: false, code, message, request_id: requestId }
    // 包含额外的错误数据（如重复客户的 matches）
    if (error?.matches) errorBody.matches = error.matches
    if (error?.identity) errorBody.identity = error.identity
    send(request, response, statusCode, errorBody, requestId)
  })
}).listen(config.port, config.host, () => console.log(`ASVA API listening on http://${config.host}:${config.port}`))
