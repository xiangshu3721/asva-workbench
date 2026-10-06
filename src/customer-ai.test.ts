import { describe, expect, it } from 'vitest'
import { assembleCustomerContext, createLocalBrief, createLocalCoreSummary } from './customer-ai'
import { seedDatabase } from './data'

function intelligence(customerId: string) {
  const context = assembleCustomerContext(seedDatabase, customerId, '2026-10-06T12:00:00.000Z')
  const summary = createLocalCoreSummary(context)
  return { context, summary, brief: createLocalBrief(context, summary) }
}

describe('ASVA customer understanding engine', () => {
  it('TEST01 downgrades meaningless input instead of inventing a profile', () => {
    const { summary, brief } = intelligence('C00001319')
    expect(summary.confidence).toBe('LOW')
    expect(summary.overview).toContain('信息较少')
    expect(summary.core_issues).toEqual(['尚待澄清'])
    expect(summary.risk.level).toBe('UNASSESSED')
    expect(brief.confirmed[0]).toContain('不足以形成稳定判断')
    expect(brief.suggested_questions.length).toBeLessThanOrEqual(4)
  })

  it('TEST02 connects relationship change and career uncertainty', () => {
    const { summary, brief } = intelligence('C00001320')
    expect(summary.overview).toContain('关系变化')
    expect(summary.overview).toContain('职业方向')
    expect(summary.priority_topics).toEqual(expect.arrayContaining(['恢复近期生活稳定感', '确认睡眠与日常功能影响', '把职业困惑落到现实选择']))
    expect(brief.entry_points.join('')).toContain('生活')
    expect(brief.interaction_guidance.avoid.join('')).toContain('关系')
  })

  it('TEST03 adds a natural care cue for a child illness context', () => {
    const { brief } = intelligence('C00001321')
    expect(brief.interaction_guidance.care_cues.join('')).toContain('孩子')
    expect(brief.suggested_questions.join('')).toContain('睡眠')
    expect(brief.suggested_questions.length).toBeLessThanOrEqual(4)
  })

  it('TEST04 uses concrete questions for a concise customer', () => {
    const { brief } = intelligence('C00001322')
    expect(brief.suggested_questions.length).toBeLessThanOrEqual(4)
    expect(brief.suggested_questions.join('')).toContain('工作')
    expect(brief.interaction_guidance.pace).toContain('具体')
  })

  it('TEST05 treats explicit safety signals as a human safety handoff', () => {
    const { summary, brief } = intelligence('C00001323')
    expect(summary.risk.level).toBe('HIGH')
    expect(brief.entry_points[0]).toContain('暂停普通课程')
    expect(brief.interaction_guidance.avoid.join('')).toContain('课程推荐')
    expect(brief.suggested_questions.join('')).toContain('安全')
  })

  it('TEST06 produces customer-specific output instead of one reusable template', () => {
    const divorce = intelligence('C00001320')
    const child = intelligence('C00001321')
    expect(divorce.brief.lede).not.toBe(child.brief.lede)
    expect(divorce.brief.suggested_questions.join('')).not.toContain('孩子最近')
    expect(child.brief.interaction_guidance.care_cues.join('')).toContain('孩子')
  })

  it('TEST07 uses the latest service record as follow-up context', () => {
    const { context, brief } = intelligence('C00001298')
    expect(context.recentSessions[0]?.topic).toBe('离婚后的生活重建')
    expect(brief.suggested_questions.join('')).toContain('生活')
    expect(brief.confirmed.join('')).toContain('关系')
  })
})

