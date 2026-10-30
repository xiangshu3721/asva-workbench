import type { Customer, Staff } from './domain'

/** Sentinel for owner filter: customers with no assigned mentor (mentorId null/empty). */
export const UNASSIGNED_OWNER_FILTER = '__unassigned__'

/**
 * Ownership semantics (do not mix):
 * - 「当前负责人」= customer.mentorId (assigned mentor; null ⇒ 未分配)
 * - 「创建人」= customer.createdByStaffId / createdByName (who created the record)
 * createdBy* must NEVER override mentor ownership for the owner dropdown filter.
 */

export type OwnerFilterValue = '' | typeof UNASSIGNED_OWNER_FILTER | string

export function buildStaffNameIndex(staff: Staff[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of staff) map.set(item.id, item.name)
  return map
}

/** Mentors + admins for the owner dropdown, including INACTIVE so historical ownership stays filterable. */
export function ownerFilterStaffOptions(staff: Staff[]): Staff[] {
  return staff
    .filter((item) => item.permissionRole === 'MENTOR' || item.permissionRole === 'ADMIN')
    .slice()
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name, 'zh')
      if (byName !== 0) return byName
      return a.id.localeCompare(b.id)
    })
}

function staffName(staffById: Map<string, string>, id?: string | null) {
  if (!id) return ''
  return staffById.get(id) || ''
}

/** Keyword haystack: customer fields + current owner name + creator name (via staff lookup / createdByName). */
export function customerKeywordHaystack(customer: Customer, staffById: Map<string, string>) {
  const ownerName = staffName(staffById, customer.mentorId)
  const creatorFromStaff = staffName(staffById, customer.createdByStaffId)
  const creatorName = customer.createdByName || creatorFromStaff
  return [
    customer.name,
    customer.phone,
    customer.wechat || '',
    customer.need,
    customer.notes,
    ownerName,
    creatorName,
    creatorFromStaff,
  ].join(' ').toLowerCase()
}

export function matchesOwnerFilter(customer: Customer, ownerFilter: OwnerFilterValue) {
  if (!ownerFilter) return true
  // Current owner only — mentorId. Never use createdBy* here.
  if (ownerFilter === UNASSIGNED_OWNER_FILTER) return !customer.mentorId
  return customer.mentorId === ownerFilter
}

export function matchesKeywordFilter(customer: Customer, normalizedQuery: string, staffById: Map<string, string>) {
  if (!normalizedQuery) return true
  return customerKeywordHaystack(customer, staffById).includes(normalizedQuery)
}

/** Keyword AND owner filter. Owner filter is for ADMIN UI only; callers decide when to pass a non-empty ownerFilter. */
export function filterCustomerDirectory(
  customers: Customer[],
  options: { query: string; ownerFilter: OwnerFilterValue; staff: Staff[] },
) {
  const normalizedQuery = options.query.trim().toLowerCase()
  const staffById = buildStaffNameIndex(options.staff)
  return customers.filter(
    (customer) =>
      matchesKeywordFilter(customer, normalizedQuery, staffById)
      && matchesOwnerFilter(customer, options.ownerFilter),
  )
}
