import { describe, expect, it } from 'vitest'
import { isSnapshotEvidence, materializeCustomerProfile, shouldAutoConfirmEvidence, summaryInputFingerprint } from './profile-materialization.mjs'

const customer = { profileFields: { city: '杭州', birth_date: '1992-03-22', hometown: '安徽阜阳' } }

function evidence(overrides) {
  return { id: 'EVD-1', sourceId: 'SRC-1', customerId: 'CUS-1', evidenceType: 'FACT', semanticKind: 'PROFILE_FIELD', fieldKey: 'birth_date', standardValue: '1992-03-22', displayText: '出生日期：1992年3月22日', sourceExcerpt: '1992年3月22日出生', confidence: 0.95, reviewStatus: 'CONFIRMED', occurredAt: null, ...overrides }
}

describe('CustomerProfileRenderer materialization', () => {
  it('keeps high-confidence empty-field facts eligible for snapshot materialization', () => {
    expect(isSnapshotEvidence(evidence({ fieldKey: 'birth_date' }))).toBe(true)
    expect(isSnapshotEvidence(evidence({ fieldKey: 'occupation', semanticKind: 'EVENT' }))).toBe(false)
  })

  it('renders confirmed events and grounded evidence without hypotheses', () => {
    const result = materializeCustomerProfile({ customer, evidenceItems: [
      evidence({ id: 'EVD-BIRTH', fieldKey: 'birth_date' }),
      evidence({ id: 'EVD-EVENT', semanticKind: 'EVENT', fieldKey: null, displayText: '18岁离乡读大学', sourceExcerpt: '18岁离乡读大学', occurredAt: '18岁' }),
      evidence({ id: 'EVD-CAREER', semanticKind: 'EVENT', fieldKey: 'occupation', displayText: '房地产销售并成为销冠', sourceExcerpt: '约20岁进入房地产销售并成为销冠' }),
      evidence({ id: 'EVD-HYP', evidenceType: 'HYPOTHESIS', semanticKind: 'OTHER', fieldKey: null, displayText: '可能缺乏安全感', sourceExcerpt: '推测', reviewStatus: 'CONFIRMED' }),
    ] })
    expect(result.sections.find((section) => section.title === 'TA是谁').items.some((item) => item.text === '1992-03-22')).toBe(true)
    expect(result.sections.find((section) => section.title === '职业与事业').items.some((item) => item.text.includes('房地产销售'))).toBe(true)
    expect(result.lifeEvents.map((item) => item.title)).toEqual(expect.arrayContaining(['18岁离乡读大学', '房地产销售并成为销冠']))
    expect(result.sections.flatMap((section) => section.items).some((item) => item.text.includes('缺乏安全感'))).toBe(false)
    expect(result.coverage.percentage).toBeGreaterThan(0)
  })

  it('renders recorded current issue and goal even when no evidence exists', () => {
    const result = materializeCustomerProfile({ customer: { need: '最近工作压力很大', helpExpectation: '先梳理优先级', goal: '找到下一步方向', profileFields: { current_core_issue: '最近工作压力很大', current_expectation: '先梳理优先级', current_goal: '找到下一步方向' } }, evidenceItems: [] })
    const section = result.sections.find((item) => item.title === '当前状态与目标')
    expect(section.items.map((item) => item.text)).toEqual(expect.arrayContaining(['最近工作压力很大', '先梳理优先级', '找到下一步方向']))
  })

  it('materializes Customers base fields when profileFields is empty and there is no evidence', () => {
    const result = materializeCustomerProfile({
      customer: {
        profileFields: {},
        age: 35,
        city: '杭州',
        occupation: '设计师',
        maritalStatus: '已婚',
        familySummary: '与家人同住',
        need: '正在考虑职业转型',
        helpExpectation: '希望梳理职业方向',
        goal: '三个月内确定下一步',
        notes: '客户情况来自基础资料录入',
      },
      evidenceItems: [],
    })
    const rendered = result.sections.flatMap((section) => section.items).map((item) => item.text)
    expect(rendered).toEqual(expect.arrayContaining(['35', '杭州', '设计师', '已婚', '与家人同住', '正在考虑职业转型', '希望梳理职业方向', '三个月内确定下一步']))
    expect(result.rawNotes).toBe('客户情况来自基础资料录入')
    expect(result.coverage.percentage).toBeGreaterThan(0)
  })

  it('keeps raw notes separate from confirmed facts and labels profile metadata', () => {
    const result = materializeCustomerProfile({
      customer: {
        notes: '客户正在考虑职业转型。',
        profileFields: { occupation: '设计师', current_goal: '探索新的方向', sleep: '一般' },
        profileFieldMeta: {
          occupation: { source: 'MENTOR_CONFIRMED', confirmed: true },
          current_goal: { source: 'AI_INFERENCE', confirmed: false },
          sleep: { source: 'MENTOR_FACTUAL_INPUT', confirmed: false },
        },
      },
      evidenceItems: [],
    })
    const fields = result.sections.flatMap((section) => section.items)
    expect(result.rawNotes).toBe('客户正在考虑职业转型。')
    expect(fields.find((item) => item.label === '当前职业')).toMatchObject({ statusLabel: '人工已确认' })
    expect(fields.find((item) => item.label === '当前目标')).toMatchObject({ statusLabel: 'AI推断 · 待验证' })
    expect(fields.find((item) => item.label === '睡眠情况')).toMatchObject({ statusLabel: '导师记录 · 待核实' })
    expect(fields.map((item) => item.text)).not.toContain('客户正在考虑职业转型。')
  })

  it('keeps existing formal profile fields ahead of legacy base-field fallbacks', () => {
    const result = materializeCustomerProfile({
      customer: { profileFields: { current_core_issue: '已确认的当前困扰' }, need: '旧基础字段内容' },
      evidenceItems: [],
    })
    const current = result.sections.find((section) => section.title === '当前状态与目标')
    expect(current?.items.map((item) => item.text)).toContain('已确认的当前困扰')
    expect(current?.items.map((item) => item.text)).not.toContain('旧基础字段内容')
  })

  it('keeps raw notes separate from structured fields and uses human labels', () => {
    const result = materializeCustomerProfile({ customer: { profileFields: { relationship_status: '恋爱中' }, notes: '最近和伴侣沟通不顺。' }, evidenceItems: [] })
    const relationship = result.sections.find((section) => section.title === '家庭与关系')
    expect(relationship.items[0]).toMatchObject({ label: '亲密关系状态', text: '恋爱中', statusLabel: '已录入' })
    expect(result.rawNotes).toBe('最近和伴侣沟通不顺。')
    expect(result.sections.flatMap((section) => section.items).map((item) => item.text)).not.toContain('最近和伴侣沟通不顺。')
  })

  it('uses profile metadata to distinguish entered, human-confirmed and AI-inferred fields', () => {
    const result = materializeCustomerProfile({
      customer: {
        profileFields: { occupation: '设计师', current_goal: '想做自己感兴趣的事业', sleep: '一般' },
        profileFieldMeta: {
          occupation: { source: 'MENTOR_CONFIRMED', confirmed: true },
          current_goal: { source: 'AI_INFERENCE', confirmed: false },
          sleep: { source: 'MENTOR_FACTUAL_INPUT', confirmed: false },
        },
      },
      evidenceItems: [],
    })
    const fields = result.sections.flatMap((section) => section.items)
    expect(fields.find((item) => item.label === '当前职业')).toMatchObject({ statusLabel: '人工已确认' })
    expect(fields.find((item) => item.label === '当前目标')).toMatchObject({ statusLabel: 'AI推断 · 待验证' })
    expect(fields.find((item) => item.label === '睡眠情况')).toMatchObject({ statusLabel: '导师记录 · 待核实' })
  })

  it('keeps a work location out of the current residence field in the display projection', () => {
    const result = materializeCustomerProfile({
      customer: { profileFields: {}, city: '', age: '', gender: '' },
      evidenceItems: [evidence({ id: 'EVD-WORK-CITY', fieldKey: 'city', semanticKind: 'CURRENT_STATE', standardValue: '杭州', displayText: '工作地点：杭州', sourceExcerpt: '她在杭州工作。' })],
    })
    expect(result.sections.find((section) => section.title === 'TA是谁')?.items.map((item) => item.text)).not.toContain('杭州')
    expect(result.sections.find((section) => section.title === '职业与事业')?.items.map((item) => item.text)).toContain('工作地点：杭州')
  })

  it('keeps the real empty state when neither base fields nor profile fields exist', () => {
    const result = materializeCustomerProfile({ customer: { profileFields: {} }, evidenceItems: [] })
    expect(result.sections.every((section) => section.items.length === 0)).toBe(true)
    expect(result.coverage.percentage).toBe(0)
  })

  it('only auto-confirms factual event evidence, never hypothesis', () => {
    expect(shouldAutoConfirmEvidence(evidence({ semanticKind: 'EVENT' }))).toBe(true)
    expect(shouldAutoConfirmEvidence(evidence({ semanticKind: 'EVENT', evidenceType: 'HYPOTHESIS' }))).toBe(false)
  })

  it('moves summary state from stale to fresh only for the matching materialization input', () => {
    const evidenceItems = [evidence({ id: 'EVD-FRESH' })]
    const fingerprint = summaryInputFingerprint({ customer, evidenceItems })
    expect(materializeCustomerProfile({ customer, evidenceItems }).aiSummaryStatus).toBe('STALE')
    expect(materializeCustomerProfile({ customer, evidenceItems, summaryMeta: { status: 'FRESH', inputFingerprint: fingerprint } }).aiSummaryStatus).toBe('FRESH')
    expect(materializeCustomerProfile({ customer, evidenceItems, summaryMeta: { status: 'FRESH', inputFingerprint: 'old' } }).aiSummaryStatus).toBe('STALE')
  })

  it('projects ordinary unconfirmed evidence without turning it into a confirmed fact', () => {
    const result = materializeCustomerProfile({ customer, evidenceItems: [
      evidence({ id: 'EVD-PENDING', reviewStatus: 'PENDING_REVIEW', fieldKey: 'occupation', semanticKind: 'EVENT', displayText: '最近开始探索心理学方向', sourceExcerpt: '她说最近开始探索心理学方向', contentSource: 'STAFF_TRANSCRIBED_CUSTOMER', informationNature: 'PERSONAL_STATEMENT', verificationStatus: 'SOURCE_SUPPORTED' }),
      evidence({ id: 'EVD-AI', reviewStatus: 'PENDING_REVIEW', evidenceType: 'HYPOTHESIS', fieldKey: 'personality_traits', semanticKind: 'OTHER', displayText: '可能比较回避冲突', sourceExcerpt: '模型推测', informationNature: 'AI_INFERENCE', verificationStatus: 'UNKNOWN' }),
      evidence({ id: 'EVD-CONFIRMED', reviewStatus: 'CONFIRMED', fieldKey: 'city', standardValue: '杭州', displayText: '现居杭州' }),
    ] })
    expect(result.provisionalItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: 'EVD-PENDING', fieldKey: 'occupation', verificationStatus: 'SOURCE_SUPPORTED', sectionTitle: '职业与事业' }),
      expect.objectContaining({ evidenceId: 'EVD-AI', label: '待验证洞察' }),
    ]))
    expect(result.provisionalItems).not.toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: 'EVD-CONFIRMED' })]))
    expect(result.sections.find((section) => section.title === 'TA是谁').items.some((item) => item.text === '杭州')).toBe(true)
  })

  it('does not project superseded or rejected evidence and deduplicates repeated display text', () => {
    const result = materializeCustomerProfile({ customer, evidenceItems: [
      evidence({ id: 'EVD-OLD', reviewStatus: 'SUPERSEDED', displayText: '旧资料' }),
      evidence({ id: 'EVD-REJECTED', reviewStatus: 'REJECTED', displayText: '被拒资料' }),
      evidence({ id: 'EVD-1', reviewStatus: 'PENDING_REVIEW', displayText: '近期睡眠有所改善', sourceExcerpt: '近期睡眠有所改善', fieldKey: 'energy_state', semanticKind: 'CURRENT_STATE' }),
      evidence({ id: 'EVD-2', reviewStatus: 'PENDING_REVIEW', displayText: '近期睡眠有所改善', sourceExcerpt: '近期睡眠有所改善', fieldKey: 'energy_state', semanticKind: 'CURRENT_STATE' }),
    ] })
    expect(result.provisionalItems.map((item) => item.evidenceId)).not.toEqual(expect.arrayContaining(['EVD-OLD', 'EVD-REJECTED']))
    expect(result.provisionalItems.filter((item) => item.text === '近期睡眠有所改善')).toHaveLength(1)
    expect(result.provisionalItems.find((item) => item.text === '近期睡眠有所改善').evidenceIds).toEqual(['EVD-1', 'EVD-2'])
  })

  it('shows persisted fallback information as pending instead of dropping it', () => {
    const result = materializeCustomerProfile({
      customer: {
        profileFields: {},
        profileFieldMeta: {},
        supplementaryItems: [{ id: 'SUP-1', text: '客户补充信息：希望逐步尝试新的工作方向', source: 'AI_EXTRACTED', confirmed: false, sourceRecordId: 'SRC-1', evidenceId: 'EVD-1' }],
      },
      evidenceItems: [],
    })
    expect(result.supplementaryItems).toHaveLength(1)
    expect(result.supplementaryItems[0]).toMatchObject({ label: '客户补充信息', statusLabel: '待核实' })
    expect(result.sections.find((section) => section.title === '客户补充信息')?.items[0].text).toContain('希望逐步尝试')
  })

  it('keeps an automatically extracted field visible as pending with its source basis', () => {
    const result = materializeCustomerProfile({
      customer: { profileFields: { career_goal: '想做自己感兴趣的事业' }, profileFieldMeta: { career_goal: { source: 'AI_EXTRACTED', confirmed: false, evidenceId: 'EVD-1' } } },
      evidenceItems: [{ id: 'EVD-1', fieldKey: 'career_goal', standardValue: '想做自己感兴趣的事业', displayText: '事业目标：想做自己感兴趣的事业', sourceExcerpt: '想做自己感兴趣的事业', sourceId: 'SRC-1', customerId: 'CUS-1', reviewStatus: 'PENDING_REVIEW', evidenceType: 'FACT', semanticKind: 'GOAL' }],
    })
    const item = result.sections.find((section) => section.title === '职业与事业')?.items.find((candidate) => candidate.label === '事业目标')
    expect(item).toMatchObject({ text: '想做自己感兴趣的事业', statusLabel: '待核实' })
    expect(item.basis[0]).toMatchObject({ evidenceId: 'EVD-1', sourceId: 'SRC-1' })
    expect(result.provisionalItems).toHaveLength(0)
  })
})
