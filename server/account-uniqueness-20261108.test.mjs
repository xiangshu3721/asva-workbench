import { describe, expect, it, vi } from 'vitest'
import { MemoryAuthCredentialRepository } from './password-auth.mjs'
import { FeishuRepository } from './repository.mjs'
import { config } from './config.mjs'

const admin = { id: 'admin-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true, phone: '13800000001', loginPhone: '13800000001', _recordId: 'admin-row' }
const mentor = { id: 'mentor-1', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true, phone: '13900000001', loginPhone: '13900000001', _recordId: 'mentor-row' }

describe('account uniqueness protections', () => {
  it('rejects ambiguous credentials instead of selecting the first record', async () => {
    const auth = new MemoryAuthCredentialRepository([
      { id: 'cred-1', _recordId: 'cred-row-1', staffId: 'mentor-1', loginPhone: '13900000001', credentialStatus: 'ACTIVE' },
      { id: 'cred-2', _recordId: 'cred-row-2', staffId: 'mentor-1', loginPhone: '13900000001', credentialStatus: 'ACTIVE' },
    ])
    await expect(auth.findByPhone('13900000001')).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT', status: 409 })
    await expect(auth.findByStaffId('mentor-1')).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT', status: 409 })
  })

  it('rejects management writes when one business staff id has duplicate physical rows', async () => {
    const repository = new FeishuRepository({ authRepository: new MemoryAuthCredentialRepository([]) })
    repository.load = vi.fn().mockResolvedValue({
      staff: [admin, { ...mentor }, { ...mentor, _recordId: 'mentor-row-2', name: '另一个物理记录' }],
      _rows: { staff: [{ record_id: 'mentor-row' }, { record_id: 'mentor-row-2' }] },
      appointments: [],
    })
    await expect(repository.updateMentor('admin-1', 'mentor-1', { name: '导师', phone: '13900000001' })).rejects.toMatchObject({ code: 'ACCOUNT_INCONSISTENT', status: 409 })
    await expect(repository.deactivateMentor('admin-1', 'mentor-1')).rejects.toMatchObject({ code: 'ACCOUNT_INCONSISTENT', status: 409 })
  })

  it('does not create a mentor credential over an existing admin identity', async () => {
    const repository = new FeishuRepository({ authRepository: new MemoryAuthCredentialRepository([]) })
    repository.loadMentorCreateContext = vi.fn().mockResolvedValue({ actor: admin, duplicateStaff: [{ ...admin, phone: '13900000001', loginPhone: '13900000001' }] })
    await expect(repository.createMentor('admin-1', { name: '新导师', phone: '13900000001' })).rejects.toMatchObject({ code: 'ACCOUNT_INCONSISTENT', status: 409 })
  })

  it('reports duplicate and pending account states without guessing', async () => {
    const repository = new FeishuRepository({ authRepository: new MemoryAuthCredentialRepository([]) })
    repository.loadMentorCreateContext = vi.fn().mockResolvedValue({ actor: admin, duplicateStaff: [mentor, { ...mentor, _recordId: 'mentor-row-2' }] })
    await expect(repository.mentorAccountStatus('admin-1', '13900000001')).resolves.toMatchObject({ status: 'DUPLICATE', mentorCount: 2 })

    const unavailable = { findAllByPhone: vi.fn().mockRejectedValue(new Error('read timeout')), findAllByStaffId: vi.fn().mockRejectedValue(new Error('read timeout')) }
    const pendingRepository = new FeishuRepository({ authRepository: unavailable })
    pendingRepository.loadMentorCreateContext = vi.fn().mockResolvedValue({ actor: admin, duplicateStaff: [mentor] })
    await expect(pendingRepository.mentorAccountStatus('admin-1', '13900000001')).resolves.toMatchObject({ status: 'PENDING' })
  })

  it('allows session and safe reads for identical duplicate Staff rows, but rejects identity conflicts', async () => {
    const previousAuthMode = config.authMode
    config.authMode = 'PASSWORD'
    const auth = new MemoryAuthCredentialRepository([{ id: 'cred-1', _recordId: 'cred-row-1', staffId: 'mentor-1', loginPhone: '13900000001', credentialStatus: 'ACTIVE', authVersion: 3 }])
    const repository = new FeishuRepository({ authRepository: auth })
    repository.loadStaffRecords = vi.fn().mockResolvedValue([{ ...mentor }, { ...mentor, _recordId: 'mentor-row-2' }])
    await expect(repository.validateSession('mentor-1', 3, 'PASSWORD')).resolves.toMatchObject({ account: { id: 'mentor-1' }, credential: { staffId: 'mentor-1' } })
    repository.loadStaffRecords = vi.fn().mockResolvedValue([{ ...mentor }, { ...mentor, _recordId: 'mentor-row-2', loginPhone: '13900000002' }])
    await expect(repository.validateSession('mentor-1', 3, 'PASSWORD')).rejects.toMatchObject({ code: 'ACCOUNT_INCONSISTENT', status: 409 })
    config.authMode = previousAuthMode
  })
})
