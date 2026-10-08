import type { Customer, Database, EnrollmentDraft, FeedbackInput, ManualCustomerInput, MentorAccountInput, NewAppointmentInput, ProfileDraft, ProfileUpdate, Staff, StaffStatus } from './domain'
import type { AsvaRepository } from './repositories'

const requireLiveHttp = (): never => {
  throw new Error('当前前端未连接真实 HTTP 服务，导师数据不会写入飞书。请配置 VITE_API_BASE_URL=http://127.0.0.1:8788 后重启前端。')
}

export function createLocalApi(repository: AsvaRepository) {
  return {
    dashboard(staffId: string): Database { return repository.getDatabaseForUser(staffId) },
    staff(staffId: string): Staff | undefined { return repository.getStaff(staffId) },
    login(phone: string, code: string): Staff { return repository.authenticate(phone, code) },
    customer(actorId: string, id: string): Customer | undefined { return repository.getDatabaseForUser(actorId).customers.find((item) => item.id === id) },
    createAppointment(input: NewAppointmentInput): Database { return repository.createAppointment(input) },
    previewCustomer(actorId: string, input: ManualCustomerInput) { return repository.previewCustomer(actorId, input) },
    createCustomer(actorId: string, input: ManualCustomerInput): Database { return repository.createCustomer(actorId, input) },
    updateCustomer(actorId: string, customerId: string, input: ManualCustomerInput): Database { return repository.updateCustomer(actorId, customerId, input) },
    updateCustomerEnrollments(actorId: string, customerId: string, enrollments: EnrollmentDraft[]): Database { return repository.updateCustomerEnrollments(actorId, customerId, enrollments) },
    assignAppointment(actorId: string, appointmentId: string, mentorId: string): Database { return repository.assignAppointment(actorId, appointmentId, mentorId) },
    markFollowupDone(actorId: string, appointmentId: string): Database { return repository.markFollowupDone(actorId, appointmentId) },
    saveFeedback(actorId: string, feedback: FeedbackInput): Database { return repository.saveFeedback(actorId, feedback) },
    profileDraft(actorId: string, customerId: string, text: string): ProfileDraft { return repository.profileDraft(actorId, customerId, text) },
    confirmProfile(actorId: string, customerId: string, updates: ProfileUpdate[]): Customer { return repository.confirmProfile(actorId, customerId, updates) },
    createMentor(actorId: string, input: MentorAccountInput): Staff { return repository.createMentor(actorId, input) },
    updateMentor(actorId: string, mentorId: string, input: MentorAccountInput): Staff { return repository.updateMentor(actorId, mentorId, input) },
    deactivateMentor(actorId: string, mentorId: string): Staff { return repository.deactivateMentor(actorId, mentorId) },
    updateCustomerReferrer(actorId: string, customerId: string, referrerName: string): Customer { return repository.updateCustomerReferrer(actorId, customerId, referrerName) },
    teamSnapshot(actorId: string, status?: StaffStatus) {
      const database = repository.getDatabaseForUser(actorId)
      const actor = database.staff.find((item) => item.id === actorId)
      if (actor?.permissionRole !== 'ADMIN') throw new Error('无权查看团队数据')
      const all = repository.getDatabase()
      return all.staff.filter((item) => item.permissionRole === 'MENTOR' && (!status || item.status === status)).map((mentor) => ({
        mentor,
        customerCount: all.customers.filter((customer) => customer.createdByStaffId === mentor.id).length,
      }))
    },
    dashboardSnapshot(actorId: string) {
      const database = repository.getDatabaseForUser(actorId)
      const actor = database.staff.find((item) => item.id === actorId)
      if (actor?.permissionRole !== 'ADMIN') throw new Error('无权查看数据看板')
      const all = repository.getDatabase()
      const month = '2026-10'
      return {
        customerCount: all.customers.length,
        monthNewCustomers: all.customers.filter((customer) => customer.createdAt.startsWith(month)).length,
        paidCustomers: all.customers.filter((customer) => customer.paid).length,
        mentorCount: all.staff.filter((staff) => staff.permissionRole === 'MENTOR').length,
        recentCustomers: all.customers.slice(0, 5),
      }
    },
  }
}

export function createGuardedLocalApi(repository: AsvaRepository) {
  const api = createLocalApi(repository)
  return {
    ...api,
    assignAppointment: (_actorId: string, _appointmentId: string, _mentorId: string): never => requireLiveHttp(),
    createMentor: (_actorId: string, _input: MentorAccountInput): never => requireLiveHttp(),
    updateMentor: (_actorId: string, _mentorId: string, _input: MentorAccountInput): never => requireLiveHttp(),
    deactivateMentor: (_actorId: string, _mentorId: string): never => requireLiveHttp(),
    teamSnapshot: (_actorId: string, _status?: StaffStatus): never => requireLiveHttp(),
  }
}
