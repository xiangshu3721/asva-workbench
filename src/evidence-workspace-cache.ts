export interface EvidenceWorkspaceCache<T> {
  load: (customerId: string, options?: { refresh?: boolean }) => Promise<T>
  getCached: (customerId: string) => T | undefined
  setCached: (customerId: string, value: T) => void
}

export function createEvidenceWorkspaceCache<T>(loader: (customerId: string) => Promise<T>): EvidenceWorkspaceCache<T> {
  const cachedByCustomerId = new Map<string, T>()
  const inFlightByCustomerId = new Map<string, Promise<T>>()

  const load = (customerId: string, options: { refresh?: boolean } = {}) => {
    if (!options.refresh && cachedByCustomerId.has(customerId)) return Promise.resolve(cachedByCustomerId.get(customerId) as T)
    const inFlight = inFlightByCustomerId.get(customerId)
    if (inFlight) return inFlight
    let request: Promise<T>
    try {
      request = Promise.resolve(loader(customerId)).then((value) => {
        cachedByCustomerId.set(customerId, value)
        return value
      })
    } catch (error) {
      request = Promise.reject(error)
    }
    const tracked = request.finally(() => {
      if (inFlightByCustomerId.get(customerId) === tracked) inFlightByCustomerId.delete(customerId)
    })
    inFlightByCustomerId.set(customerId, tracked)
    return tracked
  }

  return {
    load,
    getCached: (customerId) => cachedByCustomerId.get(customerId),
    setCached: (customerId, value) => { cachedByCustomerId.set(customerId, value) },
  }
}
