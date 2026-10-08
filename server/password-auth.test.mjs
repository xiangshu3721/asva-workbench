import { afterEach, describe, expect, it } from 'vitest'
import { config } from './config.mjs'
import { issueSession, verifySession } from './auth.mjs'
import { FeishuRepository } from './repository.mjs'
import { LoginRateLimiter } from './login-rate-limit.mjs'
import { MemoryAuthCredentialRepository, hashPassword, validatePassword, verifyPassword } from './password-auth.mjs'

const admin = { id: 'staff-admin-owner-001', name: '管理员', role: 'ADMIN', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true, phone: '15021512537' }
const mentor = { id: 'mentor-1', name: '导师', role: 'MENTOR', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: false, phone: '15021512539' }
const inactive = { id: 'staff-inactive', name: '停用', role: 'ADMIN', permissionRole: 'ADMIN', status: 'INACTIVE', loginEnabled: true, phone: '15021512538' }

function testRepository(authRepository) {
  const repository = new FeishuRepository({ authRepository })
  repository.load = async () => ({ staff: [admin, mentor, inactive], customers: [], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], _rows: { staff: [] } })
  return repository
}

const previous = { authMode: config.authMode, dataMode: config.dataMode, table: config.feishu.tables.authCredentials, secret: config.authSecret, adminCode: config.adminLoginCode }
afterEach(() => { Object.assign(config, { authMode: previous.authMode, dataMode: previous.dataMode, authSecret: previous.secret, adminLoginCode: previous.adminCode }); config.feishu.tables.authCredentials = previous.table })

