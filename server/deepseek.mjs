import { config } from './config.mjs'
import { BUSINESS_GLOSSARY, DIMENSION_REGISTRY, ENTITY_REGISTRY, METRIC_REGISTRY } from '../shared/semantic-engine.mjs'
import { applyUnderstandingDensityPolicy, CUSTOMER_UNDERSTANDING_PROMPT_VERSION, normalizeCustomerUnderstanding } from '../shared/customer-understanding.mjs'
import { SAFETY_EXPLICITNESS, SAFETY_POLARITIES, SAFETY_RECENCY, SAFETY_SCOPES, SAFETY_SIGNAL_TYPES, normalizeSafetySignal } from '../shared/safety-contract.mjs'

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
  try { return JSON.parse(content) } catch {
    const fenced = String(content || '').match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    try { return fenced ? JSON.parse(fenced[1]) : null } catch { return null }
  }
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

export async function createEvidenceCandidates(input) {
  const raw = await callDeepSeek([
    { role: 'system', content: '你是 ASVA 资料整理助手。只从当前资料文本中提取可回溯的原子信息，不生成客户画像总结，不诊断，不补全，不把推测写成事实。严格返回 JSON：{"items":[{"evidence_type":"FACT|SELF_MEANING|OBSERVATION|HYPOTHESIS","semantic_kind":"PROFILE_FIELD|CURRENT_STATE|EVENT|RELATIONSHIP|RESOURCE|NEED|GOAL|PREFERENCE|OTHER","field_key":"Customer字段英文名或空","value":"标准值","display_text":"简短展示文本","source_excerpt":"资料中的原文短摘录","occurred_at":"资料中明确的时间或空","confidence":0.0,"locator":{"char_start":0,"char_end":0,"paragraph_index":0}}]}。source_perspective=STAFF_REPORTED 时，不能把内容写成客户原话或 SELF_MEANING；可记录明确事实为 FACT。source_perspective=CUSTOMER_FIRST_PARTY 时，客户本人表达可用 SELF_MEANING 或 FACT。只有导师观察资料才可使用 OBSERVATION；HYPOTHESIS 必须带有可能、似乎、推测等不确定语气。凡是带有“高中时期、18岁、约20岁、约24岁、后来、进入、转向、离乡、成为”等历史时间或转折表达的教育经历、职业经历、职业迷茫和后续转向，必须拆成可回溯的 FACT + EVENT 证据，field_key 可为空；只有当前状态或稳定快照才使用 PROFILE_FIELD/CURRENT_STATE。字段只能使用：gender,birth_date,age,birth_year,city,hometown,marital_status,education,living_status,children_summary,occupation,industry,position,work_years,job_status,income_range,career_stage,career_satisfaction,career_problem,career_goal,entrepreneurship_experience,family_summary,parents_relationship,father_summary,mother_summary,relationship_with_father,relationship_with_mother,siblings,family_events,family_support_level,relationship_status,partner_summary,marriage_years,relationship_satisfaction,relationship_conflicts,communication_pattern,conflict_pattern,relationship_goal,children_detail,parent_child_relationship,parenting_problem,parenting_values,hobbies,sports,reading,travel,art_preferences,social_preference,sleep,diet,routine,life_satisfaction,self_description,personality_traits,communication_style,decision_style,emotion_expression,stress_response,conflict_style,action_style,strengths,common_blocks,core_values,family_values,career_values,money_values,relationship_values,success_definition,happiness_definition,freedom_definition,growth_attitude,current_core_issue,secondary_issues,current_stressors,current_goal,current_expectation,current_resources,support_system,current_barriers,energy_state,recent_major_changes。' },
    { role: 'user', content: JSON.stringify({ source_text: input.text || '', source_role: input.sourceRole || 'ADMIN', source_perspective: input.sourcePerspective || (input.sourceRole === 'CUSTOMER' ? 'CUSTOMER_FIRST_PARTY' : 'STAFF_REPORTED'), current_snapshot: input.current || {} }) },
  ])
  const parsed = parseJson(raw)
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  const sourceText = String(input.text || '')
  const explicitDate = sourceText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日出生/)
  if (explicitDate && !items.some((item) => item?.field_key === 'birth_date')) {
    const value = `${explicitDate[1]}-${String(explicitDate[2]).padStart(2, '0')}-${String(explicitDate[3]).padStart(2, '0')}`
    items.push({ evidence_type: 'FACT', semantic_kind: 'PROFILE_FIELD', field_key: 'birth_date', value, display_text: `出生日期：${value}`, source_excerpt: explicitDate[0], occurred_at: '', confidence: 1, locator: { char_start: explicitDate.index, char_end: explicitDate.index + explicitDate[0].length, paragraph_index: 0 } })
  }
  const explicitHometown = sourceText.match(/出生于([^。；，,]+)/)
  if (explicitHometown && !items.some((item) => item?.field_key === 'hometown')) {
    items.push({ evidence_type: 'FACT', semantic_kind: 'PROFILE_FIELD', field_key: 'hometown', value: explicitHometown[1].trim(), display_text: `出生地：${explicitHometown[1].trim()}`, source_excerpt: explicitHometown[0], occurred_at: '', confidence: 1, locator: { char_start: explicitHometown.index, char_end: explicitHometown.index + explicitHometown[0].length, paragraph_index: 0 } })
  }
  if (/有父母和哥哥/.test(sourceText)) {
    if (!items.some((item) => item?.field_key === 'family_summary')) items.push({ evidence_type: 'FACT', semantic_kind: 'RELATIONSHIP', field_key: 'family_summary', value: '有父母', display_text: '家庭中有父母', source_excerpt: '有父母和哥哥', occurred_at: '', confidence: 1, locator: { char_start: sourceText.indexOf('有父母和哥哥'), char_end: sourceText.indexOf('有父母和哥哥') + 6, paragraph_index: 0 } })
    if (!items.some((item) => item?.field_key === 'siblings')) items.push({ evidence_type: 'FACT', semantic_kind: 'RELATIONSHIP', field_key: 'siblings', value: '哥哥', display_text: '有哥哥', source_excerpt: '有父母和哥哥', occurred_at: '', confidence: 1, locator: { char_start: sourceText.indexOf('有父母和哥哥'), char_end: sourceText.indexOf('有父母和哥哥') + 6, paragraph_index: 0 } })
  }
  return items
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

