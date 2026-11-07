import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { list, search } = vi.hoisted(() => ({ list: vi.fn(), search: vi.fn() }))
vi.mock('./feishu.mjs', async () => ({ ...await vi.importActual('./feishu.mjs'), listRecords: list, searchRecords: search }))
const { config } = await import('./config.mjs')
const { FeishuRepository } = await import('./repository.mjs')
const { FeishuAuthCredentialRepository, hashPassword } = await import('./password-auth.mjs')
const saved = { authMode: config.authMode, dataMode: config.dataMode, table: config.feishu.tables.authCredentials }
let hash
beforeEach(async () => {
  config.authMode = 'PASSWORD'; config.dataMode = 'demo'; config.feishu.tables.authCredentials = 'isolated-auth'
  hash = await hashPassword('Isolated-Password-8472!')
  list.mockReset(); search.mockReset()
})
afterEach(() => { config.authMode = saved.authMode; config.dataMode = saved.dataMode; config.feishu.tables.authCredentials = saved.table; vi.restoreAllMocks() })
function setup({ role = 'ADMIN', rich = true, status = 'ACTIVE', duplicate = false } = {}) {
  const wrap = v => rich ? [{ type: 'text', text: v }] : v
  const fields = { '凭据ID': wrap('credential-1'), '人员ID': wrap('staff-1'), '登录手机号': '13900000123', '密码哈希': rich ? [{ type: 'text', text: hash.slice(0, 20) }, { type: 'text', text: hash.slice(20) }] : hash, '凭据状态': 'ACTIVE', '认证版本': 1 }
  list.mockResolvedValue([{ record_id: 'credential-record-1', fields }]); search.mockResolvedValue([{ record_id: 'credential-record-1', fields }])
  const auth = new FeishuAuthCredentialRepository('isolated-auth')
  const staff = { id: 'staff-1', phone: '13900000123', permissionRole: role, status, loginEnabled: true, _recordId: 'staff-record-1' }
  const repo = new FeishuRepository({ authRepository: auth })
  repo.loadStaffRecords = async () => duplicate ? [staff, { ...staff, _recordId: 'staff-record-2' }] : [staff]
  return { repo, auth }
}
describe('production login field-shape regression', () => {
  it.each(['ADMIN', 'MENTOR'])('accepts correct %s credentials encoded as search text segments', async role => {
    const { repo, auth } = setup({ role }); vi.spyOn(auth, 'recordSuccessfulLogin').mockResolvedValue(null)
    const result = await repo.authenticate('139 0000-0123', 'Isolated-Password-8472!', `correct-${role}`)
    expect(result.id).toBe('staff-1'); expect(result).not.toHaveProperty('passwordHash')
  })
  it('preserves scalar list response decoding', async () => {
    const { auth } = setup({ rich: false }); const value = await auth.findByPhone('13900000123')
    expect(value.staffId).toBe('staff-1'); expect(value.passwordHash === hash).toBe(true)
  })
  it('rejects wrong passwords without a login metadata write', async () => {
    const { repo, auth } = setup(); const write = vi.spyOn(auth, 'recordSuccessfulLogin')
    await expect(repo.authenticate('13900000123', 'Wrong-password!', 'wrong-password')).rejects.toMatchObject({ code: 'AUTH_INVALID' }); expect(write).not.toHaveBeenCalled()
  })
  it('rejects disabled staff', async () => {
    const { repo, auth } = setup({ status: 'INACTIVE' }); const write = vi.spyOn(auth, 'recordSuccessfulLogin')
    await expect(repo.authenticate('13900000123', 'Isolated-Password-8472!', 'inactive')).rejects.toMatchObject({ code: 'AUTH_INVALID' }); expect(write).not.toHaveBeenCalled()
  })
  it('returns authenticated identity even when metadata update rejects, with safe diagnostics', async () => {
    const { repo, auth } = setup({ rich: false }); vi.spyOn(auth, 'recordSuccessfulLogin').mockRejectedValue(new Error('do not log this secret'))
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(repo.authenticate('13900000123', 'Isolated-Password-8472!', 'write-failure')).resolves.toMatchObject({ id: 'staff-1' })
    await new Promise(resolve => setImmediate(resolve))
    expect(log).toHaveBeenCalledWith('[ASVA_AUTH_LOGIN_METADATA]', JSON.stringify({ lastLoginWriteSucceeded: false, failureStage: 'LAST_LOGIN_WRITE' }))
  })
  it('does not wait for a hanging metadata write', async () => {
    const { repo, auth } = setup({ rich: false }); vi.spyOn(auth, 'recordSuccessfulLogin').mockImplementation(() => new Promise(() => {}))
    let timer
    try { const result = await Promise.race([repo.authenticate('13900000123', 'Isolated-Password-8472!', 'hanging-write'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('metadata blocked login')), 1500) })]); expect(result.id).toBe('staff-1') } finally { clearTimeout(timer) }
  })
  it('same-identity duplicate staff keeps the unique credential association', async () => {
    const { repo, auth } = setup({ role: 'MENTOR', duplicate: true }); vi.spyOn(auth, 'recordSuccessfulLogin').mockResolvedValue(null)
    await expect(repo.authenticate('13900000123', 'Isolated-Password-8472!', 'duplicate-staff')).resolves.toMatchObject({ id: 'staff-1' })
  })
  it('rejects duplicate credentials instead of selecting the first one', async () => {
    const { repo, auth } = setup({ rich: false }); vi.spyOn(auth, 'findAllByPhone').mockResolvedValue([
      { staffId: 'staff-1', loginPhone: '13900000123', passwordHash: hash, credentialStatus: 'ACTIVE', authVersion: 1 },
      { staffId: 'staff-1', loginPhone: '13900000123', passwordHash: hash, credentialStatus: 'ACTIVE', authVersion: 2 },
    ])
    await expect(repo.authenticate('13900000123', 'Isolated-Password-8472!', 'duplicate-credential')).rejects.toMatchObject({ code: 'AUTH_INVALID' })
  })
  it('rejects conflicting staff identities instead of selecting the first one', async () => {
    const { repo, auth } = setup({ rich: false }); repo.loadStaffRecords = async () => [
      { id: 'staff-1', phone: '13900000123', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true },
      { id: 'staff-2', phone: '13900000123', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true },
    ]; vi.spyOn(auth, 'recordSuccessfulLogin').mockResolvedValue(null)
    await expect(repo.authenticate('13900000123', 'Isolated-Password-8472!', 'conflicting-staff')).rejects.toMatchObject({ code: 'AUTH_INVALID' })
  })
})