describe('ASVA Authentication V1', () => {
  it('stores only a scrypt hash and verifies the password', async () => {
    const hash = await hashPassword('a-strong-personal-password')
    expect(hash).toMatch(/^scrypt\$/)
    expect(hash).not.toContain('a-strong-personal-password')
    expect(await verifyPassword('a-strong-personal-password', hash)).toBe(true)
    expect(await verifyPassword('wrong-password', hash)).toBe(false)
  })

  it('enforces the 5-64 policy and rejects weak or phone-like passwords', () => {
    expect(() => validatePassword('abcd')).toThrow('密码需为 5～64 位')
    expect(validatePassword('hello')).toBe(true)
    expect(validatePassword('aB3!'.repeat(16))).toBe(true)
    expect(() => validatePassword('aB3!'.repeat(16) + 'x')).toThrow('密码需为 5～64 位')
    for (const weak of ['12345', '123456', '88888', '888888', 'abcde', 'qwerty', 'admin', 'password']) expect(() => validatePassword(weak)).toThrow('密码需为 5～64 位')
    expect(() => validatePassword('15021512537', { phone: '15021512537' })).toThrow('密码需为 5～64 位')
    expect(() => validatePassword('15021abc', { phone: '15021512537' })).toThrow('密码需为 5～64 位')
    expect(validatePassword('a-better-personal-password')).toBe(true)
  })

  it('authenticates an active admin from an independent credential repository', async () => {
    config.authMode = 'PASSWORD'; config.dataMode = 'demo'; config.adminLoginCode = '888888'; config.feishu.tables.authCredentials = 'memory'
    const authRepository = new MemoryAuthCredentialRepository([{ staffId: admin.id, loginPhone: admin.phone, passwordHash: await hashPassword('a-strong-personal-password'), passwordAlgorithm: 'scrypt', mustChangePassword: true, authVersion: 0 }])
    const account = await testRepository(authRepository).authenticate(admin.phone, 'a-strong-personal-password', '127.0.0.1')
    expect(account.id).toBe(admin.id)
    expect(account.mustChangePassword).toBe(true)
    expect(account).not.toHaveProperty('passwordHash')
    await expect(testRepository(authRepository).authenticate(admin.phone, '888888', 'ip-no-code-fallback')).rejects.toMatchObject({ code: 'AUTH_INVALID', status: 401 })
  })

  it('uses one generic failure for unknown, inactive, mentor and wrong-password attempts', async () => {
    config.authMode = 'PASSWORD'; config.dataMode = 'demo'; config.feishu.tables.authCredentials = 'memory'
    const authRepository = new MemoryAuthCredentialRepository([
      { staffId: admin.id, loginPhone: admin.phone, passwordHash: await hashPassword('a-strong-personal-password'), authVersion: 0 },
      { staffId: mentor.id, loginPhone: mentor.phone, passwordHash: await hashPassword('a-strong-personal-password'), authVersion: 0 },
      { staffId: inactive.id, loginPhone: inactive.phone, passwordHash: await hashPassword('a-strong-personal-password'), authVersion: 0 },
    ])
    const repository = testRepository(authRepository)
    for (const [phone, password] of [[admin.phone, 'wrong-password'], ['15021512000', 'wrong-password'], [mentor.phone, 'a-strong-personal-password'], [inactive.phone, 'a-strong-personal-password']]) await expect(repository.authenticate(phone, password, `ip-${phone}`)).rejects.toMatchObject({ code: 'AUTH_INVALID', status: 401 })
  })

  it('blocks after five failures per phone and IP', () => {
    let clock = 0
    const limiter = new LoginRateLimiter({ now: () => clock })
    for (let attempt = 0; attempt < 5; attempt += 1) { expect(limiter.isBlocked('15021512537', '10.0.0.1')).toBe(false); limiter.recordFailure('15021512537', '10.0.0.1') }
    expect(limiter.isBlocked('15021512537', '10.0.0.1')).toBe(true)
    clock = 15 * 60 * 1000 + 1
    expect(limiter.isBlocked('15021512537', '10.0.0.1')).toBe(false)
  })

  it('increments auth_version on password change and invalidates an old session', async () => {
    config.authMode = 'PASSWORD'; config.dataMode = 'demo'; config.feishu.tables.authCredentials = 'memory'; config.authSecret = 'test-secret'
    const authRepository = new MemoryAuthCredentialRepository([{ staffId: admin.id, loginPhone: admin.phone, passwordHash: await hashPassword('a-strong-personal-password'), authVersion: 0, mustChangePassword: true }])
    const repository = testRepository(authRepository)
    const oldToken = issueSession(admin.id, 0, 'PASSWORD')
    expect(verifySession(oldToken).auth_version).toBe(0)
    await repository.changePassword(admin.id, 'a-strong-personal-password', 'another-strong-password')
    expect((await authRepository.findByStaffId(admin.id)).authVersion).toBe(1)
    await expect(repository.validateSession(admin.id, 0, 'PASSWORD')).rejects.toMatchObject({ code: 'AUTH_INVALID', status: 401 })
    await expect(repository.authenticate(admin.phone, 'a-strong-personal-password', 'ip-change')).rejects.toMatchObject({ code: 'AUTH_INVALID' })
    const next = await repository.authenticate(admin.phone, 'another-strong-password', 'ip-change')
    expect(next.authVersion).toBe(1)
    expect(verifySession(oldToken).auth_version).toBe(0)
  })

  it('rejects reusing the current password without changing the credential', async () => {
    config.authMode = 'PASSWORD'; config.dataMode = 'demo'; config.feishu.tables.authCredentials = 'memory'
    const passwordHash = await hashPassword('a-strong-personal-password')
    const authRepository = new MemoryAuthCredentialRepository([{ staffId: admin.id, loginPhone: admin.phone, passwordHash, authVersion: 0, mustChangePassword: true }])
    const repository = testRepository(authRepository)
    await expect(repository.changePassword(admin.id, '', 'a-strong-personal-password')).rejects.toMatchObject({ code: 'PASSWORD_REUSE_NOT_ALLOWED', status: 400 })
    expect((await authRepository.findByStaffId(admin.id)).passwordHash).toBe(passwordHash)
    expect((await authRepository.findByStaffId(admin.id)).authVersion).toBe(0)
    await expect(repository.changePassword(admin.id, 'a-strong-personal-password', 'a-strong-personal-password')).rejects.toMatchObject({ code: 'PASSWORD_REUSE_NOT_ALLOWED', status: 400 })
  })

  it('rejects reusing an admin-reset password on the required first change', async () => {
    config.authMode = 'PASSWORD'; config.dataMode = 'demo'; config.feishu.tables.authCredentials = 'memory'
    const authRepository = new MemoryAuthCredentialRepository([{ staffId: admin.id, loginPhone: admin.phone, passwordHash: await hashPassword('a-strong-personal-password'), authVersion: 0 }])
    const repository = testRepository(authRepository)
    await repository.resetPassword(admin.id, admin.id, 'reset-strong-password')
    await expect(repository.changePassword(admin.id, '', 'reset-strong-password')).rejects.toMatchObject({ code: 'PASSWORD_REUSE_NOT_ALLOWED', status: 400 })
    expect((await authRepository.findByStaffId(admin.id)).mustChangePassword).toBe(true)
  })

  it('resets a password with must_change_password and increments the version', async () => {
    config.authMode = 'PASSWORD'; config.dataMode = 'demo'; config.feishu.tables.authCredentials = 'memory'
    const authRepository = new MemoryAuthCredentialRepository([{ staffId: admin.id, loginPhone: admin.phone, passwordHash: await hashPassword('a-strong-personal-password'), authVersion: 0 }])
    const result = await testRepository(authRepository).resetPassword(admin.id, admin.id, 'reset-strong-password')
    expect(result).toMatchObject({ ok: true, mustChangePassword: true, authVersion: 1 })
    expect((await authRepository.findByStaffId(admin.id)).mustChangePassword).toBe(true)
  })
})
