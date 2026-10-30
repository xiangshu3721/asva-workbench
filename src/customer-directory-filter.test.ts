import { describe, expect, it } from 'vitest'
import type { Customer, Staff } from './domain'
import {
  UNASSIGNED_OWNER_FILTER,
  filterCustomerDirectory,
  matchesOwnerFilter,
  ownerFilterStaffOptions,
} from './customer-directory-filter'

function staff(partial: Partial<Staff> & Pick<Staff, 'id' | 'name' | 'permissionRole'>): Staff {
  return {
    role: partial.permissionRole,
    status: 'ACTIVE',
    loginEnabled: true,
    displayRole: partial.permissionRole,
    title: '',
    phone: '',
    specialty: '',
    avatar: '',
    ...partial,
  }
}

function customer(partial: Partial<Customer> & Pick<Customer, 'id' | 'name' | 'mentorId'>): Customer {
  return {
    createdAt: '2026-10-01',
    initials: partial.name.slice(0, 1),
    phone: '',
    status: '活跃',
    grade: 'C',
    gradeSource: 'AI建议',
    referrerName: '',
    need: '',
    helpExpectation: '',
    goal: '',
    brief: '',
    intendedCourse: null,
    confirmedFacts: [],
    aiQuestions: [],
    notes: '',
    paid: false,
    lastActivity: '2026-10-01',
    nextFollowup: null,
    lastFollowupAt: null,
    nextFollowupAt: null,
    followupStatus: '待跟进',
    ...partial,
  }
}

describe('customer-directory-filter', () => {
  const team = [
    staff({ id: 'admin-1', name: '管理员甲', permissionRole: 'ADMIN' }),
    staff({ id: 'mentor-a', name: '导师张', permissionRole: 'MENTOR' }),
    staff({ id: 'mentor-b', name: '导师李', permissionRole: 'MENTOR', status: 'INACTIVE' }),
  ]

  const customers = [
    customer({ id: 'c1', name: '林知微', mentorId: 'mentor-a', need: '人生方向' }),
    customer({ id: 'c2', name: '叶承安', mentorId: null, createdByStaffId: 'admin-1', createdByName: '管理员甲', need: '卡住了' }),
    customer({ id: 'c3', name: '许清和', mentorId: 'mentor-b', need: '行动' }),
    customer({
      id: 'c4',
      name: '苏晚晴',
      mentorId: 'mentor-a',
      createdByStaffId: 'admin-1',
      createdByName: '管理员甲',
      need: '关系',
    }),
  ]

  it('owner options include inactive mentors and admins', () => {
    const options = ownerFilterStaffOptions(team)
    expect(options.map((item) => item.id)).toEqual(['admin-1', 'mentor-b', 'mentor-a'].sort((a, b) => {
      const names: Record<string, string> = { 'admin-1': '管理员甲', 'mentor-a': '导师张', 'mentor-b': '导师李' }
      return names[a].localeCompare(names[b], 'zh') || a.localeCompare(b)
    }))
  })

  it('filters by current owner mentorId only, never createdBy*', () => {
    expect(matchesOwnerFilter(customers[3], 'admin-1')).toBe(false)
    expect(matchesOwnerFilter(customers[3], 'mentor-a')).toBe(true)
    expect(matchesOwnerFilter(customers[1], UNASSIGNED_OWNER_FILTER)).toBe(true)
    expect(matchesOwnerFilter(customers[3], UNASSIGNED_OWNER_FILTER)).toBe(false)
  })

  it('keyword matches mentor/admin names via staff lookup AND combines with owner filter', () => {
    const byMentorName = filterCustomerDirectory(customers, { query: '导师张', ownerFilter: '', staff: team })
    expect(byMentorName.map((item) => item.id)).toEqual(['c1', 'c4'])

    const byCreatorNameUnassigned = filterCustomerDirectory(customers, {
      query: '管理员甲',
      ownerFilter: UNASSIGNED_OWNER_FILTER,
      staff: team,
    })
    expect(byCreatorNameUnassigned.map((item) => item.id)).toEqual(['c2'])

    const assignedToMentorAAndCreator = filterCustomerDirectory(customers, {
      query: '管理员甲',
      ownerFilter: 'mentor-a',
      staff: team,
    })
    expect(assignedToMentorAAndCreator.map((item) => item.id)).toEqual(['c4'])
  })

  it('inactive mentor historical customers remain filterable by staff.id', () => {
    const result = filterCustomerDirectory(customers, { query: '', ownerFilter: 'mentor-b', staff: team })
    expect(result.map((item) => item.id)).toEqual(['c3'])
  })
})
