export const PRIVACY_LEVELS = new Set(['NORMAL', 'SENSITIVE', 'HIGH_SENSITIVE'])
export const PRIVACY_CATEGORIES = new Set([
  'NON_NEEDED_IDENTITY', 'PSYCHOLOGICAL_HEALTH', 'MEDICAL_PRIVATE', 'INTIMATE_RELATIONSHIP', 'SEXUAL_PRIVATE',
  'REPRODUCTIVE_PRIVATE', 'FAMILY_SECRET', 'FINANCIAL_PRIVATE', 'THIRD_PARTY_PRIVATE', 'THIRD_PARTY_ALLEGATION',
  'SUBSTANCE_USE', 'TRAUMA', 'POLITICAL_PRIVATE', 'RELIGIOUS_PRIVATE', 'MINOR_PRIVATE', 'SELF_HARM', 'SUICIDE_RISK',
  'OTHER_HARM', 'DOMESTIC_VIOLENCE', 'ABUSE', 'LEGAL_CRIMINAL_ALLEGATION',
])
export const PRIVACY_SUBJECTS = new Set(['SELF', 'PARTNER', 'CHILD', 'FAMILY_MEMBER', 'OTHER_THIRD_PARTY', 'UNKNOWN'])
export const SERVICE_NECESSITY_LEVELS = new Set(['LOW', 'RELEVANT', 'CRITICAL'])
export const TEMPORAL_TYPES = new Set(['CURRENT', 'RECENT', 'HISTORICAL', 'FUTURE_PLAN', 'UNKNOWN'])

const highPatterns = [
  ['NON_NEEDED_IDENTITY', /身份证|证件号码|身份证号|银行卡|银行卡号|护照号|社保号/],
  ['SUICIDE_RISK', /自杀|结束生命|不想活|活着没意思|跳楼|跳河|跳下去|自杀计划/],
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
  ['PSYCHOLOGICAL_HEALTH', /抑郁|焦虑|双相|心理治疗|心理咨询|情绪困扰|精神科/],
  ['MEDICAL_PRIVATE', /疾病|用药|药物|住院|手术|健康情况/],
  ['FAMILY_SECRET', /家庭秘密|父母冲突|家庭矛盾|亲子冲突/],
  ['INTIMATE_RELATIONSHIP', /出轨|婚外关系|第三者|伴侣关系|亲密关系|离婚|分手/],
]
const thirdPartyPattern = /(?:他人|别人|老公|老婆|丈夫|妻子|伴侣|父亲|母亲|朋友|同事|家人|孩子).{0,18}(?:诈骗|骗了|骗钱|吸毒|盗窃|赌博|性侵|强奸|家暴|暴力|违法|犯罪|出轨|精神疾病)/
const firstPersonPattern = /(?:我|本人|自己).{0,18}(?:自杀|自伤|伤害自己|性侵|流产|吸毒|精神科)/

function asText(value) { return value === null || value === undefined ? '' : String(value).trim() }
function unique(values) { return [...new Set(values.filter(Boolean))] }

function sentenceContaining(text, patterns) {
  const sentences = text.split(/[。！？!?\n]/).map((item) => item.trim()).filter(Boolean)
  return sentences.find((sentence) => patterns.some((pattern) => pattern.test(sentence))) || ''
}

export function classifyTemporalText(value, { safety = false } = {}) {
  const text = asText(value)
  if (!text) return 'UNKNOWN'
  if (/未来|下个月|明年|以后|之后想|将要/.test(text)) return 'FUTURE_PLAN'
  if (/昨晚|昨天|今天|今晚|刚刚|最近|近来|这几天|本周|近期/.test(text)) return safety ? 'RECENT' : 'RECENT'
  if (/目前|当前|现在|正在|长期|一直|仍然|现阶段/.test(text)) return 'CURRENT'
  if (/以前|曾经|过去|去年|多年前|十年前|小时候|之后一直没有/.test(text)) return 'HISTORICAL'
  return 'UNKNOWN'
}

function hasCurrentSafetyNegation(text) {
  return /(现在|目前|当前|最近|昨晚|今天).{0,18}(没有|不再|已经没有|否认).{0,18}(自杀|自伤|伤害自己|伤害他人)/.test(text)
    || /(自杀|自伤|伤害自己|伤害他人).{0,18}(没有计划|没有想法|不想|不会)/.test(text)
    || /(自杀|自伤|伤害自己|伤害他人).{0,20}(之后|此后|后来).{0,12}(一直没有|再没有|不再)/.test(text)
}

