/**
 * One in-flight consultation refresh per customer + current client input.
 *
 * This is a client request de-duplicator, not a persistent AI cache. A later
 * explicit refresh is allowed after this Promise settles. Customer/input
 * scoping avoids sharing results across different records or data versions.
 */
export function createConsultationRefreshFlight<T>() {
  const inFlight = new Map<string, Promise<T>>()

  return {
    run(key: string, request: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key)
      if (existing) return existing

      const pending = Promise.resolve().then(request)
      inFlight.set(key, pending)
      // Use then(success, failure), not an unobserved finally that can create
      // a second unhandled rejected Promise.
      const clear = () => {
        if (inFlight.get(key) === pending) inFlight.delete(key)
      }
      void pending.then(clear, clear)
      return pending
    },
  }
}
