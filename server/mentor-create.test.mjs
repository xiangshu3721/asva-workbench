import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('reconciles an auth timeout after the credential has been committed', async () => {
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

    await expect(repository.createMentor(admin.id, validInput)).resolves.toMatchObject({ accountCreateCommitted: true })
    expect(authAttempts).toBe(1)
    expect(authRepository.records).toHaveLength(1)
  })

  it('does not create auth when staff persistence definitely fails', async () => {
    const authRepository = new MemoryAuthCredentialRepository()
    const { repository } = setup({ authRepository })
    createRecordMock.mockRejectedValue(Object.assign(new Error('validation'), { code: 'FEISHU_VALIDATION_ERROR', retryable: false }))

    await expect(repository.createMentor(admin.id, validInput)).rejects.toMatchObject({ code: 'FEISHU_VALIDATION_ERROR' })
    expect(authRepository.records).toHaveLength(0)
    expect(createRecordMock).toHaveBeenCalledTimes(1)
  })

  it('does not claim success when auth persistence fails', async () => {
    const authRepository = new MemoryAuthCredentialRepository()
    authRepository.createCredential = async () => { throw Object.assign(new Error('auth unavailable'), { code: 'FEISHU_AUTH_ERROR', retryable: false }) }
    const { repository } = setup({ authRepository })

    await expect(repository.createMentor(admin.id, validInput)).rejects.toMatchObject({ code: 'FEISHU_AUTH_ERROR' })
    expect(deleteRecordMock).toHaveBeenCalledTimes(1)
  })

  it('classifies complete existing accounts without generating or writing a new account', async () => {
    const database = baseDatabase()
    database.staff.push({ id: 'mentor-existing', name: '已有导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: validInput.phone })
    const authRepository = new MemoryAuthCredentialRepository([{ staffId: 'mentor-existing', loginPhone: validInput.phone, credentialStatus: 'ACTIVE' }])
    const { repository } = setup({ database, authRepository })

    await expect(repository.createMentor(admin.id, validInput)).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_EXISTS', status: 409 })
    expect(createRecordMock).not.toHaveBeenCalled()
  })

  it('classifies a staff-only account as inconsistent instead of creating a second account', async () => {
    const database = baseDatabase()
    database.staff.push({ id: 'mentor-partial', name: '异常导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: validInput.phone })
    const { repository } = setup({ database })

    await expect(repository.createMentor(admin.id, validInput)).rejects.toMatchObject({ code: 'ACCOUNT_INCONSISTENT', status: 409 })
    expect(createRecordMock).not.toHaveBeenCalled()
  })
})
