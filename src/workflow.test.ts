import { beforeEach, describe, expect, it } from 'vitest'
import { createLocalApi } from './api'
import { seedDatabase } from './data'
import type { FeedbackInput } from './domain'
import { createLocalRepository } from './repositories'

function setupStorage() {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } },
  })
}

beforeEach(() => setupStorage())

describe('V0.3 appointment workflow and permissions', () => {
  it('opens the demo as the default administrator account', () => {
    const api = createLocalApi(createLocalRepository())
    const account = api.login('15021512537', '888888')
    expect(account.id).toBe('staff-founder')
    expect(account.permissionRole).toBe('ADMIN')
    expect(account.loginEnabled).toBe(true)
    expect(() => api.login('15021512539', '888888')).toThrow('导师端暂未开放，请联系管理员。')
    expect(() => api.login('15021512537', '123456')).toThrow('手机号或验证码错误')
  })

  it('starts a new appointment in WAIT_ASSIGN and hides it from a mentor', () => {
    const api = createLocalApi(createLocalRepository())
    expect(api.dashboard('staff-admin').appointments.find((item) => item.id === 'A-20261004-01')?.status).toBe('WAIT_ASSIGN')
    expect(() => api.dashboard('mentor-zhang')).toThrow('导师端暂未开放，请联系管理员。')
  })

  it('moves WAIT_ASSIGN to WAIT_FOLLOW_UP only through ADMIN assignment', () => {
    const api = createLocalApi(createLocalRepository())
    api.assignAppointment('staff-admin', 'A-20261004-01', 'mentor-li')
    expect(api.dashboard('staff-admin').appointments.find((item) => item.id === 'A-20261004-01')?.status).toBe('WAIT_FOLLOW_UP')
    expect(() => api.assignAppointment('mentor-li', 'A-20261004-02', 'mentor-zhang')).toThrow('导师端暂未开放，请联系管理员。')
  })

  it('moves WAIT_FOLLOW_UP to WAIT_FEEDBACK through ADMIN operation', () => {
    const api = createLocalApi(createLocalRepository())
    expect(() => api.markFollowupDone('mentor-li', 'A-20261004-02')).toThrow('导师端暂未开放，请联系管理员。')
    api.markFollowupDone('staff-admin', 'A-20261004-02')
    expect(api.dashboard('staff-admin').appointments.find((item) => item.id === 'A-20261004-02')?.status).toBe('WAIT_FEEDBACK')
  })

  it('moves WAIT_FEEDBACK to COMPLETED only after feedback is saved', () => {
    const api = createLocalApi(createLocalRepository())
    const feedback: FeedbackInput = { appointmentId: 'A-20261003-07', topic: '确认行动后的变化', result: '需要继续关注', coreNeed: '希望把行动变成稳定习惯。', paid: true, grade: 'A', intendedCourse: '镜像技术', notes: '先保留本次沟通的行动记录。' }
    api.saveFeedback('staff-admin', feedback)
    const appointment = api.dashboard('staff-admin').appointments.find((item) => item.id === feedback.appointmentId)
    expect(appointment?.status).toBe('COMPLETED')
    expect(appointment?.followupInfoCompleted).toBe(true)
    expect(api.dashboard('staff-admin').sessions[0].operatorId).toBe('staff-admin')
    expect(api.dashboard('staff-admin').sessions[0].mentorId).toBe('mentor-li')
  })

  it('keeps a completed appointment when the same customer receives a new appointment', () => {
    const api = createLocalApi(createLocalRepository())
    const oldAppointmentId = 'A-20261002-11'
    const database = api.createAppointment({ customerId: 'C00001298', topic: '再次沟通', submittedAt: '刚刚', description: '客户再次提交预约。', expectation: '希望继续获得支持。', source: '解忧小屋', createdAt: '2026-10-04' })
    const newAppointment = database.appointments.find((item) => item.customerId === 'C00001298' && item.id !== oldAppointmentId && item.status === 'WAIT_ASSIGN')
    expect(newAppointment).toBeDefined()
    expect(database.appointments.find((item) => item.id === oldAppointmentId)?.status).toBe('COMPLETED')
  })

  it('creates a customer only after duplicate review and optionally creates a Case', () => {
    const api = createLocalApi(createLocalRepository())
    const preview = api.previewCustomer('staff-admin', { nickname: '林知微', phone: '13800001212', situation: '希望梳理职业方向。', needsFollowup: true })
    expect(preview.duplicates[0]?.matchedBy).toBe('nickname_exact')
    expect(() => api.createCustomer('staff-admin', { nickname: '林知微', phone: '13800001212', situation: '希望梳理职业方向。', needsFollowup: true })).toThrow('重复')
    const created = api.createCustomer('staff-admin', { nickname: '顾清弦', wechat: 'gqx-demo', situation: '最近在考虑换行业，希望有人帮我拆解下一步。', needsFollowup: true, mentorId: 'mentor-li', profileUpdates: [{ field: 'current_core_issue', value: '职业方向选择', source: 'AI_INFERENCE', confidence: 0.94 }] })
    const customer = created.customers.find((item) => item.name === '顾清弦')
    expect(customer?.source).toBe('管理员手动录入')
    expect(customer?.profileFields?.current_core_issue).toBe('职业方向选择')
    expect(created.appointments.some((item) => item.customerId === customer?.id && item.status === 'WAIT_FOLLOW_UP' && item.caseSource === 'ADMIN_MANUAL')).toBe(true)
    const archiveOnly = api.createCustomer('staff-admin', { nickname: '闻溪月', phone: '13900001234', situation: '先存档，暂时不安排跟进。', needsFollowup: false })
    const archiveCustomer = archiveOnly.customers.find((item) => item.name === '闻溪月')
    expect(archiveOnly.appointments.some((item) => item.customerId === archiveCustomer?.id)).toBe(false)
  })

  it('stores manual enrolled courses as deduplicated structured relations', () => {
    const api = createLocalApi(createLocalRepository())
    const first = api.createCustomer('staff-admin', { nickname: '温知遥', phone: '13900001111', situation: '先记录第一门课程。', needsFollowup: false, enrollments: [{ productId: 'P-001' }] })
    const existing = first.customers.find((item) => item.name === '温知遥')!
    api.updateCustomer('staff-admin', existing.id, { nickname: existing.name, situation: '', needsFollowup: false, enrollments: [{ productId: 'P-001' }, { productId: 'P-002' }] })
    const saved = api.dashboard('staff-admin')
    const relations = saved.enrollments.filter((item) => item.customerId === existing.id && item.status !== 'CANCELLED')
    expect(relations.map((item) => item.productId).sort()).toEqual(['P-001', 'P-002'])
    expect(relations).toHaveLength(2)
    expect(saved.customers.find((item) => item.id === existing.id)?.intendedCourse).not.toBe('P-002')
  })

  it('does not allow manual entry to select an inactive product', () => {
    const api = createLocalApi(createLocalRepository())
    expect(() => api.createCustomer('staff-admin', { nickname: '沈知遥', wechat: 'szy-demo', situation: '先记录课程关系。', needsFollowup: false, enrollments: [{ productId: 'P-003' }] })).toThrow('有效课程')
  })

  it('uses the unified ADMIN role and keeps dashboard counts sourced from appointments', () => {
    const api = createLocalApi(createLocalRepository())
    expect(api.dashboard('staff-founder').customers).toHaveLength(seedDatabase.customers.length)
    const snapshot = api.dashboardSnapshot('staff-admin')
    const all = api.dashboard('staff-admin').appointments
    expect(Object.values(snapshot.statusCounts).reduce((sum, count) => sum + count, 0)).toBe(all.length)
    expect(snapshot.mentorCount).toBe(4)
  })

  it('enforces customer reads at the API boundary', () => {
    const api = createLocalApi(createLocalRepository())
    expect(() => api.customer('mentor-zhang', 'C00001301')).toThrow('导师端暂未开放，请联系管理员。')
    expect(api.customer('staff-admin', 'C00001276')?.name).toBe('许清和')
  })

  it('allows only ADMIN to update a customer referrer', () => {
    const api = createLocalApi(createLocalRepository())
    expect(api.customer('staff-admin', 'C00001305')?.referrerName).toBe('')
    api.updateCustomerReferrer('staff-admin', 'C00001305', '李老师')
    expect(api.customer('staff-admin', 'C00001305')?.referrerName).toBe('李老师')
    expect(() => api.updateCustomerReferrer('mentor-zhang', 'C00001305', '陈某')).toThrow('导师端暂未开放，请联系管理员。')
  })

  it('lets ADMIN manage active mentor accounts and rejects duplicate phones', () => {
    const api = createLocalApi(createLocalRepository())
    const created = api.createMentor('staff-admin', { name: '新导师', phone: '13900000005' })
    expect(created.permissionRole).toBe('MENTOR')
    expect(created.status).toBe('ACTIVE')
    expect(() => api.createMentor('staff-admin', { name: '重复手机号', phone: '13900000005' })).toThrow('该手机号已绑定账户')
    expect(() => api.createMentor('mentor-li', { name: '越权导师', phone: '13900000006' })).toThrow('导师端暂未开放，请联系管理员。')
    const updated = api.updateMentor('staff-admin', created.id, { name: '新导师二号', phone: '13900000007' })
    expect(updated.name).toBe('新导师二号')
    expect(updated.phone).toBe('13900000007')
  })

  it('blocks mentor deactivation while unfinished appointments remain', () => {
    const api = createLocalApi(createLocalRepository())
    expect(() => api.deactivateMentor('staff-admin', 'mentor-li')).toThrow('未完成客户')
    expect(api.staff('mentor-li')?.status).toBe('ACTIVE')
  })

  it('soft-deactivates an idle mentor and rejects future login and assignment', () => {
    const api = createLocalApi(createLocalRepository())
    const created = api.createMentor('staff-admin', { name: '待停用导师', phone: '13900000008' })
    const deactivated = api.deactivateMentor('staff-admin', created.id)
    expect(deactivated.status).toBe('INACTIVE')
    expect(() => api.login('13900000008', '888888')).toThrow('账户已停用')
    expect(() => api.assignAppointment('staff-admin', 'A-20261004-01', created.id)).toThrow('账户已停用')
    expect(api.dashboard('staff-admin').staff.some((item) => item.id === created.id && item.status === 'INACTIVE')).toBe(true)
  })

  it('extracts natural profile facts without writing until mentor confirmation', () => {
    const api = createLocalApi(createLocalRepository())
    const draft = api.profileDraft('staff-admin', 'C00001301', '客户 36 岁，住在杭州，从事产品设计，已婚，有一个女儿，喜欢瑜伽和旅行，可能缺乏安全感。')
    expect(draft.updates.map((item) => item.field)).toEqual(expect.arrayContaining(['age', 'city', 'occupation', 'marital_status', 'children_summary', 'hobbies']))
    expect(draft.updates.find((item) => item.field === 'self_description')?.source).toBe('AI_INFERENCE')
    expect(draft.updates.find((item) => item.field === 'self_description')?.confirmed).toBe(false)
    expect(api.dashboard('staff-admin').customers.find((item) => item.id === 'C00001301')?.profileFields?.age).toBeUndefined()
    const saved = api.confirmProfile('staff-admin', 'C00001301', draft.updates)
    expect(saved.profileFields?.age).toBe(36)
    expect(saved.profileFieldMeta?.age.confirmed).toBe(true)
    expect(api.dashboard('staff-admin').profileChanges.some((item) => item.customerId === 'C00001301' && item.field === 'age')).toBe(true)
  })

  it('blocks mentor profile access while mentor login is disabled', () => {
    const api = createLocalApi(createLocalRepository())
    expect(() => api.profileDraft('mentor-zhang', 'C00001276', '她喜欢阅读。')).toThrow('导师端暂未开放，请联系管理员。')
  })

  it('marks a changed existing profile fact as a conflict before confirmation', () => {
    const api = createLocalApi(createLocalRepository())
    const draft = api.profileDraft('staff-admin', 'C00001298', '客户现在住在上海。')
    expect(draft.updates.find((item) => item.field === 'city')?.conflict).toBe(true)
    expect(api.dashboard('staff-admin').customers.find((item) => item.id === 'C00001298')?.profileFields?.city).toBe('杭州')
  })

  it('persists confirmed profile updates together with a service record', () => {
    const api = createLocalApi(createLocalRepository())
    const feedback: FeedbackInput = { appointmentId: 'A-20261003-07', topic: '确认近期行动', result: '继续跟进', coreNeed: '希望稳定行动节奏。', paid: false, grade: 'B', intendedCourse: null, notes: '下次继续回看行动。', profileText: '她最近开始跑步，也在杭州生活。', profileUpdates: [{ field: 'hobbies', value: ['跑步'], source: 'MENTOR_OBSERVATION', confidence: 0.9 }] }
    api.saveFeedback('staff-admin', feedback)
    const database = api.dashboard('staff-admin')
    expect(database.sessions[0].profileUpdates?.[0].field).toBe('hobbies')
    expect(database.customers.find((item) => item.id === 'C00001276')?.profileFields?.hobbies).toEqual(['跑步'])
  })
})
