/** Stage 4: client cache freshness only. Never use this as the persisted
 * AI/DeepSeek fingerprint; the backend's legacy v4 key stays unchanged.
 */
export interface ConsultationCacheResponse {
  customerId: string
  meta?: {
    profileVersion?: number
    consultationClientFingerprint?: string
  }
}

export interface ConsultationCacheCheck {
  cached?: ConsultationCacheResponse | null
  cachedAt?: number
  customerId: string
  profileVersion: number
  consultationClientFingerprint: string
  now: number
  ttlMs: number
}

export function consultationCacheDecision({
  cached, cachedAt, customerId, profileVersion, consultationClientFingerprint, now, ttlMs,
}: ConsultationCacheCheck): { reuse: boolean; forceRead: boolean } {
  const snapshotMatches = Boolean(
    cached
    && cached.customerId === customerId
    && (cached.meta?.profileVersion ?? 0) === profileVersion
    && cached.meta?.consultationClientFingerprint === consultationClientFingerprint,
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

/** While an old request is loading, render current local source signals
 * instead of stale server topics. Server Evidence still wins once its
 * response has been tagged with this exact client snapshot.
 */
export function currentConsultationTopics<T extends { customer_id: string; source_fingerprint: string | null }>(
  response: { customerId: string; meta?: { consultationClientFingerprint?: string }; consultation_topics?: T } | null | undefined,
  local: T,
): T {
  return response?.customerId === local.customer_id
    && response.meta?.consultationClientFingerprint === local.source_fingerprint
    && response.consultation_topics?.customer_id === local.customer_id
    ? response.consultation_topics
    : local
}
