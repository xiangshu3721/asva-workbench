import type { ProfileSource, ProfileValue, CustomerProfileState, ProfileUpdate } from './domain'

export const PROFILE_FIELD_KEYS = [
  'gender', 'age', 'birth_year', 'city', 'hometown', 'marital_status', 'education', 'living_status', 'children_summary',
  'occupation', 'industry', 'position', 'work_years', 'job_status', 'income_range', 'career_stage', 'career_satisfaction', 'career_problem', 'career_goal', 'entrepreneurship_experience',
  'family_summary', 'parents_relationship', 'father_summary', 'mother_summary', 'relationship_with_father', 'relationship_with_mother', 'siblings', 'family_events', 'family_support_level',
  'relationship_status', 'partner_summary', 'marriage_years', 'relationship_satisfaction', 'relationship_conflicts', 'communication_pattern', 'conflict_pattern', 'relationship_goal',
  'children_detail', 'parent_child_relationship', 'parenting_problem', 'parenting_values',
  'hobbies', 'sports', 'reading', 'travel', 'art_preferences', 'social_preference', 'sleep', 'diet', 'routine', 'life_satisfaction',
  'self_description', 'personality_traits', 'communication_style', 'decision_style', 'emotion_expression', 'stress_response', 'conflict_style', 'action_style', 'strengths', 'common_blocks',
  'core_values', 'family_values', 'career_values', 'money_values', 'relationship_values', 'success_definition', 'happiness_definition', 'freedom_definition', 'growth_attitude',
  'current_core_issue', 'secondary_issues', 'current_stressors', 'current_goal', 'current_expectation', 'current_resources', 'support_system', 'current_barriers', 'energy_state', 'recent_major_changes', 'ai_customer_summary',
] as const

export type ProfileField = typeof PROFILE_FIELD_KEYS[number]

export const PROFILE_SECTIONS: Array<{ title: string; fields: Array<{ key: ProfileField; label: string }> }> = [
  { title: 'TA是谁', fields: [{ key: 'age', label: '年龄' }, { key: 'gender', label: '性别' }, { key: 'city', label: '现居' }, { key: 'hometown', label: '家乡' }, { key: 'marital_status', label: '婚姻状态' }, { key: 'children_summary', label: '子女' }] },
  { title: '工作与事业', fields: [{ key: 'occupation', label: '职业' }, { key: 'industry', label: '行业' }, { key: 'position', label: '职位' }, { key: 'career_stage', label: '阶段' }, { key: 'career_problem', label: '事业困扰' }, { key: 'career_goal', label: '事业目标' }] },
  { title: '家庭与关系', fields: [{ key: 'family_summary', label: '家庭背景' }, { key: 'relationship_status', label: '关系状态' }, { key: 'partner_summary', label: '伴侣情况' }, { key: 'relationship_conflicts', label: '关系冲突' }, { key: 'communication_pattern', label: '沟通模式' }, { key: 'relationship_goal', label: '关系目标' }] },
  { title: '兴趣与生活', fields: [{ key: 'hobbies', label: '兴趣' }, { key: 'sports', label: '运动' }, { key: 'reading', label: '阅读' }, { key: 'travel', label: '旅行' }, { key: 'routine', label: '生活节奏' }, { key: 'life_satisfaction', label: '生活满意度' }] },
  { title: '价值观与特点', fields: [{ key: 'self_description', label: '自我描述' }, { key: 'personality_traits', label: '性格特点' }, { key: 'strengths', label: '优势' }, { key: 'common_blocks', label: '常见卡点' }, { key: 'core_values', label: '核心价值' }, { key: 'growth_attitude', label: '成长态度' }] },
  { title: '当前状态', fields: [{ key: 'current_core_issue', label: '核心困扰' }, { key: 'secondary_issues', label: '其他困扰' }, { key: 'current_stressors', label: '当前压力' }, { key: 'current_goal', label: '当前目标' }, { key: 'current_expectation', label: '期待获得' }, { key: 'current_resources', label: '已有资源' }, { key: 'support_system', label: '支持系统' }, { key: 'current_barriers', label: '当前阻碍' }, { key: 'energy_state', label: '能量状态' }, { key: 'recent_major_changes', label: '近期变化' }] },
]

