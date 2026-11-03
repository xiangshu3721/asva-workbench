import { FeishuRepository } from './repository.mjs'

export async function main() {
  const startedAt = Date.now()
  const before = process.memoryUsage()
  const repository = new FeishuRepository({ backgroundArchiveWorker: true })
  try {
    const result = await repository.runAutomaticArchiveWorkerTick()
    const after = process.memoryUsage()
    console.info('[ASVA_AUTO_ARCHIVE_TICK]', JSON.stringify({
      result: result.status,
      customer_id: result.customerId || undefined,
      source_id: result.sourceId || undefined,
      stage: result.workerStage || result.phase || undefined,
      duration_ms: Date.now() - startedAt,
      heap_used_before: before.heapUsed,
      heap_used_after: after.heapUsed,
      rss_before: before.rss,
      rss_after: after.rss,
    }))
    return result
  } catch (error) {
    const after = process.memoryUsage()
    console.error('[ASVA_AUTO_ARCHIVE_TICK]', JSON.stringify({ result: 'FAILED', duration_ms: Date.now() - startedAt, error_code: error?.code || 'AUTOMATIC_ARCHIVE_TICK_FAILED', heap_used_before: before.heapUsed, heap_used_after: after.heapUsed, rss_before: before.rss, rss_after: after.rss }))
    throw error
  }
}
