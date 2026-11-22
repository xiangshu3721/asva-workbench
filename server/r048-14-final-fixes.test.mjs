import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CloudBaseAiBudgetGuard, chinaDay } from './ai-budget-guard.mjs'
import { getCurrentCallId, consumeCallUsage, recordCallUsage, extractTokensFromPayload } from './deepseek.mjs'

// R048.14 regression tests for final fixes before production deploy

describe('R048.14 final fixes', () => {
  describe('PG V2 migration CHECK constraint', () => {
    it('V2 migration SQL drops old CHECK and adds new constraint for counter semantics', () => {
      const sql = readFileSync(new URL('../cloudbase/migrations/20261122160000_asva_ai_budget_v2_limits_and_monitoring.sql', import.meta.url), 'utf8')
      // Must drop old constraint before adding new one
      expect(sql).toContain('DROP CONSTRAINT IF EXISTS asva_ai_budget_v1_active_check')
      // New constraint must allow 0..2 for counter semantics
      expect(sql).toContain('active >= 0 AND active <= 2')
      // Must set active = active + 1 for incrementing
      expect(sql).toContain('active = control_row.active + 1')
    })
  })

  describe('Token tracking isolation per call', () => {
    it('generates unique call IDs for concurrent operations', () => {
      const id1 = getCurrentCallId()
      const id2 = getCurrentCallId()
      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^call-\d+$/)
    })

    it('isolates token usage between concurrent calls', () => {
      const call1 = getCurrentCallId()
      const call2 = getCurrentCallId()
      
      // Simulate concurrent DeepSeek calls with different token counts
      recordCallUsage(call1, { inputTokens: 100, outputTokens: 50 })
      recordCallUsage(call2, { inputTokens: 200, outputTokens: 100 })
      recordCallUsage(call1, { inputTokens: 150, outputTokens: 75 }) // Second call for call1
      
      // Each call should have its own isolated totals
      const usage1 = consumeCallUsage(call1)
      const usage2 = consumeCallUsage(call2)
      
      expect(usage1).toEqual({ inputTokens: 250, outputTokens: 125 })
      expect(usage2).toEqual({ inputTokens: 200, outputTokens: 100 })
      
      // Consuming should clear the tracking
      expect(consumeCallUsage(call1)).toEqual({ inputTokens: 0, outputTokens: 0 })
    })

    it('extracts tokens from DeepSeek payload correctly', () => {
      const payload = { usage: { prompt_tokens: 500, completion_tokens: 300 } }
      const usage = extractTokensFromPayload(payload)
      expect(usage).toEqual({ inputTokens: 500, outputTokens: 300 })
    })
  })

  describe('Daily stats with Beijing time', () => {
    it('uses China day for default when no day provided', () => {
      // Beijing time 2026-11-22 16:00 = UTC 2026-11-22 08:00
      expect(chinaDay(new Date('2026-11-22T08:00:00.000Z'))).toBe('2026-11-22')
      // Beijing time 2026-11-22 23:59 = UTC 2026-11-22 15:59
      expect(chinaDay(new Date('2026-11-22T15:59:00.000Z'))).toBe('2026-11-22')
      // Beijing time 2026-11-23 00:01 = UTC 2026-11-22 16:01
      expect(chinaDay(new Date('2026-11-22T16:01:00.000Z'))).toBe('2026-11-23')
    })

    it('includes cost estimate note in daily stats', async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          data: { day: '2026-11-22', used: 5, successCount: 4, failCount: 1, totalInputTokens: 1000, totalOutputTokens: 500, estimatedCostUsd: 0.00028 }
        })
      })
      const guard = new CloudBaseAiBudgetGuard({
        table: 'asva_ai_budget_v1',
        rpcBaseUrl: 'https://test.rpc/v1/rdb/rest/rpc',
        rpcFunction: 'asva_ai_budget_guard',
        apiKey: 'test-key',
        fetchImpl: mockFetch,
      })
      const stats = await guard.dailyStats('2026-11-22')
      expect(stats.costEstimateNote).toContain('估算')
      expect(stats.costEstimateNote).toContain('$0.14/M')
      expect(stats.costEstimateNote).toContain('非实际账单')
    })
  })

  describe('Anomaly detection', () => {
    it('detects high failure rate', async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          data: { day: '2026-11-22', used: 10, successCount: 5, failCount: 5, pendingCount: 0, totalInputTokens: 2000, totalOutputTokens: 1000, estimatedCostUsd: 0.00056 }
        })
      })
      const guard = new CloudBaseAiBudgetGuard({
        table: 'asva_ai_budget_v1',
        rpcBaseUrl: 'https://test.rpc/v1/rdb/rest/rpc',
        rpcFunction: 'asva_ai_budget_guard',
        apiKey: 'test-key',
        fetchImpl: mockFetch,
      })
      const result = await guard.checkAndAlertAnomalies('2026-11-22')
      expect(result.anomalies).toHaveLength(1)
      expect(result.anomalies[0].type).toBe('HIGH_FAILURE_RATE')
    })

    it('detects high daily cost', async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          data: { day: '2026-11-22', used: 100, successCount: 100, failCount: 0, pendingCount: 0, totalInputTokens: 500000, totalOutputTokens: 250000, estimatedCostUsd: 1.5 }
        })
      })
      const guard = new CloudBaseAiBudgetGuard({
        table: 'asva_ai_budget_v1',
        rpcBaseUrl: 'https://test.rpc/v1/rdb/rest/rpc',
        rpcFunction: 'asva_ai_budget_guard',
        apiKey: 'test-key',
        fetchImpl: mockFetch,
      })
      const result = await guard.checkAndAlertAnomalies('2026-11-22')
      expect(result.anomalies.some(a => a.type === 'HIGH_DAILY_COST')).toBe(true)
    })
  })

  describe('Server-side AUTO trigger', () => {
    it('index.mjs creates source and triggers AUTO when conditions met', () => {
      const indexSource = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
      // Must check AUTO conditions after createSource
      expect(indexSource).toContain('processSourceOnDemand')
      expect(indexSource).toContain("trigger: 'AUTO'")
      expect(indexSource).toContain('onDemandAiAutoTrigger')
      expect(indexSource).toContain('onDemandAiAutoTriggerCustomerIds')
    })
  })

  describe('FAILED lock behavior', () => {
    it('repository.mjs distinguishes definite failure from unknown result', () => {
      const repoSource = readFileSync(new URL('./repository.mjs', import.meta.url), 'utf8')
      // Must have isDefiniteFailure check
      expect(repoSource).toContain('isDefiniteFailure')
      // Must have isUnknownResult check
      expect(repoSource).toContain('isUnknownResult')
      // Must release active for definite failure
      expect(repoSource).toContain('releaseActive: isDefiniteFailure')
      // Must log lock for unknown result
      expect(repoSource).toContain('PROCESS_SOURCE_ON_DEMAND_LOCKED')
    })
  })
})
