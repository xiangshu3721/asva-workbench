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

const snapshotFile = path.resolve(process.env.STAGE1_SNAPSHOT_FILE || path.join('stage1-backup', `feishu-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
const port = Number(process.env.STAGE1_TEST_PORT || 8899)
const base = `http://127.0.0.1:${port}`
const suffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const prefix = `STAGE1_TEST_${suffix}`
const testEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_MODE: 'production', ASVA_ENVIRONMENT: 'production', FEATURE_EXTERNAL_APPOINTMENT: 'false' }
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: testEnv, stdio: ['ignore', 'pipe', 'pipe'] })
const serverLogs = []
child.stdout.on('data', (chunk) => serverLogs.push(String(chunk)))
child.stderr.on('data', (chunk) => serverLogs.push(String(chunk)))

function assert(condition, message) { if (!condition) throw new Error(message) }
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

  const phoneOnlyInput = { operationId: `${prefix}_PHONE`, nickname: `${prefix}_PHONE_ONLY`, phone: `139${String(Date.now()).slice(-8)}`, situation: 'Stage 1 phone-only identity test', needsFollowup: false, source: prefix, confirmedNotSame: true }
  const phoneOnly = await requireCall('/api/customers', { method: 'POST', body: JSON.stringify(phoneOnlyInput) }, token)
  const phoneCustomer = phoneOnly.customers.find((item) => item.name === phoneOnlyInput.nickname)
  assert(phoneCustomer, 'phone-only Customer create did not read back')

  const wechatOnlyInput = { operationId: `${prefix}_WECHAT`, nickname: `${prefix}_WECHAT_ONLY`, wechat: `${prefix}_WX`, situation: 'Stage 1 WeChat-only identity test', needsFollowup: false, source: prefix, confirmedNotSame: true }
  const wechatOnly = await requireCall('/api/customers', { method: 'POST', body: JSON.stringify(wechatOnlyInput) }, token)
  const wechatCustomer = wechatOnly.customers.find((item) => item.name === wechatOnlyInput.nickname)
  assert(wechatCustomer, 'WeChat-only Customer create did not read back')

  const fullInput = { operationId: `${prefix}_FULL`, nickname: `${prefix}_FULL`, phone: `138${String(Date.now() + 1).slice(-8)}`, wechat: `${prefix}_FULL_WX`, situation: 'Stage 1 multi-enrollment identity test', needsFollowup: false, source: prefix, confirmedNotSame: true, profileUpdates: [{ field: 'city', value: '南京', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }], enrollments: [{ productId: products[0].id, paymentStatus: 'PAID', amount: 1 }, { productId: products[1].id, paymentStatus: 'UNPAID', amount: 2 }] }
  const created = await requireCall('/api/customers', { method: 'POST', body: JSON.stringify(fullInput) }, token)
  const customer = created.customers.find((item) => item.name === fullInput.nickname)
  assert(customer, 'full Customer create did not read back')
  assert(!created.appointments.some((item) => item.customerId === customer.id), 'Customer creation unexpectedly created Appointment')

  const duplicatePhone = await call('/api/customers', { method: 'POST', body: JSON.stringify({ ...fullInput, operationId: `${prefix}_DUP_PHONE`, nickname: `${prefix}_DUP_PHONE`, wechat: `${prefix}_DUP_PHONE_WX` }) }, token)
  assert(duplicatePhone.response.status === 409 && duplicatePhone.payload?.code === 'CUSTOMER_DUPLICATE', 'duplicate phone was not blocked')
  const duplicateWechat = await call('/api/customers', { method: 'POST', body: JSON.stringify({ ...fullInput, operationId: `${prefix}_DUP_WX`, nickname: `${prefix}_DUP_WX`, phone: `137${String(Date.now() + 2).slice(-8)}` }) }, token)
  assert(duplicateWechat.response.status === 409 && duplicateWechat.payload?.code === 'CUSTOMER_DUPLICATE', 'duplicate WeChat was not blocked')

  const updated = await requireCall(`/api/customers/${encodeURIComponent(customer.id)}`, { method: 'PATCH', body: JSON.stringify({ ...fullInput, operationId: `${prefix}_UPDATE`, nickname: `${prefix}_UPDATED`, wechat: `${prefix}_UPDATED_WX`, situation: 'Stage 1 updated identity and profile', needsFollowup: false, profileUpdates: [{ field: 'city', value: '杭州', source: 'USER_EXPLICIT', confidence: 1, confirmed: true }], enrollments: [{ productId: products[0].id, paymentStatus: 'PAID', amount: 1 }, { productId: products[1].id, paymentStatus: 'PAID', amount: 2 }] }) }, token)
  const refreshed = updated.customers.find((item) => item.id === customer.id)
  const profileChanges = updated.profileChanges.filter((item) => item.customerId === customer.id)
  const enrollments = updated.enrollments.filter((item) => item.customerId === customer.id && item.status !== 'CANCELLED')
  assert(refreshed?.name === `${prefix}_UPDATED` && refreshed.profileVersion > customer.profileVersion, 'Customer update/profile version did not read back')
  assert(refreshed.profileFieldMeta?.city?.source === 'ADMIN_CONFIRMED', 'confirmed provenance metadata did not read back')
  assert(profileChanges.some((item) => item.field === 'city' && item.confirmed), 'ProfileChange was not created')
  assert(enrollments.length === 2, 'multi-enrollment relation did not read back')
  assert(!updated.appointments.some((item) => item.customerId === customer.id), 'Customer update unexpectedly created Appointment')
  console.log(JSON.stringify({ ok: true, testPrefix: prefix, snapshotFile, snapshotCounts, customerCount: 3, enrollmentCount: enrollments.length, profileChangeCount: profileChanges.length, appointmentCreated: false }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'integration test failed', serverErrorCodes: serverLogs.join('').split('\n').filter((line) => line.includes('[ASVA_API_ERROR]')).slice(-5).map((line) => { try { const parsed = JSON.parse(line.slice(line.indexOf('{'))); return { operation: parsed.operation, status: parsed.status, error_code: parsed.error_code, provider_message: parsed.provider_message } } catch { return { line: 'unparseable server error' } } }) }))
  process.exitCode = 1
} finally {
  child.kill('SIGTERM')
}