function effectiveServiceNecessity({ categories = [], safetyFlags = [], temporalType = 'UNKNOWN', serviceNecessity = '', override = '' } = {}) {
  const categoryList = Array.isArray(categories) ? categories : []
  const safety = Array.isArray(safetyFlags) ? safetyFlags : []
  const currentRisk = safety.length > 0 && ['CURRENT', 'RECENT'].includes(temporalType)
  if (currentRisk) return 'CRITICAL'
  if (categoryList.includes('NON_NEEDED_IDENTITY') && !safety.length && categoryList.every((category) => category === 'NON_NEEDED_IDENTITY')) return 'LOW'
  if (SERVICE_NECESSITY_LEVELS.has(override)) return override
  if (SERVICE_NECESSITY_LEVELS.has(serviceNecessity)) return serviceNecessity
  return 'RELEVANT'
}

function necessityReason(level, { categories = [], temporalType = 'UNKNOWN' } = {}) {
  if (level === 'LOW') return '该信息对当前服务几乎没有必要，导师不需要原始细节。'
  if (level === 'CRITICAL') return `该信息可能影响当前咨询质量或安全判断，时间属性为${temporalType}，仅提供完成服务所需的最小必要信息。`
  if (categories.includes('THIRD_PARTY_ALLEGATION')) return '该信息与客户当前议题可能相关，但来源是客户陈述，仍需保留未核实属性。'
  return '该信息有助于理解客户当前议题，但只向导师提供服务所需的事实、影响和当前意义。'
}

function buildServiceDetail(text, categories, safetyFlags, temporalType) {
  const parts = []
  if (categories.includes('INTIMATE_RELATIONSHIP') || categories.includes('SEXUAL_PRIVATE') || categories.includes('FAMILY_SECRET')) parts.push('客户当前关系与信任议题存在重要背景，正在影响其安全感、自我评价或关系决策。')
  if (categories.includes('TRAUMA')) parts.push('客户有与当前服务相关的重要创伤背景，需结合当前影响谨慎核实。')
  if (categories.includes('MEDICAL_PRIVATE') || categories.includes('PSYCHOLOGICAL_HEALTH')) parts.push('客户提到与当前服务相关的心理或健康信息，应区分客户自述与已确认的医疗事实。')
  if (categories.includes('THIRD_PARTY_ALLEGATION')) parts.push('客户对身边人的相关行为表达了担忧；该信息来自客户陈述，尚未核实。')
  if (safetyFlags.length) parts.push(`资料中有需要优先核实的安全相关信息，时间属性为${temporalType}。应确认当前意图、计划、手段可及性、支持系统及即时安全情况。`)
  return parts.join(' ') || '该资料包含与当前服务相关的敏感背景，建议在服务中按需核实其当前影响。'
}

function buildSalesSafeSummary(categories, safetyFlags) {
  if (safetyFlags.length) return '客户当前存在较高紧迫度的情绪支持与安全关注需求，不应将脆弱处境作为成交依据。'
  if (categories.includes('INTIMATE_RELATIONSHIP') || categories.includes('SEXUAL_PRIVATE') || categories.includes('FAMILY_SECRET')) return '客户当前存在高紧迫度的亲密关系与信任议题，问题已明显影响其日常状态。'
  if (categories.includes('TRAUMA') || categories.includes('PSYCHOLOGICAL_HEALTH') || categories.includes('MEDICAL_PRIVATE')) return '客户当前存在需要谨慎支持的情绪与个人成长议题，具体隐私不作为销售依据。'
  if (categories.includes('THIRD_PARTY_ALLEGATION')) return '客户当前对身边关系中的重要问题存在较高关注，相关细节尚未核实。'
  return '客户当前存在与服务相关的重要个人议题，建议先理解需求，不利用隐私推动成交。'
}

