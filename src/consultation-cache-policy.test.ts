import { describe, expect, it } from 'vitest'
import type { Customer, ServiceSession } from './domain'
import { buildLocalConsultationTopics } from './clientApi'
import { createRuleOneLineUnderstanding } from './one-line-understanding'
import { consultationCacheDecision, currentConsultationTopics, type ConsultationCacheResponse } from './consultation-cache-policy'

const customer = (overrides: Partial<Customer> = {}) => ({
  id: 'CUS-CACHE', name: '合成客户', notes: '想聊职业发展', need: '', goal: '',
  helpExpectation: '', profileVersion: 4, profileFields: {}, profileFieldMeta: {},
  ...overrides,
} as Customer)

const fingerprint = (c: Customer, sessions: ServiceSession[] = []) =>
  buildLocalConsultationTopics(c, sessions).source_fingerprint || ''

const cached = (c: Customer, overrides: Partial<NonNullable<ConsultationCacheResponse['meta']>> = {}): ConsultationCacheResponse => ({
  customerId: c.id,
  meta: { profileVersion: c.profileVersion ?? 0, consultationClientFingerprint: fingerprint(c), ...overrides },
})

function decide(c: Customer, entry: ConsultationCacheResponse | null, updates: Record<string, unknown> = {}) {
  return consultationCacheDecision({
    cached: entry, cachedAt: 1000, customerId: c.id, profileVersion: c.profileVersion ?? 0,
    consultationClientFingerprint: fingerprint(c), now: 1010, ttlMs: 45_000,
    ...updates,
  })
}

describe('stage 4 consultation cache freshness contract', () => {
  it('reuses an unchanged current-customer response within the client TTL', () => {
    const c = customer()
    expect(decide(c, cached(c))).toEqual({ reuse: true, forceRead: false })
  })

  it('invalidates notes and current need changes even without a profileVersion bump', () => {
    const c = customer()
    const previous = cached(c)
    const changedNotes = customer({ notes: '最近工作压力很大' })
    const changedNeed = customer({ need: '亲密关系方面的咨询需求' })
    expect(changedNotes.profileVersion).toBe(c.profileVersion)
    expect(fingerprint(changedNotes)).not.toBe(fingerprint(c))
    expect(fingerprint(changedNeed)).not.toBe(fingerprint(c))
    expect(decide(changedNotes, previous)).toEqual({ reuse: false, forceRead: true })
    expect(decide(changedNeed, previous)).toEqual({ reuse: false, forceRead: true })
  })

  it('uses the consultation snapshot fingerprint to notice newly recorded sessions', () => {
    const c = customer()
    const session = { id: 'SESSION-1', customerId: c.id, date: '2026-11-16', note: '新的服务记录' } as ServiceSession
    expect(fingerprint(c, [session])).not.toBe(fingerprint(c))
    expect(decide(c, cached(c), { consultationClientFingerprint: fingerprint(c, [session]) }))
      .toEqual({ reuse: false, forceRead: true })
  })

  it('keeps the earlier one-line AI freshness fingerprint independent of consultation cache identity', () => {
    const c = customer()
    const session = { id: 'SESSION-1', customerId: c.id, date: '2026-11-16', note: '新的服务记录' } as ServiceSession
    expect(createRuleOneLineUnderstanding(c, []).inputFingerprint)
      .toBe(createRuleOneLineUnderstanding(c, [session]).inputFingerprint)
    expect(fingerprint(c)).not.toBe(fingerprint(c, [session]))
  })

  it('rejects the old customer or changed profile version even while TTL is valid', () => {
    const c = customer()
    expect(decide(c, { ...cached(c), customerId: 'CUS-OTHER' })).toEqual({ reuse: false, forceRead: true })
    expect(decide(customer({ profileVersion: 5 }), cached(c))).toEqual({ reuse: false, forceRead: true })
  })

  it('does one refresh for a legacy cached entry with no client consultation fingerprint', () => {
    const c = customer()
    expect(decide(c, { customerId: c.id, meta: { profileVersion: 4 } })).toEqual({ reuse: false, forceRead: true })
  })

  it('expires normally after TTL without forcing the read only because of time', () => {
    const c = customer()
    expect(decide(c, cached(c), { now: 46_000 })).toEqual({ reuse: false, forceRead: false })
    expect(decide(c, cached(c), { now: 999 })).toEqual({ reuse: false, forceRead: false })
  })

  it('allows a missing cache to load without force', () => {
    expect(decide(customer(), null)).toEqual({ reuse: false, forceRead: false })
  })
})

describe('stage 4 topic selection during cache turnover', () => {
  it('uses server Evidence-based topics only for a matching current client snapshot', () => {
    const c = customer()
    const local = buildLocalConsultationTopics(c)
    const server = {
      ...local,
      topics: [{ ...local.topics[0], title: '服务器确认的咨询线索', source: 'EVIDENCE', evidence_ids: ['EVD-1'] }],
    }
    const response = {
      customerId: c.id,
      meta: { consultationClientFingerprint: local.source_fingerprint || '' },
      consultation_topics: server,
    }
    expect(currentConsultationTopics(response, local)).toBe(server)
  })

  it('shows current local topics while the response belongs to older notes or another customer', () => {
    const before = customer()
    const current = customer({ notes: '最近经济压力很大' })
    const local = buildLocalConsultationTopics(current)
    const old = buildLocalConsultationTopics(before)
    const oldResponse = { customerId: before.id, meta: { consultationClientFingerprint: old.source_fingerprint || '' }, consultation_topics: old }
    expect(currentConsultationTopics(oldResponse, local)).toBe(local)
    expect(currentConsultationTopics({ ...oldResponse, customerId: 'CUS-OTHER' }, local)).toBe(local)
    expect(currentConsultationTopics(null, local)).toBe(local)
  })

  it('never trusts a mismatched server topic customerId, even with a matching client fingerprint', () => {
    const c = customer()
    const local = buildLocalConsultationTopics(c)
    const server = { ...local, customer_id: 'CUS-OTHER' }
    expect(currentConsultationTopics({
      customerId: c.id,
      meta: { consultationClientFingerprint: local.source_fingerprint || '' },
      consultation_topics: server,
    }, local)).toBe(local)
  })
})
