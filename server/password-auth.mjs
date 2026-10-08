import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { config } from './config.mjs'
import { createRecord, listRecords, updateRecord } from './feishu.mjs'
import { field, fields, read } from './field-mapping.mjs'

const scryptAsync = promisify(crypto.scrypt)
const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
const SALT_BYTES = 16
const MAXMEM = 64 * 1024 * 1024
const DUMMY_HASH = 'scrypt$N=32768,r=8,p=1$YXN2YS1kdW1teS1zYWx0$wq1o4n2t2pQdU6t4nLh6Qw6h4QZfPZ0G3Dk3tQG4l7Q'
const WEAK_PASSWORDS = new Set(['12345', '123456', '1234567890', '12345678901', '88888', '888888', '8888888888', 'abcde', 'abcdefghij', 'qwerty', 'qwertyuiop', 'admin', 'password', 'password123', '1111111111', '0000000000'])
export const PASSWORD_POLICY_MESSAGE = '密码需为 5～64 位'

const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const bool = (value) => value === true || value === 'true' || value === '是'
const normalizePhone = (value) => text(value).replace(/[\s-]/g, '')
const now = () => new Date().toISOString()

export class PasswordPolicyError extends Error {
  code = 'PASSWORD_POLICY_INVALID'
  status = 400
}

export class AuthCredentialStoreNotConfiguredError extends Error {
  code = 'AUTH_CREDENTIAL_STORE_NOT_CONFIGURED'
  status = 503
}

