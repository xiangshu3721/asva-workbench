import { describe, expect, it } from 'vitest'
import { buildConsultationPanelView } from './consultation-panel-view'
import type { ConsultationTopicsResponse, ConsultationTopicSignal } from './clientApi'

function signal(overrides: Partial<ConsultationTopicSignal> = {}): ConsultationTopicSignal {
  return {
    title: '亲密关系方面的咨询方向', kind: 'PROVISIONAL_DIRECTION',
    source: 'NOTES', source_ref: 'notes', excerpt: '更多咨询情感问题',
    evidence_ids: [], verification_status: 'UNKNOWN', temporal_status: 'CURRENT',
    specific_problem_known: false, unknowns: ['具体困扰与现实影响尚待确认'],
    ...overrides,
  }
}
function result(topics: ConsultationTopicSignal[], overrides: Partial<ConsultationTopicsResponse> = {}): ConsultationTopicsResponse {
  return {
    schema_version: 'consultation-topics-v1', customer_id: 'CUS-1', source_fingerprint: 'snapshot-1',
    status: topics.length ? 'HAS_SIGNALS' : 'INSUFFICIENT_INFORMATION', topics,
    ...overrides,
  }
}

describe('stage 3 consultation panel consistency', () => {
  it('uses a recorded consultation direction for both core issue and matching opening', () => {
    const view = buildConsultationPanelView('CUS-1', result([signal()]))
    expect(view.state).toBe('HAS_SIGNALS')
    expect(view.issues).toEqual([expect.objectContaining({
      title: '亲密关系方面的咨询方向', kind: 'PROVISIONAL_DIRECTION',
      sourceLabel: '客户备注', verificationLabel: '具体内容待确认',
    })])
    expect(view.entryPoints).toHaveLength(1)
    expect(view.entryPoints[0].suggested_entry).toContain('亲密关系')
    expect(view.entryPoints[0].suggested_entry).not.toMatch(/关系冲突|创伤|依恋|人格/)
  })

  it('shows explicitly reported stress without treating an unverified source as a proven fact', () => {
    const view = buildConsultationPanelView('CUS-1', result([signal({
      kind: 'EXPLICIT_CONCERN', title: '最近工作压力很大，经常睡不好',
      excerpt: '最近工作压力很大，经常睡不好', source: 'EVIDENCE',
      verification_status: 'UNKNOWN', evidence_ids: ['EVD-1'], specific_problem_known: true,
    })]))
    expect(view.issues[0]).toMatchObject({
      title: '最近工作压力很大，经常睡不好',
      kind: 'EXPLICIT_CONCERN', evidenceIds: ['EVD-1'],
      verificationLabel: '具体内容待确认',
    })
    expect(view.entryPoints[0].evidence_ids).toEqual(['EVD-1'])
    expect(view.entryPoints[0].suggested_entry).toContain('工作压力')
  })

  it('preserves multiple topics and derives each opening from the corresponding lead', () => {
    const view = buildConsultationPanelView('CUS-1', result([
      signal({ kind: 'EXPLICIT_CONCERN', title: '工作持续拖延让我很焦虑', excerpt: '工作持续拖延让我很焦虑', source: 'RECORDED_FIELD', specific_problem_known: true }),
      signal({ title: '亲密关系方面的咨询方向' }),
      signal({ title: '家庭与亲子方面的咨询方向' }),
      signal({ title: '职业与发展方面的咨询方向' }),
    ]))
    expect(view.issues).toHaveLength(3)
    expect(view.entryPoints).toHaveLength(2)
    expect(view.entryPoints[0].suggested_entry).toContain('工作持续拖延')
    expect(view.entryPoints[1].suggested_entry).toContain('亲密关系')
    expect(view.entryPoints[1].suggested_entry).not.toContain('职业与发展')
  })

  it('shows a consistent unknown state without inventing a topic or hiding the opening', () => {
    const view = buildConsultationPanelView('CUS-1', result([]))
    expect(view).toMatchObject({ state: 'INSUFFICIENT_INFORMATION', issues: [] })
    expect(view.entryPoints).toHaveLength(1)
    expect(view.entryPoints[0].suggested_entry).toContain('最近有什么事情')
  })

  it('does not mix other customers’ topics or a missing API response into the current customer', () => {
    const mismatched = buildConsultationPanelView('CUS-2', result([signal()]))
    const unavailable = buildConsultationPanelView('CUS-1', null)
    expect(mismatched).toMatchObject({ state: 'UNAVAILABLE', issues: [] })
    expect(unavailable).toMatchObject({ state: 'UNAVAILABLE', issues: [] })
    expect(mismatched.entryPoints[0].suggested_entry).not.toContain('亲密关系')
    expect(unavailable.entryPoints[0].suggested_entry).not.toContain('情感')
  })

  it('does not expose a historical or invalid signal as a current issue', () => {
    const view = buildConsultationPanelView('CUS-1', result([
      signal({ temporal_status: 'HISTORICAL', kind: 'EXPLICIT_CONCERN', title: '过去的情感困扰', excerpt: '过去的情感困扰' }),
      signal({ temporal_status: 'CURRENT', kind: 'PROVISIONAL_DIRECTION', title: '职业与发展方面的咨询方向', excerpt: '想聊职业方向' }),
    ]))
    expect(view.issues).toHaveLength(1)
    expect(view.issues[0].title).toBe('职业与发展方面的咨询方向')
    expect(view.entryPoints[0].suggested_entry).toContain('职业与发展')
  })

  it('labels human verification as source verification, not psychological confirmation', () => {
    const view = buildConsultationPanelView('CUS-1', result([signal({ verification_status: 'HUMAN_VERIFIED', source: 'SUPPLEMENTARY' })]))
    expect(view.issues[0].verificationLabel).toBe('资料已人工核实')
    expect(view.issues[0].kind).toBe('PROVISIONAL_DIRECTION')
    expect(view.entryPoints[0].confidence).toBe('LOW')
  })

  it('is pure and stable for unchanged responses', () => {
    const input = result([signal()])
    const frozen = JSON.stringify(input)
    expect(buildConsultationPanelView('CUS-1', input)).toEqual(buildConsultationPanelView('CUS-1', input))
    expect(JSON.stringify(input)).toBe(frozen)
  })
})
