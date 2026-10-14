export interface CustomerScopedState<T> {
  customerId: string
  value: T | null
  loading: boolean
  error: string
}

export function createCustomerScopedState<T>(customerId: string, value: T | null = null, loading = false): CustomerScopedState<T> {
  return { customerId, value, loading, error: '' }
}

export function isCustomerScopedStateFor<T>(state: CustomerScopedState<T>, customerId: string) {
  return state.customerId === customerId
}

export function canCommitCustomerResponse(input: {
  requestCustomerId: string
  activeCustomerId: string
  requestSequence: number
  activeSequence: number
  responseCustomerId: string
}) {
  return input.requestCustomerId === input.activeCustomerId
    && input.requestSequence === input.activeSequence
    && input.responseCustomerId === input.requestCustomerId
}
