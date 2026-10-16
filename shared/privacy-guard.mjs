export const PRIVACY_LEVELS = new Set(['NORMAL', 'SENSITIVE', 'HIGH_SENSITIVE'])
export const PRIVACY_CATEGORIES = new Set([
  'NON_NEEDED_IDENTITY', 'PSYCHOLOGICAL_HEALTH', 'MEDICAL_PRIVATE', 'INTIMATE_RELATIONSHIP', 'SEXUAL_PRIVATE',
  'REPRODUCTIVE_PRIVATE', 'FAMILY_SECRET', 'FINANCIAL_PRIVATE', 'THIRD_PARTY_PRIVATE', 'THIRD_PARTY_ALLEGATION',
  'SUBSTANCE_USE', 'TRAUMA', 'POLITICAL_PRIVATE', 'RELIGIOUS_PRIVATE', 'MINOR_PRIVATE', 'SELF_HARM', 'SUICIDE_RISK',
  'OTHER_HARM', 'DOMESTIC_VIOLENCE', 'ABUSE', 'LEGAL_CRIMINAL_ALLEGATION',
])
export const PRIVACY_SUBJECTS = new Set(['SELF', 'PARTNER', 'CHILD', 'FAMILY_MEMBER', 'OTHER_THIRD_PARTY', 'UNKNOWN'])

const highPatterns = [
  ['NON_NEEDED_IDENTITY', /身份证|证件号码|身份证号|银行卡|银行卡号|护照号|社保号/],
  ['SUICIDE_RISK', /自杀|结束生命|不想活|活着没意思|跳楼|跳河|自杀计划/],
  ['SELF_HARM', /自伤|伤害自己|割腕|自残/],
  ['OTHER_HARM', /伤害他人|杀人|弄死他|暴力威胁/],
  ['DOMESTIC_VIOLENCE', /家暴|家庭暴力|被打|打我|殴打/],
  ['SEXUAL_PRIVATE', /性侵|强奸|强暴|性取向|发生过性关系|性关系|婚外性/],
  ['REPRODUCTIVE_PRIVATE', /流产|堕胎|备孕|生育隐私|怀孕/],
  ['SUBSTANCE_USE', /吸毒|毒品|戒毒|成瘾/],
  ['TRAUMA', /重大创伤|创伤经历|创伤后/],
  ['LEGAL_CRIMINAL_ALLEGATION', /诈骗|盗窃|赌博|违法|犯罪|非法经营|强奸|性侵/],
  ['POLITICAL_PRIVATE', /政治身份|政治观点|宗教身份|宗教观点|信仰/],
  ['MINOR_PRIVATE', /未成年人|儿童隐私|孩子遭受|儿童遭受/],
]
const sensitivePatterns = [
  ['FINANCIAL_PRIVATE', /收入|工资|债务|负债|存款|支出|经济压力/],
  ['PSYCHOLOGICAL_HEALTH', /抑郁|焦虑|心理治疗|心理咨询|情绪困扰|精神科/],
  ['MEDICAL_PRIVATE', /疾病|用药|药物|住院|手术|健康情况/],
  ['FAMILY_SECRET', /家庭秘密|父母冲突|家庭矛盾|亲子冲突/],
  ['INTIMATE_RELATIONSHIP', /出轨|婚外关系|第三者|伴侣关系|亲密关系|离婚|分手/],
]
const thirdPartyPattern = /(?:他人|别人|老公|老婆|丈夫|妻子|伴侣|父亲|母亲|朋友|同事|家人|孩子).{0,18}(?:诈骗|吸毒|盗窃|赌博|性侵|强奸|家暴|暴力|违法|犯罪|出轨|精神疾病)/
const firstPersonPattern = /(?:我|本人|自己).{0,18}(?:自杀|自伤|伤害自己|性侵|流产|吸毒|精神科)/

function asText(value) { return value === null || value === undefined ? '' : String(value).trim() }
function unique(values) { return [...new Set(values.filter(Boolean))] }

