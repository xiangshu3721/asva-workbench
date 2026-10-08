import { FeishuRepository } from '../server/repository.mjs'

const TARGET_PHONE = '15021512537'
const tableId = process.env.FEISHU_AUTH_CREDENTIALS_TABLE_ID
if (!tableId) throw new Error('FEISHU_AUTH_CREDENTIALS_TABLE_ID is required')

function hiddenQuestion(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    if (!input.isTTY || typeof input.setRawMode !== 'function') return reject(new Error('Interactive TTY required.'))
    let value = ''
    process.stdout.write(prompt)
    input.setRawMode(true)
    input.resume()
    const onData = (chunk) => {
      const char = chunk.toString()
      if (char === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return }
      if (char === '\r' || char === '\n') { cleanup(); process.stdout.write('\n'); resolve(value); return }
      if (char === '\u007f') { value = value.slice(0, -1); return }
      if (char >= ' ') value += char
    }
    const cleanup = () => { input.setRawMode(false); input.pause(); input.off('data', onData) }
    input.on('data', onData)
  })
}

const repository = new FeishuRepository()
const database = await repository.load()
const admin = database.staff.find((item) => item.phone === TARGET_PHONE)
const credential = admin ? await repository.authRepository.findByStaffId(admin.id) : null
const checks = {
  staffExists: Boolean(admin),
  staffEligible: Boolean(admin?.permissionRole === 'ADMIN' && admin.status === 'ACTIVE' && admin.loginEnabled === true),
  credentialExists: Boolean(credential),
  passwordHashPresent: Boolean(credential?.passwordHash),
  passwordHashEnvelopeValid: Boolean(credential?.passwordHash?.startsWith('scrypt$')),
  credentialStatusActive: credential?.credentialStatus === 'ACTIVE',
  authVersionValid: Number.isSafeInteger(credential?.authVersion) && credential.authVersion >= 1,
}
const password = await hiddenQuestion('Password to verify (hidden): ')
try {
  const authenticated = await repository.authenticate(TARGET_PHONE, password, 'bootstrap-admin-password-verification')
  checks.passwordVerify = authenticated.id === admin.id ? 'PASS' : 'FAIL'
} catch {
  checks.passwordVerify = 'FAIL'
}
try { await repository.authenticate(TARGET_PHONE, 'wrong-password-value', 'bootstrap-admin-wrong-password'); checks.wrongPasswordRejected = 'FAIL' } catch (error) { checks.wrongPasswordRejected = error?.code === 'AUTH_INVALID' ? 'PASS' : 'FAIL' }
try { await repository.authenticate(TARGET_PHONE, '888888', 'bootstrap-admin-fixed-code'); checks.fixed888888Rejected = 'FAIL' } catch (error) { checks.fixed888888Rejected = error?.code === 'AUTH_INVALID' ? 'PASS' : 'FAIL' }
console.log(JSON.stringify(checks, null, 2))
if (!Object.values(checks).every((value) => value === true || value === 'PASS')) process.exitCode = 1
