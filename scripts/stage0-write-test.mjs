import crypto from 'node:crypto'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { config } from '../server/config.mjs'
import { listRecords } from '../server/feishu.mjs'
import { read as readField } from '../server/field-mapping.mjs'

if (process.env.RUN_FEISHU_INTEGRATION_TESTS !== 'true') {
  console.log('Stage 0 Feishu integration skipped; set RUN_FEISHU_INTEGRATION_TESTS=true to run real writes.')
  process.exit(0)
}

const snapshotFile = process.env.STAGE0_SNAPSHOT_FILE
if (!snapshotFile || !fs.existsSync(snapshotFile)) throw new Error('Refusing real writes without STAGE0_SNAPSHOT_FILE pointing to the pre-write snapshot.')
const port = Number(process.env.STAGE0_TEST_PORT || 8799)
const base = `http://127.0.0.1:${port}`
const suffix = `${Date.now()}_${crypto.randomBytes(2).toString('hex')}`
const secret = crypto.randomBytes(32).toString('hex')
const testEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_MODE: 'demo', ASVA_ENVIRONMENT: 'local', ALLOW_DEV_OTP: 'true', ASVA_AUTH_SECRET: secret, FEATURE_EXTERNAL_APPOINTMENT: 'false' }
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: testEnv, stdio: ['ignore', 'ignore', 'ignore'] })

