import { config } from '../server/config.mjs'
import { createRecord, listFields, listRecords } from '../server/feishu.mjs'
import { field, fields, read } from '../server/field-mapping.mjs'
import { contractFieldByName } from '../server/schema-contract.mjs'

const TARGET_PHONE = '15021512537'
const TARGET_STAFF_ID = 'staff-admin-owner-001'
const TARGET_NICKNAME = '翔叔'
const REQUIRED_KEYS = ['staff_id', 'nickname', 'name', 'phone', 'login_phone', 'role', 'permission_role', 'status', 'display_status', 'login_enabled', 'display_role', 'created_at', 'updated_at']

function assertProductionBootstrapEnabled() {
  if (process.env.ALLOW_ADMIN_BOOTSTRAP !== 'true') throw new Error('Admin bootstrap disabled.')
  if (config.environment !== 'production' || config.dataMode !== 'production') throw new Error('Admin bootstrap requires production environment and DATA_MODE=production.')
  if (!config.feishu.appId || !config.feishu.appSecret || !config.feishu.baseToken) throw new Error('Production Feishu configuration is incomplete.')
}

function maskedPhone(phone) { return `${phone.slice(0, 3)}****${phone.slice(-4)}` }
function normalized(value) { return String(value ?? '').replace(/[^0-9+]/g, '') }
function samePhone(value) { return normalized(value) === normalized(TARGET_PHONE) }
function rowIdentity(row) {
  return {
    staffId: String(read('staff', row.fields, 'staff_id') || ''),
    nickname: String(read('staff', row.fields, 'nickname') || read('staff', row.fields, 'name') || ''),
    phone: normalized(read('staff', row.fields, 'phone')),
    loginPhone: normalized(read('staff', row.fields, 'login_phone')),
    role: String(read('staff', row.fields, 'role') || ''),
    permissionRole: String(read('staff', row.fields, 'permission_role') || ''),
    status: String(read('staff', row.fields, 'status') || ''),
    loginEnabled: read('staff', row.fields, 'login_enabled') === true || String(read('staff', row.fields, 'login_enabled')).toLowerCase() === 'true',
  }
}

async function readStaff() {
  const tableId = config.feishu.tables.staff
  const [schema, rows] = await Promise.all([listFields(tableId), listRecords(tableId)])
  const names = new Set(schema.map((item) => item.field_name))
  const missing = REQUIRED_KEYS.map((key) => field('staff', key)).filter((name) => !names.has(name))
  if (missing.length) throw new Error(`Staff schema missing required fields: ${missing.join(', ')}`)
  for (const key of REQUIRED_KEYS) {
    if (!contractFieldByName('staff', field('staff', key)) && key !== 'name' && key !== 'display_status' && key !== 'display_role') throw new Error(`Staff schema contract missing mapping: ${key}`)
  }
  return { schema, rows, identities: rows.map(rowIdentity) }
}

function preview(identity, mode) {
  return {
    ok: true,
    mode,
    targetEnvironment: 'production',
    dataSource: 'FEISHU',
    phone: maskedPhone(TARGET_PHONE),
    staffId: TARGET_STAFF_ID,
    nickname: TARGET_NICKNAME,
    role: 'ADMIN',
    permissionRole: 'ADMIN',
    status: 'ACTIVE',
    loginEnabled: true,
    phoneFieldConflict: identity.phone === TARGET_PHONE,
    loginPhoneFieldConflict: identity.loginPhone === TARGET_PHONE,
  }
}

const confirm = process.argv.includes('--confirm')

try {
  assertProductionBootstrapEnabled()
  const first = await readStaff()
  const byId = first.identities.find((item) => item.staffId === TARGET_STAFF_ID)
  const byPhone = first.identities.filter((item) => item.phone === TARGET_PHONE || item.loginPhone === TARGET_PHONE)
  if (byPhone.length) {
    const exact = byPhone.find((item) => item.staffId === TARGET_STAFF_ID && item.role === 'ADMIN' && item.permissionRole === 'ADMIN' && item.status === 'ACTIVE' && item.loginEnabled)
    if (exact) {
      console.log(JSON.stringify({ ok: true, result: 'ADMIN_ALREADY_EXISTS', ...preview({ phone: TARGET_PHONE, loginPhone: TARGET_PHONE }, confirm ? 'CONFIRM' : 'PREVIEW') }))
      process.exit(0)
    }
    throw new Error('ADMIN_IDENTITY_CONFLICT')
  }
  if (byId) throw new Error('STAFF_ID_CONFLICT')

  const previewResult = preview({ phone: '', loginPhone: '' }, confirm ? 'CONFIRM' : 'PREVIEW')
  console.log(`BOOTSTRAP PREVIEW\n${JSON.stringify(previewResult)}`)
  if (!confirm) process.exit(0)

  const second = await readStaff()
  if (second.identities.some((item) => item.phone === TARGET_PHONE || item.loginPhone === TARGET_PHONE)) throw new Error('ADMIN_IDENTITY_CONFLICT')
  if (second.identities.some((item) => item.staffId === TARGET_STAFF_ID)) throw new Error('STAFF_ID_CONFLICT')

  const now = new Date().toISOString()
  const writeResult = await createRecord(config.feishu.tables.staff, fields('staff', {
    staff_id: TARGET_STAFF_ID,
    nickname: TARGET_NICKNAME,
    name: TARGET_NICKNAME,
    phone: TARGET_PHONE,
    login_phone: TARGET_PHONE,
    role: 'ADMIN',
    permission_role: 'ADMIN',
    status: 'ACTIVE',
    display_status: '在职',
    login_enabled: true,
    display_role: '管理员',
    created_at: now,
    updated_at: now,
  }))
  const after = await readStaff()
  const created = after.identities.find((item) => item.staffId === TARGET_STAFF_ID && samePhone(item.phone) && samePhone(item.loginPhone))
  if (!created || created.role !== 'ADMIN' || created.permissionRole !== 'ADMIN' || created.status !== 'ACTIVE' || !created.loginEnabled) throw new Error(`ADMIN_BOOTSTRAP_READBACK_FAILED:${writeResult?.record?.record_id || writeResult?.record_id || 'unknown'}`)
  console.log(JSON.stringify({ ok: true, result: 'ADMIN_CREATED', staffId: created.staffId, recordId: writeResult?.record?.record_id || writeResult?.record_id || writeResult?.record?.id, phone: maskedPhone(TARGET_PHONE), role: created.role, permissionRole: created.permissionRole, status: created.status, loginEnabled: created.loginEnabled, allowAdminBootstrap: 'DISABLED_AFTER_PROCESS_EXIT' }))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'bootstrap failed' }))
  process.exitCode = 1
}
