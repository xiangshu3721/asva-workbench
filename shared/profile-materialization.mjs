const SNAPSHOT_SEMANTIC_KINDS = new Set(['PROFILE_FIELD', 'CURRENT_STATE', 'RELATIONSHIP', 'RESOURCE', 'NEED', 'GOAL', 'PREFERENCE'])
const SUBJECTIVE_FIELDS = new Set(['self_description', 'personality_traits', 'communication_style', 'decision_style', 'emotion_expression', 'stress_response', 'conflict_style', 'action_style', 'strengths', 'common_blocks'])
const VALUE_FIELDS = new Set(['core_values', 'family_values', 'career_values', 'money_values', 'relationship_values', 'success_definition', 'happiness_definition', 'freedom_definition', 'growth_attitude'])

const FIELD_LABELS = {
  birth_date: '出生日期', age: '年龄', gender: '性别', city: '现居地', hometown: '出生地 / 家乡', marital_status: '婚姻状态', children_summary: '子女情况',
  family_summary: '家庭背景', parents_relationship: '父母关系', siblings: '兄弟姐妹', family_events: '家庭经历', support_system: '支持系统', relationship_status: '亲密关系状态', relationship_conflicts: '关系困扰', partner_summary: '伴侣情况',
  occupation: '当前职业', industry: '行业', position: '职位', career_stage: '事业阶段', career_problem: '事业困扰', career_goal: '事业目标', education: '教育经历', work_years: '工作年限',
  hobbies: '兴趣', sports: '运动', reading: '阅读', travel: '旅行', art_preferences: '艺术偏好', strengths: '优势',
  personality_traits: '性格特点', communication_style: '沟通方式', decision_style: '决策方式', common_blocks: '常见卡点', emotion_expression: '情绪表达', stress_response: '压力反应',
  core_values: '核心价值', family_values: '家庭价值', career_values: '事业价值', growth_attitude: '成长态度',
  current_core_issue: '当前困扰', current_goal: '当前目标', current_expectation: '期待获得', current_resources: '已有资源', current_barriers: '当前阻碍', energy_state: '当前状态', sleep: '睡眠情况', routine: '生活状态',
}

const SECTION_DEFINITIONS = [
  { title: 'TA是谁', fields: ['birth_date', 'age', 'gender', 'city', 'hometown', 'marital_status', 'children_summary'], emptyLabel: '待补充' },
  { title: '家庭与关系', fields: ['family_summary', 'parents_relationship', 'siblings', 'family_events', 'relationship_status', 'relationship_conflicts', 'partner_summary', 'support_system'], emptyLabel: '待补充' },
  { title: '职业与事业', fields: ['occupation', 'industry', 'position', 'career_stage', 'career_problem', 'career_goal', 'education', 'work_years'], emptyLabel: '待补充' },
  { title: '情绪与生活', fields: ['emotion_expression', 'stress_response', 'sleep', 'routine', 'energy_state'], emptyLabel: '待了解' },
  { title: '兴趣偏好', fields: ['hobbies', 'sports', 'reading', 'travel', 'art_preferences'], emptyLabel: '待了解' },
  { title: '性格特点', fields: ['self_description', 'personality_traits', 'communication_style', 'decision_style', 'strengths', 'common_blocks'], emptyLabel: '待了解' },
  { title: '核心价值观', fields: ['core_values', 'family_values', 'career_values', 'growth_attitude'], emptyLabel: '待了解' },
  { title: '当前状态与目标', fields: ['current_core_issue', 'current_expectation', 'current_goal', 'current_barriers'], emptyLabel: '待补充' },
  { title: '当前资源', fields: ['current_resources', 'support_system', 'strengths', 'career_stage'], emptyLabel: '待补充' },
]

