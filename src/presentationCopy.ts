const TOKEN_COPY: Array<[string, string]> = [
  ['STABILIZE_BEFORE_SALE', '先稳定状态，再决定是否进入服务'],
  ['DISCOVER_BEFORE_SALE', '先了解清楚，再决定下一步'],
  ['EXPERIENCE_NURTURE', '先建立信任和体验'],
  ['COGNITIVE_GROWTH_READY', '可以进一步聊系统学习'],
  ['LONG_TERM_SERVICE_EXPLORABLE', '可以了解长期陪伴需求'],
  ['STABILIZE_FIRST', '先稳定状态'],
  ['SAFETY_FIRST', '先确认安全'],
  ['HARD_BLOCK', '暂不适合进入常规服务'],
  ['SOFT_BLOCK', '先确认清楚再决定'],
  ['HIGH_READINESS', '当前意愿较明确'],
  ['PAUSE', '暂缓'],
  ['NURTURE', '继续了解和建立信任'],
  ['READY', '可以推进'],
  ['UNKNOWN', '待确认'],
  ['FRESH', '已更新'],
  ['STALE', '待重新整理'],
  ['PROCESSING', '整理中'],
  ['FAILED', '整理未完成'],
  ['RICH', '资料较完整'],
  ['SPARSE', '目前了解还比较少'],
  ['FACT_BASED', '已确认信息'],
  ['SELF_MEANING_BASED', '客户自己的表达'],
  ['SELF_MEANING', '客户自己的表达'],
  ['OBSERVATION', '服务过程中的观察'],
  ['HYPOTHESIS', 'AI初步判断，待确认'],
  ['HIGH', '高'],
  ['MEDIUM', '中'],
  ['LOW', '低'],
  ['R0', '目前没有明显安全信号'],
  ['R1', '需要保持关注'],
  ['R2', '需要先稳定和确认'],
  ['R3', '需要人工先确认'],
  ['R4', '需要立即人工处理'],
  ['DAILY', '每天'],
  ['WEEKLY', '每周'],
  ['OCCASIONAL', '偶尔'],
  ['FREQUENT', '经常'],
  ['CURRENT', '当前'],
  ['RECENT', '最近'],
  ['HISTORICAL', '过去'],
  ['PRESENT', '有明确表达'],
  ['NEGATED', '未发现'],
  ['UNCERTAIN', '还需确认'],
  ['EXPLICIT', '明确表达'],
  ['IMPLICIT', '间接提到'],
  ['NONE', '暂无'],
  ['ASVA_HUMAN', 'ASVA人工支持'],
  ['LICENSED_MENTAL_HEALTH', '专业支持'],
  ['EMERGENCY', '紧急支持'],
  ['AI_INFERENCE', 'AI初步判断，待确认'],
  ['MENTOR_OBSERVATION', '服务过程中的观察'],
  ['MENTOR_CONFIRMED', '已确认信息'],
  ['CUSTOMER_FIRST_PARTY', '客户自己的表达'],
  ['STAFF_REPORTED', '导师或管理员记录'],
]

const FIELD_COPY: Array<[RegExp, string]> = [
  [/willingness_to_pay/gi, '付费意愿'],
  [/ability_to_pay/gi, '支付条件'],
  [/positive_signals/gi, '已有信号'],
  [/negative_signals/gi, '需要留意的信号'],
  [/known_financial_signals/gi, '已知的支付信息'],
  [/evidence_ids?/gi, '依据'],
  [/source_ids?/gi, '资料来源'],
  [/input_fingerprint/gi, '资料版本'],
  [/context_density/gi, '资料完整程度'],
  [/profile_version/gi, '档案版本'],
  [/service_gate/gi, '服务安排'],
  [/commercial_block/gi, '服务限制'],
  [/risk_level/gi, '安全情况'],
  [/risk_confidence/gi, '安全判断把握'],
  [/requires_human_review/gi, '需要人工确认'],
  [/schema|payload|metadata|fingerprint|deterministic|enum|repository|fallback|pipeline/gi, '系统信息'],
]

const TOKEN_PATTERN = new RegExp(`\\b(?:${TOKEN_COPY.map(([token]) => token).sort((a, b) => b.length - a.length).join('|')})\\b`, 'g')
const TOKEN_LOOKUP = new Map(TOKEN_COPY)

export function sanitizeUserVisibleText(value: unknown): string {
  if (value === null || value === undefined) return ''
  let result = String(value)
  for (const [pattern, replacement] of FIELD_COPY) result = result.replace(pattern, replacement)
  return result.replace(TOKEN_PATTERN, (token) => TOKEN_LOOKUP.get(token) || token)
}

export function humanizeProcessingStatus(value: string): string {
  return ({ FRESH: '已更新', STALE: '待重新整理', PROCESSING: '整理中', FAILED: '整理未完成' } as Record<string, string>)[value] || '待形成理解'
}

export function humanizeStrategy(value: string): string {
  return ({
    STABILIZE_BEFORE_SALE: '先稳定状态，再决定是否进入服务',
    DISCOVER_BEFORE_SALE: '先了解清楚，再决定下一步',
    EXPERIENCE_NURTURE: '先建立信任和体验',
    COGNITIVE_GROWTH_READY: '可以进一步聊系统学习',
    LONG_TERM_SERVICE_EXPLORABLE: '可以了解长期陪伴需求',
  } as Record<string, string>)[value] || '先了解清楚，再决定下一步'
}

export function humanizeTiming(value: string): string {
  return ({ PAUSE: '暂缓', NURTURE: '继续了解和建立信任', READY: '可以推进', HIGH_READINESS: '当前意愿较明确' } as Record<string, string>)[value] || '继续了解和建立信任'
}

export function humanizeLevel(value: string): string {
  return ({ HIGH: '高', MEDIUM: '中', LOW: '低', UNKNOWN: '待确认' } as Record<string, string>)[value] || '待确认'
}

export function humanizeEvidenceType(value: string): string {
  return ({ FACT: '已确认信息', FACT_BASED: '已确认信息', SELF_MEANING: '客户自己的表达', SELF_MEANING_BASED: '客户自己的表达', OBSERVATION: '服务过程中的观察', HYPOTHESIS: 'AI初步判断，待确认' } as Record<string, string>)[value] || '资料记录'
}

export function humanizeDensity(value: string): string {
  return ({ RICH: '资料较完整', MEDIUM: '已有一定资料', SPARSE: '目前了解还比较少' } as Record<string, string>)[value] || '资料完整程度待确认'
}
