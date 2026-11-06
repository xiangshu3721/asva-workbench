import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from './config.mjs'

const { createRecordMock, deleteRecordMock } = vi.hoisted(() => ({
  createRecordMock: vi.fn(),
  deleteRecordMock: vi.fn(),
}))

vi.mock('./feishu.mjs', async () => {
  const actual = await vi.importActual('./feishu.mjs')
  return { ...actual, createRecord: createRecordMock, deleteRecord: deleteRecordMock }
})

const { FeishuRepository } = await import('./repository.mjs')
const { MemoryAuthCredentialRepository } = await import('./password-auth.mjs')

const admin = { id: 'admin-1', name: '管理员', role: 'ADMIN', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }
const baseDatabase = () => ({ staff: [admin], customers: [], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [], sourceRecords: [], evidenceItems: [], profileUpdateProposals: [], evidenceConflicts: [], _rows: {} })
const validInput = { name: '测试导师', phone: '13900000001', initialPassword: 'Aa123456789!' }

function setup({ database = baseDatabase(), authRepository = new MemoryAuthCredentialRepository(), load = null } = {}) {
  const repository = new FeishuRepository({ authRepository })
  repository.load = load || (async () => database)
  return { repository, database, authRepository }
}

beforeEach(() => {
  createRecordMock.mockReset()
  deleteRecordMock.mockReset().mockResolvedValue({})
  createRecordMock.mockResolvedValue({ record: { record_id: 'rec-created' } })
})

