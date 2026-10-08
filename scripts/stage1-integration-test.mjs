import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config } from '../server/config.mjs'
import { listRecords } from '../server/feishu.mjs'
import { read as readField } from '../server/field-mapping.mjs'

if (process.env.RUN_FEISHU_INTEGRATION_TESTS !== 'true') {
  console.log(JSON.stringify({ skipped: true, reason: 'set RUN_FEISHU_INTEGRATION_TESTS=true to run real writes' }))
  process.exit(0)
}

const snapshotFile = path.resolve(process.env.STAGE1_SNAPSHOT_FILE || path.join('stage1-backup', `stage1-final-acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
const resultFile = path.resolve(process.env.STAGE1_RESULT_FILE || path.join('stage1-backup', `stage1-integration-result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
const port = Number(process.env.STAGE1_TEST_PORT || 8899)
const base = `http://127.0.0.1:${port}`
const suffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const prefix = `STAGE1_IT_${suffix}`
const testEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_MODE: 'production', ASVA_ENVIRONMENT: 'production', FEATURE_EXTERNAL_APPOINTMENT: 'false' }
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: testEnv, stdio: ['ignore', 'pipe', 'pipe'] })
const serverLogs = []
child.stdout.on('data', (chunk) => serverLogs.push(String(chunk)))
child.stderr.on('data', (chunk) => serverLogs.push(String(chunk)))