const CAREER_TERMS = /职业|工作|销售|销冠|互联网|产品|运营|社交|电商|直播|内容|后台|创业|咨询|课程|事业|转型|大学|读书|毕业|房地产|心理成长|艺术疗愈/
const INTEREST_TERMS = /创作|小说|作词|作曲|写作|音乐|绘画|艺术|阅读|旅行|摄影|运动|表达/
const SUMMARY_STATUSES = new Set(['FRESH', 'STALE', 'PROCESSING', 'FAILED'])
const PROVISIONAL_EXCLUDED_STATUSES = new Set(['CONFIRMED', 'SUPERSEDED', 'REJECTED'])

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

const WORK_LOCATION_CUES = /工作地点|在[^，。；]{0,12}工作|于[^，。；]{0,12}工作/
const RESIDENCE_CUES = /现居|居住|住在|生活在|定居|搬到|所在城市/

function isWorkLocationOnlyEvidence(evidence) {
  if (!evidence || !['city', 'current_city'].includes(evidence.fieldKey)) return false
  const text = `${evidence.displayText || ''} ${evidence.sourceExcerpt || ''}`
  return WORK_LOCATION_CUES.test(text) && !RESIDENCE_CUES.test(text)
}

function fieldEvidence(evidenceItems, field) {
  return evidenceItems.filter((item) => confirmed(item) && item.fieldKey === field && !isWorkLocationOnlyEvidence(item))
}

function fieldStatusLabel(fieldMeta, evidenceItems) {
  const source = fieldMeta?.source
  if (fieldMeta?.confirmed === false) {
    if (source === 'AI_INFERENCE') return 'AI推断 · 待验证'
    if (source === 'AI_EXTRACTED') return 'AI整理 · 待核实'
    if (source === 'MENTOR_OBSERVATION') return '导师观察 · 待核实'
    if (source === 'MENTOR_FACTUAL_INPUT') return '导师记录 · 待核实'
    return 'AI整理 · 待核实'
  }
  if (evidenceItems.length) {
    if (source === 'AI_EXTRACTED_CONFIRMED') return 'AI提取 · 人工确认'
    if (['ADMIN_CONFIRMED', 'MENTOR_CONFIRMED', 'USER_EXPLICIT'].includes(source)) return '人工已确认'
    return '已确认'
  }
  if (fieldMeta?.confirmed === true) {
    if (source === 'AI_EXTRACTED_CONFIRMED') return 'AI提取 · 人工确认'
    if (['ADMIN_CONFIRMED', 'MENTOR_CONFIRMED', 'USER_EXPLICIT'].includes(source)) return '人工已确认'
    return '已确认'
  }
  if (source === 'AI_INFERENCE') return 'AI推断 · 待验证'
  if (source === 'MENTOR_OBSERVATION') return '导师观察 · 待核实'
  if (source === 'MENTOR_FACTUAL_INPUT') return '导师记录 · 待核实'
  if (fieldMeta) return '待核实'
  return '已录入'
}

function itemFromField(field, value, evidenceItems, fieldMeta) {
  if (!present(value)) return null
  const evidence = evidenceItems.filter((item) => item.fieldKey === field && (confirmed(item) || fieldMeta?.evidenceId === item.id)).slice(0, 4)
  return { label: FIELD_LABELS[field] || field, text: displayValue(value), statusLabel: fieldStatusLabel(fieldMeta, evidence), evidenceIds: evidence.map((item) => item.id), basis: evidence.map(basis) }
}

function itemFromEvidence(evidence, label = '资料线索') {
  return { label, text: evidence.displayText, statusLabel: '已确认', evidenceIds: [evidence.id], basis: [basis(evidence)] }
}

const MATERIALIZATION_FIELD_KEYS = new Set(SECTION_DEFINITIONS.flatMap((definition) => definition.fields))
const MATERIALIZATION_ALIASES = {
  current_core_issue: ['need', 'currentIssue'],
  current_expectation: ['helpExpectation', 'expectation'],
  current_goal: ['goal', 'currentGoal'],
  family_summary: ['familySummary'],
  marital_status: ['maritalStatus'],
  relationship_status: ['relationshipStatus'],
}

