import { describe, expect, it } from 'vitest'
import { buildConsultationInputSnapshot } from './consultation-input-snapshot.mjs'

const source = (overrides = {}) => ({ id: 'SRC-1', customerId: 'CUS-1', sourceType: 'DOCUMENT', title: '客户资料', occurredAt: '2026-11-01T00:00:00.000Z', uploadedAt: '2026-11-02T00:00:00.000Z', processingStatus: 'COMPLETED', ...overrides })
const evidence = (overrides = {}) => ({ id: 'EVD-1', customerId: 'CUS-1', sourceId: 'SRC-1', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', fieldKey: 'current_core_issue', displayText: '最近工作压力很大', sourceExcerpt: '我最近工作压力很大', occurredAt: '2026-11-10T00:00:00.000Z', reviewStatus: 'CONFIRMED', contentSource: 'CUSTOMER_DIRECT', ...overrides })
const session = (overrides = {}) => ({ id: 'SRV-1', customerId: 'CUS-1', date: '2026-11-09T00:00:00.000Z', topic: '工作压力', note: '客户描述最近工作压力很大', profileText: '希望先稳定作息', result: '继续跟进', nextStep: '确认具体影响', ...overrides })

describe('consultation input snapshot', () => {
  it('collects existing fields, notes, supplementary information, communications, sources and Evidence', () => {
    const snapshot = buildConsultationInputSnapshot({
      customer: {
        id: 'CUS-1',
        need: '最近工作压力很大',
        goal: '稳定作息',
        helpExpectation: '先找到能执行的一步',
        notes: '客户补充：近期正在考虑换工作。',
        profileUpdatedAt: '2026-11-08T00:00:00.000Z',
        profileFields: { occupation: '设计师' },
        profileFieldMeta: { occupation: { source: 'MENTOR_CONFIRMED', confirmed: true, updatedAt: '2026-11-08T00:00:00.000Z' } },
        supplementaryItems: [{ id: 'SUP-1', text: '客户希望先理清换工作的影响', source: 'MENTOR_OBSERVATION', reviewStatus: 'PENDING_REVIEW' }],
      },
      sourceRecords: [source()],
      evidenceItems: [evidence()],
      sessions: [session()],
      now: '2026-11-14T00:00:00.000Z',
    })

    expect(snapshot.schema_version).toBe('consultation-input-v1')
    expect(snapshot.current.profile_fields).toMatchObject({ occupation: '设计师', current_core_issue: '最近工作压力很大' })
    expect(snapshot.current.notes).toMatchObject({ source: 'CUSTOMER_NOTES', recorded_at: '2026-11-08T00:00:00.000Z' })
    expect(snapshot.current.supplementary[0]).toMatchObject({ supplementary_id: 'SUP-1', verification_status: 'UNVERIFIED' })
    expect(snapshot.historical.communications[0]).toMatchObject({ service_record_id: 'SRV-1', source: 'SERVICE_RECORD', recorded_at: '2026-11-09T00:00:00.000Z', verification_status: 'HUMAN_VERIFIED' })
    expect(snapshot.current.evidence[0]).toMatchObject({ evidence_id: 'EVD-1', source_id: 'SRC-1', source_title: '客户资料', source_excerpt: '我最近工作压力很大', verification_status: 'HUMAN_VERIFIED', occurred_at: '2026-11-10T00:00:00.000Z' })
  })

  it('keeps current and historical Evidence distinct while preserving provenance status', () => {
    const snapshot = buildConsultationInputSnapshot({
      customer: { id: 'CUS-1', profileFields: {} },
      sourceRecords: [source()],
      evidenceItems: [
        evidence(),
        evidence({ id: 'EVD-OLD', semanticKind: 'EVENT', fieldKey: 'occupation', displayText: '2024 年曾从事销售', sourceExcerpt: '2024 年曾从事销售', occurredAt: '2024-06-01T00:00:00.000Z', reviewStatus: 'PENDING_REVIEW' }),
      ],
      now: '2026-11-14T00:00:00.000Z',
    })

    expect(snapshot.current.evidence.map((item) => item.evidence_id)).toEqual(['EVD-1'])
    expect(snapshot.historical.evidence).toEqual([expect.objectContaining({ evidence_id: 'EVD-OLD', temporal_status: 'HISTORICAL', verification_status: 'UNVERIFIED', occurred_at: '2024-06-01T00:00:00.000Z' })])
  })

  it('uses the same normalization for legacy fields and structured profile fields', () => {
    const legacy = buildConsultationInputSnapshot({ customer: { id: 'CUS-1', need: '理清工作方向', goal: '找到下一步', helpExpectation: '获得提问帮助' } })
    const structured = buildConsultationInputSnapshot({ customer: { id: 'CUS-1', profileFields: { current_core_issue: '理清工作方向', current_goal: '找到下一步', current_expectation: '获得提问帮助' } } })

    expect(legacy.current.profile_fields).toMatchObject(structured.current.profile_fields)
    expect(legacy.current.recorded_fields.map((item) => item.value)).toEqual(structured.current.recorded_fields.map((item) => item.value))
    expect(legacy.input_fingerprint).toBe(structured.input_fingerprint)
  })

  it('isolates all input collections by customer id', () => {
    const snapshot = buildConsultationInputSnapshot({
      customer: { id: 'CUS-1', notes: '只属于客户一' },
      sourceRecords: [source(), source({ id: 'SRC-2', customerId: 'CUS-2', title: '客户二资料' })],
      evidenceItems: [evidence(), evidence({ id: 'EVD-2', customerId: 'CUS-2', sourceId: 'SRC-2', displayText: '客户二资料' })],
      sessions: [session(), session({ id: 'SRV-2', customerId: 'CUS-2', note: '客户二沟通' })],
    })

    expect(snapshot.customer_id).toBe('CUS-1')
    expect(snapshot.sources.map((item) => item.source_id)).toEqual(['SRC-1'])
    expect(snapshot.all_evidence.map((item) => item.evidence_id)).toEqual(['EVD-1'])
    expect(snapshot.historical.communications.map((item) => item.service_record_id)).toEqual(['SRV-1'])
  })
})