function buildNecessaryExcerpt(text, categories, safetyFlags, temporalType) {
  if (!safetyFlags.length || !['CURRENT', 'RECENT'].includes(temporalType)) return ''
  const excerpt = sentenceContaining(text, [/自杀|自伤|伤害自己|伤害他人|家暴|被打|跳楼|跳河|跳下去/])
  if (!excerpt || /身份证|银行卡|护照|社保号/.test(excerpt)) return ''
  return excerpt.slice(0, 240)
}

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
  const temporalType = classifyTemporalText(text, { safety: safetyFlags.length > 0 })
  const effectiveSafetyFlags = hasCurrentSafetyNegation(text) && temporalType !== 'RECENT' ? [] : safetyFlags
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
  const serviceNecessity = effectiveServiceNecessity({ categories: unique(categories), safetyFlags: effectiveSafetyFlags, temporalType })
  const mentorServiceDetail = serviceNecessity === 'LOW' ? '' : buildServiceDetail(text, unique(categories), effectiveSafetyFlags, temporalType)
  const necessaryExcerpt = buildNecessaryExcerpt(text, unique(categories), effectiveSafetyFlags, temporalType)
  return {
    privacyLevel,
    categories: unique(categories),
    subjects: [...subjects],
    safetyFlags,
    containsThirdPartyAllegation: thirdParty,
    containsNonNeededIdentity,
    assertionType: thirdParty ? 'CLIENT_REPORTED' : 'DIRECT_INPUT',
    verification: thirdParty ? 'UNVERIFIED' : 'NOT_APPLICABLE',
    temporalType,
    serviceNecessity,
    serviceNecessityReason: necessityReason(serviceNecessity, { categories: unique(categories), temporalType }),
    classificationReason: high ? '包含需要限制传播或安全优先处理的内容' : categories.length ? '包含普通敏感服务信息' : '未发现需要额外限制的内容',
    mentorSafeSummary,
    mentorServiceDetail,
    necessaryExcerpt,
    salesSafeSummary: privacyLevel === 'HIGH_SENSITIVE' ? buildSalesSafeSummary(unique(categories), effectiveSafetyFlags) : '',
    safeRiskSummary: hasSafety ? mentorSafeSummary : '',
  }
}

export function resolvePrivacyPolicy({ privacyLevel = 'NORMAL', categories = [], currentRole = 'ADMIN', isAssignedMentor = true, serviceNecessity = '', serviceNecessityOverride = '', temporalType = 'UNKNOWN', safetyFlags = [], assertionType = '', verification = '' } = {}) {
  const level = PRIVACY_LEVELS.has(privacyLevel) ? privacyLevel : 'HIGH_SENSITIVE'
  const categoryList = Array.isArray(categories) ? categories : []
  const safety = Array.isArray(safetyFlags) && safetyFlags.length > 0
  const thirdParty = categoryList.includes('THIRD_PARTY_ALLEGATION') || categoryList.includes('LEGAL_CRIMINAL_ALLEGATION') || assertionType === 'CLIENT_REPORTED'
  const nonNeeded = categoryList.includes('NON_NEEDED_IDENTITY')
  const high = level === 'HIGH_SENSITIVE'
  const mentor = currentRole === 'MENTOR'
  const necessity = effectiveServiceNecessity({ categories: categoryList, safetyFlags, temporalType, serviceNecessity, override: serviceNecessityOverride })
  const ownerMentor = mentor && isAssignedMentor
  const canViewAdminRaw = currentRole === 'ADMIN'
  const canViewMentorRaw = ownerMentor && !high
  const canViewSafe = high || safety
  const canViewService = ownerMentor && high && ['RELEVANT', 'CRITICAL'].includes(necessity)
  const canViewSafety = ownerMentor && safety && necessity === 'CRITICAL'
  const canViewExcerpt = ownerMentor && high && necessity === 'CRITICAL' && (safety || categoryList.includes('SELF_HARM') || categoryList.includes('SUICIDE_RISK') || categoryList.includes('OTHER_HARM'))
  return {
    serviceNecessity: necessity,
    canViewRaw: canViewAdminRaw || canViewMentorRaw,
    canViewSafeSummary: canViewSafe && (canViewAdminRaw || ownerMentor),
    canViewServiceDetail: canViewAdminRaw || canViewService,
    canViewNecessaryExcerpt: canViewAdminRaw || canViewExcerpt,
    canViewSafetyDetail: canViewAdminRaw || canViewSafety,
    canUseInStage5: safety || !nonNeeded,
    canUseInConsultation: !nonNeeded && (level !== 'HIGH_SENSITIVE' || (ownerMentor && ['RELEVANT', 'CRITICAL'].includes(necessity))),
    canUseInStage4: !nonNeeded && (level !== 'HIGH_SENSITIVE' || (ownerMentor && ['RELEVANT', 'CRITICAL'].includes(necessity)) || canViewAdminRaw),
    canUseInSales: !high && !nonNeeded && !thirdParty,
    canUseInSalesSafeSummary: high && !nonNeeded,
    canUseInGlobalAI: !high && !nonNeeded,
    canPromoteToProfile: !high && !nonNeeded && !thirdParty,
    requiresHumanReview: high || thirdParty || nonNeeded || verification === 'UNVERIFIED',
  }
}

