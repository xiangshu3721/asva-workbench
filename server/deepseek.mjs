import { config } from './config.mjs'
import { BUSINESS_GLOSSARY, DIMENSION_REGISTRY, ENTITY_REGISTRY, METRIC_REGISTRY } from '../shared/semantic-engine.mjs'

export class DeepSeekUnavailableError extends Error {
  code = 'DEEPSEEK_UNAVAILABLE'
}

async function callDeepSeek(messages, temperature = 0.2) {
  if (!config.deepseek.apiKey) throw new DeepSeekUnavailableError('DeepSeek 尚未配置')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 35_000)
  try {
    const response = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseek.apiKey}` },
      body: JSON.stringify({ model: config.deepseek.model, messages, temperature, stream: false }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new DeepSeekUnavailableError(payload?.error?.message || `DeepSeek HTTP ${response.status}`)
    const content = payload?.choices?.[0]?.message?.content?.trim()
    if (!content) throw new DeepSeekUnavailableError('DeepSeek 返回内容为空')
    return content
  } catch (error) {
    if (error instanceof DeepSeekUnavailableError) throw error
    throw new DeepSeekUnavailableError(error instanceof Error ? error.message : 'DeepSeek 请求失败')
  } finally {
    clearTimeout(timeout)
  }
}

function parseJson(content) {
  try { return JSON.parse(content) } catch { return null }
}

const QUERY_OPERATIONS = new Set(['ENTITY_DETAIL', 'ENTITY_LIST', 'COUNT', 'AGGREGATE', 'GROUP_AGGREGATE', 'SUMMARY', 'RANK', 'TREND', 'COMPARE'])
const QUERY_ENTITIES = new Set(Object.keys(ENTITY_REGISTRY))
const QUERY_METRICS = new Set(Object.keys(METRIC_REGISTRY))
const QUERY_DIMENSIONS = new Set(Object.keys(DIMENSION_REGISTRY))
const QUERY_FILTER_FIELDS = new Set(['customer_id', 'product', 'mentor', 'referrer', 'city', 'grade', 'payment_status', 'appointment_status'])

function cleanQueryUnderstanding(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const operation = QUERY_OPERATIONS.has(parsed.operation) ? parsed.operation : null
  const entity = QUERY_ENTITIES.has(parsed.entity) ? parsed.entity : null
  const metrics = Array.isArray(parsed.metrics) ? parsed.metrics.filter((item) => QUERY_METRICS.has(item)) : []
  const dimensions = Array.isArray(parsed.dimensions) ? parsed.dimensions.filter((item) => QUERY_DIMENSIONS.has(item)) : []
  const filters = Array.isArray(parsed.filters) ? parsed.filters.filter((item) => QUERY_FILTER_FIELDS.has(item?.field) && ['EQ', 'NEQ', 'IN', 'CONTAINS'].includes(item?.operator)).map((item) => ({ field: item.field, operator: item.operator, value: typeof item.value === 'string' || typeof item.value === 'boolean' || Array.isArray(item.value) ? item.value : String(item.value ?? '') })) : []
  if (!operation || !entity) return null
  return { operation, entity, metrics, dimensions, filters, time_range_label: typeof parsed.time_range_label === 'string' ? parsed.time_range_label.slice(0, 40) : '', sort: Array.isArray(parsed.sort) ? parsed.sort.filter((item) => QUERY_METRICS.has(item?.metric) && ['ASC', 'DESC'].includes(item?.direction)).slice(0, 3) : [], limit: Math.min(50, Math.max(1, Number(parsed.limit) || 20)) }
}

export async function createQueryUnderstanding(question) {
  if (!config.deepseek.apiKey) return null
  const raw = await callDeepSeek([
    { role: 'system', content: `你是 ASVA 内部数据查询的语义解析器。只把自然语言映射为 JSON，不读取数据、不计算、不写库。只能使用给定注册表中的值。严格返回：{"operation":"ENTITY_DETAIL|ENTITY_LIST|COUNT|AGGREGATE|GROUP_AGGREGATE|SUMMARY|RANK|TREND|COMPARE","entity":"CUSTOMER|MENTOR|PRODUCT|APPOINTMENT|SERVICE_RECORD|ENROLLMENT","metrics":["指标名"],"dimensions":["维度名"],"filters":[{"field":"字段","operator":"EQ|NEQ|IN|CONTAINS","value":"值"}],"time_range_label":"今天/上个月/具体月份/日期区间","sort":[{"metric":"指标名","direction":"ASC|DESC"}],"limit":20}。业务术语：${JSON.stringify(BUSINESS_GLOSSARY)}。指标：${JSON.stringify(Object.keys(METRIC_REGISTRY))}。维度：${JSON.stringify(Object.keys(DIMENSION_REGISTRY))}。实体：${JSON.stringify(Object.keys(ENTITY_REGISTRY))}` },
    { role: 'user', content: question },
  ], 0)
  return cleanQueryUnderstanding(parseJson(raw))
}

const PROFILE_FIELD_KEYS = new Set([
  'gender', 'birth_date', 'age', 'birth_year', 'city', 'hometown', 'marital_status', 'education', 'living_status', 'children_summary',
  'occupation', 'industry', 'position', 'work_years', 'job_status', 'income_range', 'career_stage', 'career_satisfaction', 'career_problem', 'career_goal', 'entrepreneurship_experience',
  'family_summary', 'parents_relationship', 'father_summary', 'mother_summary', 'relationship_with_father', 'relationship_with_mother', 'siblings', 'family_events', 'family_support_level',
  'relationship_status', 'partner_summary', 'marriage_years', 'relationship_satisfaction', 'relationship_conflicts', 'communication_pattern', 'conflict_pattern', 'relationship_goal',
  'children_detail', 'parent_child_relationship', 'parenting_problem', 'parenting_values',
  'hobbies', 'sports', 'reading', 'travel', 'art_preferences', 'social_preference', 'sleep', 'diet', 'routine', 'life_satisfaction',
  'self_description', 'personality_traits', 'communication_style', 'decision_style', 'emotion_expression', 'stress_response', 'conflict_style', 'action_style', 'strengths', 'common_blocks',
  'core_values', 'family_values', 'career_values', 'money_values', 'relationship_values', 'success_definition', 'happiness_definition', 'freedom_definition', 'growth_attitude',
  'current_core_issue', 'secondary_issues', 'current_stressors', 'current_goal', 'current_expectation', 'current_resources', 'support_system', 'current_barriers', 'energy_state', 'recent_major_changes', 'ai_customer_summary',
])

function profileValue(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' || typeof item === 'number').map(String)
  return null
}

export async function createProfileDraft(input) {
  const raw = await callDeepSeek([
    { role: 'system', content: '你是 ASVA 客户画像整理助手。只根据导师提供的原话提取事实，不补全、不诊断、不虚构人格。严格返回 JSON：{"updates":[{"field":"字段英文名","value":"值","source":"MENTOR_OBSERVATION|AI_INFERENCE","confidence":0.0}]}。只允许使用给定字段名。无法确定的信息不要输出。只有明确标注为推测的内容才能使用 AI_INFERENCE，且不能把推测写成事实。' },
    { role: 'user', content: JSON.stringify({ text: input.text || '', existing: input.existing || {} }) },
  ])
  const parsed = parseJson(raw)
  const updates = Array.isArray(parsed?.updates) ? parsed.updates : []
  return {
    updates: updates.filter((item) => PROFILE_FIELD_KEYS.has(item?.field)).map((item) => ({
      field: item.field,
      value: profileValue(item.value),
      source: item.source === 'AI_INFERENCE' ? 'AI_INFERENCE' : 'MENTOR_OBSERVATION',
      confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.85))),
      confirmed: false,
    })).filter((item) => item.value !== null),
  }
}

export async function createServiceSummary(input) {
  const raw = await callDeepSeek([
    { role: 'system', content: '你是 ASVA 内部服务记录助手。只做事实整理，不做诊断、不做复杂销售推荐。请严格返回 JSON：{"summary":"本次总结","currentStatus":"当前客户状态","nextStep":"下一步建议"}。内容简洁、具体、可被导师修改确认。' },
    { role: 'user', content: JSON.stringify({
      customer: { concern: input.coreNeed, expectation: input.expectation },
      conversation: input.topic,
      result: input.result,
      note: input.notes,
    }) },
  ])
  const parsed = parseJson(raw)
  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary : raw,
    currentStatus: typeof parsed?.currentStatus === 'string' ? parsed.currentStatus : '已完成本次沟通，等待导师确认记录。',
    nextStep: typeof parsed?.nextStep === 'string' ? parsed.nextStep : '根据本次沟通结果决定是否重新预约。',
  }
}

export async function createBrief(input) {
  const raw = await callDeepSeek([
    { role: 'system', content: '你是 ASVA 接待前信息整理助手。只根据提供的客户上下文工作，不做心理诊断，不把推测写成事实，不以 SABC、付费或课程作为服务主导。严格返回 JSON：{"confirmed":["本次最需要记住的事实，3-5条"],"to_confirm":["会影响下一步服务的高价值缺口，最多4条"],"entry_points":["具体、自然的服务切入策略，2-3条"],"suggested_questions":["针对当前客户的备选开放式问题，最多4条"],"interaction_guidance":{"tone":"语气","pace":"节奏","avoid":["避免事项"],"care_cues":["自然的人文关怀入口"]},"lede":"一句话说明本次服务状态"}。资料不足时明确输出待澄清，不要补写人物画像。' },
    { role: 'user', content: JSON.stringify(input.context || input) },
  ])
  const parsed = parseJson(raw)
  return briefText(cleanBrief(parsed, raw))
}

function list(value, limit) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, limit) : [] }
function briefText(brief) { return [brief.lede, `建议先从：${brief.entry_points.join('；')}`, `备选提问：${brief.suggested_questions.join('；')}`].filter(Boolean).join('\n') }
function cleanBrief(parsed, fallback = '') {
  if (!parsed || typeof parsed !== 'object') return { confirmed: ['当前资料不足，尚不能形成稳定判断。'], to_confirm: ['最近最希望解决的具体事情'], entry_points: ['先建立基本理解，不急于分析和给建议。'], suggested_questions: ['你愿意的话，可以先和我说说最近最让你困扰的一件事。'], interaction_guidance: { tone: '温和、开放', pace: '少分析，多听和确认', avoid: ['把推测当成事实'], care_cues: [] }, lede: fallback || '当前资料不足，本次以澄清需求为主。' }
  const confirmed = list(parsed.confirmed, 5)
  const toConfirm = list(parsed.to_confirm, 4)
  const entryPoints = list(parsed.entry_points, 3)
  const questions = list(parsed.suggested_questions, 4)
  return {
    confirmed: confirmed.length ? confirmed : ['当前资料不足，尚不能形成稳定判断。'],
    to_confirm: toConfirm.length ? toConfirm : ['最近最希望解决的具体事情'],
    entry_points: entryPoints.length ? entryPoints : ['先建立基本理解，不急于分析和给建议。'],
    suggested_questions: questions.length ? questions : ['你愿意的话，可以先和我说说最近最让你困扰的一件事。'],
    interaction_guidance: {
      tone: typeof parsed.interaction_guidance?.tone === 'string' ? parsed.interaction_guidance.tone : '温和、具体',
      pace: typeof parsed.interaction_guidance?.pace === 'string' ? parsed.interaction_guidance.pace : '先听后问',
      avoid: list(parsed.interaction_guidance?.avoid, 4),
      care_cues: list(parsed.interaction_guidance?.care_cues, 3),
    },
    lede: typeof parsed.lede === 'string' && parsed.lede.trim() ? parsed.lede.trim() : '本次以建立理解和确认重点为主。',
  }
}

export async function createCustomerIntelligence(input) {
  const raw = await callDeepSeek([
    { role: 'system', content: '你是 ASVA 客户理解引擎。你的任务不是复述字段，而是帮助导师理解客户当前处境，并准备下一次服务。请先完成事实→归纳→关联→主次判断，再返回严格 JSON：{"summary":{"overview":"120-250字以内的当前人生/生活阶段与核心矛盾，不把推测写成事实","core_issues":["最多3项"],"priority_topics":["最多3项"],"current_goals":["明确表达的目标；没有就写待确认"],"resources":["已有资源；没有就写尚待确认"],"service_focus":"当前服务重点","risk":{"level":"LOW|MEDIUM|HIGH|UNASSESSED","reason":"风险理由"},"confidence":"LOW|MEDIUM|HIGH","missing_key_information":["最多4项"]},"brief":{"confirmed":["3-5条"],"to_confirm":["最多4条高价值缺口"],"entry_points":["2-3条服务策略"],"suggested_questions":["最多4条客户特异性问题"],"interaction_guidance":{"tone":"语气","pace":"节奏","avoid":["避免事项"],"care_cues":["自然关怀入口"]},"lede":"一句话"}}。信息只有无意义短句时，summary.overview 必须说明信息不足，core_issues 写尚待澄清，risk.level 写 UNASSESSED；不得编造创伤、人格、诊断或课程销售话术。' },
    { role: 'user', content: JSON.stringify(input.context || input) },
  ])
  const parsed = parseJson(raw)
  const summary = parsed?.summary && typeof parsed.summary === 'object' ? parsed.summary : {}
  const riskLevels = new Set(['LOW', 'MEDIUM', 'HIGH', 'UNASSESSED'])
  const confidenceLevels = new Set(['LOW', 'MEDIUM', 'HIGH'])
  return {
    summary: {
      overview: typeof summary.overview === 'string' ? summary.overview : '当前资料不足，暂不能形成稳定判断。',
      core_issues: list(summary.core_issues, 3).length ? list(summary.core_issues, 3) : ['尚待澄清'],
      priority_topics: list(summary.priority_topics, 3).length ? list(summary.priority_topics, 3) : ['建立基本理解'],
      current_goals: list(summary.current_goals, 3).length ? list(summary.current_goals, 3) : ['待确认'],
      resources: list(summary.resources, 3).length ? list(summary.resources, 3) : ['尚待确认'],
      service_focus: typeof summary.service_focus === 'string' ? summary.service_focus : '先建立基本理解，再确认客户当前最需要支持的一件事。',
      risk: { level: riskLevels.has(summary.risk?.level) ? summary.risk.level : 'UNASSESSED', reason: typeof summary.risk?.reason === 'string' ? summary.risk.reason : '尚未完成安全风险评估。' },
      confidence: confidenceLevels.has(summary.confidence) ? summary.confidence : 'LOW',
      missing_key_information: list(summary.missing_key_information, 4).length ? list(summary.missing_key_information, 4) : ['最近最困扰的具体场景', '当前支持系统'],
    },
    brief: cleanBrief(parsed?.brief),
  }
}