function assert(condition, message) { if (!condition) throw new Error(message) }
async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('local Stage 0 test API did not start')
}
async function call(path, options = {}, token) {
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${base}${path}`, { ...options, headers })
  const payload = await response.json().catch(() => null)
  assert(response.ok, `${path} failed: ${payload?.code || response.status}`)
  return payload
}

try {
  await waitForServer()
  const staffRows = await listRecords(config.feishu.tables.staff)
  const admin = staffRows.map((row) => ({ phone: readField('staff', row.fields, 'phone') || readField('staff', row.fields, 'login_phone'), role: readField('staff', row.fields, 'permission_role'), status: readField('staff', row.fields, 'status'), enabled: readField('staff', row.fields, 'login_enabled') })).find((item) => item.role === 'ADMIN' && item.status === 'ACTIVE' && item.enabled !== false)
  assert(admin?.phone, 'no active admin found for the gated integration test')
  const health = await call('/api/health')
  assert(health.service === 'asva-api' && health.dataMode === 'demo', 'health metadata mismatch')
  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone: admin.phone, code: '888888' }) })
  assert(login.token && login.permissionRole === 'ADMIN', 'admin login did not return a signed session')
  const token = login.token
  const initialDatabase = await call('/api/dashboard', {}, token)
  const products = initialDatabase.products.filter((product) => product.active !== false && product.status === '在售')
  assert(products.length >= 2, 'need two active products for enrollment acceptance')

  const mentor = await call('/api/staff/mentors', { method: 'POST', headers: { 'X-Operation-Id': `STAGE0_TEST_MENTOR_${suffix}` }, body: JSON.stringify({ name: `STAGE0_TEST_导师_${suffix}`, phone: `138${String(Date.now()).slice(-8)}` }) }, token)
  const updatedMentor = await call(`/api/staff/mentors/${encodeURIComponent(mentor.id)}`, { method: 'PATCH', body: JSON.stringify({ name: `STAGE0_TEST_导师_更新_${suffix}`, phone: mentor.phone }) }, token)
  assert(updatedMentor.name.includes('STAGE0_TEST_导师_更新'), 'mentor update did not read back')
  const deactivatedMentor = await call(`/api/staff/mentors/${encodeURIComponent(mentor.id)}/deactivate`, { method: 'POST', body: '{}' }, token)
  assert(deactivatedMentor.status === 'INACTIVE', 'mentor deactivation did not read back')

  const customerInput = {
    operationId: `STAGE0_TEST_CUSTOMER_${suffix}`,
    nickname: `STAGE0_TEST_客户_${suffix}`,
    phone: `139${String(Date.now()).slice(-8)}`,
    wechat: `STAGE0_TEST_WX_${suffix}`,
    situation: 'STAGE0_TEST 南京初始记录',
    needsFollowup: true,
    source: 'STAGE0_TEST_IMPORT',
    confirmedNotSame: true,
    profileUpdates: [
      { field: 'city', value: '南京', source: 'USER_EXPLICIT', confidence: 1 },
      { field: 'occupation', value: 'STAGE0_TEST 产品经理', source: 'USER_EXPLICIT', confidence: 1 },
    ],
    enrollments: [{ productId: products[0].id, paymentStatus: 'PAID', amount: 1 }],
  }
  const created = await call('/api/customers', { method: 'POST', body: JSON.stringify(customerInput) }, token)
  const customer = created.customers.find((item) => item.name === customerInput.nickname)
  assert(customer, 'customer create did not read back')
  for (let index = 2; index <= 6; index += 1) {
    await call('/api/customers', { method: 'POST', body: JSON.stringify({ operationId: `STAGE0_TEST_CUSTOMER_${index}_${suffix}`, nickname: `STAGE0_TEST_客户_${index}_${suffix}`, phone: `137${String(Date.now() + index).slice(-8)}`, wechat: `STAGE0_TEST_WX_${index}_${suffix}`, situation: `STAGE0_TEST 样本 ${index}`, needsFollowup: false, source: 'STAGE0_TEST_DATASET_V1', confirmedNotSame: true }) }, token)
  }
  const readCustomer = await call(`/api/customers/${encodeURIComponent(customer.id)}`, {}, token)
  assert(readCustomer.id === customer.id, 'customer read failed')
  const updated = await call(`/api/customers/${encodeURIComponent(customer.id)}`, { method: 'PATCH', body: JSON.stringify({ ...customerInput, operationId: `STAGE0_TEST_CUSTOMER_UPDATE_${suffix}`, nickname: `STAGE0_TEST_客户_更新_${suffix}`, wechat: `STAGE0_TEST_WX_UPDATED_${suffix}`, situation: 'STAGE0_TEST 更新后的记录', needsFollowup: false, source: 'STAGE0_TEST_UPDATE', profileUpdates: [{ field: 'city', value: '杭州', source: 'USER_EXPLICIT', confidence: 1 }, { field: 'occupation', value: 'STAGE0_TEST 运营负责人', source: 'USER_EXPLICIT', confidence: 1 }], enrollments: [{ productId: products[0].id, paymentStatus: 'PAID', amount: 1 }, { productId: products[1].id, paymentStatus: 'UNPAID', amount: 2 }] }) }, token)
  const refreshedCustomer = updated.customers.find((item) => item.id === customer.id)
  assert(refreshedCustomer?.wechat === `STAGE0_TEST_WX_UPDATED_${suffix}`, 'customer update did not read back')
  await call(`/api/customers/${encodeURIComponent(customer.id)}/referrer`, { method: 'POST', body: JSON.stringify({ referrerName: `STAGE0_TEST_介绍人_${suffix}` }) }, token)

  let database = await call('/api/dashboard', {}, token)
  let appointment = database.appointments.find((item) => item.customerId === customer.id && item.status === 'WAIT_FOLLOW_UP')
  assert(appointment, 'customer follow-up appointment missing')
  await call(`/api/appointments/${encodeURIComponent(appointment.id)}/complete-followup`, { method: 'POST', body: '{}' }, token)
  await call(`/api/appointments/${encodeURIComponent(appointment.id)}/feedback`, { method: 'POST', body: JSON.stringify({ topic: 'STAGE0_TEST ServiceRecord A', result: '完成', coreNeed: 'STAGE0_TEST 普通记录', paid: false, grade: 'C', intendedCourse: null, notes: 'STAGE0_TEST A', profileUpdates: [] }) }, token)

  await call(`/api/customers/${encodeURIComponent(customer.id)}`, { method: 'PATCH', body: JSON.stringify({ nickname: refreshedCustomer.name, phone: refreshedCustomer.phone, wechat: refreshedCustomer.wechat, situation: 'STAGE0_TEST 第二次服务前', needsFollowup: true, source: 'STAGE0_TEST_UPDATE', confirmedNotSame: true, enrollments: [] }) }, token)
  database = await call('/api/dashboard', {}, token)
  appointment = database.appointments.find((item) => item.customerId === customer.id && item.status === 'WAIT_FOLLOW_UP')
  assert(appointment, 'second follow-up appointment missing')
  await call(`/api/appointments/${encodeURIComponent(appointment.id)}/complete-followup`, { method: 'POST', body: '{}' }, token)
  await call(`/api/appointments/${encodeURIComponent(appointment.id)}/feedback`, { method: 'POST', body: JSON.stringify({ topic: 'STAGE0_TEST ServiceRecord B', result: '完成', coreNeed: 'STAGE0_TEST AI与画像联动', paid: false, grade: 'C', intendedCourse: products[1].name, notes: 'STAGE0_TEST B', aiSummary: 'STAGE0_TEST_RULE_SUMMARY', aiStatus: '已完成', aiNextStep: 'STAGE0_TEST_NEXT', profileUpdates: [{ field: 'current_goal', value: 'STAGE0_TEST 可验证目标', source: 'MENTOR_CONFIRMED', confidence: 1 }] }) }, token)
  database = await call('/api/dashboard', {}, token)
  const finalCustomer = database.customers.find((item) => item.id === customer.id)
  assert(finalCustomer && database.customers.filter((item) => item.name.startsWith('STAGE0_TEST_')).length >= 6 && database.enrollments.filter((item) => item.customerId === customer.id).length >= 2, 'test dataset or enrollment refresh failed')
  assert(database.sessions.filter((item) => item.customerId === customer.id).length >= 2, 'service record refresh failed')
  assert(database.profileChanges.some((item) => item.customerId === customer.id && item.field === 'city'), 'profile change refresh failed')
  console.log(JSON.stringify({ ok: true, testPrefix: 'STAGE0_TEST_', mentorId: mentor.id, customerId: customer.id, enrollmentCount: database.enrollments.filter((item) => item.customerId === customer.id).length, serviceRecordCount: database.sessions.filter((item) => item.customerId === customer.id).length, profileChangeCount: database.profileChanges.filter((item) => item.customerId === customer.id).length }))
} finally {
  child.kill('SIGTERM')
}