function materializationFields(customer = {}) {
  const stored = customer?.profileFields && typeof customer.profileFields === 'object' && !Array.isArray(customer.profileFields) ? customer.profileFields : {}
  const fields = { ...stored }
  for (const field of MATERIALIZATION_FIELD_KEYS) {
    if (present(fields[field]) || !present(customer?.[field])) continue
    fields[field] = customer[field]
  }
  for (const [field, aliases] of Object.entries(MATERIALIZATION_ALIASES)) {
    if (present(fields[field])) continue
    const alias = aliases.find((key) => present(customer?.[key]))
    if (alias) fields[field] = customer[alias]
  }
  if (!present(fields.notes) && present(customer?.notes)) fields.notes = customer.notes
  return fields
}

function provisionalSourceLabel(evidence) {
  if (evidence?.informationNature === 'AI_INFERENCE' || evidence?.evidenceType === 'HYPOTHESIS') return '待验证洞察'
  if (evidence?.contentSource === 'MENTOR_OBSERVATION' || evidence?.informationNature === 'BEHAVIOR_OBSERVATION') return '导师观察 · 待核实'
  if (evidence?.contentSource === 'MENTOR_REPORTED') return '导师转述 · 待核实'
  if (evidence?.contentSource === 'STAFF_TRANSCRIBED_CUSTOMER') return '客户表达（转录）· 待核实'
  if (evidence?.contentSource === 'CUSTOMER_DIRECT' || evidence?.informationNature === 'PERSONAL_STATEMENT') return '客户表达 · 待核实'
  if (evidence?.contentSource === 'THIRD_PARTY_REPORTED') return '第三方说法 · 待核实'
  return '资料线索 · 待核实'
}

function sectionTitleForEvidence(evidence) {
  if (isWorkLocationOnlyEvidence(evidence)) return '职业与事业'
  const direct = SECTION_DEFINITIONS.find((definition) => definition.fields.includes(evidence?.fieldKey))
  if (direct) return direct.title
  if (evidence?.semanticKind === 'RELATIONSHIP') return '家庭与关系'
  if (evidence?.semanticKind === 'PREFERENCE' || INTEREST_TERMS.test(evidenceText(evidence))) return '兴趣偏好'
  if (evidence?.semanticKind === 'RESOURCE') return '当前资源'
  if (evidence?.semanticKind === 'GOAL' || evidence?.semanticKind === 'NEED') return '目标与需要'
  if (evidence?.semanticKind === 'OBSERVATION' || evidence?.evidenceType === 'OBSERVATION') return '咨询观察'
  if (evidence?.semanticKind === 'EVENT' && CAREER_TERMS.test(evidenceText(evidence))) return '职业与事业'
  if (evidence?.semanticKind === 'EVENT') return '人生经历与变化'
  return '当前状态'
}

function isProvisionalEvidence(evidence) {
  if (!evidence || PROVISIONAL_EXCLUDED_STATUSES.has(evidence.reviewStatus)) return false
  if (!evidence.displayText || !evidence.sourceId || !evidence.customerId) return false
  return true
}

function provisionalItemFromEvidence(evidence) {
  const label = provisionalSourceLabel(evidence)
  return {
    fieldKey: evidence.fieldKey || null,
    value: evidence.standardValue,
    displayText: evidence.displayText,
    label,
    statusLabel: evidence.verificationStatus === 'CONFLICTED' ? '存在冲突' : evidence.informationNature === 'AI_INFERENCE' || evidence.evidenceType === 'HYPOTHESIS' ? 'AI推断 · 待验证' : '待核实',
    text: evidence.displayText,
    sourceId: evidence.sourceId,
    evidenceId: evidence.id,
    contentSource: evidence.contentSource || null,
    informationNature: evidence.informationNature || null,
    verificationStatus: evidence.verificationStatus || 'UNKNOWN',
    occurredAt: evidence.occurredAt || null,
    conflictState: evidence.verificationStatus === 'CONFLICTED' ? 'CONFLICTED' : 'UNCONFIRMED',
    sectionTitle: sectionTitleForEvidence(evidence),
    evidenceIds: [evidence.id],
    basis: [basis(evidence)],
  }
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

function uniqueProvisionalItems(items) {
  const result = []
  for (const item of items) {
    const existing = result.find((candidate) => candidate.label === item.label && candidate.text === item.text)
    if (!existing) {
      result.push(item)
      continue
    }
    for (const evidenceId of item.evidenceIds || []) if (!existing.evidenceIds.includes(evidenceId)) existing.evidenceIds.push(evidenceId)
    for (const reference of item.basis || []) if (!existing.basis.some((candidate) => candidate.evidenceId === reference.evidenceId)) existing.basis.push(reference)
  }
  return result
}

function evidenceText(evidence) { return `${evidence.displayText || ''} ${evidence.sourceExcerpt || ''}` }

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]))
  return value
}