function assert(condition, message) { if (!condition) throw new Error(message) }
function telemetry(marker) {
  return serverLogs.join('').split('\n').filter((line) => line.includes(marker)).map((line) => {
    try { return JSON.parse(line.slice(line.indexOf('{'))) } catch { return { marker, parseError: true } }
  })
}
async function snapshot() {
  const tables = {}
  for (const [name, tableId] of Object.entries(config.feishu.tables)) tables[name] = tableId ? await listRecords(tableId) : []
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true })
  fs.writeFileSync(snapshotFile, JSON.stringify({ generatedAt: new Date().toISOString(), counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])), tables }, null, 2), { mode: 0o600 })
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]))
}
async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Stage 1 integration API did not start')
}
async function call(pathname, options = {}, token) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const headers = new Headers(options.headers)
    headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${base}${pathname}`, { ...options, headers })
    const payload = await response.json().catch(() => null)
    if (payload?.code !== 'FEISHU_UNAVAILABLE' || attempt === 3) return { response, payload }
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  throw new Error('integration request retry exhausted')
}
async function requireCall(pathname, options = {}, token) {
  const result = await call(pathname, options, token)
  assert(result.response.ok, `${pathname} failed: ${result.payload?.code || result.response.status}`)
  return result.payload
}

try {
  const snapshotCounts = await snapshot()
  await waitForServer()
  const health = await requireCall('/api/health')
  assert(health.dataMode === 'production' && health.featureFlags?.externalAppointment === false, 'production integration mode mismatch')
  assert(config.adminLoginCode, 'ASVA_ADMIN_LOGIN_CODE is not configured for the gated test')
  const staffRows = await listRecords(config.feishu.tables.staff)
  const admin = staffRows.map((row) => ({ phone: readField('staff', row.fields, 'phone') || readField('staff', row.fields, 'login_phone'), role: readField('staff', row.fields, 'permission_role'), status: readField('staff', row.fields, 'status'), enabled: readField('staff', row.fields, 'login_enabled') })).find((item) => item.role === 'ADMIN' && item.status === 'ACTIVE' && item.enabled !== false)
  assert(admin?.phone, 'no active admin found for the gated integration test')
  const login = await requireCall('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: admin.phone, code: config.adminLoginCode }) })
  assert(login.permissionRole === 'ADMIN' && login.token, 'admin login did not return a session')
  const token = login.token
  const database = await requireCall('/api/dashboard', {}, token)
  const products = database.products.filter((product) => product.active !== false && product.status === '在售')
  assert(products.length >= 2, 'need two active products for enrollment integration')

  const noContact = await call('/api/customers', { method: 'POST', body: JSON.stringify({ operationId: `${prefix}_NO_CONTACT`, nickname: `${prefix}_NO_CONTACT`, situation: 'no contact rejection' }) }, token)
  assert(noContact.response.status === 400 && noContact.payload?.code === 'CUSTOMER_CONTACT_REQUIRED', 'no-contact Customer create was not rejected')

  const phoneOnlyInput = { operationId: `${prefix}_PHONE`, nickname: `${prefix}_PHONE_ONLY`, phone: `139${String(Date.now()).slice(-8)}`, situation: 'Stage 1 phone-only identity test', needsFollowup: false, source: prefix, confirmedNotSame: true }
  const phoneOnly = await requireCall('/api/customers', { method: 'POST', body: JSON.stringify(phoneOnlyInput) }, token)
  const phoneCustomer = phoneOnly.customers.find((item) => item.name === phoneOnlyInput.nickname)
  assert(phoneCustomer, 'phone-only Customer create did not read back')

  const nicknamePossible = await call('/api/customers', { method: 'POST', body: JSON.stringify({ operationId: `${prefix}_NICKNAME_POSSIBLE`, nickname: phoneOnlyInput.nickname, phone: `136${String(Date.now() + 3).slice(-8)}`, situation: 'nickname possible match' }) }, token)
  assert(nicknamePossible.response.status === 409 && nicknamePossible.payload?.code === 'CUSTOMER_POSSIBLE_MATCH', 'nickname possible match was not surfaced')
  const nicknameConfirmed = await requireCall('/api/customers', { method: 'POST', body: JSON.stringify({ operationId: `${prefix}_NICKNAME_CONFIRMED`, nickname: phoneOnlyInput.nickname, phone: `136${String(Date.now() + 3).slice(-8)}`, situation: 'nickname confirmed different person', confirmedNotSame: true, source: prefix }) }, token)
  assert(nicknameConfirmed.customers.filter((item) => item.name === phoneOnlyInput.nickname).length >= 2, 'nickname confirmation did not create the distinct Customer')

  const wechatOnlyInput = { operationId: `${prefix}_WECHAT`, nickname: `${prefix}_WECHAT_ONLY`, wechat: `${prefix}_WX`, situation: 'Stage 1 WeChat-only identity test', needsFollowup: false, source: prefix, confirmedNotSame: true }
  const wechatOnly = await requireCall('/api/customers', { method: 'POST', body: JSON.stringify(wechatOnlyInput) }, token)
  const wechatCustomer = wechatOnly.customers.find((item) => item.name === wechatOnlyInput.nickname)
  assert(wechatCustomer, 'WeChat-only Customer create did not read back')

  const fullInput = { operationId: `${prefix}_FULL`, nickname: `${prefix}_FULL`, phone: `139${String(Date.now() + 1).slice(-8)}`, wechat: `${prefix}_FULL_WX`, situation: 'Stage 1 multi-enrollment identity test', needsFollowup: false, source: prefix, confirmedNotSame: true, profileUpdates: [{ field: 'city', value: '南京', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'marital_status', value: '已婚', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'occupation', value: '设计师', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'current_goal', value: '建立稳定节奏', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'birth_date', value: '1990-01-10', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'intended_course', value: '只表达兴趣的课程', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }], enrollments: [{ productId: products[0].id, paymentStatus: 'PAID', amount: 1 }, { productId: products[1].id, paymentStatus: 'UNPAID', amount: 2 }] }
  const created = await requireCall('/api/customers', { method: 'POST', body: JSON.stringify(fullInput) }, token)
  const customer = created.customers.find((item) => item.name === fullInput.nickname)
  assert(customer, 'full Customer create did not read back')
  assert(!created.appointments.some((item) => item.customerId === customer.id), 'Customer creation unexpectedly created Appointment')
  const retry = await requireCall('/api/customers', { method: 'POST', body: JSON.stringify(fullInput) }, token)
  assert(retry.customers.filter((item) => item.id === customer.id).length === 1, 'same operationId retry did not remain idempotent')

  const duplicatePhone = await call('/api/customers', { method: 'POST', body: JSON.stringify({ ...fullInput, operationId: `${prefix}_DUP_PHONE`, nickname: `${prefix}_DUP_PHONE`, wechat: `${prefix}_DUP_PHONE_WX` }) }, token)
  assert(duplicatePhone.response.status === 409 && duplicatePhone.payload?.code === 'CUSTOMER_DUPLICATE', 'duplicate phone was not blocked')
  const duplicateWechat = await call('/api/customers', { method: 'POST', body: JSON.stringify({ ...fullInput, operationId: `${prefix}_DUP_WX`, nickname: `${prefix}_DUP_WX`, phone: `137${String(Date.now() + 2).slice(-8)}` }) }, token)
  assert(duplicateWechat.response.status === 409 && duplicateWechat.payload?.code === 'CUSTOMER_DUPLICATE', 'duplicate WeChat was not blocked')
  const conflict = await call('/api/customers', { method: 'POST', body: JSON.stringify({ ...fullInput, operationId: `${prefix}_CONFLICT`, nickname: `${prefix}_CONFLICT`, wechat: wechatOnlyInput.wechat }) }, token)
  assert(conflict.response.status === 409 && conflict.payload?.code === 'IDENTITY_CONFLICT', 'cross-customer identity conflict was not blocked')

  const updated = await requireCall(`/api/customers/${encodeURIComponent(customer.id)}`, { method: 'PATCH', body: JSON.stringify({ ...fullInput, operationId: `${prefix}_UPDATE`, nickname: `${prefix}_UPDATED`, wechat: `${prefix}_UPDATED_WX`, situation: 'Stage 1 updated identity and profile', needsFollowup: false, profileUpdates: [{ field: 'city', value: '杭州', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'marital_status', value: '未婚', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'occupation', value: '产品顾问', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'current_goal', value: '完成稳定转型', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }, { field: 'birth_date', value: '1990-01-10', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }], enrollments: [{ productId: products[0].id, paymentStatus: 'PAID', amount: 1 }, { productId: products[1].id, paymentStatus: 'PAID', amount: 2 }] }) }, token)
  const refreshed = updated.customers.find((item) => item.id === customer.id)
  const profileChanges = updated.profileChanges.filter((item) => item.customerId === customer.id)
  const enrollments = updated.enrollments.filter((item) => item.customerId === customer.id && item.status !== 'CANCELLED')
  assert(refreshed?.name === `${prefix}_UPDATED` && refreshed.profileVersion > customer.profileVersion, 'Customer update/profile version did not read back')
  assert(refreshed.profileFieldMeta?.city?.source === 'ADMIN_CONFIRMED', 'confirmed provenance metadata did not read back')
  assert(refreshed.profileFields?.birth_date?.startsWith('1990-01-10') && refreshed.profileFields?.birth_year === 1990, 'birth_date did not read back as the canonical fact')
  for (const field of ['city', 'marital_status', 'occupation', 'current_goal', 'birth_date']) assert(profileChanges.some((item) => item.field === field && item.confirmed), `ProfileChange missing: ${field}`)
  assert(enrollments.length === 2, 'multi-enrollment relation did not read back')
  assert(!updated.appointments.some((item) => item.customerId === customer.id), 'Customer update unexpectedly created Appointment')
  const cancelled = await requireCall(`/api/customers/${encodeURIComponent(customer.id)}/enrollments`, { method: 'PUT', body: JSON.stringify({ operationId: `${prefix}_REMOVE`, enrollments: [{ productId: products[0].id }] }) }, token)
  assert(cancelled.enrollments.some((item) => item.customerId === customer.id && item.productId === products[1].id && item.status === 'CANCELLED'), 'Enrollment REMOVE did not preserve a CANCELLED history row')
  const restored = await requireCall(`/api/customers/${encodeURIComponent(customer.id)}/enrollments`, { method: 'PUT', body: JSON.stringify({ operationId: `${prefix}_RESTORE`, enrollments: [{ productId: products[0].id }, { productId: products[1].id }] }) }, token)
  assert(restored.enrollments.filter((item) => item.customerId === customer.id && item.status !== 'CANCELLED').length === 2, 'cancelled Enrollment was not restored')
  assert(refreshed.intendedCourse === '只表达兴趣的课程' && !restored.enrollments.some((item) => item.productId === refreshed.intendedCourse), 'intended_course leaked into Enrollment truth')
  const result = { ok: true, testPrefix: prefix, snapshotFile, snapshotCounts, customerIds: [phoneCustomer.id, wechatCustomer.id, customer.id, ...nicknameConfirmed.customers.filter((item) => item.name === phoneOnlyInput.nickname).map((item) => item.id)], enrollmentCount: restored.enrollments.filter((item) => item.customerId === customer.id && item.status !== 'CANCELLED').length, profileChangeCount: profileChanges.length, appointmentCreated: false, cancelledAndRestored: true, noContactRejected: true, nicknamePossibleMatch: true, idempotentRetry: true, writeTelemetry: telemetry('[ASVA_FEISHU_WRITE]'), readbackTelemetry: telemetry('[ASVA_FEISHU_READBACK]'), generatedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(resultFile), { recursive: true })
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ...result, resultFile }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'integration test failed', serverErrorCodes: serverLogs.join('').split('\n').filter((line) => line.includes('[ASVA_API_ERROR]')).slice(-5).map((line) => { try { const parsed = JSON.parse(line.slice(line.indexOf('{'))); return { operation: parsed.operation, status: parsed.status, error_code: parsed.error_code, provider_message: parsed.provider_message } } catch { return { line: 'unparseable server error' } } }) }))
  process.exitCode = 1
} finally {
  child.kill('SIGTERM')
}