export function buildConsultationContext({ role = 'MENTOR', isAssignedMentor = true, evidenceItems = [], sourceRecords = [] } = {}) {
  const sourceById = new Map(sourceRecords.map((source) => [source.id, source]))
  return evidenceItems.map((evidence) => {
    const source = sourceById.get(evidence.sourceId)
    const meta = evidence.privacyMeta || source?.privacyMeta || {}
    const policy = resolvePrivacyPolicy({ privacyLevel: evidence.privacyLevel || source?.privacyLevel, categories: meta.categories, currentRole: role, isAssignedMentor, serviceNecessity: meta.serviceNecessity, serviceNecessityOverride: meta.serviceNecessityOverride, temporalType: meta.temporalType, safetyFlags: meta.safetyFlags, assertionType: meta.assertionType, verification: meta.verification })
    if (!policy.canUseInConsultation) return null
    return { ...evidence, displayText: policy.canViewServiceDetail ? (meta.mentorServiceDetail || evidence.displayText) : evidence.displayText, sourceExcerpt: policy.canViewNecessaryExcerpt ? (meta.necessaryExcerpt || '') : '', mentorServiceDetail: meta.mentorServiceDetail || '', necessaryExcerpt: meta.necessaryExcerpt || '', privacyPolicy: policy }
  }).filter(Boolean)
}

export function buildSalesContext({ evidenceItems = [], sourceRecords = [] } = {}) {
  const sourceById = new Map(sourceRecords.map((source) => [source.id, source]))
  return evidenceItems.map((evidence) => {
    const source = sourceById.get(evidence.sourceId)
    const meta = evidence.privacyMeta || source?.privacyMeta || {}
    const policy = resolvePrivacyPolicy({ privacyLevel: evidence.privacyLevel || source?.privacyLevel, categories: meta.categories, safetyFlags: meta.safetyFlags, serviceNecessity: meta.serviceNecessity, serviceNecessityOverride: meta.serviceNecessityOverride, temporalType: meta.temporalType, assertionType: meta.assertionType, verification: meta.verification, currentRole: 'MENTOR' })
    if (policy.canUseInSales) return { ...evidence, sourceExcerpt: '', privacyPolicy: policy }
    if (!policy.canUseInSalesSafeSummary) return null
    return { ...evidence, displayText: meta.salesSafeSummary || '客户当前存在与服务相关的重要议题。', sourceExcerpt: '', standardValue: undefined, privacyPolicy: policy }
  }).filter(Boolean)
}

export function applyServiceNecessityOverride(meta = {}, override) {
  const level = effectiveServiceNecessity({ ...meta, override })
  return { ...meta, serviceNecessityOverride: SERVICE_NECESSITY_LEVELS.has(override) ? override : undefined, serviceNecessity: level, serviceNecessityReason: '管理员人工覆盖服务必要性判断。' }
}

export function privacySafeText(meta, fallback = '该资料正在进行安全处理，请稍后查看。') {
  if (!meta || typeof meta !== 'object') return fallback
  return meta.safeRiskSummary || meta.mentorSafeSummary || fallback
}

export function buildPrivacyClassificationPrompt(sourceText) {
  return `你是 ASVA Privacy Classifier。只根据以下原始资料分类，不诊断、不脑补、不改变原意，严格返回 JSON：{"privacyLevel":"NORMAL|SENSITIVE|HIGH_SENSITIVE","categories":[],"subjects":[],"safetyFlags":[],"temporalType":"CURRENT|RECENT|HISTORICAL|FUTURE_PLAN|UNKNOWN","serviceNecessity":"LOW|RELEVANT|CRITICAL","serviceNecessityReason":"","containsThirdPartyAllegation":false,"containsNonNeededIdentity":false,"mentorSafeSummary":"","mentorServiceDetail":"","necessaryExcerpt":"","salesSafeSummary":"","safeRiskSummary":""}。客户陈述不是客观事实；安全风险必须保留给安全评估；CRITICAL只用于当前或近期确实影响服务质量或安全判断的信息；身份证和银行卡必须是LOW。原始资料：${asText(sourceText)}`
}

