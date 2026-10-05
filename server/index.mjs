import http from 'node:http'
import { config, configurationStatus } from './config.mjs'
import { createBrief, createServiceSummary, DeepSeekUnavailableError } from './deepseek.mjs'
import { FeishuRepository } from './repository.mjs'
import { FeishuUnavailableError } from './feishu.mjs'

const repository = new FeishuRepository()
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Staff-Id', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS' }

function send(response, status, body) { response.writeHead(status, headers); response.end(JSON.stringify(body)) }
async function readBody(request) { let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1_000_000) throw new Error('请求体过大') } return JSON.parse(raw || '{}') }
function actorId(request) { return typeof request.headers['x-staff-id'] === 'string' ? request.headers['x-staff-id'] : '' }
function guard(request) { const id = actorId(request); if (!id) throw Object.assign(new Error('缺少 X-Staff-Id'), { status: 401 }); return id }
function status(error) { if (error?.status) return error.status; if (error instanceof FeishuUnavailableError) return 502; if (error instanceof DeepSeekUnavailableError) return 502; if (/无权|账号不存在|只有 ADMIN|账户已停用|导师端暂未开放/.test(error?.message || '')) return 403; return 400 }
async function guardAdmin(request) { const id = guard(request); await repository.staff(id); return id }

async function handle(request, response) {
  if (request.method === 'OPTIONS') return send(response, 204, {})
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
  if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true, service: 'asva-workbench', ...configurationStatus(), tables: config.feishu.tables })
  if (request.method === 'POST' && url.pathname === '/api/auth/login') { const body = await readBody(request); return send(response, 200, await repository.authenticate(body.phone, body.code)) }
  if (request.method === 'GET' && url.pathname === '/api/dashboard') return send(response, 200, await repository.dashboard(guard(request)))
  if (request.method === 'GET' && url.pathname === '/api/staff/me') return send(response, 200, await repository.staff(guard(request)))
  if (request.method === 'GET' && url.pathname === '/api/staff/mentors') return send(response, 200, await repository.teamSnapshot(guard(request)))
  if (request.method === 'POST' && url.pathname === '/api/staff/mentors') { const body = await readBody(request); return send(response, 201, await repository.createMentor(guard(request), body)) }
  const mentorEdit = url.pathname.match(/^\/api\/staff\/mentors\/([^/]+)$/)
  if (request.method === 'PATCH' && mentorEdit) { const body = await readBody(request); return send(response, 200, await repository.updateMentor(guard(request), decodeURIComponent(mentorEdit[1]), body)) }
  const mentorDeactivate = url.pathname.match(/^\/api\/staff\/mentors\/([^/]+)\/deactivate$/)
  if (request.method === 'POST' && mentorDeactivate) return send(response, 200, await repository.deactivateMentor(guard(request), decodeURIComponent(mentorDeactivate[1])))
  const profileExtract = url.pathname.match(/^\/api\/customers\/([^/]+)\/profile\/extract$/)
  if (request.method === 'POST' && profileExtract) { const body = await readBody(request); return send(response, 200, await repository.profileDraft(guard(request), decodeURIComponent(profileExtract[1]), body.text)) }
  const profileConfirm = url.pathname.match(/^\/api\/customers\/([^/]+)\/profile\/confirm$/)
  if (request.method === 'POST' && profileConfirm) { const body = await readBody(request); return send(response, 200, await repository.confirmProfile(guard(request), decodeURIComponent(profileConfirm[1]), body.updates)) }
  if (request.method === 'POST' && url.pathname === '/api/customers/preview') return send(response, 200, await repository.previewCustomer(await guardAdmin(request), await readBody(request)))
  if (request.method === 'POST' && url.pathname === '/api/customers') return send(response, 201, await repository.createCustomer(await guardAdmin(request), await readBody(request)))
  const customerEdit = url.pathname.match(/^\/api\/customers\/([^/]+)$/)
  if (request.method === 'PATCH' && customerEdit) return send(response, 200, await repository.updateCustomer(await guardAdmin(request), decodeURIComponent(customerEdit[1]), await readBody(request)))
  if (request.method === 'GET' && url.pathname.startsWith('/api/customers/')) return send(response, 200, await repository.customer(guard(request), decodeURIComponent(url.pathname.slice('/api/customers/'.length))))
  const briefCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/brief$/)
  if (request.method === 'POST' && briefCustomer) { const body = await readBody(request); return send(response, 200, await repository.saveBrief(guard(request), decodeURIComponent(briefCustomer[1]), body.brief)) }
  const referrerCustomer = url.pathname.match(/^\/api\/customers\/([^/]+)\/referrer$/)
  if (request.method === 'POST' && referrerCustomer) { const body = await readBody(request); return send(response, 200, await repository.updateCustomerReferrer(guard(request), decodeURIComponent(referrerCustomer[1]), body.referrerName)) }
  if (request.method === 'GET' && url.pathname === '/api/team') return send(response, 200, await repository.teamSnapshot(guard(request)))
  if (request.method === 'GET' && url.pathname === '/api/dashboard/snapshot') return send(response, 200, await repository.dashboardSnapshot(guard(request)))
  const assign = url.pathname.match(/^\/api\/appointments\/([^/]+)\/assign$/)
  if (request.method === 'POST' && assign) { const body = await readBody(request); return send(response, 200, await repository.assignAppointment(guard(request), decodeURIComponent(assign[1]), body.mentorId)) }
  const complete = url.pathname.match(/^\/api\/appointments\/([^/]+)\/complete-followup$/)
  if (request.method === 'POST' && complete) return send(response, 200, await repository.markFollowupDone(guard(request), decodeURIComponent(complete[1])))
  if (request.method === 'POST' && url.pathname === '/api/ai/query') { const body = await readBody(request); return send(response, 200, await repository.assistantQuery(guard(request), body.question, body.context)) }
  if (request.method === 'GET' && url.pathname === '/api/ai/query-logs') return send(response, 200, await repository.assistantQueryLogs(guard(request)))
  if (request.method === 'POST' && url.pathname === '/api/ai/service-summary') { await guardAdmin(request); return send(response, 200, await createServiceSummary(await readBody(request))) }
  if (request.method === 'POST' && url.pathname === '/api/ai/brief') { await guardAdmin(request); return send(response, 200, { brief: await createBrief(await readBody(request)) }) }
  const feedback = url.pathname.match(/^\/api\/appointments\/([^/]+)\/feedback$/)
  if (request.method === 'POST' && feedback) { const body = await readBody(request); return send(response, 200, await repository.saveFeedback(guard(request), { ...body, appointmentId: decodeURIComponent(feedback[1]) })) }
  if (request.method === 'POST' && url.pathname === '/api/appointments') return send(response, 200, await repository.createAppointment(await readBody(request)))
  return send(response, 404, { error: '接口不存在' })
}

http.createServer((request, response) => { handle(request, response).catch((error) => send(response, status(error), { error: error instanceof Error ? error.message : '服务器错误', code: error?.code })) }).listen(config.port, '127.0.0.1', () => console.log(`ASVA API listening on http://127.0.0.1:${config.port}`))