describe('reliable mentor creation', () => {
  it('returns committed success without requiring a post-write full readback', async () => {
    const { repository } = setup()
    let loads = 0
    repository.load = async () => { loads += 1; return baseDatabase() }

    const result = await repository.createMentor(admin.id, validInput)

    expect(result).toMatchObject({ name: validInput.name, phone: validInput.phone, accountCreateCommitted: true, createOutcome: 'CREATED', initialPassword: validInput.initialPassword })
    expect(loads).toBe(1)
    expect(createRecordMock).toHaveBeenCalledTimes(1)
    expect(createRecordMock.mock.calls[0][2]).toMatchObject({ operationId: expect.stringMatching(/^M-/), idempotency: { field: '手机号', value: validInput.phone } })
  })

  it('serializes duplicate clicks and returns already-exists on the second request', async () => {
    const database = baseDatabase()
    const authRepository = new MemoryAuthCredentialRepository()
    const { repository } = setup({ database, authRepository })
    createRecordMock.mockImplementation(async (_table, fields) => {
      if (fields['人员ID'] && !fields['凭据ID']) database.staff.push({ id: fields['人员ID'], name: fields['人员昵称'], permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: fields['手机号'] })
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { record: { record_id: 'rec-created' } }
    })

    const results = await Promise.allSettled([repository.createMentor(admin.id, validInput), repository.createMentor(admin.id, validInput)])

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((item) => item.status === 'rejected')?.reason).toMatchObject({ code: 'ACCOUNT_ALREADY_EXISTS', status: 409 })
    expect(database.staff.filter((item) => item.permissionRole === 'MENTOR')).toHaveLength(1)
    expect(authRepository.records).toHaveLength(1)
  })

  it('reconciles a staff timeout after the provider has committed the row', async () => {
    const database = baseDatabase()
    const { repository } = setup({ database })
    let staffAttempts = 0
    createRecordMock.mockImplementation(async (_table, fields) => {
      if (fields['人员ID'] && !fields['凭据ID']) {
        staffAttempts += 1
        database.staff.push({ id: fields['人员ID'], name: fields['人员昵称'], permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: fields['手机号'] })
        throw Object.assign(new Error('timeout'), { retryable: true, code: 'FEISHU_TIMEOUT' })
      }
      return { record: { record_id: 'rec-auth' } }
    })

    await expect(repository.createMentor(admin.id, validInput)).resolves.toMatchObject({ accountCreateCommitted: true })
    expect(staffAttempts).toBe(1)
    expect(createRecordMock).toHaveBeenCalledTimes(1)
  })

  it('does not return a new password when an auth response times out after commit', async () => {
    const authRepository = new MemoryAuthCredentialRepository()
    const originalCreate = authRepository.createCredential.bind(authRepository)
    let authAttempts = 0
    authRepository.createCredential = async (input) => {
      authAttempts += 1
      const result = await originalCreate(input)
      if (authAttempts === 1) throw Object.assign(new Error('timeout'), { retryable: true, code: 'FEISHU_TIMEOUT' })
      return result
    }
    const { repository } = setup({ authRepository })

    await expect(repository.createMentor(admin.id, validInput)).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_EXISTS', status: 409 })
    expect(authAttempts).toBe(1)
    expect(authRepository.records).toHaveLength(1)
    expect(deleteRecordMock).not.toHaveBeenCalled()
  })

  it('does not create auth when staff persistence definitely fails', async () => {
    const authRepository = new MemoryAuthCredentialRepository()
    const { repository } = setup({ authRepository })
    createRecordMock.mockRejectedValue(Object.assign(new Error('validation'), { code: 'FEISHU_VALIDATION_ERROR', retryable: false }))

    await expect(repository.createMentor(admin.id, validInput)).rejects.toMatchObject({ code: 'FEISHU_VALIDATION_ERROR' })
    expect(authRepository.records).toHaveLength(0)
    expect(createRecordMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the staff row for safe credential recovery when auth persistence fails', async () => {
    const authRepository = new MemoryAuthCredentialRepository()
    authRepository.createCredential = async () => { throw Object.assign(new Error('auth unavailable'), { code: 'FEISHU_AUTH_ERROR', retryable: false }) }
    const { repository } = setup({ authRepository })

    await expect(repository.createMentor(admin.id, validInput)).rejects.toMatchObject({ code: 'PARTIAL_INCONSISTENT', status: 503 })
    expect(deleteRecordMock).not.toHaveBeenCalled()
  })

  it('classifies complete existing accounts without generating or writing a new account', async () => {
    const database = baseDatabase()
    database.staff.push({ id: 'mentor-existing', name: '已有导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: validInput.phone })
    const authRepository = new MemoryAuthCredentialRepository([{ staffId: 'mentor-existing', loginPhone: validInput.phone, credentialStatus: 'ACTIVE' }])
    const { repository } = setup({ database, authRepository })

    await expect(repository.createMentor(admin.id, validInput)).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_EXISTS', status: 409 })
    expect(createRecordMock).not.toHaveBeenCalled()
  })

  it('recovers a staff-only account without creating a second staff identity', async () => {
    const database = baseDatabase()
    database.staff.push({ id: 'mentor-partial', name: '异常导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: validInput.phone })
    const authRepository = new MemoryAuthCredentialRepository()
    const { repository } = setup({ database, authRepository })

    await expect(repository.createMentor(admin.id, validInput)).resolves.toMatchObject({ id: 'mentor-partial', accountCreateCommitted: true })
    expect(createRecordMock).not.toHaveBeenCalled()
    expect(authRepository.records).toHaveLength(1)
  })

  it('uses targeted staff searches instead of the 11-table load for account creation', async () => {
    const previousStaffTable = config.feishu.tables.staff
    config.feishu.tables.staff = 'tbl-staff'
    const archiveSearch = vi.fn(async (_table, filter) => {
      const value = filter?.conditions?.[0]?.value?.[0]
      return value === admin.id ? [{ record_id: 'rec-admin', fields: { '人员ID': admin.id, '姓名': admin.name, '权限角色': 'ADMIN', '账号状态': 'ACTIVE', '允许登录': true } }] : []
    })
    const repository = new FeishuRepository({ authRepository: new MemoryAuthCredentialRepository(), archiveSearch })
    createRecordMock.mockResolvedValue({ record: { record_id: 'rec-mentor' } })
    try {
      await expect(repository.createMentor(admin.id, validInput)).resolves.toMatchObject({ accountCreateCommitted: true })
      expect(archiveSearch).toHaveBeenCalledTimes(3)
      expect(archiveSearch.mock.calls.map((call) => call[1].conditions[0].field_name)).toEqual(expect.arrayContaining(['人员ID', '手机号', '登录手机号']))
    } finally {
      config.feishu.tables.staff = previousStaffTable
    }
  })

  it('reports account status without returning password material', async () => {
    const database = baseDatabase()
    database.staff.push({ id: 'mentor-status', name: '状态导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: validInput.phone })
    const authRepository = new MemoryAuthCredentialRepository([{ staffId: 'mentor-status', loginPhone: validInput.phone, credentialStatus: 'ACTIVE' }])
    const { repository } = setup({ database, authRepository })
    const status = await repository.mentorAccountStatus(admin.id, validInput.phone)
    expect(status).toMatchObject({ status: 'COMPLETED', phone: validInput.phone })
    expect(status).not.toHaveProperty('passwordHash')
  })

  it('simulates two independent instances and never returns the losing password', async () => {
    const databaseA = baseDatabase()
    const databaseB = baseDatabase()
    const staffRecords = new Map()
    const credentialRecords = new Map()
    const authRepository = {
      findByPhone: async (phone) => [...credentialRecords.values()].find((item) => item.loginPhone === phone) || null,
      findByStaffId: async (staffId) => credentialRecords.get(staffId) || null,
      createCredential: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        const existing = credentialRecords.get(input.staffId)
        if (existing) return { ...existing, idempotencyRecovered: true }
        const record = { ...input, loginPhone: input.loginPhone, credentialStatus: 'ACTIVE', staffId: input.staffId }
        credentialRecords.set(input.staffId, record)
        return record
      },
    }
    createRecordMock.mockImplementation(async (_table, fields) => {
      const staffId = fields['人员ID']
      const existing = staffRecords.get(staffId)
      if (existing) return { record: existing, idempotency_recovered: true }
      const record = { record_id: `rec-${staffId}` }
      staffRecords.set(staffId, record)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { record }
    })
    const first = setup({ database: databaseA, authRepository }).repository
    const second = setup({ database: databaseB, authRepository }).repository
    const results = await Promise.allSettled([first.createMentorLocked(admin.id, { ...validInput, initialPassword: 'Aa123456789!' }), second.createMentorLocked(admin.id, { ...validInput, initialPassword: 'Bb123456789!' })])
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((item) => item.status === 'rejected').map((item) => item.reason.code)).toEqual(['ACCOUNT_ALREADY_EXISTS'])
    expect(credentialRecords.size).toBe(1)
  })
})
