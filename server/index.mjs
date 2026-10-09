import http from 'node:http'
import crypto from 'node:crypto'
import { config, configurationStatus } from './config.mjs'
import { createBrief, createCustomerIntelligence, createServiceSummary, DeepSeekUnavailableError } from './deepseek.mjs'
import { FeishuRepository } from './repository.mjs'
import { FeishuUnavailableError } from './feishu.mjs'
import { AuthError, bearerToken, issueSession, verifySession } from './auth.mjs'
import { featureFlags, releaseMetadata } from './release.mjs'

const repository = new FeishuRepository()

function responseHeaders(request, requestId) {
  const requestedOrigin = request.headers.origin
  const origin = requestedOrigin && requestedOrigin === config.frontendOrigin ? requestedOrigin : config.frontendOrigin
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Staff-Id, X-Operation-Id, X-Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'X-Request-Id': requestId,
  }
}

function send(request, response, statusCode, body, requestId) {
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
    if (session.credential?.mustChangePassword && request.url?.split('?')[0] !== '/api/auth/change-password') throw Object.assign(new Error('请先修改密码后继续使用'), { code: 'PASSWORD_CHANGE_REQUIRED', status: 403 })
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
  if (code === 'FEISHU_UNAVAILABLE') return '数据源暂时不可用，请稍后重试。'
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
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return send(request, response, 200, { ok: true, service: 'asva-api', ...releaseMetadata, ...configurationStatus(), featureFlags: featureFlags(), tables: config.feishu.tables }, requestId)
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(request)
    const account = await repository.authenticate(body.phone, config.authMode === 'PASSWORD' ? body.password : body.code, clientIp(request))
    const token = config.authSecret ? issueSession(account.id, account.authVersion, account.authMode) : ''
    return send(request, response, 200, { ...account, token: token || undefined }, requestId)
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/change-password') { const body = await readBody(request); const id = await guard(request); const changed = await repository.changePassword(id, body.currentPassword, body.newPassword); return send(request, response, 200, { ...changed, token: config.authSecret ? issueSession(id, changed.authVersion, 'PASSWORD') : undefined }, requestId) }
  const passwordReset = url.pathname.match(/^\/api\/staff\/([^/]+)\/reset-password$/)
  if (request.method === 'POST' && passwordReset) { const body = await readBody(request); return send(request, response, 200, await repository.resetPassword(await guardAdmin(request), decodeURIComponent(passwordReset[1]), body.password), requestId) }
  if (request.method === 'GET' && url.pathname === '/api/dashboard') return send(request, response, 200, await repository.dashboard(await guard(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/dashboard/basic') return send(request, response, 200, await repository.basicDashboard(await guardAdmin(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/staff/me') return send(request, response, 200, await repository.staff(await guard(request)), requestId)
  if (request.method === 'GET' && url.pathname === '/api/staff/mentors') {
    const filter = url.searchParams.get('status') || ''
    if (filter && !['ACTIVE', 'INACTIVE'].includes(filter)) fail('status 只支持 ACTIVE 或 INACTIVE', 'INVALID_STATUS', 400)
    return send(request, response, 200, await repository.teamSnapshot(await guard(request), filter), requestId)
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
  if (request.method === 'POST' && url.pathname === '/api/documents/extract') { const body = await readBody(request); return send(request, response, 200, await repository.extractDocument(await guardAdmin(request), body.document), requestId) }
  const customerSources = url.pathname.match(/^\/api\/customers\/([^/]+)\/sources$/)
  if (request.method === 'GET' && customerSources) return send(request, response, 200, await repository.sourceWorkspace(await guard(request), decodeURIComponent(customerSources[1])), requestId)
  if (request.method === 'POST' && url.pathname === '/api/sources') return send(request, response, 201, await repository.createSource(await guard(request), await readBody(request)), requestId)
  const sourceProcess = url.pathname.match(/^\/api\/sources\/([^/]+)\/process$/)
  if (request.method === 'POST' && sourceProcess) { const body = await readBody(request); return send(request, response, 200, await repository.processSource(await guard(request), decodeURIComponent(sourceProcess[1]), { force: body.force === true }), requestId) }
  const sourceDetail = url.pathname.match(/^\/api\/sources\/([^/]+)$/)
  if (request.method === 'GET' && sourceDetail) return send(request, response, 200, await repository.sourceDetail(await guard(request), decodeURIComponent(sourceDetail[1])), requestId)
  const proposalReview = url.pathname.match(/^\/api\/profile-proposals\/([^/]+)\/review$/)
  if (request.method === 'POST' && proposalReview) { const body = await readBody(request); return send(request, response, 200, await repository.reviewProposal(await guard(request), decodeURIComponent(proposalReview[1]), body.decision), requestId) }
  const conflictResolve = url.pathname.match(/^\/api\/evidence-conflicts\/([^/]+)\/resolve$/)
  if (request.method === 'POST' && conflictResolve) { const body = await readBody(request); return send(request, response, 200, await repository.resolveConflict(await guard(request), decodeURIComponent(conflictResolve[1]), body.resolution), requestId) }
  if (request.method === 'POST' && url.pathname === '/api/customers/preview') return send(request, response, 200, await repository.previewCustomer(await guard(request), await readBody(request)), requestId)
  if (request.method === 'POST' && url.pathname === '/api/customers') return send(request, response, 201, await repository.createCustomer(await guard(request), await readBody(request), requestId), requestId)
  const customerEdit = url.pathname.match(/^\/api\/customers\/([^/]+)$/)
  if (request.method === 'PATCH' && customerEdit) return send(request, response, 200, await repository.updateCustomer(await guard(request), decodeURIComponent(customerEdit[1]), await readBody(request)), requestId)
  const customerEnrollments = url.pathname.match(/^\/api\/customers\/([^/]+)\/enrollments$/)
  if (request.method === 'PUT' && customerEnrollments) { const body = await readBody(request); return send(request, response, 200, await repository.updateCustomerEnrollments(await guard(request), decodeURIComponent(customerEnrollments[1]), body.enrollments, body.operationId), requestId) }
  const understandingCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/understanding(?:\/refresh)?$/)
  if (understandingCustomer && request.method === 'GET' && url.pathname.endsWith('/understanding')) return send(request, response, 200, await repository.getCustomerUnderstanding(await guard(request), decodeURIComponent(understandingCustomer[1])), requestId)
  if (understandingCustomer && request.method === 'POST' && url.pathname.endsWith('/understanding/refresh')) { const body = await readBody(request); return send(request, response, 200, await repository.refreshCustomerUnderstanding(await guard(request), decodeURIComponent(understandingCustomer[1]), { force: body.force === true }), requestId) }
  const safetyCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/safety-assessment(?:\/refresh)?$/)
  if (safetyCustomer && request.method === 'GET' && url.pathname.endsWith('/safety-assessment')) return send(request, response, 200, await repository.getCustomerSafetyAssessment(await guard(request), decodeURIComponent(safetyCustomer[1])), requestId)
  if (safetyCustomer && request.method === 'POST' && url.pathname.endsWith('/safety-assessment/refresh')) { const body = await readBody(request); return send(request, response, 200, await repository.refreshCustomerSafetyAssessment(await guardAdmin(request), decodeURIComponent(safetyCustomer[1]), { force: body.force === true }), requestId) }
  if (request.method === 'GET' && url.pathname.startsWith('/api/customers/')) return send(request, response, 200, await repository.customer(await guard(request), decodeURIComponent(url.pathname.slice('/api/customers/'.length))), requestId)
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
  fail('接口不存在', 'NOT_FOUND', 404)
}

http.createServer((request, response) => {
  const requestId = typeof request.headers['x-request-id'] === 'string' && request.headers['x-request-id'].length < 100 ? request.headers['x-request-id'] : crypto.randomUUID()
  const startedAt = Date.now()
  handle(request, response, requestId).catch(async (error) => {
    const code = error?.code || (error instanceof FeishuUnavailableError ? 'FEISHU_UNAVAILABLE' : error instanceof DeepSeekUnavailableError ? 'DEEPSEEK_UNAVAILABLE' : 'REQUEST_FAILED')
    const statusCode = status(error)
    const operatorId = await (async () => { try { return await actorId(request) } catch { return '' } })()
    console.error('[ASVA_API_ERROR]', JSON.stringify({ timestamp: new Date().toISOString(), request_id: requestId, operator_id: operatorId || undefined, operation: `${request.method} ${request.url}`, provider_operation: error?.operation, entity: 'api', status: statusCode, duration: Date.now() - startedAt, error_code: code, provider_code: error?.providerCode, provider_message: typeof error?.providerMessage === 'string' ? error.providerMessage.slice(0, 160) : undefined, provider_request_id: error?.providerRequestId, provider_http_status: error?.httpStatus, retryable: error?.retryable, write_status: error?.writeStatus, readback_status: error?.readbackStatus }))
    const message = code === 'AUTH_INVALID' ? '登录信息验证失败' : code === 'AUTH_RATE_LIMITED' ? '登录尝试过于频繁，请稍后再试' : safeMessage(error, code)
    send(request, response, statusCode, { success: false, code, message, request_id: requestId }, requestId)
  })
}).listen(config.port, config.host, () => console.log(`ASVA API listening on http://${config.host}:${config.port}`))