export function classifyPrivacyText(value, { subject = 'UNKNOWN' } = {}) {
  const text = asText(value)
  const categories = []
  for (const [category, pattern] of highPatterns) if (pattern.test(text)) categories.push(category)
  for (const [category, pattern] of sensitivePatterns) if (pattern.test(text)) categories.push(category)
  const thirdParty = thirdPartyPattern.test(text)
  if (thirdParty) categories.push('THIRD_PARTY_ALLEGATION')
  const subjects = new Set(PRIVACY_SUBJECTS.has(subject) ? [subject] : [])
  if (thirdParty) {
    subjects.delete('SELF')
    subjects.add(/孩子/.test(text) ? 'CHILD' : /父亲|母亲|家人/.test(text) ? 'FAMILY_MEMBER' : 'PARTNER')
  }
  if (!subjects.size) subjects.add(firstPersonPattern.test(text) ? 'SELF' : 'UNKNOWN')
  const safetyFlags = unique(categories.filter((category) => ['SELF_HARM', 'SUICIDE_RISK', 'OTHER_HARM', 'DOMESTIC_VIOLENCE', 'ABUSE'].includes(category)))
  const high = categories.some((category) => ['NON_NEEDED_IDENTITY', 'SEXUAL_PRIVATE', 'REPRODUCTIVE_PRIVATE', 'SUBSTANCE_USE', 'TRAUMA', 'POLITICAL_PRIVATE', 'RELIGIOUS_PRIVATE', 'MINOR_PRIVATE', 'SELF_HARM', 'SUICIDE_RISK', 'OTHER_HARM', 'DOMESTIC_VIOLENCE', 'ABUSE', 'THIRD_PARTY_ALLEGATION', 'LEGAL_CRIMINAL_ALLEGATION'].includes(category))
  const privacyLevel = high ? 'HIGH_SENSITIVE' : categories.length ? 'SENSITIVE' : 'NORMAL'
  const containsNonNeededIdentity = categories.includes('NON_NEEDED_IDENTITY')
  const hasSafety = safetyFlags.length > 0
  const mentorSafeSummary = hasSafety
    ? '客户近期出现与自身或他人安全相关的风险信号，建议优先进行安全评估与真人跟进。'
    : containsNonNeededIdentity
      ? '原始资料中包含不必要的身份识别信息。'
      : thirdParty
        ? '客户对身边人的部分行为存在重大担忧，相关信息来自客户陈述，尚未核实。'
        : privacyLevel === 'HIGH_SENSITIVE'
          ? '当前资料涉及较高敏感度的个人经历、关系或健康议题，需要谨慎处理。'
          : '资料可在当前服务范围内按需使用。'
  return {
    privacyLevel,
    categories: unique(categories),
    subjects: [...subjects],
    safetyFlags,
    containsThirdPartyAllegation: thirdParty,
    containsNonNeededIdentity,
    assertionType: thirdParty ? 'CLIENT_REPORTED' : 'DIRECT_INPUT',
    verification: thirdParty ? 'UNVERIFIED' : 'NOT_APPLICABLE',
    classificationReason: high ? '包含需要限制传播或安全优先处理的内容' : categories.length ? '包含普通敏感服务信息' : '未发现需要额外限制的内容',
    mentorSafeSummary,
    safeRiskSummary: hasSafety ? mentorSafeSummary : '',
  }
}

export function resolvePrivacyPolicy({ privacyLevel = 'NORMAL', categories = [], currentRole = 'ADMIN', safetyFlags = [], assertionType = '' } = {}) {
  const level = PRIVACY_LEVELS.has(privacyLevel) ? privacyLevel : 'HIGH_SENSITIVE'
  const categoryList = Array.isArray(categories) ? categories : []
  const safety = Array.isArray(safetyFlags) && safetyFlags.length > 0
  const thirdParty = categoryList.includes('THIRD_PARTY_ALLEGATION') || categoryList.includes('LEGAL_CRIMINAL_ALLEGATION') || assertionType === 'CLIENT_REPORTED'
  const nonNeeded = categoryList.includes('NON_NEEDED_IDENTITY')
  const high = level === 'HIGH_SENSITIVE'
  const mentor = currentRole === 'MENTOR'
  return {
    canViewRaw: !mentor || !high,
    canViewSafeSummary: high || safety,
    canUseInStage4: !nonNeeded,
    canUseInStage5: safety || !nonNeeded,
    canUseInSales: !high && !nonNeeded && !thirdParty,
    canUseInGlobalAI: !high && !nonNeeded,
    canPromoteToProfile: !high && !nonNeeded && !thirdParty,
    requiresHumanReview: high || thirdParty || nonNeeded,
  }
}

export function privacySafeText(meta, fallback = '该资料正在进行安全处理，请稍后查看。') {
  if (!meta || typeof meta !== 'object') return fallback
  return meta.safeRiskSummary || meta.mentorSafeSummary || fallback
}

export function buildPrivacyClassificationPrompt(sourceText) {
  return `你是 ASVA Privacy Classifier。只根据以下原始资料分类，不诊断、不脑补、不改变原意，严格返回 JSON：{"privacyLevel":"NORMAL|SENSITIVE|HIGH_SENSITIVE","categories":[],"subjects":[],"safetyFlags":[],"containsThirdPartyAllegation":false,"containsNonNeededIdentity":false,"mentorSafeSummary":"","safeRiskSummary":""}。客户陈述不是客观事实；安全风险必须保留给安全评估。原始资料：${asText(sourceText)}`
}