function hashText(value) {
  let hash = 2166136261
  for (const character of String(value)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function summaryInputFingerprint({ customer = {}, evidenceItems = [] } = {}) {
  const confirmedEvidence = evidenceItems.filter(confirmed).map((item) => ({ id: item.id, type: item.evidenceType, kind: item.semanticKind, field: item.fieldKey, value: stableValue(item.standardValue), occurredAt: item.occurredAt || '' })).sort((left, right) => left.id.localeCompare(right.id))
  const input = { need: customer.need || '', helpExpectation: customer.helpExpectation || '', goal: customer.goal || '', profileFields: stableValue(customer.profileFields || {}), confirmedEvidence }
  return hashText(JSON.stringify(input))
}

function summaryStatus({ customer, confirmedEvidence, summaryMeta, fingerprint }) {
  if (summaryMeta?.inputFingerprint === fingerprint && SUMMARY_STATUSES.has(summaryMeta.status)) return summaryMeta.status
  if (!summaryMeta && !confirmedEvidence.length && !Object.keys(customer?.profileFields || {}).length) return 'FRESH'
  return 'STALE'
}

export function isHighConfidenceFact(evidence) {
  return evidence?.evidenceType === 'FACT' && Number(evidence.confidence) >= 0.8
}

export function isSnapshotEvidence(evidence) {
  return isHighConfidenceFact(evidence) && Boolean(evidence.fieldKey) && SNAPSHOT_SEMANTIC_KINDS.has(evidence.semanticKind) && evidence.semanticKind !== 'EVENT'
}

export function shouldAutoConfirmEvidence(evidence) {
  if (evidence?.contentSource && ['UNKNOWN', 'MIXED'].includes(evidence.contentSource)) return false
  if (evidence?.informationNature === 'AI_INFERENCE') return false
  if (evidence?.verificationStatus === 'UNKNOWN' || evidence?.verificationStatus === 'CONFLICTED') return false
  return isHighConfidenceFact(evidence) && evidence.semanticKind === 'EVENT'
}

function coverageFor(customer, evidenceItems) {
  const fields = materializationFields(customer)
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

export function materializeCustomerProfile({ customer, evidenceItems = [], summaryMeta = null }) {
  const confirmedEvidence = evidenceItems.filter(confirmed)
  const fingerprint = summaryInputFingerprint({ customer, evidenceItems })
  const fields = materializationFields(customer)
  const fieldMeta = customer?.profileFieldMeta && typeof customer.profileFieldMeta === 'object' && !Array.isArray(customer.profileFieldMeta) ? customer.profileFieldMeta : {}
  const provisionalItems = uniqueProvisionalItems(evidenceItems.filter(isProvisionalEvidence).filter((item) => !confirmed(item)).filter((item) => fieldMeta[item.fieldKey]?.evidenceId !== item.id).map(provisionalItemFromEvidence))
  const supplementaryItems = Array.isArray(customer?.supplementaryItems) ? customer.supplementaryItems.filter((item) => present(item?.text)).map((item) => ({
    id: String(item.id || hashText(`${item.sourceRecordId || ''}:${item.text}`)),
    label: '客户补充信息',
    text: String(item.text),
    statusLabel: item.confirmed === true ? '已确认' : item.source === 'AI_INFERENCE' ? 'AI推断 · 待验证' : '待核实',
    evidenceIds: item.evidenceId ? [item.evidenceId] : [],
    basis: item.evidenceId ? [{ evidenceId: item.evidenceId, sourceId: item.sourceRecordId || '', displayText: String(item.text), excerpt: String(item.text) }] : [],
    source: item.source || 'AI_EXTRACTED',
    confirmed: item.confirmed === true,
    sourceRecordId: item.sourceRecordId || '',
    evidenceId: item.evidenceId || '',
  })) : []
  const currentSnapshot = Object.fromEntries(Object.entries(fields).filter(([, value]) => present(value)).map(([field, value]) => {
    const evidence = fieldEvidence(evidenceItems, field).slice(0, 4)
    return [field, { value, evidenceIds: evidence.map((item) => item.id), basis: evidence.map(basis) }]
  }))

  const sections = SECTION_DEFINITIONS.map((definition) => {
    const fieldItems = definition.fields.map((field) => itemFromField(field, fields[field], evidenceItems, fieldMeta[field])).filter(Boolean)
    let evidenceItemsForSection = []
    if (definition.title === '家庭与关系') evidenceItemsForSection = confirmedEvidence.filter((item) => item.semanticKind === 'RELATIONSHIP' && !definition.fields.includes(item.fieldKey))
    if (definition.title === '职业与事业') evidenceItemsForSection = confirmedEvidence.filter((item) => (item.semanticKind === 'EVENT' && CAREER_TERMS.test(evidenceText(item))) || isWorkLocationOnlyEvidence(item))
    if (definition.title === '兴趣偏好') evidenceItemsForSection = confirmedEvidence.filter((item) => (item.semanticKind === 'PREFERENCE' || (item.semanticKind === 'EVENT' && INTEREST_TERMS.test(evidenceText(item)))) && !definition.fields.includes(item.fieldKey))
    if (definition.title === '性格特点') evidenceItemsForSection = confirmedEvidence.filter((item) => (item.evidenceType === 'SELF_MEANING' || item.evidenceType === 'OBSERVATION') && (SUBJECTIVE_FIELDS.has(item.fieldKey) || /性格|沟通|决策|优势|卡点|表达/.test(evidenceText(item))))
    if (definition.title === '核心价值观') evidenceItemsForSection = confirmedEvidence.filter((item) => VALUE_FIELDS.has(item.fieldKey) || (item.evidenceType === 'SELF_MEANING' && /价值|重要|意义|成长|自由|成功|幸福/.test(evidenceText(item))))
    if (definition.title === '当前资源') evidenceItemsForSection = confirmedEvidence.filter((item) => (item.semanticKind === 'RESOURCE' || (item.semanticKind === 'EVENT' && /创作|销冠|创业|课程|咨询|互联网|父母|哥哥/.test(evidenceText(item)))) && !definition.fields.includes(item.fieldKey))
    const extraItems = evidenceItemsForSection.slice(0, 4).map((item) => itemFromEvidence(item, item.evidenceType === 'OBSERVATION' ? '导师观察' : item.evidenceType === 'SELF_MEANING' ? '客户表达' : '经历线索'))
    return { title: definition.title, emptyLabel: definition.emptyLabel, items: uniqueItems([...fieldItems, ...extraItems]).slice(0, 4) }
  })

  const lifeEvents = confirmedEvidence.filter((item) => item.semanticKind === 'EVENT').map((item) => ({ id: item.id, title: item.displayText, detail: item.sourceExcerpt, occurredAt: item.occurredAt || null, evidenceIds: [item.id], basis: [basis(item)] }))
  if (supplementaryItems.length) sections.push({ title: '客户补充信息', emptyLabel: '暂无补充信息', items: supplementaryItems })
  return { schemaVersion: 'profile-materialization-v2', currentSnapshot, sections, provisionalItems, supplementaryItems, lifeEvents, rawNotes: present(customer?.notes) ? String(customer.notes) : '', coverage: coverageFor(customer, evidenceItems), aiSummaryStatus: summaryStatus({ customer, confirmedEvidence, summaryMeta, fingerprint }), aiSummaryFingerprint: fingerprint }
}
