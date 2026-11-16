import { describe, expect, it } from 'vitest'
import { buildConsultationPanelView } from './consultation-panel-view'
import type { ConsultationTopicsResponse } from './clientApi'
// @ts-expect-error Shared JavaScript runtime has no TS declaration in this repository.
import { buildConsultationInputSnapshot } from '../shared/consultation-input-snapshot.mjs'
// @ts-expect-error Shared JavaScript runtime has no TS declaration in this repository.
import { buildConsultationTopics } from '../shared/consultation-topics.mjs'

// Offline synthetic GOLDEN SET: no actual customer records, no model/network calls.
// Evaluate the same chain used for visible mentor opening cards:
// customer snapshot -> source-aware topics -> H5 consultation panel.
type Kind = 'EXPLICIT_CONCERN' | 'PROVISIONAL_DIRECTION'
type Fixture = {
  id: string
  title: string
  customer?: Record<string, unknown>
  evidenceItems?: Array<Record<string, unknown>>
  sessions?: Array<Record<string, unknown>>
  conflicts?: Array<Record<string, unknown>>
  expected: 'HAS_SIGNALS' | 'INSUFFICIENT_INFORMATION'
  kind?: Kind
  subject?: string
  issueCount?: number
  excerptMarkerMustNotAppear?: string
}

const directEvidence = (customerId: string, id = 'EV-SYNTHETIC') => ({
  id, customerId, sourceId: 'SRC-SYNTHETIC', evidenceType: 'FACT',
  semanticKind: 'CURRENT_STATE', fieldKey: 'current_core_issue',
  displayText: '最近工作压力很大', sourceExcerpt: '最近工作压力很大',
  contentSource: 'CUSTOMER_DIRECT', reviewStatus: 'CONFIRMED',
  verificationStatus: 'HUMAN_VERIFIED', temporalType: 'CURRENT',
})

