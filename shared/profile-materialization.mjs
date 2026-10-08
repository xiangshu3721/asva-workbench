const SNAPSHOT_SEMANTIC_KINDS = new Set(['PROFILE_FIELD', 'CURRENT_STATE', 'RELATIONSHIP', 'RESOURCE', 'NEED', 'GOAL', 'PREFERENCE'])
const SUBJECTIVE_FIELDS = new Set(['self_description', 'personality_traits', 'communication_style', 'decision_style', 'emotion_expression', 'stress_response', 'conflict_style', 'action_style', 'strengths', 'common_blocks'])
const VALUE_FIELDS = new Set(['core_values', 'family_values', 'career_values', 'money_values', 'relationship_values', 'success_definition', 'happiness_definition', 'freedom_definition', 'growth_attitude'])

const FIELD_LABELS = {
  birth_date: '出生日期', age: '年龄', gender: '性别', city: '现居地', hometown: '出生地 / 家乡', marital_status: '婚姻状态', children_summary: '子女情况',
  family_summary: '家庭背景', parents_relationship: '父母关系', siblings: '兄弟姐妹', family_events: '家庭经历', support_system: '支持系统',
  occupation: '当前职业', industry: '行业', position: '职位', career_stage: '事业阶段', career_problem: '事业困扰', career_goal: '事业目标',
  hobbies: '兴趣', sports: '运动', reading: '阅读', travel: '旅行', art_preferences: '艺术偏好', strengths: '优势',
  personality_traits: '性格特点', communication_style: '沟通方式', decision_style: '决策方式', common_blocks: '常见卡点',
  core_values: '核心价值', family_values: '家庭价值', career_values: '事业价值', growth_attitude: '成长态度',
  current_core_issue: '当前困扰', current_goal: '当前目标', current_expectation: '期待获得', current_resources: '已有资源', current_barriers: '当前阻碍', energy_state: '当前状态',
}

const SECTION_DEFINITIONS = [
  { title: 'TA是谁', fields: ['birth_date', 'age', 'gender', 'city', 'hometown', 'marital_status', 'children_summary'], emptyLabel: '待补充' },
  { title: '家庭与关系', fields: ['family_summary', 'parents_relationship', 'siblings', 'family_events', 'relationship_status', 'relationship_conflicts', 'support_system'], emptyLabel: '待补充' },
  { title: '职业与事业', fields: ['occupation', 'industry', 'position', 'career_stage', 'career_problem', 'career_goal'], emptyLabel: '待补充' },
  { title: '兴趣偏好', fields: ['hobbies', 'sports', 'reading', 'travel', 'art_preferences'], emptyLabel: '待了解' },
  { title: '性格特点', fields: ['self_description', 'personality_traits', 'communication_style', 'decision_style', 'strengths', 'common_blocks'], emptyLabel: '待了解' },
  { title: '核心价值观', fields: ['core_values', 'family_values', 'career_values', 'growth_attitude'], emptyLabel: '待了解' },
  { title: '当前资源', fields: ['current_resources', 'support_system', 'strengths', 'career_stage'], emptyLabel: '待补充' },
]

const CAREER_TERMS = /职业|工作|销售|销冠|互联网|产品|运营|社交|电商|直播|内容|后台|创业|咨询|课程|事业|转型|大学|读书|毕业|房地产|心理成长|艺术疗愈/
const INTEREST_TERMS = /创作|小说|作词|作曲|写作|音乐|绘画|艺术|阅读|旅行|摄影|运动|表达/

function present(value) {
  return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
}

function displayValue(value) {
  if (Array.isArray(value)) return value.join('、')
  return present(value) ? String(value) : ''
}

function confirmed(evidence) {
  return evidence?.reviewStatus === 'CONFIRMED' && evidence.evidenceType !== 'HYPOTHESIS'
}

function basis(evidence) {
  return { evidenceId: evidence.id, sourceId: evidence.sourceId, displayText: evidence.displayText, excerpt: evidence.sourceExcerpt }
}

function fieldEvidence(evidenceItems, field) {
  return evidenceItems.filter((item) => confirmed(item) && item.fieldKey === field)
}

function itemFromField(field, value, evidenceItems) {
  if (!present(value)) return null
  const evidence = fieldEvidence(evidenceItems, field).slice(0, 4)
  return { label: FIELD_LABELS[field] || field, text: displayValue(value), evidenceIds: evidence.map((item) => item.id), basis: evidence.map(basis) }
}

function itemFromEvidence(evidence, label = '资料线索') {
  return { label, text: evidence.displayText, evidenceIds: [evidence.id], basis: [basis(evidence)] }
}

