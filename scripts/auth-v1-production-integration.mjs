import crypto from 'node:crypto'
import { config } from '../server/config.mjs'
import { issueSession } from '../server/auth.mjs'
import { FeishuRepository } from '../server/repository.mjs'

const TARGET_PHONE = '15021512537'
const randomPassword = () => `ASVA-${crypto.randomBytes(24).toString('base64url')}`
const expectReject = async (label, task) => { try { await task(); return { label, result: 'FAIL' } } catch (error) { return { label, result: error?.code === 'AUTH_INVALID' ? 'PASS' : 'FAIL', code: error?.code } } }
const assert = (condition, message) => { if (!condition) throw new Error(message) }

assert(config.dataMode === 'production' && config.environment === 'production', 'Production environment required')
assert(config.authMode === 'PASSWORD', 'Run this integration test with process-local AUTH_MODE=PASSWORD; Production mode must remain unchanged')
assert(config.feishu.tables.authCredentials, 'FEISHU_AUTH_CREDENTIALS_TABLE_ID is not configured')

const repository = new FeishuRepository()
const database = await repository.load()
const admin = database.staff.find((item) => item.phone === TARGET_PHONE)
assert(admin?.permissionRole === 'ADMIN' && admin.status === 'ACTIVE' && admin.loginEnabled === true, 'Bootstrap Admin is not login eligible')
const existingAdminCredential = await repository.authRepository.findByStaffId(admin.id)
const rotateExisting = process.argv.includes('--rotate-existing')
assert(!existingAdminCredential || rotateExisting, 'Admin credential already exists; pass --rotate-existing only for the authorized test rotation')

const initialPassword = randomPassword()
await repository.setInitialPassword(admin.id, initialPassword, { mustChangePassword: true })
const created = await repository.authRepository.findByStaffId(admin.id)
assert(created?.staffId === admin.id && created.loginPhone === TARGET_PHONE, 'Admin credential readback identity mismatch')
assert(created.passwordHash && !created.passwordHash.includes(initialPassword) && created.passwordAlgorithm === 'scrypt', 'Admin credential hash readback failed')
assert(created.mustChangePassword === true && created.authVersion === (existingAdminCredential ? Number(existingAdminCredential.authVersion || 0) + 1 : 1) && created.credentialStatus === 'ACTIVE', 'Admin credential initial state mismatch')

const checks = []
const authenticated = await repository.authenticate(TARGET_PHONE, initialPassword, 'auth-v1-good-password')
checks.push({ label: 'correct_password', result: authenticated.id === admin.id ? 'PASS' : 'FAIL', mustChangePassword: authenticated.mustChangePassword === true })
checks.push(await expectReject('wrong_password', () => repository.authenticate(TARGET_PHONE, 'wrong-password-value', 'auth-v1-wrong-password')))
checks.push(await expectReject('fixed_888888', () => repository.authenticate(TARGET_PHONE, '888888', 'auth-v1-fixed-code')))
checks.push(await expectReject('unknown_phone', () => repository.authenticate('15021512000', initialPassword, 'auth-v1-unknown')))

const mentor = database.staff.find((item) => item.permissionRole === 'MENTOR' && item.status === 'ACTIVE')
assert(mentor, 'No active MENTOR available for auth rejection test')
const mentorOriginal = { name: mentor.name, phone: mentor.phone }
const mentorPassword = randomPassword()
await repository.resetPassword(admin.id, mentor.id, mentorPassword)
checks.push(await expectReject('mentor_login_disabled', () => repository.authenticate(mentor.phone, mentorPassword, 'auth-v1-mentor')))

const inactive = database.staff.find((item) => item.status === 'INACTIVE')
if (inactive) {
  const inactivePassword = randomPassword()
  await repository.resetPassword(admin.id, inactive.id, inactivePassword)
  checks.push(await expectReject('inactive_staff', () => repository.authenticate(inactive.phone, inactivePassword, 'auth-v1-inactive')))
  await repository.authRepository.disableCredential(inactive.id)
} else checks.push({ label: 'inactive_staff', result: 'BLOCKED_NO_INACTIVE_FIXTURE' })

const initialVersion = created.authVersion
const oldSession = issueSession(admin.id, initialVersion, 'PASSWORD')
const nextPassword = randomPassword()
await repository.changePassword(admin.id, initialPassword, nextPassword)
const changed = await repository.authRepository.findByStaffId(admin.id)
assert(changed.authVersion === initialVersion + 1 && changed.mustChangePassword === false, 'First password change state mismatch')
checks.push(await expectReject('old_password_after_change', () => repository.authenticate(TARGET_PHONE, initialPassword, 'auth-v1-old-after-change')))
const changedLogin = await repository.authenticate(TARGET_PHONE, nextPassword, 'auth-v1-new-after-change')
checks.push({ label: 'new_password_after_change', result: changedLogin.id === admin.id ? 'PASS' : 'FAIL' })
try { await repository.validateSession(admin.id, initialVersion, 'PASSWORD'); checks.push({ label: 'old_session_after_change', result: 'FAIL' }) } catch { checks.push({ label: 'old_session_after_change', result: 'PASS' }) }
assert(oldSession, 'Session issuance failed')

const syncPhone = `139${String(Date.now()).slice(-8)}`
await repository.updateMentor(admin.id, mentor.id, { name: mentorOriginal.name, phone: syncPhone })
const syncedCredential = await repository.authRepository.findByStaffId(mentor.id)
checks.push({ label: 'phone_sync', result: syncedCredential?.loginPhone === syncPhone ? 'PASS' : 'FAIL' })
await repository.updateMentor(admin.id, mentor.id, mentorOriginal)
await repository.authRepository.disableCredential(mentor.id)
checks.push({ label: 'credential_disable', result: (await repository.authRepository.findByStaffId(mentor.id))?.credentialStatus === 'DISABLED' ? 'PASS' : 'FAIL' })

const resetPassword = randomPassword()
await repository.resetPassword(admin.id, admin.id, resetPassword)
const reset = await repository.authRepository.findByStaffId(admin.id)
assert(reset.authVersion === initialVersion + 2 && reset.mustChangePassword === true && reset.credentialStatus === 'ACTIVE', 'Admin reset state mismatch')
checks.push(await expectReject('password_before_admin_reset', () => repository.authenticate(TARGET_PHONE, nextPassword, 'auth-v1-before-reset')))
const resetLogin = await repository.authenticate(TARGET_PHONE, resetPassword, 'auth-v1-reset-password')
checks.push({ label: 'temporary_password_after_reset', result: resetLogin.id === admin.id && resetLogin.mustChangePassword ? 'PASS' : 'FAIL' })
try { await repository.validateSession(admin.id, initialVersion + 1, 'PASSWORD'); checks.push({ label: 'old_session_after_reset', result: 'FAIL' }) } catch { checks.push({ label: 'old_session_after_reset', result: 'PASS' }) }

const result = {
  ok: checks.every((item) => item.result === 'PASS'),
  tableConfigured: true,
  adminCredentialCreated: !existingAdminCredential,
  adminCredentialRotated: Boolean(existingAdminCredential),
  adminInitialCredential: { staffId: admin.id, loginPhone: TARGET_PHONE, passwordHashPresent: true, passwordHashNotPlaintext: true, algorithm: created.passwordAlgorithm, mustChangePasswordAtCreate: created.mustChangePassword, authVersionAtCreate: created.authVersion },
  finalAdminCredential: { credentialStatus: reset.credentialStatus, mustChangePassword: reset.mustChangePassword, authVersion: reset.authVersion },
  checks,
}
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