export function emptyProfileState(customerId: string): CustomerProfileState {
  return { customerId, fields: {}, fieldMeta: {}, updatedAt: null, schemaVersion: 'v0.4' }
}

export function displayProfileValue(value: ProfileValue) {
  if (Array.isArray(value)) return value.join('、')
  if (value === null || value === undefined || value === '') return ''
  return String(value)
}

export function updateValue(value: unknown): ProfileValue {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' || typeof item === 'number').map(String)
  return String(value)
}

export function profileUpdateLabel(update: ProfileUpdate) {
  for (const section of PROFILE_SECTIONS) {
    const field = section.fields.find((item) => item.key === update.field)
    if (field) return field.label
  }
  return update.field
}

export function profileSourceLabel(source: ProfileSource) {
  return source === 'AI_INFERENCE' ? 'AI 推测' : source === 'AI_EXTRACTED_CONFIRMED' ? 'AI提取 · 人工确认' : source === 'MENTOR_OBSERVATION' ? '导师观察' : source === 'MENTOR_FACTUAL_INPUT' || source === 'MENTOR_CONFIRMED' ? '导师事实输入' : source === 'ADMIN_CONFIRMED' ? '管理员确认' : source === 'STRUCTURED_INPUT' ? '结构化录入' : source === 'IMPORTED_HISTORY' || source === 'LEGACY_MIGRATION' ? '历史导入' : '客户明确表达'
}

export function extractLocalProfile(text: string, existing: CustomerProfileState): { updates: ProfileUpdate[] } {
  const updates: ProfileUpdate[] = []
  const add = (field: string, value: ProfileValue, confidence = 0.92, source: ProfileSource = 'MENTOR_OBSERVATION') => {
    if (value === null || value === '') return
    const previousValue = existing.fields[field] ?? null
    updates.push({ field, value, previousValue, conflict: previousValue !== null && displayProfileValue(previousValue) !== displayProfileValue(value), source, confidence, confirmed: false })
  }
  const age = text.match(/(?:今年|现年|年龄)?\s*(\d{2})\s*岁/)
  if (age) add('age', Number(age[1]))
  const cities = ['杭州', '南京', '上海', '北京', '深圳', '广州', '苏州', '成都', '重庆', '武汉', '西安']
  const city = cities.find((item) => text.includes(item))
  if (city) add('city', city)
  const occupation = text.match(/(?:做|从事|是一名|职业是)([^，。；、]{1,12})/)
  if (occupation) add('occupation', occupation[1].replace(/工作|职业/g, '').trim())
  if (/已婚|结婚/.test(text)) add('marital_status', '已婚')
  if (/离异|离婚/.test(text)) add('marital_status', '离异')
  const child = text.match(/(?:有个|有一位|有一个|带着)([^，。；]{1,16}(?:女儿|儿子|孩子))/) || text.match(/(?:有个|有一位|有一个|带着)([^，。；]{1,16})/)
  if (child) add('children_summary', child[1])
  const hobbies = ['瑜伽', '旅行', '跑步', '阅读', '摄影', '音乐', '绘画', '游泳'].filter((item) => text.includes(item))
  if (hobbies.length) add('hobbies', hobbies)
  const relationshipIssue = text.match(/([^，。；]{0,12}(?:夫妻关系|亲密关系|家庭关系)[^，。；]{0,16})/)
  if (relationshipIssue) add('current_core_issue', relationshipIssue[1].trim())
  if (/夫妻关系|亲密关系|伴侣|冷战/.test(text)) add('relationship_conflicts', text.match(/([^，。；]{0,16}(?:夫妻关系|亲密关系|伴侣)[^，。；]{0,20})/)?.[1]?.trim() || '亲密关系中存在持续冲突')
  const goal = text.match(/(?:希望|想要|目标是|想)([^，。；]{2,24})/)
  if (goal) add('current_goal', goal[1].trim())
  const inference = text.match(/可能[^，。；]{0,12}(?:缺乏安全感|不够自信|害怕被拒绝)/)
  if (inference) add('self_description', inference[0].trim(), 0.56, 'AI_INFERENCE')
  return { updates }
}