const fixtures: Fixture[] = [
  { id: 'S6C-01', title: 'work distress', customer: { notes: '最近工作压力很大，经常睡不好。' }, expected: 'HAS_SIGNALS', kind: 'EXPLICIT_CONCERN', subject: '工作压力' },
  { id: 'S6C-02', title: 'relationship conflict', customer: { notes: '最近和伴侣总是争吵，我觉得很疲惫。' }, expected: 'HAS_SIGNALS', kind: 'EXPLICIT_CONCERN', subject: '伴侣' },
  { id: 'S6C-03', title: 'relationship inquiry only', customer: { need: '更多咨询情感问题' }, expected: 'HAS_SIGNALS', kind: 'PROVISIONAL_DIRECTION', subject: '亲密关系' },
  { id: 'S6C-04', title: 'career discussion only', customer: { notes: '对于目前工作的探讨，以及未来的发展。' }, expected: 'HAS_SIGNALS', kind: 'PROVISIONAL_DIRECTION', subject: '职业与发展' },
  { id: 'S6C-05', title: 'sleep complaint', customer: { notes: '我最近总是睡不着，影响工作。' }, expected: 'HAS_SIGNALS', kind: 'EXPLICIT_CONCERN', subject: '睡不着' },
  { id: 'S6C-06', title: 'two independent problems', customer: { notes: '最近工作压力大，也和伴侣总是争吵。' }, expected: 'HAS_SIGNALS', kind: 'EXPLICIT_CONCERN', subject: '工作压力', issueCount: 2 },
  { id: 'S6C-07', title: 'demographics alone', customer: { profileFields: { occupation: '老师', marital_status: '离异' }, notes: '在广州工作，有两个孩子。' }, expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-08', title: 'historical distress', customer: { notes: '去年工作压力很大。' }, expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-09', title: 'explicit refusal', customer: { notes: '不需要咨询情感问题。' }, expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-10', title: 'goals not current concerns', customer: { goal: '稳定作息', helpExpectation: '先找到能执行的一步', profileFields: { current_goal: '希望稳定作息' } }, expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-11', title: 'AI speculation', customer: { supplementaryItems: [{ id: 'SUP-AI', text: 'AI 总结：客户存在情感焦虑', source: 'AI_INFERENCE' }] }, expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-12', title: 'mentor speculation', customer: { supplementaryItems: [{ id: 'SUP-MENTOR', text: '导师觉得她可能缺乏安全感并感到焦虑', source: 'MENTOR_OBSERVATION' }] }, expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-13', title: 'third party report', customer: { supplementaryItems: [{ id: 'SUP-3P', text: '客户最近工作压力很大', source: 'THIRD_PARTY_REPORTED' }] }, expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-14', title: 'unverified extracted intent stays provisional', customer: { supplementaryItems: [{ id: 'SUP-U', text: '有男朋友，更多咨询情感问题', source: 'AI_EXTRACTED', verificationStatus: 'UNVERIFIED' }] }, expected: 'HAS_SIGNALS', kind: 'PROVISIONAL_DIRECTION', subject: '亲密关系' },
  { id: 'S6C-15', title: 'confirmed first-party evidence', evidenceItems: [directEvidence('S6C-15')], expected: 'HAS_SIGNALS', kind: 'EXPLICIT_CONCERN', subject: '工作压力' },
  { id: 'S6C-16', title: 'unresolved evidence conflict', evidenceItems: [directEvidence('S6C-16', 'EV-CONFLICT')], conflicts: [{ customerId: 'S6C-16', status: 'OPEN', fieldKey: 'current_core_issue', currentEvidenceId: 'EV-CONFLICT', newEvidenceId: 'EV-NEW' }], expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-17', title: 'old service record', sessions: [{ customerId: 'S6C-17', id: 'SESS-OLD', date: '2024-01-01', note: '当时与伴侣争吵很严重' }], expected: 'INSUFFICIENT_INFORMATION' },
  { id: 'S6C-18', title: 'long evidence excerpt is not repeated in opening', evidenceItems: [{ ...directEvidence('S6C-18'), sourceExcerpt: '最近工作压力很大，工作节奏乱。'.repeat(9) + '仅供资料末尾参考' }], expected: 'HAS_SIGNALS', kind: 'EXPLICIT_CONCERN', subject: '工作压力', excerptMarkerMustNotAppear: '仅供资料末尾参考' },
  { id: 'S6C-19', title: 'foreign customer evidence is not inherited', evidenceItems: [directEvidence('SOMEONE-ELSE', 'EV-FOREIGN')], expected: 'INSUFFICIENT_INFORMATION' },
]

function runFixture(fixture: Fixture) {
  const snapshot = buildConsultationInputSnapshot({
    customer: { id: fixture.id, profileFields: {}, ...fixture.customer },
    evidenceItems: fixture.evidenceItems || [],
    sessions: fixture.sessions || [],
    conflicts: fixture.conflicts || [],
    now: '2026-11-16T00:00:00.000Z',
  })
  const topics = buildConsultationTopics(snapshot) as ConsultationTopicsResponse
  return { topics, view: buildConsultationPanelView(fixture.id, topics) }
}

describe('Stage 6C: synthetic end-to-end consultation quality golden set', () => {
  it.each(fixtures)('$id — $title', (fixture) => {
    const { topics, view } = runFixture(fixture)
    expect(view.state).toBe(fixture.expected)
    expect(view.entryPoints.length).toBeGreaterThanOrEqual(1)
    expect(view.entryPoints.length).toBeLessThanOrEqual(2)

    if (fixture.expected === 'INSUFFICIENT_INFORMATION') {
      expect(topics.topics).toEqual([])
      expect(view.issues).toEqual([])
      expect(view.entryPoints[0]).toMatchObject({ confidence: 'LOW', evidence_ids: [] })
      expect(view.entryPoints[0].suggested_entry).toContain('最近有什么事情')
    } else {
      expect(view.issues[0].kind).toBe(fixture.kind)
      expect(view.entryPoints[0].confidence).toBe('LOW')
      expect(view.entryPoints[0].suggested_entry).toContain(fixture.subject)
      expect(view.entryPoints[0].suggested_entry).toContain('？')
      expect(view.entryPoints[0].suggested_entry).not.toMatch(/缺乏安全感|心理创伤|人格障碍|你一定|你其实/)
      if (fixture.kind === 'PROVISIONAL_DIRECTION') {
        expect(view.entryPoints[0].focus).toContain('不预设已有困扰')
      } else {
        expect(view.entryPoints[0].focus).toContain('具体经历')
      }
    }
    if (fixture.issueCount) {
      expect(view.issues).toHaveLength(fixture.issueCount)
      expect(view.entryPoints).toHaveLength(Math.min(2, fixture.issueCount))
    }
    if (fixture.excerptMarkerMustNotAppear) {
      expect(view.entryPoints[0].suggested_entry).not.toContain(fixture.excerptMarkerMustNotAppear)
    }
  })

  it('retains only the matching first-party evidence id through all three layers', () => {
    const id = 'CASE-EVIDENCE'
    const snapshot = buildConsultationInputSnapshot({
      customer: { id, profileFields: {} },
      evidenceItems: [directEvidence(id, 'EV-OWN'), directEvidence('CASE-OTHER', 'EV-FOREIGN')],
      now: '2026-11-16T00:00:00.000Z',
    })
    const topics = buildConsultationTopics(snapshot) as ConsultationTopicsResponse
    const view = buildConsultationPanelView(id, topics)
    expect(topics.topics[0].evidence_ids).toEqual(['EV-OWN'])
    expect(view.issues[0].evidenceIds).toEqual(['EV-OWN'])
    expect(view.entryPoints[0].evidence_ids).toEqual(['EV-OWN'])
    expect(JSON.stringify({ topics, view })).not.toContain('EV-FOREIGN')
  })

  it('never displays another customer’s signal on a switched customer panel', () => {
    const { topics } = runFixture(fixtures[0])
    const view = buildConsultationPanelView('CASE-DIFFERENT', topics)
    expect(view.state).toBe('UNAVAILABLE')
    expect(view.issues).toEqual([])
    expect(view.entryPoints[0].suggested_entry).not.toContain('工作压力')
  })

  it('is deterministic and does not mutate source data', () => {
    for (const fixture of fixtures) {
      const original = JSON.stringify(fixture)
      expect(runFixture(fixture)).toEqual(runFixture(fixture))
      expect(JSON.stringify(fixture)).toBe(original)
    }
  })
})
