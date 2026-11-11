import { describe, expect, it } from 'vitest'
import { applyCurrentIssuePolicy, buildCustomerUnderstandingContext, classifyUnderstandingContextDensity, createLocalCustomerUnderstanding, normalizeCustomerUnderstanding, qualityCheckCustomerUnderstanding, understandingInputFingerprint } from './customer-understanding.mjs'

const customer = { id: 'CUS-1', profileVersion: 2, need: '最近工作节奏很乱', helpExpectation: '先找到能执行的一步', profileFields: { city: '杭州', occupation: '自由职业', current_goal: '稳定作息', phone: '15000000000' } }
const fact = (overrides = {}) => ({ id: 'EVD-1', sourceId: 'SRC-1', customerId: 'CUS-1', evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', fieldKey: 'current_goal', standardValue: '稳定作息', displayText: '目前希望稳定作息', sourceExcerpt: '我希望先稳定作息', confidence: 0.9, reviewStatus: 'CONFIRMED', ...overrides })

describe('CustomerUnderstandingV1 contract', () => {
  it('builds a structured, redacted context with current and historical separation', () => {
    const context = buildCustomerUnderstandingContext({ customer, evidenceItems: [fact(), fact({ id: 'EVD-2', semanticKind: 'EVENT', fieldKey: 'occupation', displayText: '后来转为自由职业', occurredAt: '2025' }), fact({ id: 'EVD-3', evidenceType: 'HYPOTHESIS', displayText: '可能存在某种人格类型', reviewStatus: 'CONFIRMED' })] })
    expect(context.current_snapshot.phone).toBeUndefined()
    expect(context.current_goals[0].evidence_ids).toContain('EVD-1')
    expect(context.top_life_events[0].evidence_ids).toContain('EVD-2')
    expect(context.working_hypotheses[0].evidence_ids).toContain('EVD-3')
    expect(context.evidence_refs.map((item) => item.evidence_id)).toEqual(expect.arrayContaining(['EVD-1', 'EVD-2', 'EVD-3']))
  })

  it('does not promote pending Evidence into current facts or goals', () => {
    const context = buildCustomerUnderstandingContext({
      customer: { id: 'CUS-1', profileVersion: 1, profileFields: {} },
      evidenceItems: [fact({ id: 'EVD-PENDING', reviewStatus: 'PENDING_REVIEW', standardValue: '可能想创业', displayText: '可能想创业', fieldKey: 'current_goal' })],
    })
    expect(context.current_snapshot.current_goal).not.toBe('可能想创业')
    expect(context.current_goals).toEqual([])
    expect(context.current_needs).toEqual([])
    expect(context.evidence_refs.find((item) => item.evidence_id === 'EVD-PENDING').verification_status).toBeNull()
  })

  it('does not promote AI-written unconfirmed profile fields into current facts', () => {
    const context = buildCustomerUnderstandingContext({
      customer: {
        id: 'CUS-1',
        profileFields: { city: '深圳', occupation: '自由职业', education: '本科' },
        profileFieldMeta: {
          city: { confirmed: false, source: 'AI_EXTRACTED' },
          occupation: { confirmed: true, source: 'HUMAN_CONFIRMED' },
        },
      },
      evidenceItems: [],
    })
    expect(context.current_snapshot.city).toBeUndefined()
    expect(context.current_snapshot.occupation).toBe('自由职业')
    expect(context.current_snapshot.education).toBe('本科')
  })

  it('changes fingerprint when confirmed evidence changes', () => {
    expect(understandingInputFingerprint({ customer, evidenceItems: [fact()] })).not.toBe(understandingInputFingerprint({ customer, evidenceItems: [fact({ id: 'EVD-2' })] }))
  })

  it('includes recorded customer notes and needs in the understanding context and fingerprint', () => {
    const withNotes = { ...customer, notes: '最近睡眠变差，希望先理清工作安排。', need: '降低工作压力', goal: '恢复稳定节奏', helpExpectation: '先找到一小步' }
    const context = buildCustomerUnderstandingContext({ customer: withNotes, evidenceItems: [] })
    expect(context.recorded_context).toMatchObject({ notes: '最近睡眠变差，希望先理清工作安排。', current_need: '降低工作压力', current_goal: '恢复稳定节奏', help_expectation: '先找到一小步' })
    expect(context.current_needs.map((item) => item.text)).toEqual(expect.arrayContaining(['降低工作压力', '恢复稳定节奏']))
    expect(understandingInputFingerprint({ customer, evidenceItems: [] })).not.toBe(understandingInputFingerprint({ customer: withNotes, evidenceItems: [] }))
  })

  it('keeps a sparse customer understandable without inventing a confirmed fact', () => {
    const local = createLocalCustomerUnderstanding({ generated_at: '2026-01-01T00:00:00.000Z', recorded_context: { current_need: '降低工作压力' }, current_needs: [], resources: [], top_life_events: [], coverage_gaps: [], evidence_refs: [] })
    expect(local.one_line_understanding.text).toBe('降低工作压力')
    expect(local.one_line_understanding.confidence).toBe('LOW')
    expect(local.one_line_understanding.evidence_ids).toEqual([])
  })

  it('uses existing notes in the conservative local one-line fallback', () => {
    const value = createLocalCustomerUnderstanding({ generated_at: '2026-01-01T00:00:00.000Z', recorded_context: { notes: '29岁，在杭州工作，最近对职业方向感到困惑。' }, evidence_refs: [], coverage_gaps: ['职业事业'] })
    expect(value.one_line_understanding.text).toContain('29岁，在杭州工作')
    expect(value.one_line_understanding.confidence).toBe('LOW')
    expect(value.one_line_understanding.evidence_ids).toEqual([])
  })

  it('forms a conservative one-line understanding from recorded customer facts without evidence', () => {
    const context = buildCustomerUnderstandingContext({ customer: { ...customer, need: '最近工作压力很大', goal: '找到下一步方向' }, evidenceItems: [] })
    const local = createLocalCustomerUnderstanding(context)
    expect(local.one_line_understanding.text).toBe('最近工作压力很大')
    expect(local.one_line_understanding.evidence_ids).toEqual([])
    expect(local.one_line_understanding.confidence).toBe('LOW')
  })

  it('uses notes for a sparse customer instead of treating the record as empty', () => {
    const context = buildCustomerUnderstandingContext({ customer: { ...customer, need: '', goal: '', helpExpectation: '', notes: '客户正在考虑职业转型。' }, evidenceItems: [] })
    const local = createLocalCustomerUnderstanding(context)
    expect(local.one_line_understanding.text).toContain('已录入资料：客户正在考虑职业转型。')
    expect(local.one_line_understanding.confidence).toBe('LOW')
  })

  it('rejects unsupported diagnosis and unknown evidence references', () => {
    const normalized = normalizeCustomerUnderstanding({ one_line_understanding: { text: '这是抑郁症', evidence_ids: ['NOPE'], confidence: 'HIGH', type: 'SYNTHESIS' }, knowledge_gaps: [{ text: '待确认' }] }, { evidenceIds: ['EVD-1'] })
    const result = qualityCheckCustomerUnderstanding(normalized, { evidenceIds: ['EVD-1'] })
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining(['UNSUPPORTED_DIAGNOSIS', 'UNKNOWN_EVIDENCE_REF']))
  })

  it('keeps an explicit unknown path in the deterministic fallback', () => {
    const local = createLocalCustomerUnderstanding({ generated_at: '2026-01-01T00:00:00.000Z', current_needs: [], resources: [], top_life_events: [], coverage_gaps: ['当前状态'], evidence_refs: [] })
    expect(local.knowledge_gaps.length).toBeGreaterThan(0)
    expect(local.one_line_understanding.confidence).toBe('LOW')
  })

  it('uses tension sides as the title and preserves an actionable conversation entry', () => {
    const normalized = normalizeCustomerUnderstanding({
      key_tensions: [{ text: '待进一步确认', side_a: '熟悉职业路径', side_b: '探索新方向', evidence_ids: ['EVD-1'], confidence: 'MEDIUM', type: 'SYNTHESIS' }],
      next_conversation: [{ focus: '还原最近一次争吵的变化过程', why_now: '先找到可观察的触发点', suggested_entry: '她持续说你的时候，你最先发生了什么变化？', evidence_ids: ['EVD-1'], confidence: 'HIGH', type: 'SYNTHESIS' }],
      knowledge_gaps: [{ question: '伴侣如何理解这次冲突？' }],
    }, { evidenceIds: ['EVD-1'] })
    expect(normalized.key_tensions[0].text).toBe('熟悉职业路径 ↔ 探索新方向')
    expect(normalized.next_conversation[0].focus).toBe('还原最近一次争吵的变化过程')
    expect(normalized.next_conversation[0].suggested_entry).toContain('你最先发生了什么变化')
  })

  it('classifies sparse context only when at least two sparse signals are present', () => {
    expect(classifyUnderstandingContextDensity({ profileCoverage: 20, confirmedEvidenceCount: 4, sourceCount: 1, knownDomainCount: 2, lifeEventCount: 0 }).classification).toBe('SPARSE')
    expect(classifyUnderstandingContextDensity({ profileCoverage: 55, confirmedEvidenceCount: 16, sourceCount: 2, knownDomainCount: 5, lifeEventCount: 2 }).classification).toBe('MEDIUM')
    expect(classifyUnderstandingContextDensity({ profileCoverage: 90, confirmedEvidenceCount: 30, sourceCount: 5, knownDomainCount: 9, lifeEventCount: 4 }).classification).toBe('RICH')
    expect(classifyUnderstandingContextDensity({ profileCoverage: 90, confirmedEvidenceCount: 30, sourceCount: 5, knownDomainCount: 9, lifeEventCount: 4 }).policy_version).toBe('DENSITY_V1')
  })

  it('keeps basic demographics out of current core issues', () => {
    const context = buildCustomerUnderstandingContext({ customer: { id: 'CUS-BASE', profileFields: { gender: '女性', age: 31 } }, evidenceItems: [] })
    expect(createLocalCustomerUnderstanding(context).top_issues).toEqual([])
  })

  it('uses one confirmed explicit concern as the primary local issue', () => {
    const context = buildCustomerUnderstandingContext({ customer: { id: 'CUS-ONE', profileFields: {} }, evidenceItems: [fact({ id: 'EVD-ONE', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: '最近项目交付反复拖延，影响收入', standardValue: '最近项目交付反复拖延，影响收入' })] })
    expect(createLocalCustomerUnderstanding(context).top_issues[0]).toMatchObject({ text: '最近项目交付反复拖延，影响收入', evidence_ids: ['EVD-ONE'] })
  })

  it('ranks an explicit customer concern ahead of related current states', () => {
    const context = buildCustomerUnderstandingContext({ customer: { id: 'CUS-RANK', profileFields: {} }, evidenceItems: [
      fact({ id: 'EVD-STATE', fieldKey: 'sleep', displayText: '近期睡眠不稳', standardValue: '近期睡眠不稳', confidence: 0.7 }),
      fact({ id: 'EVD-NEED', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: '希望先处理工作压力对收入的影响', standardValue: '希望先处理工作压力对收入的影响', sourcePerspective: 'CUSTOMER_FIRST_PARTY', confidence: 0.7 }),
    ] })
    expect(context.current_issue_candidates.evidence[0].evidence_ids).toEqual(['EVD-NEED'])
    expect(createLocalCustomerUnderstanding(context).top_issues[0].text).toBe('希望先处理工作压力对收入的影响')
  })

  it('does not treat a resolved historical event as a current issue', () => {
    const context = buildCustomerUnderstandingContext({ customer: { id: 'CUS-HISTORY', profileFields: {} }, evidenceItems: [fact({ id: 'EVD-OLD', semanticKind: 'EVENT', fieldKey: 'past_issue', displayText: '2024 年的失业经历已解决', standardValue: '2024 年的失业经历已解决', occurredAt: '2024-03-01' })] })
    expect(context.current_issue_candidates.evidence).toEqual([])
    expect(createLocalCustomerUnderstanding(context).top_issues).toEqual([])
  })

  it('moves conflicting current facts out of issue candidates instead of choosing one', () => {
    const current = fact({ id: 'EVD-CURRENT', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: '仍受职业选择困扰', standardValue: '仍受职业选择困扰' })
    const historical = fact({ id: 'EVD-HISTORY', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: '职业选择已经明确', standardValue: '职业选择已经明确' })
    const context = buildCustomerUnderstandingContext({ customer: { id: 'CUS-CONFLICT', profileFields: {} }, evidenceItems: [current, historical], conflicts: [{ status: 'OPEN', fieldKey: 'current_core_issue', currentEvidenceId: 'EVD-CURRENT', newEvidenceId: 'EVD-HISTORY' }] })
    expect(context.current_issue_candidates.evidence).toEqual([])
    expect(createLocalCustomerUnderstanding(context).top_issues).toEqual([])
  })

  it('keeps unconfirmed AI hypotheses out of current core issues', () => {
    const context = buildCustomerUnderstandingContext({ customer: { id: 'CUS-HYPOTHESIS', profileFields: {} }, evidenceItems: [fact({ id: 'EVD-HYPOTHESIS', evidenceType: 'HYPOTHESIS', reviewStatus: 'PENDING_REVIEW', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: 'AI 推测存在关系焦虑', standardValue: 'AI 推测存在关系焦虑' })] })
    expect(context.current_issue_candidates.evidence).toEqual([])
    expect(createLocalCustomerUnderstanding(context).top_issues).toEqual([])
  })

  it('deduplicates repeated or highly similar issue output', () => {
    const filtered = applyCurrentIssuePolicy({ top_issues: [
      { title: '项目拖延影响收入', text: '项目拖延影响收入', evidence_ids: ['EVD-1'], confidence: 'HIGH', type: 'FACT_BASED' },
      { title: '项目反复拖延，收入受影响', text: '项目反复拖延，收入受影响', evidence_ids: ['EVD-1'], confidence: 'HIGH', type: 'FACT_BASED' },
      { title: '伴侣沟通减少', text: '伴侣沟通减少', evidence_ids: ['EVD-1'], confidence: 'MEDIUM', type: 'FACT_BASED' },
    ] }, { currentIssueEvidenceIds: ['EVD-1'] })
    expect(filtered.top_issues.map((item) => item.title)).toEqual(['项目拖延影响收入', '伴侣沟通减少'])
  })

  it('changes the issue context and fingerprint when new current information arrives', () => {
    const before = buildCustomerUnderstandingContext({ customer: { id: 'CUS-UPDATE', profileFields: {} }, evidenceItems: [fact({ id: 'EVD-BEFORE', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: '希望稳定作息', standardValue: '希望稳定作息' })] })
    const afterEvidence = fact({ id: 'EVD-AFTER', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: '近期合同中断，优先处理收入安排', standardValue: '近期合同中断，优先处理收入安排', sourcePerspective: 'CUSTOMER_FIRST_PARTY', confidence: 0.99 })
    const after = buildCustomerUnderstandingContext({ customer: { id: 'CUS-UPDATE', profileFields: {} }, evidenceItems: [fact({ id: 'EVD-BEFORE', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: '希望稳定作息', standardValue: '希望稳定作息' }), afterEvidence] })
    expect(after.input_fingerprint).not.toBe(before.input_fingerprint)
    expect(createLocalCustomerUnderstanding(after).top_issues[0].text).toBe('近期合同中断，优先处理收入安排')
  })

  it('keeps an important current concern in the prompt context with many Evidence records', () => {
    const background = Array.from({ length: 30 }, (_, index) => fact({ id: `EVD-BULK-${index}`, semanticKind: 'CURRENT_STATE', fieldKey: `state_${index}`, displayText: `一般当前状态 ${index}`, standardValue: `一般当前状态 ${index}`, confidence: 0.1, occurredAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}` }))
    const important = fact({ id: 'EVD-IMPORTANT', semanticKind: 'NEED', fieldKey: 'current_core_issue', displayText: '合同刚中断，收入安排需要尽快确认', standardValue: '合同刚中断，收入安排需要尽快确认', sourcePerspective: 'CUSTOMER_FIRST_PARTY', confidence: 0.99 })
    const context = buildCustomerUnderstandingContext({ customer: { id: 'CUS-BULK', profileFields: {} }, evidenceItems: [...background, important] })
    expect(context.current_issue_candidates.evidence.map((item) => item.evidence_ids[0])).toContain('EVD-IMPORTANT')
    expect(context.evidence_refs.map((item) => item.evidence_id)).toContain('EVD-IMPORTANT')
  })

  it('normalizes legacy understanding data without requiring new issue fields', () => {
    const legacy = normalizeCustomerUnderstanding({ top_issues: [{ text: '工作压力增大', evidence_ids: ['EVD-1'], confidence: 'MEDIUM', type: 'SYNTHESIS' }], knowledge_gaps: [{ text: '近期现实影响' }] }, { evidenceIds: ['EVD-1'] })
    expect(legacy.top_issues[0].text).toBe('工作压力增大')
    expect(legacy.knowledge_gaps[0].text).toBe('近期现实影响')
  })
})
