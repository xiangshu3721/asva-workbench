import { describe, expect, it } from 'vitest'
import { buildPrivacyClassificationPrompt, classifyPrivacyText, privacySafeText, resolvePrivacyPolicy } from './privacy-guard.mjs'

describe('R040 privacy guard', () => {
  it('classifies ordinary work information as NORMAL', () => {
    expect(classifyPrivacyText('目前住在杭州，从事品牌设计工作。').privacyLevel).toBe('NORMAL')
  })

  it('keeps ordinary financial information at SENSITIVE', () => {
    expect(classifyPrivacyText('收入约一万六，固定支出八千五。').privacyLevel).toBe('SENSITIVE')
  })

  it('classifies self-harm content as HIGH_SENSITIVE with a safety flag', () => {
    const result = classifyPrivacyText('我今晚准备伤害自己。')
    expect(result.privacyLevel).toBe('HIGH_SENSITIVE')
    expect(result.safetyFlags).toContain('SELF_HARM')
  })

  it('classifies suicide risk independently from privacy level', () => {
    const result = classifyPrivacyText('如果活着没意思就结束算了。')
    expect(result.safetyFlags).toContain('SUICIDE_RISK')
    expect(resolvePrivacyPolicy(result)).toMatchObject({ canUseInStage5: true, canUseInSales: false })
  })

  it('does not treat a political news sentence as high by keyword alone', () => {
    expect(classifyPrivacyText('最近战争新闻让我很焦虑。').privacyLevel).toBe('SENSITIVE')
  })

  it('recognizes non-needed identity information', () => {
    const result = classifyPrivacyText('身份证号：110101199001011234')
    expect(result.containsNonNeededIdentity).toBe(true)
    expect(result.categories).toContain('NON_NEEDED_IDENTITY')
  })

  it('never promotes non-needed identity information to profile', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['NON_NEEDED_IDENTITY'] }).canPromoteToProfile).toBe(false)
  })

  it('detects an unverified allegation about a third party', () => {
    const result = classifyPrivacyText('客户说老公拿朋友的钱去诈骗。')
    expect(result.containsThirdPartyAllegation).toBe(true)
    expect(result.assertionType).toBe('CLIENT_REPORTED')
    expect(result.verification).toBe('UNVERIFIED')
  })

  it('blocks third-party allegations from confirmed profile promotion', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['THIRD_PARTY_ALLEGATION'], assertionType: 'CLIENT_REPORTED' })).toMatchObject({ canPromoteToProfile: false, canUseInSales: false })
  })

  it('allows admins to view high-sensitive raw content', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', currentRole: 'ADMIN' }).canViewRaw).toBe(true)
  })

  it('blocks owner mentors from high-sensitive raw content', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', currentRole: 'MENTOR' }).canViewRaw).toBe(false)
  })

  it('gives owner mentors a safe summary instead of raw content', () => {
    const result = classifyPrivacyText('她去年经历过性侵。')
    expect(privacySafeText(result)).not.toContain('性侵')
    expect(privacySafeText(result)).toContain('谨慎')
    expect('请谨慎处理，必要时咨询专业督导老师。').toContain('谨慎')
  })

  it('keeps safety processing available to mentors', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', safetyFlags: ['SUICIDE_RISK'], currentRole: 'MENTOR' })).toMatchObject({ canUseInStage5: true, canViewSafeSummary: true })
  })

  it('excludes high-sensitive content from sales by default', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['TRAUMA'] }).canUseInSales).toBe(false)
  })

  it('allows confirmed financial facts to remain available for sales rules', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'SENSITIVE', categories: ['FINANCIAL_PRIVATE'] }).canUseInSales).toBe(true)
  })

  it('allows normal content in the ordinary global AI context', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'NORMAL' }).canUseInGlobalAI).toBe(true)
  })

  it('blocks high-sensitive content from a mentor global AI context', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', currentRole: 'MENTOR' }).canUseInGlobalAI).toBe(false)
  })

  it('keeps the classifier prompt structured and independent', () => {
    const prompt = buildPrivacyClassificationPrompt('我最近很焦虑。')
    expect(prompt).toContain('privacyLevel')
    expect(prompt).toContain('严格返回 JSON')
  })

  it('keeps ordinary family conflict usable by the owner mentor', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'SENSITIVE', categories: ['FAMILY_SECRET'], currentRole: 'MENTOR' })).toMatchObject({ canViewRaw: true, canUseInStage4: true })
  })

  it('uses a strict policy for unknown levels', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'UNKNOWN', currentRole: 'MENTOR' }).canViewRaw).toBe(false)
  })

  it('does not make a client-reported criminal claim a sales signal', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['LEGAL_CRIMINAL_ALLEGATION'], assertionType: 'CLIENT_REPORTED' }).canUseInSales).toBe(false)
  })

  it('keeps a high-sensitive safety summary non-specific', () => {
    const result = classifyPrivacyText('我有过自杀的想法，但现在没有计划。')
    expect(result.mentorSafeSummary).toContain('安全评估')
    expect(result.mentorSafeSummary).not.toContain('自杀')
  })

  it('does not classify the word 性 alone as sexual private content', () => {
    expect(classifyPrivacyText('我希望提升表达性和创造性。').privacyLevel).toBe('NORMAL')
  })

  it('returns all required privacy metadata keys', () => {
    expect(classifyPrivacyText('普通记录')).toEqual(expect.objectContaining({ privacyLevel: 'NORMAL', categories: expect.any(Array), subjects: expect.any(Array), safetyFlags: expect.any(Array), mentorSafeSummary: expect.any(String) }))
  })

  it('separates privacy from safety as independent output dimensions', () => {
    const result = classifyPrivacyText('我很焦虑，但没有自伤想法。')
    expect(result).toHaveProperty('privacyLevel')
    expect(result).toHaveProperty('safetyFlags')
  })
})

