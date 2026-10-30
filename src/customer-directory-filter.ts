import type { Customer, PermissionRole, Staff } from './domain'

/** Sentinel for owner filter: customers with no assigned mentor (mentorId null/empty). */
export const UNASSIGNED_OWNER_FILTER = '__unassigned__'

/**
 * Ownership semantics (do not mix):
 * - 「当前负责人」= customer.mentorId (assigned mentor; null/empty ⇒ 未分配)
 * - 「创建人」= customer.createdByStaffId / createdByName (who created the record)
 *
 * Owner dropdown matching:
 * - Mentor option: mentorId === staffId (assigned customers stay under their mentor)
 * - Admin option: createdByStaffId === adminId AND still unassigned — does NOT pull
 *   customers already assigned to another mentor into the admin bucket
 * - 「未分配」: all customers with empty mentorId
 */

export type OwnerFilterValue = '' | typeof UNASSIGNED_OWNER_FILTER | string

export function buildStaffNameIndex(staff: Staff[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of staff) map.set(item.id, item.name)
  return map
}

export function buildStaffRoleIndex(staff: Staff[]): Map<string, PermissionRole> {
  const map = new Map<string, PermissionRole>()
  for (const item of staff) map.set(item.id, item.permissionRole)
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

function isUnassignedMentor(customer: Customer) {
  return !customer.mentorId
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

/**
 * @param staffRoles role lookup for the selected owner option (from database.staff).
 * When the selected id is an ADMIN, match creator+unassigned; MENTOR matches mentorId only.
 * Unknown ids fall back to mentorId equality (safe default).
 */
export function matchesOwnerFilter(
  customer: Customer,
  ownerFilter: OwnerFilterValue,
  staffRoles?: Map<string, PermissionRole> | Staff[],
) {
  if (!ownerFilter) return true
  if (ownerFilter === UNASSIGNED_OWNER_FILTER) return isUnassignedMentor(customer)

  const roles = staffRoles instanceof Map
    ? staffRoles
    : Array.isArray(staffRoles)
      ? buildStaffRoleIndex(staffRoles)
      : undefined
  const role = roles?.get(ownerFilter)

  if (role === 'ADMIN') {
    // Admin bucket: only still-unassigned customers created by this admin.
    // Assigned customers remain under their mentor option — never pulled into the admin bucket.
    return isUnassignedMentor(customer) && customer.createdByStaffId === ownerFilter
  }

  // Mentor (or unknown id): current owner = mentorId only.
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
  const staffRoles = buildStaffRoleIndex(options.staff)
  return customers.filter(
    (customer) =>
      matchesKeywordFilter(customer, normalizedQuery, staffById)
      && matchesOwnerFilter(customer, options.ownerFilter, staffRoles),
  )
}
