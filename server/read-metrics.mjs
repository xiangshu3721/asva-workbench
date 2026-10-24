const normalizeLabel = (value, fallback) => {
  const normalized = String(value || '').trim()
  return normalized || fallback
}

export class ReadMetrics {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.entries = []
  }

  start({ scene = 'UNSPECIFIED', mode = 'FULL', table = 'UNKNOWN' } = {}) {
    const startedAt = this.now()
    const entry = {
      scene: normalizeLabel(scene, 'UNSPECIFIED'),
      mode: mode === 'TARGETED' ? 'TARGETED' : 'FULL',
      table: normalizeLabel(table, 'UNKNOWN'),
      startedAt,
      providerRequests: 0,
      providerRetries: 0,
    }
    return {
      providerRequest: ({ retry = false } = {}) => {
        entry.providerRequests += 1
        if (retry) entry.providerRetries += 1
      },
      finish: ({ status = 'SUCCESS', cacheHit = false } = {}) => {
        const finishedAt = this.now()
        this.entries.push({
          scene: entry.scene,
          mode: entry.mode,
          table: entry.table,
          durationMs: Math.max(0, finishedAt - startedAt),
          providerRequests: entry.providerRequests || 1,
          providerRetries: entry.providerRetries,
          status: normalizeLabel(status, 'SUCCESS'),
          cacheHit: cacheHit === true,
        })
      },
    }
  }

  snapshot() {
    const byPath = new Map()
    for (const entry of this.entries) {
      const key = `${entry.scene}:${entry.mode}:${entry.table}`
      const current = byPath.get(key) || {
        scene: entry.scene,
        mode: entry.mode,
        table: entry.table,
        logicalReads: 0,
        providerRequests: 0,
        retries: 0,
        cacheHits: 0,
        failures: 0,
        durationsMs: [],
      }
      current.logicalReads += 1
      current.providerRequests += entry.providerRequests
      current.retries += entry.providerRetries
      current.cacheHits += entry.cacheHit ? 1 : 0
      if (entry.status !== 'SUCCESS') current.failures += 1
      current.durationsMs.push(entry.durationMs)
      byPath.set(key, current)
    }
    const summarize = (durations) => {
      const sorted = [...durations].sort((a, b) => a - b)
      const percentile = (ratio) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] : null
      return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.length ? sorted[sorted.length - 1] : null }
    }
    return [...byPath.values()].map(({ durationsMs, ...summary }) => ({ ...summary, latency: summarize(durationsMs) }))
  }

  reset() {
    this.entries = []
  }
}