function uniqueItems(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = `${item.label}:${item.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function evidenceText(evidence) { return `${evidence.displayText || ''} ${evidence.sourceExcerpt || ''}` }

export function isHighConfidenceFact(evidence) {
  return evidence?.evidenceType === 'FACT' && Number(evidence.confidence) >= 0.8
}

export function isSnapshotEvidence(evidence) {
  return isHighConfidenceFact(evidence) && Boolean(evidence.fieldKey) && SNAPSHOT_SEMANTIC_KINDS.has(evidence.semanticKind) && evidence.semanticKind !== 'EVENT'
}

export function shouldAutoConfirmEvidence(evidence) {
  return isHighConfidenceFact(evidence) && evidence.semanticKind === 'EVENT'
}

function coverageFor(customer, evidenceItems) {
  const fields = customer?.profileFields || {}
  const domains = [
    ['基础身份', ['birth_date', 'age', 'gender', 'city', 'hometown']],
    ['家庭关系', ['family_summary', 'parents_relationship', 'siblings', 'family_events', 'relationship_status', 'relationship_conflicts']],
    ['教育成长', ['education', 'family_events']],
    ['职业事业', ['occupation', 'industry', 'position', 'career_stage', 'career_problem', 'career_goal']],
    ['兴趣能力', ['hobbies', 'sports', 'reading', 'travel', 'art_preferences', 'strengths']],
    ['人生经历', ['education', 'career_stage', 'career_problem', 'career_goal', 'recent_major_changes']],
    ['重要关系', ['support_system', 'partner_summary', 'relationship_conflicts']],
    ['当前状态', ['current_core_issue', 'current_stressors', 'energy_state', 'recent_major_changes']],
    ['目标需要', ['current_goal', 'current_expectation', 'current_barriers']],
    ['资源', ['current_resources', 'support_system', 'strengths']],
    ['价值意义', [...VALUE_FIELDS]],
  ]
  const result = domains.map(([name, fieldList]) => {
    const fieldSignals = fieldList.filter((field) => present(fields[field])).length
    const evidenceSignals = evidenceItems.filter((item) => confirmed(item) && (fieldList.includes(item.fieldKey) || (name === '职业事业' && item.semanticKind === 'EVENT' && CAREER_TERMS.test(evidenceText(item))) || (name === '兴趣能力' && item.semanticKind === 'EVENT' && INTEREST_TERMS.test(evidenceText(item))) || (name === '教育成长' && item.semanticKind === 'EVENT' && /教育|学校|大学|成长|离乡|毕业/.test(evidenceText(item))) || (name === '人生经历' && item.semanticKind === 'EVENT' && /高中|大学|离乡|房地产|销售|互联网|职业|迷茫|心理成长|艺术疗愈|课程|咨询|创业|后来|转向/.test(evidenceText(item))) || (name === '资源' && (item.semanticKind === 'RESOURCE' || (item.semanticKind === 'EVENT' && /创作|销冠|创业|课程|咨询|互联网|父母|哥哥/.test(evidenceText(item))))))).length
    const signals = fieldSignals + evidenceSignals
    return { name, status: signals >= 2 ? 'KNOWN' : signals === 1 ? 'PARTIAL' : 'UNKNOWN', signalCount: signals }
  })
  const weighted = result.reduce((sum, item) => sum + (item.status === 'KNOWN' ? 1 : item.status === 'PARTIAL' ? 0.5 : 0), 0)
  return { percentage: Math.round(weighted / result.length * 100), domains: result }
}

export function materializeCustomerProfile({ customer, evidenceItems = [] }) {
  const confirmedEvidence = evidenceItems.filter(confirmed)
  const fields = customer?.profileFields || {}
  const currentSnapshot = Object.fromEntries(Object.entries(fields).filter(([, value]) => present(value)).map(([field, value]) => {
    const evidence = fieldEvidence(evidenceItems, field).slice(0, 4)
    return [field, { value, evidenceIds: evidence.map((item) => item.id), basis: evidence.map(basis) }]
  }))

  const sections = SECTION_DEFINITIONS.map((definition) => {
    const fieldItems = definition.fields.map((field) => itemFromField(field, fields[field], evidenceItems)).filter(Boolean)
    let evidenceItemsForSection = []
    if (definition.title === '家庭与关系') evidenceItemsForSection = confirmedEvidence.filter((item) => item.semanticKind === 'RELATIONSHIP' && !definition.fields.includes(item.fieldKey))
    if (definition.title === '职业与事业') evidenceItemsForSection = confirmedEvidence.filter((item) => item.semanticKind === 'EVENT' && CAREER_TERMS.test(evidenceText(item)))
    if (definition.title === '兴趣偏好') evidenceItemsForSection = confirmedEvidence.filter((item) => (item.semanticKind === 'PREFERENCE' || (item.semanticKind === 'EVENT' && INTEREST_TERMS.test(evidenceText(item)))) && !definition.fields.includes(item.fieldKey))
    if (definition.title === '性格特点') evidenceItemsForSection = confirmedEvidence.filter((item) => (item.evidenceType === 'SELF_MEANING' || item.evidenceType === 'OBSERVATION') && (SUBJECTIVE_FIELDS.has(item.fieldKey) || /性格|沟通|决策|优势|卡点|表达/.test(evidenceText(item))))
    if (definition.title === '核心价值观') evidenceItemsForSection = confirmedEvidence.filter((item) => VALUE_FIELDS.has(item.fieldKey) || (item.evidenceType === 'SELF_MEANING' && /价值|重要|意义|成长|自由|成功|幸福/.test(evidenceText(item))))
    if (definition.title === '当前资源') evidenceItemsForSection = confirmedEvidence.filter((item) => (item.semanticKind === 'RESOURCE' || (item.semanticKind === 'EVENT' && /创作|销冠|创业|课程|咨询|互联网|父母|哥哥/.test(evidenceText(item)))) && !definition.fields.includes(item.fieldKey))
    const extraItems = evidenceItemsForSection.slice(0, 4).map((item) => itemFromEvidence(item, item.evidenceType === 'OBSERVATION' ? '导师观察' : item.evidenceType === 'SELF_MEANING' ? '客户表达' : '经历线索'))
    return { title: definition.title, emptyLabel: definition.emptyLabel, items: uniqueItems([...fieldItems, ...extraItems]).slice(0, 4) }
  })

  const lifeEvents = confirmedEvidence.filter((item) => item.semanticKind === 'EVENT').map((item) => ({ id: item.id, title: item.displayText, detail: item.sourceExcerpt, occurredAt: item.occurredAt || null, evidenceIds: [item.id], basis: [basis(item)] }))
  return { schemaVersion: 'profile-materialization-v1', currentSnapshot, sections, lifeEvents, coverage: coverageFor(customer, evidenceItems), aiSummaryStatus: confirmedEvidence.length ? 'STALE' : 'CURRENT' }
}