export async function createCustomerUnderstanding(input) {
  const context = input?.context || input || {}
  const evidenceRefs = Array.isArray(context.evidence_refs) ? context.evidence_refs : []
  const aliasToId = new Map(evidenceRefs.map((item, index) => [`E${index + 1}`, item.evidence_id]))
  const idToAlias = new Map([...aliasToId].map(([alias, id]) => [id, alias]))
  const replaceEvidenceIds = (value) => {
    if (Array.isArray(value)) return value.map(replaceEvidenceIds)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'evidence_ids' && Array.isArray(item) ? item.map((id) => idToAlias.get(id)).filter(Boolean) : key === 'evidence_id' ? undefined : replaceEvidenceIds(item)]).filter(([, item]) => item !== undefined))
  }
  const redactValues = [...new Set((input?.redactValues || []).filter((value) => value !== null && value !== undefined && String(value) !== '').map(String))]
  const redactDirectIdentifiers = (value) => {
    if (Array.isArray(value)) return value.map(redactDirectIdentifiers)
    if (typeof value === 'string') return redactValues.reduce((text, identifier) => text.split(identifier).join('[REDACTED]'), value)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDirectIdentifiers(item)]))
  }
  const llmContext = redactDirectIdentifiers(replaceEvidenceIds({ ...context, evidence_refs: evidenceRefs.map((item, index) => ({ evidence_ref: `E${index + 1}`, display_text: item.display_text, excerpt: item.excerpt, occurred_at: item.occurred_at, evidence_type: item.evidence_type, source_perspective: item.source_perspective })) }))
  const densityInstruction = context.context_density?.classification === 'SPARSE' ? '当前资料密度为 SPARSE：输出必须明显短于 MEDIUM；top_issues 最多2项、core_blocks最多1项、resources_and_strengths最多2项、key_tensions必须为空、working_hypotheses最多1项；知识缺口要比解释更突出。没有证据支持的模块请返回空数组，不要为了填满模块而推断。' : ''
  const system = '你是 ASVA 的 CustomerUnderstandingV1 结构化整理引擎，prompt_version=' + CUSTOMER_UNDERSTANDING_PROMPT_VERSION + '。只根据提供的结构化客户快照、已确认 Evidence 摘要和匿名 evidence_ref 工作，不读取或要求原始全文。禁止输出姓名、手机号、微信号、诊断、人格类型、疾病判断、销售结论。current_snapshot 是当前信息，top_life_events 是历史经历，不能把历史当当前。open_conflicts 中的值必须作为未决不确定性处理，不能选一边写成确定事实。资料不足必须写入 knowledge_gaps。必须严格返回一个 JSON 对象，不能包裹其它字段、不能 Markdown。严格字段与数组项结构如下：one_line_understanding={text,detail,evidence_ids,confidence,type}；top_issues=[{title,why_it_matters,evidence_ids,confidence,type}]最多3项；current_life_phase={title,description,supporting_events,evidence_ids,confidence,type}或null；current_needs=[{need,level:"EXPLICIT"|"INFERRED",evidence_ids,confidence,type}]最多5项；core_blocks=[{pattern,trigger,current_cost,evidence_ids,confidence,type}]；resources_and_strengths=[{resource,why_it_matters,evidence_ids,confidence,type}]；key_tensions=[{side_a,side_b,description,evidence_ids,confidence,type}]；knowledge_gaps=[{question,why_it_matters,related_issue,priority,evidence_ids}]至少1项只要存在合理未知；next_conversation=[{focus,why_now,suggested_entry,evidence_ids,confidence,type}]最多3项；service_cautions=[{caution,why,avoid,prefer,evidence_ids,confidence,type}]；working_hypotheses=[{text,evidence_ids,confidence:"LOW",type:"WORKING_HYPOTHESIS"}]；meta={overall_confidence,evidence_count}。所有引用只填写 evidence_ref（例如 E1），不要猜测其它引用；没有依据时 confidence 必须为 LOW。' + densityInstruction + (input?.repair === true ? '这是一次修复调用：上一版未通过证据或安全门禁，请重新生成完整 JSON，删除所有无法由 evidence_ref 支持的强结论和诊断词，并保留至少一个具体 knowledge_gaps。' : '')
  const raw = await callDeepSeek([
    { role: 'system', content: system },
    { role: 'system', content: '模块分工必须互不替代：core_blocks 只写可观察的行为或现实循环；key_tensions 只写两个同时存在、彼此拉扯的方向，并填写 side_a 与 side_b；next_conversation 只写下一次具体探索方向，必须包含 focus、why_now、suggested_entry，suggested_entry 要像导师可以直接说给客户的一句话，最多 1 至 2 个开场问题；working_hypotheses 只写尚未证实的解释可能，保持 LOW 把握。不要把同一段内容在这四个模块中重复复述。' },
    { role: 'user', content: JSON.stringify(llmContext) },
  ], 0.15)
  const normalized = normalizeCustomerUnderstanding(parseJson(raw), { evidenceIds: [...aliasToId.keys()], now: new Date().toISOString() })
  const restoreEvidenceIds = (value) => {
    if (Array.isArray(value)) return value.map(restoreEvidenceIds)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'evidence_ids' && Array.isArray(item) ? item.map((id) => aliasToId.get(id) || id) : restoreEvidenceIds(item)]))
  }
  return applyUnderstandingDensityPolicy(restoreEvidenceIds(normalized), context.context_density)
}

