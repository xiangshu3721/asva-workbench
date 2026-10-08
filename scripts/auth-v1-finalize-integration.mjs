import crypto from 'node:crypto'
import { config } from '../server/config.mjs'
import { issueSession } from '../server/auth.mjs'
import { FeishuRepository } from '../server/repository.mjs'

const TARGET_PHONE = '15021512537'
const randomPassword = () => `ASVA-${crypto.randomBytes(24).toString('base64url')}`
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const rejected = async (task) => {
  try { await task(); return false } catch (error) { return error?.code === 'AUTH_INVALID' }
}

assert(config.dataMode === 'production' && config.environment === 'production', 'Production environment required')
assert(config.authMode === 'PASSWORD', 'Run with process-local AUTH_MODE=PASSWORD; CloudBase Production remains unchanged')
assert(config.feishu.tables.authCredentials, 'Auth credential table is not configured')

const repository = new FeishuRepository()
let database = await repository.load()
const admin = database.staff.find((item) => item.phone === TARGET_PHONE)
assert(admin?.permissionRole === 'ADMIN' && admin.status === 'ACTIVE' && admin.loginEnabled === true, 'Bootstrap Admin is not login eligible')

// Remove only temporary/non-login-eligible credentials created by the prior integration run.
for (const credential of await repository.authRepository.list()) {
  const staff = database.staff.find((item) => item.id === credential.staffId)
  if (!staff || staff.permissionRole !== 'ADMIN' || staff.status !== 'ACTIVE' || staff.loginEnabled !== true) {
    if (credential.credentialStatus !== 'DISABLED') await repository.authRepository.disableCredential(credential.staffId)
  }
}

const checks = []
const initialPassword = randomPassword()
await repository.setInitialPassword(admin.id, initialPassword, { mustChangePassword: true })
let adminCredential = await repository.authRepository.findByStaffId(admin.id)
assert(adminCredential?.credentialStatus === 'ACTIVE' && adminCredential.mustChangePassword === true, 'Admin initial password state mismatch')
const initialVersion = adminCredential.authVersion

const login = await repository.authenticate(TARGET_PHONE, initialPassword, 'auth-v1-final-good')
checks.push({ label: 'correct_password', result: login.id === admin.id && login.mustChangePassword ? 'PASS' : 'FAIL' })
checks.push({ label: 'wrong_password', result: await rejected(() => repository.authenticate(TARGET_PHONE, 'wrong-password-value', 'auth-v1-final-wrong')) ? 'PASS' : 'FAIL' })
checks.push({ label: 'fixed_888888', result: await rejected(() => repository.authenticate(TARGET_PHONE, '888888', 'auth-v1-final-fixed')) ? 'PASS' : 'FAIL' })
checks.push({ label: 'unknown_phone', result: await rejected(() => repository.authenticate('15021512000', initialPassword, 'auth-v1-final-unknown')) ? 'PASS' : 'FAIL' })

database = await repository.load()
const mentor = database.staff.find((item) => item.permissionRole === 'MENTOR' && item.status === 'ACTIVE')
assert(mentor, 'No active MENTOR available for rejection test')
const mentorOriginal = { name: mentor.name, phone: mentor.phone }
const mentorPassword = randomPassword()
await repository.resetPassword(admin.id, mentor.id, mentorPassword)
checks.push({ label: 'mentor_login_disabled', result: await rejected(() => repository.authenticate(mentor.phone, mentorPassword, 'auth-v1-final-mentor')) ? 'PASS' : 'FAIL' })

const syncPhone = `139${String(Date.now()).slice(-8)}`
await repository.updateMentor(admin.id, mentor.id, { name: mentorOriginal.name, phone: syncPhone })
const synced = await repository.authRepository.findByStaffId(mentor.id)
checks.push({ label: 'phone_sync', result: synced?.loginPhone === syncPhone ? 'PASS' : 'FAIL' })
await repository.updateMentor(admin.id, mentor.id, mentorOriginal)
await repository.authRepository.disableCredential(mentor.id)
checks.push({ label: 'mentor_credential_disabled', result: (await repository.authRepository.findByStaffId(mentor.id))?.credentialStatus === 'DISABLED' ? 'PASS' : 'FAIL' })

const inactive = database.staff.find((item) => item.status === 'INACTIVE')
if (inactive) {
  const inactivePassword = randomPassword()
  await repository.resetPassword(admin.id, inactive.id, inactivePassword)
  checks.push({ label: 'inactive_staff', result: await rejected(() => repository.authenticate(inactive.phone, inactivePassword, 'auth-v1-final-inactive')) ? 'PASS' : 'FAIL' })
  await repository.authRepository.disableCredential(inactive.id)
} else checks.push({ label: 'inactive_staff', result: 'BLOCKED_NO_INACTIVE_FIXTURE' })

const oldSession = issueSession(admin.id, initialVersion, 'PASSWORD')
const changedPassword = randomPassword()
await repository.changePassword(admin.id, initialPassword, changedPassword)
adminCredential = await repository.authRepository.findByStaffId(admin.id)
checks.push({ label: 'first_password_change', result: adminCredential.authVersion === initialVersion + 1 && adminCredential.mustChangePassword === false ? 'PASS' : 'FAIL' })
checks.push({ label: 'old_password_after_change', result: await rejected(() => repository.authenticate(TARGET_PHONE, initialPassword, 'auth-v1-final-old')) ? 'PASS' : 'FAIL' })
checks.push({ label: 'new_password_after_change', result: (await repository.authenticate(TARGET_PHONE, changedPassword, 'auth-v1-final-new')).id === admin.id ? 'PASS' : 'FAIL' })
try { await repository.validateSession(admin.id, initialVersion, 'PASSWORD'); checks.push({ label: 'old_session_after_change', result: 'FAIL' }) } catch { checks.push({ label: 'old_session_after_change', result: oldSession ? 'PASS' : 'FAIL' }) }

const resetPassword = randomPassword()
await repository.resetPassword(admin.id, admin.id, resetPassword)
adminCredential = await repository.authRepository.findByStaffId(admin.id)
checks.push({ label: 'admin_reset_state', result: adminCredential.mustChangePassword === true && adminCredential.credentialStatus === 'ACTIVE' ? 'PASS' : 'FAIL' })
checks.push({ label: 'password_before_admin_reset', result: await rejected(() => repository.authenticate(TARGET_PHONE, changedPassword, 'auth-v1-final-before-reset')) ? 'PASS' : 'FAIL' })
const resetLogin = await repository.authenticate(TARGET_PHONE, resetPassword, 'auth-v1-final-reset')
checks.push({ label: 'temporary_password_after_reset', result: resetLogin.id === admin.id && resetLogin.mustChangePassword ? 'PASS' : 'FAIL' })
try { await repository.validateSession(admin.id, adminCredential.authVersion - 1, 'PASSWORD'); checks.push({ label: 'old_session_after_reset', result: 'FAIL' }) } catch { checks.push({ label: 'old_session_after_reset', result: 'PASS' }) }

const result = {
  ok: checks.every((item) => item.result === 'PASS'),
  tableConfigured: true,
  adminStaffId: admin.id,
  adminCredential: { status: adminCredential.credentialStatus, mustChangePassword: adminCredential.mustChangePassword, authVersion: adminCredential.authVersion, passwordHashPresent: Boolean(adminCredential.passwordHash), algorithm: adminCredential.passwordAlgorithm },
  checks,
}
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
