export type CustomerIdentityResult = 'EXACT_MATCH' | 'POSSIBLE_MATCH' | 'CONFLICT' | 'NEW_CUSTOMER'
export interface IdentityCustomer { id: string; name?: string; phone?: string; wechat?: string }
export interface IdentityResolution { result: CustomerIdentityResult; matched_customer_id: string | null; match_reasons: string[]; confidence: number; matches: IdentityCustomer[] }
export function normalizePhone(value: unknown): string
export function normalizeWechat(value: unknown): string
export function normalizeNickname(value: unknown): string
export function contactRequired(input: { phone?: unknown; wechat?: unknown }): boolean
export function resolveCustomerIdentity(customers: IdentityCustomer[], input: { customerId?: unknown; phone?: unknown; wechat?: unknown; nickname?: unknown }): IdentityResolution
export function provenance(source: string | undefined, confirmed?: boolean): string
