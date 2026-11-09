import { describe, expect, it } from 'vitest'
import { createRuleOneLineUnderstanding, mergeOneLineCustomer, selectOneLineUnderstanding, type OneLineCustomerData } from './one-line-understanding'

const base = (overrides: Partial<OneLineCustomerData> = {}): OneLineCustomerData => ({
  id: 'CUS-1', name: '测试客户', need: '', helpExpectation: '', goal: '', notes: '', source: '管理员手动录入', profileFields: {}, profileFieldMeta: {}, profileVersion: 1, ...overrides,
})

describe('一句话理解 V1 本地摘要', () => {
  it('keeps empty data non-empty without inventing facts', () => {
    const result = createRuleOneLineUnderstanding(base())
    expect(result.text).toBe('当前尚未录入客户的核心情况、身份或需求信息。')
    expect(result.source).toBe('RULE')
  })

  it('supports a gender-only profile', () => {
    expect(createRuleOneLineUnderstanding(base({ profileFields: { gender: '女' } })).text).toBe('目前了解到客户为女性，其他背景与需求尚未录入')
  })

  it('prioritizes the current issue and adds representative profile facts', () => {
    const result = createRuleOneLineUnderstanding(base({ profileFields: { current_core_issue: '工作压力很大', occupation: '咨询师', city: '上海', hobbies: ['旅行', '阅读'], personality_traits: '敏感' } }))
    expect(result.text).toContain('目前主要困扰是工作压力很大')
    expect(result.text).toContain('从事咨询师')
    expect(result.text).toContain('现居上海')
    expect(result.text).not.toContain('敏感')
  })

  it('extracts notes instead of copying a long raw note', () => {
    const notes = '客户最近对工作安排感到困惑，希望先理清下一步。这里是与当前理解无关的内部长段落，不能整段原样展示。'
    const result = createRuleOneLineUnderstanding(base({ notes }))
    expect(result.text).toContain('工作安排感到困惑')
    expect(result.text).not.toContain('这里是与当前理解无关的内部长段落')
  })

  it('keeps third-party and unverified provenance visible', () => {
    const result = createRuleOneLineUnderstanding(base({ notes: '朋友转述：客户最近考虑换工作。', profileFields: { occupation: '设计师' }, profileFieldMeta: { occupation: { source: 'MENTOR_OBSERVATION', confirmed: false, confidence: 0.7, updatedAt: '2026-11-09T00:00:00.000Z' } } }))
    expect(result.sourceNotice).toContain('待核实')
    expect(result.sourceNotice).toContain('第三方转述')
  })

  it('changes the fingerprint when a field is modified or deleted', () => {
    const original = createRuleOneLineUnderstanding(base({ profileFields: { gender: '女', occupation: '设计师' } }))
    const modified = createRuleOneLineUnderstanding(base({ profileFields: { gender: '女', occupation: '教师' } }))
    const deleted = createRuleOneLineUnderstanding(base({ profileFields: { gender: '女' } }))
    expect(modified.inputFingerprint).not.toBe(original.inputFingerprint)
    expect(deleted.inputFingerprint).not.toBe(original.inputFingerprint)
  })

  it('rejects old AI cache and accepts only the same input fingerprint', () => {
    const local = createRuleOneLineUnderstanding(base({ profileFields: { gender: '女' } }))
    const old = selectOneLineUnderstanding({ local, understanding: { one_line_understanding: { text: '旧 AI 理解' } }, meta: { status: 'FRESH', source: 'DEEPSEEK', profileVersion: 1, clientSnapshotFingerprint: 'old-snapshot' } })
    const current = selectOneLineUnderstanding({ local, understanding: { one_line_understanding: { text: '当前 AI 理解', evidence_ids: ['E1'] } }, meta: { status: 'FRESH', source: 'DEEPSEEK', profileVersion: 1, clientSnapshotFingerprint: local.inputFingerprint, inputFingerprint: 'server-evidence-dependent-hash' } })
    expect(old.source).toBe('RULE')
    expect(old.text).toContain('客户为女性')
    expect(current).toMatchObject({ source: 'AI', text: '当前 AI 理解', evidenceIds: ['E1'] })
  })

  it('keeps fresh AI with confirmed Evidence, but immediately falls back when notes change', () => {
    const original = createRuleOneLineUnderstanding(base({ notes: '准备求职', profileFields: { gender: '女' } }))
    const serverMeta = { status: 'FRESH', source: 'DEEPSEEK', profileVersion: 1, inputFingerprint: 'includes-confirmed-evidence', clientSnapshotFingerprint: original.inputFingerprint }
    const ai = { one_line_understanding: { text: '客户正在准备求职。' } }
    expect(selectOneLineUnderstanding({ local: original, understanding: ai, meta: serverMeta }).source).toBe('AI')
    const changed = createRuleOneLineUnderstanding(base({ notes: '已经入职', profileFields: { gender: '女' } }))
    const stale = selectOneLineUnderstanding({ local: changed, understanding: ai, meta: serverMeta })
    expect(stale.source).toBe('RULE')
    expect(stale.text).not.toContain('正在准备求职')
  })

  it('falls back to rules after AI failure and keeps customer switches isolated', () => {
    const first = createRuleOneLineUnderstanding(base({ id: 'CUS-1', profileFields: { gender: '女' } }))
    const second = createRuleOneLineUnderstanding(base({ id: 'CUS-2', profileFields: { gender: '男' } }))
    expect(selectOneLineUnderstanding({ local: first, meta: undefined }).source).toBe('RULE')
    expect(first.text).not.toBe(second.text)
  })

  it('does not let an older loaded profile overwrite a newer customer edit', () => {
    const customer = base({ profileFields: { gender: '女' }, profileVersion: 2 })
    const merged = mergeOneLineCustomer(customer, { customerId: customer.id, profileFields: { gender: '男' }, profileVersion: 1 })
    expect(merged.profileFields?.gender).toBe('女')
  })

  it('calculates the summary well below the 50ms target', () => {
    const customer = base({ need: '理清工作方向', notes: '最近工作压力很大，希望找到下一步。', profileFields: { gender: '女', age: 32, city: '上海', occupation: '咨询师', current_core_issue: '工作压力' } })
    const start = performance.now()
    for (let index = 0; index < 1000; index += 1) createRuleOneLineUnderstanding(customer)
    const elapsed = performance.now() - start
    const perCallMs = elapsed / 1000
    console.info(`[ASVA_PERF] one-line-summary: ${perCallMs.toFixed(4)}ms/call (${elapsed.toFixed(2)}ms/1000)`)
    expect(perCallMs).toBeLessThan(0.5)
  })
})
