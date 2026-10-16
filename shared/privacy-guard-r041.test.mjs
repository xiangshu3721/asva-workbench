import { describe, expect, it } from 'vitest'
import { applyServiceNecessityOverride, buildConsultationContext, buildSalesContext, classifyPrivacyText, classifyTemporalText, resolvePrivacyPolicy } from './privacy-guard.mjs'

describe('R041 service necessity and minimum disclosure', () => {
  it('classifies all service necessity levels deterministically', () => {
    expect(classifyPrivacyText('身份证号：110101199001011234').serviceNecessity).toBe('LOW')
    expect(classifyPrivacyText('她去年经历过性侵，正在处理关系中的信任问题。').serviceNecessity).toBe('RELEVANT')
    expect(classifyPrivacyText('昨晚她站在阳台边，表达过想跳下去的念头。').serviceNecessity).toBe('CRITICAL')
  })

  it('uses temporal classification to distinguish future, recent, current, and historical information', () => {
    expect(classifyTemporalText('她计划下个月去深圳看看。')).toBe('FUTURE_PLAN')
    expect(classifyTemporalText('昨晚发生了争吵。')).toBe('RECENT')
    expect(classifyTemporalText('她目前长期住在杭州。')).toBe('CURRENT')
    expect(classifyTemporalText('十年前经历过一次重大事件。')).toBe('HISTORICAL')
  })

  it('keeps historical safety context relevant instead of critical', () => {
    const result = classifyPrivacyText('十年前有过一次自伤，之后一直没有。')
    expect(result.privacyLevel).toBe('HIGH_SENSITIVE')
    expect(result.serviceNecessity).toBe('RELEVANT')
  })

  it('forces current and recent safety signals to critical', () => {
    for (const text of ['我现在有自杀计划。', '昨晚又想过跳下去。', '目前正在被家暴。']) {
      expect(classifyPrivacyText(text).serviceNecessity).toBe('CRITICAL')
    }
  })

  it('does not promote a resolved historical safety statement to current critical', () => {
    const result = classifyPrivacyText('我有过自杀的想法，但现在没有计划。')
    expect(result.serviceNecessity).not.toBe('CRITICAL')
    expect(result.mentorSafeSummary).toContain('安全评估')
  })

  it('keeps non-needed identity at the deterministic low floor', () => {
    const result = resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['NON_NEEDED_IDENTITY'], serviceNecessity: 'CRITICAL', currentRole: 'MENTOR' })
    expect(result.serviceNecessity).toBe('LOW')
    expect(result.canViewRaw).toBe(false)
    expect(result.canViewServiceDetail).toBe(false)
  })

  it('allows owner mentors service detail for high relevant material', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['INTIMATE_RELATIONSHIP'], serviceNecessity: 'RELEVANT', currentRole: 'MENTOR', isAssignedMentor: true })).toMatchObject({ canViewRaw: false, canViewServiceDetail: true, canViewNecessaryExcerpt: false })
  })

  it('allows only necessary excerpts for high critical material', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['SUICIDE_RISK'], safetyFlags: ['SUICIDE_RISK'], serviceNecessity: 'CRITICAL', currentRole: 'MENTOR', isAssignedMentor: true })).toMatchObject({ canViewRaw: false, canViewServiceDetail: true, canViewNecessaryExcerpt: true, canViewSafetyDetail: true })
  })

  it('keeps admin raw access while preserving policy metadata', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['SUICIDE_RISK'], serviceNecessity: 'CRITICAL', currentRole: 'ADMIN' })).toMatchObject({ canViewRaw: true, canViewServiceDetail: true, canViewNecessaryExcerpt: true })
  })

  it('blocks other mentors even when service necessity is critical', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', categories: ['SUICIDE_RISK'], safetyFlags: ['SUICIDE_RISK'], serviceNecessity: 'CRITICAL', currentRole: 'MENTOR', isAssignedMentor: false })).toMatchObject({ canViewRaw: false, canViewServiceDetail: false, canViewSafetyDetail: false })
  })

  it('grounds a necessary excerpt to the original source sentence', () => {
    const source = '身份证号：110101199001011234。昨晚她站在阳台边，想过跳下去。'
    const result = classifyPrivacyText(source)
    expect(result.necessaryExcerpt).toBe('昨晚她站在阳台边，想过跳下去')
    expect(source).toContain(result.necessaryExcerpt)
    expect(result.necessaryExcerpt).not.toContain('身份证')
  })

  it('does not create a necessary excerpt without a grounded safety sentence', () => {
    const result = classifyPrivacyText('资料显示存在风险，但没有可核对的具体原话。')
    expect(result.necessaryExcerpt).toBe('')
  })

  it('keeps service detail abstract and excludes unnecessary identity content', () => {
    const result = classifyPrivacyText('身份证号：110101199001011234。客户经历过婚外关系，正在影响亲密关系。')
    expect(result.mentorServiceDetail).not.toContain('110101199001011234')
    expect(result.mentorServiceDetail).toContain('关系')
  })

  it('keeps third-party allegations unverified', () => {
    const result = classifyPrivacyText('客户说丈夫可能骗了朋友很多钱。')
    expect(result.assertionType).toBe('CLIENT_REPORTED')
    expect(result.verification).toBe('UNVERIFIED')
    expect(result.mentorServiceDetail).toContain('尚未核实')
  })

  it('does not promote high-sensitive material into the profile', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', serviceNecessity: 'RELEVANT' }).canPromoteToProfile).toBe(false)
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', serviceNecessity: 'CRITICAL', safetyFlags: ['SUICIDE_RISK'] }).canPromoteToProfile).toBe(false)
  })

  it('keeps sales access abstract even when consultation detail is allowed', () => {
    const evidence = { id: 'E1', sourceId: 'S1', displayText: '具体婚外关系细节', sourceExcerpt: '具体婚外关系细节', privacyLevel: 'HIGH_SENSITIVE', privacyMeta: classifyPrivacyText('她存在婚外关系，当前影响亲密关系。') }
    const result = buildSalesContext({ evidenceItems: [evidence], sourceRecords: [{ id: 'S1', privacyLevel: 'HIGH_SENSITIVE', privacyMeta: evidence.privacyMeta }] })
    expect(result).toHaveLength(1)
    expect(result[0].displayText).not.toContain('婚外关系细节')
    expect(result[0].sourceExcerpt).toBe('')
    expect(result[0].standardValue).toBeUndefined()
  })

  it('does not expose safety quotes to sales context', () => {
    const meta = classifyPrivacyText('昨晚我站在阳台边，想过跳下去。')
    const result = buildSalesContext({ evidenceItems: [{ id: 'E1', sourceId: 'S1', displayText: meta.necessaryExcerpt, sourceExcerpt: meta.necessaryExcerpt, privacyLevel: 'HIGH_SENSITIVE', privacyMeta: meta }], sourceRecords: [{ id: 'S1', privacyLevel: 'HIGH_SENSITIVE', privacyMeta: meta }] })
    expect(result[0].displayText).not.toContain('阳台')
    expect(result[0].displayText).not.toContain('跳下去')
  })

  it('keeps normal and non-high sensitive sales evidence usable', () => {
    const result = buildSalesContext({ evidenceItems: [{ id: 'E1', sourceId: 'S1', displayText: '当前城市为杭州', sourceExcerpt: '当前城市为杭州', privacyLevel: 'NORMAL', privacyMeta: {} }], sourceRecords: [{ id: 'S1', privacyLevel: 'NORMAL', privacyMeta: {} }] })
    expect(result).toHaveLength(1)
    expect(result[0].displayText).toBe('当前城市为杭州')
  })

  it('separates consultation context from sales context', () => {
    const meta = classifyPrivacyText('她去年经历过婚外关系，目前正在处理信任问题。')
    const evidence = { id: 'E1', sourceId: 'S1', displayText: '具体私密细节', sourceExcerpt: '具体私密细节', privacyLevel: 'HIGH_SENSITIVE', privacyMeta: meta }
    const source = { id: 'S1', privacyLevel: 'HIGH_SENSITIVE', privacyMeta: meta }
    const consultation = buildConsultationContext({ role: 'MENTOR', isAssignedMentor: true, evidenceItems: [evidence], sourceRecords: [source] })
    const sales = buildSalesContext({ evidenceItems: [evidence], sourceRecords: [source] })
    expect(consultation).toHaveLength(1)
    expect(consultation[0].mentorServiceDetail).toContain('关系')
    expect(sales[0].displayText).not.toContain('私密细节')
  })

  it('keeps low necessity high-sensitive information out of consultation context', () => {
    const meta = classifyPrivacyText('身份证号：110101199001011234')
    const result = buildConsultationContext({ role: 'MENTOR', evidenceItems: [{ id: 'E1', sourceId: 'S1', displayText: '身份证号', sourceExcerpt: '身份证号', privacyLevel: 'HIGH_SENSITIVE', privacyMeta: meta }], sourceRecords: [{ id: 'S1', privacyLevel: 'HIGH_SENSITIVE', privacyMeta: meta }] })
    expect(result).toHaveLength(0)
  })

  it('allows service-relevant medical information without converting self-report into diagnosis', () => {
    const meta = classifyPrivacyText('客户说自己可能有双相，但没有医疗诊断。')
    expect(meta.mentorServiceDetail).toContain('客户提到')
    expect(meta.mentorServiceDetail).not.toContain('确诊')
  })

  it('uses a safe summary for current safety information', () => {
    const result = classifyPrivacyText('昨晚她站在阳台边，想过跳下去。')
    expect(result.salesSafeSummary).toContain('不应将脆弱处境作为成交依据')
    expect(result.salesSafeSummary).not.toContain('阳台')
  })

  it('preserves explicit confirmation and source attribution in metadata', () => {
    const result = classifyPrivacyText('客户说丈夫可能诈骗朋友。')
    expect(result.assertionType).toBe('CLIENT_REPORTED')
    expect(result.verification).toBe('UNVERIFIED')
    expect(result.salesSafeSummary).toBeTruthy()
  })

  it('admin override changes the suggested level without bypassing deterministic floors', () => {
    expect(applyServiceNecessityOverride({ categories: ['INTIMATE_RELATIONSHIP'], serviceNecessity: 'RELEVANT' }, 'CRITICAL').serviceNecessity).toBe('CRITICAL')
    expect(applyServiceNecessityOverride({ categories: ['SUICIDE_RISK'], safetyFlags: ['SUICIDE_RISK'], temporalType: 'RECENT', serviceNecessity: 'RELEVANT' }, 'LOW').serviceNecessity).toBe('CRITICAL')
    expect(applyServiceNecessityOverride({ categories: ['NON_NEEDED_IDENTITY'], serviceNecessity: 'CRITICAL' }, 'RELEVANT').serviceNecessity).toBe('LOW')
  })

  it('does not allow high-sensitive context into global AI', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', serviceNecessity: 'CRITICAL', currentRole: 'MENTOR' }).canUseInGlobalAI).toBe(false)
  })

  it('keeps safety detail available to the owner mentor only when critical', () => {
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', safetyFlags: ['SUICIDE_RISK'], serviceNecessity: 'RELEVANT', currentRole: 'MENTOR' }).canViewSafetyDetail).toBe(false)
    expect(resolvePrivacyPolicy({ privacyLevel: 'HIGH_SENSITIVE', safetyFlags: ['SUICIDE_RISK'], serviceNecessity: 'CRITICAL', currentRole: 'MENTOR' }).canViewSafetyDetail).toBe(true)
  })
})
