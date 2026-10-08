import { describe, expect, it } from 'vitest'
import { PROFILE_COMPLETENESS_THRESHOLD, buildBasicDashboard } from './basic-dashboard.mjs'

const staff = [
  { id: 'admin-1', name: '翔叔', permissionRole: 'ADMIN' },
  { id: 'mentor-1', name: '张老师', permissionRole: 'MENTOR' },
]
const products = [{ id: 'course-a', name: '觉塑' }, { id: 'course-b', name: '镜像技术' }]

function customer(id, createdAt, createdByStaffId, coverage) {
  return { id, createdAt, createdByStaffId, profileMaterialization: coverage === undefined ? undefined : { coverage: { percentage: coverage } } }
}

describe('ASVA basic dashboard aggregation', () => {
  it('counts this week in Asia/Shanghai and excludes the previous week', () => {
    const dashboard = buildBasicDashboard({
      customers: [customer('this-week', '2026-10-05T00:30:00+08:00', 'admin-1', 80), customer('previous-week', '2026-09-28T23:59:00+08:00', 'admin-1', 80)],
      enrollments: [], staff, products,
    }, new Date('2026-10-08T12:00:00+08:00'))
    expect(dashboard.customer_total).toBe(2)
    expect(dashboard.new_customers_this_week).toBe(1)
    expect(dashboard.previous_week_new_customers).toBe(1)
  })

  it('counts unique enrolled customers and active course distribution', () => {
    const dashboard = buildBasicDashboard({
      customers: [customer('one', '2026-10-07T10:00:00+08:00', 'admin-1', 80), customer('two', '2026-10-07T10:00:00+08:00', 'mentor-1', 80)],
      enrollments: [
        { customerId: 'one', productId: 'course-a', status: '学习中' },
        { customerId: 'one', productId: 'course-b', status: '学习中' },
        { customerId: 'two', productId: 'course-a', status: '学习中' },
        { customerId: 'two', productId: 'course-b', status: 'CANCELLED' },
      ], staff, products,
    }, new Date('2026-10-08T12:00:00+08:00'))
    expect(dashboard.enrolled_customer_total).toBe(2)
    expect(dashboard.active_enrollment_total).toBe(3)
    expect(dashboard.course_enrollment_distribution).toEqual([
      { course_id: 'course-a', course_name: '觉塑', enrollment_count: 2, percentage: 67 },
      { course_id: 'course-b', course_name: '镜像技术', enrollment_count: 1, percentage: 33 },
    ])
  })

  it('uses the 60 threshold, treats null coverage as pending, and keeps deleted creators identifiable', () => {
    const dashboard = buildBasicDashboard({
      customers: [customer('below', '2026-10-07T10:00:00+08:00', 'deleted-staff', PROFILE_COMPLETENESS_THRESHOLD - 1), customer('equal', '2026-10-07T10:00:00+08:00', 'admin-1', PROFILE_COMPLETENESS_THRESHOLD), customer('unknown', '2026-10-07T10:00:00+08:00', '', undefined)],
      enrollments: [], staff, products,
    }, new Date('2026-10-08T12:00:00+08:00'))
    expect(dashboard.profile_pending_total).toBe(2)
    expect(dashboard.customer_owner_distribution).toEqual(expect.arrayContaining([{ staff_id: '', staff_name: '历史/未识别', role: 'UNKNOWN', customer_count: 2 }]))
  })

  it('returns a clean empty course state and deterministic management facts', () => {
    const dashboard = buildBasicDashboard({ customers: [], enrollments: [], staff, products }, new Date('2026-10-08T12:00:00+08:00'))
    expect(dashboard.active_enrollment_total).toBe(0)
    expect(dashboard.course_enrollment_distribution).toEqual([])
    expect(dashboard.management_insights[0]).toEqual({ type: 'NEW_CUSTOMERS', text: '本周暂无新增客户，可关注新客户来源。' })
  })
})
