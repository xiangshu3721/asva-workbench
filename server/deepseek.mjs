import { config } from './config.mjs'

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

const PROFILE_FIELD_KEYS = new Set([
  'gender', 'age', 'birth_year', 'city', 'hometown', 'marital_status', 'education', 'living_status', 'children_summary',
  'occupation', 'industry', 'position', 'work_years', 'job_status', 'income_range', 'career_stage', 'career_satisfaction', 'career_problem', 'career_goal', 'entrepreneurship_experience',
  'family_summary', 'parents_relationship', 'father_summary', 'mother_summary', 'relationship_with_father', 'relationship_with_mother', 'siblings', 'family_events', 'family_support_level',
  'relationship_status', 'partner_summary', 'marriage_years', 'relationship_satisfaction', 'relationship_conflicts', 'communication_pattern', 'conflict_pattern', 'relationship_goal',
  'children_detail', 'parent_child_relationship', 'parenting_problem', 'parenting_values',
  'hobbies', 'sports', 'reading', 'travel', 'art_preferences', 'social_preference', 'sleep', 'diet', 'routine', 'life_satisfaction',
  'self_description', 'personality_traits', 'communication_style', 'decision_style', 'emotion_expression', 'stress_response', 'conflict_style', 'action_style', 'strengths', 'common_blocks',
  'core_values', 'family_values', 'career_values', 'money_values', 'relationship_values', 'success_definition', 'happiness_definition', 'freedom_definition', 'growth_attitude',
  'current_core_issue', 'secondary_issues', 'current_stressors', 'current_goal', 'current_expectation', 'current_resources', 'support_system', 'current_barriers', 'energy_state', 'recent_major_changes',
])

function profileValue(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number') return value
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
    { role: 'system', content: '你是 ASVA 接待前信息整理助手。只根据提供的预约内容生成简洁 Brief：先说已知情况，再列出接待时应确认的 1-3 个问题。不要诊断，不推荐课程。' },
    { role: 'user', content: `昵称：${input.name}\n当前困扰：${input.need}\n希望获得帮助：${input.expectation}` },
  ])
  return raw
}
