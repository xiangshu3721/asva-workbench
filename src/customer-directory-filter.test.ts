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
    staff({ id: 'admin-2', name: '管理员乙', permissionRole: 'ADMIN' }),
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
    customer({ id: 'c5', name: '匿名未分配', mentorId: null, need: '方向' }),
    customer({ id: 'c6', name: '乙创建未分配', mentorId: null, createdByStaffId: 'admin-2', createdByName: '管理员乙', need: '起步' }),
  ]

  it('owner options include inactive mentors and admins', () => {
    const options = ownerFilterStaffOptions(team)
    expect(options.map((item) => item.id).sort()).toEqual(['admin-1', 'admin-2', 'mentor-a', 'mentor-b'].sort())
  })

  it('mentor option matches mentorId only; assigned creator stays under mentor', () => {
    expect(matchesOwnerFilter(customers[3], 'mentor-a', team)).toBe(true)
    expect(matchesOwnerFilter(customers[3], 'admin-1', team)).toBe(false)
    expect(matchesOwnerFilter(customers[0], 'mentor-a', team)).toBe(true)
    expect(matchesOwnerFilter(customers[0], UNASSIGNED_OWNER_FILTER)).toBe(false)
  })

  it('admin option includes only that admin’s still-unassigned created customers', () => {
    expect(matchesOwnerFilter(customers[1], 'admin-1', team)).toBe(true)
    expect(matchesOwnerFilter(customers[5], 'admin-1', team)).toBe(false)
    expect(matchesOwnerFilter(customers[5], 'admin-2', team)).toBe(true)
    // Unassigned but not created by admin-1
    expect(matchesOwnerFilter(customers[4], 'admin-1', team)).toBe(false)
    // Created by admin-1 but already assigned → mentor bucket only
    expect(matchesOwnerFilter(customers[3], 'admin-1', team)).toBe(false)
  })

  it('未分配 includes all empty mentorId regardless of creator', () => {
    expect(matchesOwnerFilter(customers[1], UNASSIGNED_OWNER_FILTER)).toBe(true)
    expect(matchesOwnerFilter(customers[4], UNASSIGNED_OWNER_FILTER)).toBe(true)
    expect(matchesOwnerFilter(customers[5], UNASSIGNED_OWNER_FILTER)).toBe(true)
    expect(matchesOwnerFilter(customers[3], UNASSIGNED_OWNER_FILTER)).toBe(false)

    const unassigned = filterCustomerDirectory(customers, { query: '', ownerFilter: UNASSIGNED_OWNER_FILTER, staff: team })
    expect(unassigned.map((item) => item.id).sort()).toEqual(['c2', 'c5', 'c6'])
  })

  it('admin filter directory returns creator-unassigned only', () => {
    const byAdmin1 = filterCustomerDirectory(customers, { query: '', ownerFilter: 'admin-1', staff: team })
    expect(byAdmin1.map((item) => item.id)).toEqual(['c2'])

    const byAdmin2 = filterCustomerDirectory(customers, { query: '', ownerFilter: 'admin-2', staff: team })
    expect(byAdmin2.map((item) => item.id)).toEqual(['c6'])
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

    const adminBucketAndKeyword = filterCustomerDirectory(customers, {
      query: '叶承安',
      ownerFilter: 'admin-1',
      staff: team,
    })
    expect(adminBucketAndKeyword.map((item) => item.id)).toEqual(['c2'])
  })

  it('inactive mentor historical customers remain filterable by staff.id', () => {
    const result = filterCustomerDirectory(customers, { query: '', ownerFilter: 'mentor-b', staff: team })
    expect(result.map((item) => item.id)).toEqual(['c3'])
  })
})
