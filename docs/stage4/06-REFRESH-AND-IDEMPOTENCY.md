# Refresh, Status and Idempotency

Statuses are `FRESH`, `STALE`, `PROCESSING` and `FAILED`. The fingerprint combines the customer profile version, confirmed evidence and open conflict summary. A matching profile version, fingerprint and prompt version is a no-op and does not call DeepSeek again.

Source processing schedules one coalesced refresh after a 30-second debounce window. Manual refresh is available for administrators. A failed validation or provider call preserves the previous payload and records FAILED metadata. One repair request is allowed after an invalid AI result.
