import { describe, expect, it } from 'vitest'
import { buildConsultationInputSnapshot } from './consultation-input-snapshot.mjs'
import { buildConsultationTopics } from './consultation-topics.mjs'

const read = ({ customer = {}, evidenceItems = [], sessions = [], conflicts = [] } = {}) =>
  buildConsultationTopics(buildConsultationInputSnapshot({ customer: { id: 'CUS-1', ...customer }, evidenceItems, sessions, conflicts, now: '2026-11-14T00:00:00.000Z' }))
const evidence = (overrides = {}) => ({
  id: 'EV-1', customerId: 'CUS-1', sourceId: 'SRC-1', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE',
  fieldKey: 'current_core_issue', displayText: '最近工作压力很大', sourceExcerpt: '最近工作压力很大',
  contentSource: 'CUSTOMER_DIRECT', reviewStatus: 'CONFIRMED', verificationStatus: 'HUMAN_VERIFIED',
  temporalType: 'CURRENT', ...overrides,
})

describe('consultation topic signals v1', () => {
  it('identifies a stated current concern while keeping source verification separate', () => {
    const result = read({ customer: { notes: '最近和伴侣总是争吵，我觉得很疲惫。' } })
    expect(result.status).toBe('HAS_SIGNALS')
    expect(result.topics[0]).toMatchObject({ kind: 'EXPLICIT_CONCERN', verification_status: 'UNKNOWN', source: 'NOTES' })
    expect(result.topics[0].excerpt).toContain('争吵')
  })

  it('keeps a stated intent as pending direction without inventing a concrete problem', () => {
    const result = read({ customer: { need: '更多咨询情感问题' } })
    expect(result.topics).toEqual([expect.objectContaining({ title: '亲密关系方面的咨询方向', kind: 'PROVISIONAL_DIRECTION', specific_problem_known: false, evidence_ids: [] })])
    expect(JSON.stringify(result)).not.toMatch(/缺乏安全感|感情创伤|关系冲突/)
  })

  it('handles a legacy discussion note and preserves its source', () => {
    const result = read({ customer: { notes: '从事幼教老师；对于目前工作的探讨，以及未来的发展。' } })
    expect(result.topics).toEqual([expect.objectContaining({ title: '职业与发展方面的咨询方向', source: 'NOTES', verification_status: 'UNKNOWN' })])
  })

  it('keeps two independent concerns rather than collapsing the record to one category', () => {
    const result = read({ customer: { notes: '最近工作压力大，也和伴侣总是争吵。' } })
    expect(result.topics.map((item) => item.kind)).toEqual(['EXPLICIT_CONCERN', 'EXPLICIT_CONCERN'])
    expect(result.topics.map((item) => item.title).join('')).toContain('工作')
    expect(result.topics.map((item) => item.title).join('')).toContain('伴侣')
  })

  it('does not turn identity or life events into a consultation topic', () => {
    const result = read({ customer: { profileFields: { marital_status: '离异', occupation: '老师', relationship_status: '有男朋友' }, notes: '在广州工作，有两个孩子。' } })
    expect(result).toMatchObject({ status: 'INSUFFICIENT_INFORMATION', topics: [] })
  })

  it('skips explicit denials and resolved history', () => {
    const result = read({ customer: { notes: '不需要咨询情感问题。三年前工作压力很大。现在已经解决。' } })
    expect(result.topics).toEqual([])
  })

  it('never promotes AI inference, unapproved hypotheses or mentor speculation', () => {
    const result = read({ customer: { supplementaryItems: [
      { id: 'S1', text: 'AI 总结：客户存在情感焦虑', source: 'AI_INFERENCE' },
      { id: 'S2', text: '导师觉得她可能缺乏安全感并感到焦虑', source: 'MENTOR_OBSERVATION' },
    ] }, evidenceItems: [evidence({ id: 'EV-H', evidenceType: 'HYPOTHESIS', displayText: 'AI 推测她有婚姻冲突' })] })
    expect(result.topics).toEqual([])
  })

  it('keeps an unverified AI-extracted reported intent provisional, never a verified fact', () => {
    const result = read({ customer: { supplementaryItems: [{ id: 'S1', text: '有男朋友，更多咨询情感问题', source: 'AI_EXTRACTED', verificationStatus: 'UNVERIFIED' }] } })
    expect(result.topics[0]).toMatchObject({ kind: 'PROVISIONAL_DIRECTION', verification_status: 'UNVERIFIED', source: 'SUPPLEMENTARY' })
  })

  it('preserves verified Evidence source IDs without borrowing another customer’s data', () => {
    const result = read({ evidenceItems: [
      evidence(), evidence({ id: 'EV-2', customerId: 'CUS-2', displayText: '和伴侣持续争吵' }),
    ] })
    expect(result.topics).toEqual([expect.objectContaining({ kind: 'EXPLICIT_CONCERN', evidence_ids: ['EV-1'] })])
    expect(JSON.stringify(result)).not.toContain('EV-2')
  })

  it('excludes conflicting and historical Evidence from current topics', () => {
    const result = read({ evidenceItems: [evidence({ id: 'EV-CONFLICT' }), evidence({ id: 'EV-OLD', temporalType: 'HISTORICAL', displayText: '过去感情关系很困难' })], conflicts: [
      { customerId: 'CUS-1', status: 'OPEN', fieldKey: 'current_core_issue', currentEvidenceId: 'EV-CONFLICT', newEvidenceId: 'EV-MISSING' },
    ] })
    expect(result.topics).toEqual([])
  })

  it('does not confuse a goal or service expectation alone with a current concern', () => {
    const result = read({ customer: { goal: '稳定作息', helpExpectation: '先找到能执行的一步', profileFields: { current_goal: '希望稳定作息', occupation: '设计师' } } })
    expect(result.topics).toEqual([])
  })

  it('ignores historical communication records as proof of a current concern', () => {
    const result = read({ sessions: [{ id: 'S1', customerId: 'CUS-1', date: '2024-01-01', note: '当时与伴侣争吵很严重' }] })
    expect(result.topics).toEqual([])
  })

  it('is deterministic with the same input and does not mutate the snapshot', () => {
    const snapshot = buildConsultationInputSnapshot({ customer: { id: 'CUS-1', notes: '想聊职业发展' }, now: '2026-11-14T00:00:00.000Z' })
    const before = JSON.stringify(snapshot)
    expect(buildConsultationTopics(snapshot)).toEqual(buildConsultationTopics(snapshot))
    expect(JSON.stringify(snapshot)).toBe(before)
  })
})