export function validatePassword(password, { phone = '' } = {}) {
  const normalizedPhone = normalizePhone(phone)
  const normalizedPassword = typeof password === 'string' ? password.toLowerCase() : ''
  const passwordDigits = typeof password === 'string' ? password.replace(/\D/g, '') : ''
  const phoneDistance = normalizedPhone && passwordDigits.length >= 8 ? levenshteinDistance(passwordDigits, normalizedPhone) : Number.POSITIVE_INFINITY
  const phoneLike = Boolean(normalizedPhone && passwordDigits.length >= 5 && (normalizedPhone.includes(passwordDigits) || passwordDigits.includes(normalizedPhone) || phoneDistance <= 1))
  if (typeof password !== 'string' || password.length < 5 || password.length > 64 || /^(.)(\1)+$/.test(password) || WEAK_PASSWORDS.has(normalizedPassword) || phoneLike) throw new PasswordPolicyError(PASSWORD_POLICY_MESSAGE)
  return true
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]
    previous[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[right.length]
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES)
  const derived = await scryptAsync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM })
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`
}

function parseHash(encoded) {
  const [algorithm, params, salt, digest] = String(encoded || '').split('$')
  if (algorithm !== 'scrypt' || !params || !salt || !digest) return null
  const values = Object.fromEntries(params.split(',').map((item) => item.split('=')))
  const N = Number(values.N)
  const r = Number(values.r)
  const p = Number(values.p)
  if (![N, r, p].every(Number.isSafeInteger) || N < 16_384 || r < 1 || p < 1) return null
  return { N, r, p, salt: Buffer.from(salt, 'base64url'), digest: Buffer.from(digest, 'base64url') }
}

export async function verifyPassword(password, encodedHash) {
  const parsed = parseHash(encodedHash) || parseHash(DUMMY_HASH)
  const derived = await scryptAsync(String(password || ''), parsed.salt, parsed.digest.length || KEY_LENGTH, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: MAXMEM })
  const actual = Buffer.from(derived)
  return actual.length === parsed.digest.length && crypto.timingSafeEqual(actual, parsed.digest) && Boolean(parseHash(encodedHash))
}

function credential(row) {
  const f = row.fields || {}
  return {
    id: text(read('authCredentials', f, 'credential_id')) || row.record_id,
    staffId: text(read('authCredentials', f, 'staff_id')),
    loginPhone: normalizePhone(read('authCredentials', f, 'login_phone')),
    passwordHash: text(read('authCredentials', f, 'password_hash')),
    passwordAlgorithm: text(read('authCredentials', f, 'password_algorithm')) || 'scrypt',
    mustChangePassword: bool(read('authCredentials', f, 'must_change_password')),
    passwordChangedAt: text(read('authCredentials', f, 'password_changed_at')) || null,
    authVersion: Number(read('authCredentials', f, 'auth_version') || 0),
    credentialStatus: text(read('authCredentials', f, 'credential_status')) || 'ACTIVE',
    createdAt: text(read('authCredentials', f, 'created_at')) || null,
    updatedAt: text(read('authCredentials', f, 'updated_at')) || null,
    lastLoginAt: text(read('authCredentials', f, 'last_login_at')) || null,
    _recordId: row.record_id,
  }
}

function assertTable(tableId) {
  if (!tableId) throw new AuthCredentialStoreNotConfiguredError('生产密码凭据表尚未配置')
}

export class FeishuAuthCredentialRepository {
  constructor(tableId = config.feishu.tables.authCredentials) { this.tableId = tableId }
  assertConfigured() { assertTable(this.tableId) }
  async list() { this.assertConfigured(); return (await listRecords(this.tableId)).map(credential) }
  async findByPhone(phone) { if (!this.tableId) return null; return (await this.list()).find((item) => item.loginPhone === normalizePhone(phone)) }
  async findByStaffId(staffId) { if (!this.tableId) return null; return (await this.list()).find((item) => item.staffId === staffId) }
  async create(input) {
    this.assertConfigured()
    const existing = await this.list()
    if (existing.some((item) => item.staffId === input.staffId || item.loginPhone === normalizePhone(input.loginPhone))) throw Object.assign(new Error('Auth credential identity conflict'), { code: 'AUTH_CREDENTIAL_CONFLICT', status: 409 })
    const values = { credential_id: input.credentialId || `cred-${crypto.randomUUID()}`, staff_id: input.staffId, login_phone: normalizePhone(input.loginPhone), password_hash: input.passwordHash, password_algorithm: input.passwordAlgorithm || 'scrypt', must_change_password: input.mustChangePassword === true, auth_version: input.authVersion || 1, credential_status: input.credentialStatus || 'ACTIVE', password_changed_at: input.passwordChangedAt || null, created_at: input.createdAt || now(), updated_at: input.updatedAt || now(), last_login_at: input.lastLoginAt || null }
    const result = await createRecord(this.tableId, fields('authCredentials', values))
    return { ...input, id: result?.record?.record_id || result?.record_id || values.credential_id, ...values, loginPhone: values.login_phone, staffId: values.staff_id, passwordHash: values.password_hash, authVersion: values.auth_version, mustChangePassword: values.must_change_password, _recordId: result?.record?.record_id || result?.record_id }
  }
  async update(credentialRecord, patch) {
    this.assertConfigured()
    const values = {}
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) values[key] = value
    values.updated_at ??= now()
    await updateRecord(this.tableId, credentialRecord._recordId, fields('authCredentials', values))
    return { ...credentialRecord, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value])) }
  }
  async updateByStaffId(staffId, patch) {
    const current = await this.findByStaffId(staffId)
    if (!current) return null
    return this.update(current, patch)
  }
  async createCredential(input) { return this.create(input) }
  async updatePassword(credentialRecord, passwordHash, patch = {}) { return this.update(credentialRecord, { password_hash: passwordHash, ...patch }) }
  async updateLoginPhone(staffId, loginPhone) { return this.updateByStaffId(staffId, { login_phone: normalizePhone(loginPhone) }) }
  async disableCredential(staffId) { return this.updateByStaffId(staffId, { credential_status: 'DISABLED', auth_version: ((await this.findByStaffId(staffId))?.authVersion || 0) + 1 }) }
  async recordSuccessfulLogin(staffId) { return this.updateByStaffId(staffId, { last_login_at: now() }) }
}

export class MemoryAuthCredentialRepository {
  constructor(records = []) { this.records = records.map((record) => ({ ...record })) }
  async findByPhone(phone) { return this.records.find((item) => item.loginPhone === normalizePhone(phone)) }
  async findByStaffId(staffId) { return this.records.find((item) => item.staffId === staffId) }
  async create(input) { if (this.records.some((item) => item.staffId === input.staffId || item.loginPhone === normalizePhone(input.loginPhone))) throw Object.assign(new Error('Auth credential identity conflict'), { code: 'AUTH_CREDENTIAL_CONFLICT', status: 409 }); const record = { id: input.credentialId || `cred-${this.records.length + 1}`, credentialStatus: input.credentialStatus || 'ACTIVE', authVersion: input.authVersion || 1, ...input, _recordId: input.credentialId || `cred-${this.records.length + 1}` }; this.records.push(record); return record }
  async update(record, patch) { Object.assign(record, Object.fromEntries(Object.entries(patch).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]))); return record }
  async updateByStaffId(staffId, patch) { const record = await this.findByStaffId(staffId); return record ? this.update(record, patch) : null }
  async createCredential(input) { return this.create(input) }
  async updatePassword(record, passwordHash, patch = {}) { return this.update(record, { password_hash: passwordHash, ...patch }) }
  async updateLoginPhone(staffId, loginPhone) { return this.updateByStaffId(staffId, { login_phone: normalizePhone(loginPhone) }) }
  async disableCredential(staffId) { const record = await this.findByStaffId(staffId); return record ? this.update(record, { credential_status: 'DISABLED', auth_version: Number(record.authVersion || 0) + 1 }) : null }
  async recordSuccessfulLogin(staffId) { return this.updateByStaffId(staffId, { last_login_at: now() }) }
}

export const dummyPasswordHash = DUMMY_HASH
