import { config } from '../server/config.mjs'
import { FeishuRepository } from '../server/repository.mjs'
import { FeishuAuthCredentialRepository } from '../server/password-auth.mjs'

const mask = (value) => { const text = String(value || ''); return text.length > 7 ? `${text.slice(0, 3)}****${text.slice(-4)}` : 'masked' }
const result = { ok: true, tableConfigured: Boolean(config.feishu.tables.authCredentials), credentialCount: 0, activeCredentialCount: 0, anomalies: [] }
if (!config.feishu.tables.authCredentials) {
  result.ok = false
  result.anomalies.push({ type: 'AUTH_CREDENTIAL_TABLE_NOT_CONFIGURED' })
} else {
  const authRepository = new FeishuAuthCredentialRepository()
  const [credentials, database] = await Promise.all([authRepository.list(), new FeishuRepository({ authRepository }).load()])
  result.credentialCount = credentials.length
  result.activeCredentialCount = credentials.filter((item) => item.credentialStatus === 'ACTIVE').length
  const staffById = new Map(database.staff.map((item) => [item.id, item]))
  const active = credentials.filter((item) => item.credentialStatus === 'ACTIVE')
  const duplicate = (values, type) => { const seen = new Set(); for (const value of values) { if (seen.has(value)) result.anomalies.push({ type, value: type.includes('PHONE') ? mask(value) : 'duplicate' }); seen.add(value) } }
  duplicate(active.map((item) => item.staffId), 'DUPLICATE_ACTIVE_STAFF_ID')
  duplicate(active.map((item) => item.loginPhone), 'DUPLICATE_ACTIVE_LOGIN_PHONE')
  for (const item of credentials) {
    const staff = staffById.get(item.staffId)
    if (!staff) result.anomalies.push({ type: 'CREDENTIAL_WITHOUT_STAFF' })
    if (!item.passwordHash || !item.passwordHash.startsWith('scrypt$')) result.anomalies.push({ type: 'MISSING_OR_INVALID_PASSWORD_HASH' })
    if (item.passwordAlgorithm !== 'scrypt') result.anomalies.push({ type: 'UNKNOWN_PASSWORD_ALGORITHM' })
    if (!Number.isInteger(item.authVersion) || item.authVersion < 1) result.anomalies.push({ type: 'INVALID_AUTH_VERSION' })
    if (!['ACTIVE', 'DISABLED'].includes(item.credentialStatus)) result.anomalies.push({ type: 'UNKNOWN_CREDENTIAL_STATUS' })
    if (item.credentialStatus === 'ACTIVE' && staff && (staff.status !== 'ACTIVE' || staff.loginEnabled !== true)) result.anomalies.push({ type: 'ACTIVE_CREDENTIAL_FOR_UNAVAILABLE_STAFF' })
  }
  result.ok = result.anomalies.length === 0
}
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
