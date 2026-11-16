/** Stage 4: client cache freshness only. Never use this as the persisted
 * AI/DeepSeek fingerprint; the backend's legacy v4 key stays unchanged.
 */
export interface ConsultationCacheResponse {
  customerId: string
  meta?: {
    profileVersion?: number
    clientSnapshotFingerprint?: string
  }
}

export interface ConsultationCacheCheck {
  cached?: ConsultationCacheResponse | null
  cachedAt?: number
  customerId: string
  profileVersion: number
  clientSnapshotFingerprint: string
  now: number
  ttlMs: number
}

export function consultationCacheDecision({
  cached, cachedAt, customerId, profileVersion, clientSnapshotFingerprint, now, ttlMs,
}: ConsultationCacheCheck): { reuse: boolean; forceRead: boolean } {
  const snapshotMatches = Boolean(
    cached
    && cached.customerId === customerId
    && (cached.meta?.profileVersion ?? 0) === profileVersion
    && cached.meta?.clientSnapshotFingerprint === clientSnapshotFingerprint,
  )
  const withinTtl = typeof cachedAt === 'number' && Number.isFinite(cachedAt) && cachedAt > 0
    && now >= cachedAt && now - cachedAt < ttlMs
  return {
    reuse: snapshotMatches && withinTtl,
    // ResourceCache.load() otherwise returns a recently cached response even
    // when its input identity changed. Force only on an identity mismatch.
    forceRead: Boolean(cached && !snapshotMatches),
  }
}