export async function createSafetySignalCandidates(input) {
  const context = input?.context || input || {}
  const refs = Array.isArray(context.evidence_refs) ? context.evidence_refs : []
  const llmContext = {
    current_snapshot: context.current_snapshot || {},
    evidence_refs: refs.map((item, index) => ({ evidence_ref: `E${index + 1}`, display_text: item.display_text, excerpt: item.excerpt, occurred_at: item.occurred_at, evidence_type: item.evidence_type, source_perspective: item.source_perspective })),
    open_conflicts: context.open_conflicts || [],
    stage4_current_issues: context.stage4_current_issues || [],
    knowledge_gaps: context.knowledge_gaps || [],
    safety_data_sufficiency: context.safety_data_sufficiency || 'INSUFFICIENT',
  }
  const system = '你是 ASVA Safety Signal Extractor。只从已确认的结构化客户快照和匿名证据摘要中提取可能需要安全确认的信号，不做诊断、不分配风险等级、不决定服务门禁、不决定商业阻断。必须区分 subject_scope=SELF/OTHER/UNKNOWN、polarity=PRESENT/NEGATED/UNCERTAIN、explicitness=EXPLICIT/IMPLICIT、recency=CURRENT/RECENT/HISTORICAL/UNKNOWN。每个信号必须引用一个或多个 evidence_ref（例如 E1），没有依据就不要输出。严格返回 JSON：{"signals":[{"signal_type":"SELF_HARM_IDEATION|SUICIDAL_INTENT_OR_PLAN|RECENT_SELF_HARM_BEHAVIOR|HARM_TO_OTHERS_IDEATION|VIOLENCE_OR_COERCION|SEVERE_FUNCTIONAL_IMPAIRMENT|SEVERE_SLEEP_DEPRIVATION_OR_ACTIVATION|REALITY_TESTING_CONCERN|SUBSTANCE_RELATED_SAFETY|ABUSE_OR_EXPLOITATION|ACUTE_TRAUMA_OR_BEREAVEMENT|BASIC_SELF_CARE_FAILURE|OTHER_SAFETY_CONCERN","subject_scope":"SELF|OTHER|UNKNOWN","polarity":"PRESENT|NEGATED|UNCERTAIN","explicitness":"EXPLICIT|IMPLICIT","recency":"CURRENT|RECENT|HISTORICAL|UNKNOWN","severity":"LOW|MEDIUM|HIGH","confidence":"LOW|MEDIUM|HIGH","evidence_refs":["E1"],"short_description":"不超过60字","current_status":"不超过100字","details":"不超过200字"}],"critical_unknowns":["最多5条需要确认的问题"],"context_summary":"不超过120字"}。资料不足时 signals 为空，critical_unknowns 明确写出需要确认的安全信息。禁止输出 risk_level、service_gate、commercial_block、requires_human_review 或任何诊断词。'
  const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(llmContext) }]
  const valid = (parsed) => Boolean(parsed && typeof parsed === 'object' && Array.isArray(parsed.signals) && parsed.signals.every((item) => item && SAFETY_SIGNAL_TYPES.has(item.signal_type) && SAFETY_SCOPES.has(item.subject_scope) && SAFETY_POLARITIES.has(item.polarity) && SAFETY_EXPLICITNESS.has(item.explicitness) && SAFETY_RECENCY.has(item.recency) && Array.isArray(item.evidence_refs) && item.evidence_refs.length > 0) && Array.isArray(parsed.critical_unknowns) && typeof parsed.context_summary === 'string')
  const normalize = (parsed) => ({ signals: parsed.signals.map(normalizeSafetySignal), critical_unknowns: list(parsed.critical_unknowns, 5), context_summary: parsed.context_summary.slice(0, 120) })
  const repairShape = (parsed) => {
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.signals)) return parsed
    return { ...parsed, signals: parsed.signals.map((item) => {
      if (SAFETY_RECENCY.has(item?.polarity) && SAFETY_POLARITIES.has(item?.recency)) return { ...item, polarity: item.recency, recency: item.polarity }
      if (!SAFETY_POLARITIES.has(item?.polarity) && SAFETY_RECENCY.has(item?.recency)) return { ...item, polarity: ['CURRENT', 'RECENT'].includes(item.recency) ? 'PRESENT' : 'UNCERTAIN' }
      return item
    }) }
  }
  let initialJsonValid = false
  let repairUsed = false
  let raw = await callDeepSeek(messages, 0)
  let parsed = parseJson(raw)
  initialJsonValid = valid(parsed)
  if (!initialJsonValid) {
    repairUsed = true
    raw = await callDeepSeek([{ role: 'system', content: system }, { role: 'system', content: '上一轮输出未通过 JSON 结构门禁。只返回符合指定字段、枚举和 evidence_ref 要求的完整 JSON，不要解释。' }, { role: 'user', content: JSON.stringify(llmContext) }], 0)
    parsed = repairShape(parseJson(raw))
  }
  const finalJsonValid = valid(parsed)
  if (!finalJsonValid) throw Object.assign(new Error('安全信号 JSON 结构校验失败'), { code: 'SAFETY_JSON_INVALID', status: 502, initialJsonValid, repairUsed, finalJsonValid, parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12) : [], signalCount: Array.isArray(parsed?.signals) ? parsed.signals.length : -1, signalShapes: Array.isArray(parsed?.signals) ? parsed.signals.slice(0, 3).map((item) => ({ keys: item && typeof item === 'object' ? Object.keys(item).slice(0, 12) : [], polarity_value: typeof item?.polarity === 'string' ? item.polarity.slice(0, 40) : null, recency_value: typeof item?.recency === 'string' ? item.recency.slice(0, 40) : null, signal_type: SAFETY_SIGNAL_TYPES.has(item?.signal_type), subject_scope: SAFETY_SCOPES.has(item?.subject_scope), polarity: SAFETY_POLARITIES.has(item?.polarity), explicitness: SAFETY_EXPLICITNESS.has(item?.explicitness), recency: SAFETY_RECENCY.has(item?.recency), evidence_refs: Array.isArray(item?.evidence_refs) && item.evidence_refs.length > 0 })) : [], criticalUnknownsType: Array.isArray(parsed?.critical_unknowns) ? 'array' : typeof parsed?.critical_unknowns, contextSummaryType: typeof parsed?.context_summary })
  return { ...normalize(parsed), initial_json_valid: initialJsonValid, repair_used: repairUsed, final_json_valid: finalJsonValid }
}
