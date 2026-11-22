import { vi } from 'vitest'

// Test helper: in-memory budget guard for integration tests
export function createMemoryBudgetGuard({ mode = 'DISABLED', dailyLimit = 10, maxConcurrent = 2 } = {}) {
  let currentMode = mode
  let used = 0
  let active = 0
  let reservations = new Map()
  const successCount = { value: 0 }
  const failCount = { value: 0 }

  return {
    configured: () => true,
    reserve: vi.fn(async ({ sourceId, actorId, trigger, operationId }) => {
      const reservationId = `res-${sourceId}-${Date.now()}`
      const reservation = {
        id: reservationId,
        sourceId,
        actorId,
        trigger,
        operationId,
        status: 'RESERVED',
        createdAt: new Date().toISOString(),
      }
      reservations.set(reservationId, reservation)
      used++
      active++
      // Return the expected format: { reservation, duplicate: false }
      return { reservation, duplicate: false }
    }),
    markAttempted: vi.fn(async (reservation) => {
      const r = reservations.get(reservation.id)
      if (r) r.status = 'ATTEMPTED'
    }),
    complete: vi.fn(async (reservation, { status }) => {
      const r = reservations.get(reservation.id)
      if (r) {
        r.status = status
        if (status === 'SUCCEEDED') successCount.value++
        else failCount.value++
        active--
      }
    }),
    dailyStats: vi.fn(async (day) => ({
      day,
      used,
      successCount: successCount.value,
      failCount: failCount.value,
      pendingCount: active,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    })),
    setMode: (newMode) => { currentMode = newMode },
    getMode: () => currentMode,
    control: vi.fn(async () => ({ mode: currentMode })),
    setControl: vi.fn(async ({ mode }) => { currentMode = mode }),
    checkAndAlertAnomalies: vi.fn(async () => ({ anomalies: [] })),
  }
}
