import type { Customer, ProfileValue } from './domain'

// Keep this range aligned with shared/customer-understanding.mjs. The frontend
// only has the customer/profile snapshot here, so it deliberately passes no
// evidence rows or open conflicts.
// @ts-expect-error The shared .mjs module is bundled by Vite and executed by Node on the server.
import { understandingInputFingerprint } from '../shared/customer-understanding.mjs'

type ProfileMeta = { source?: string; confirmed?: boolean }

export type OneLineCustomerData = Pick<Customer, 'id' | 'name' | 'need' | 'helpExpectation' | 'goal' | 'notes' | 'source' | 'profileFields' | 'profileFieldMeta' | 'profileVersion' | 'understandingMeta'>

export interface OneLineUnderstanding {
  text: string
  inputFingerprint: string
  profileVersion: number
  source: 'RULE' | 'AI'
  evidenceIds: string[]
  sourceNotice: string
  usedFields: string[]
}
export interface ExistingOneLineUnderstanding {
  one_line_understanding?: { text?: string; evidence_ids?: string[] }
}

export interface ExistingOneLineMeta {
  inputFingerprint?: string
  profileVersion?: number
  source?: string
  status?: string
  clientSnapshotFingerprint?: string
}

const SUMMARY_FIELDS = [
  ['current_core_issue', '当前主要困扰'],
  ['current_stressors', '近期压力'],
  ['current_goal', '目前目标'],
  ['current_expectation', '期待获得'],
  ['recent_major_changes', '近期变化'],
  ['secondary_issues', '其他困扰'],
] as const
const IDENTITY_FIELDS = [
  ['gender', (value: string) => `客户为${genderText(value)}`],
  ['age', (value: string) => `目前${value}岁`],
  ['birth_year', (value: string) => `${value}年生`],
  ['city', (value: string) => `现居${value}`],
  ['occupation', (value: string) => `从事${value}`],
  ['industry', (value: string) => `所在行业为${value}`],
  ['position', (value: string) => `职位为${value}`],
  ['job_status', (value: string) => `工作状态为${value}`],
  ['career_stage', (value: string) => `处于${value}阶段`],
  ['relationship_status', (value: string) => `关系状态为${value}`],
  ['marital_status', (value: string) => `婚姻状态为${value}`],
  ['children_summary', (value: string) => `子女情况：${value}`],
  ['living_status', (value: string) => `生活状态为${value}`],
  ['hobbies', (value: string) => `兴趣包括${value}`],
  ['sports', (value: string) => `运动包括${value}`],
  ['reading', (value: string) => `阅读偏好为${value}`],
  ['travel', (value: string) => `旅行偏好为${value}`],
  ['routine', (value: string) => `生活节奏为${value}`],
] as const

function genderText(value: string) {
  if (value === '女' || value === '女性') return '女性'
  if (value === '男' || value === '男性') return '男性'
  return value
}

function valueText(value: ProfileValue | string | undefined) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join('、')
  if (value === null || value === undefined) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function cleanClause(value: string, limit = 100) {
  return value.replace(/^[：:，,。；;\s]+|[，,。；;\s]+$/g, '').replace(/\s+/g, ' ').slice(0, limit)
}

function redactPrivateText(value: string) {
  return value
    .replace(/1\d{10}/g, '联系方式已隐藏')
    .replace(/(?:微信|wx|wechat)(?:号|id)?\s*[:：]?\s*[a-z0-9_-]{3,}/gi, '微信信息已隐藏')
}

function noteSummary(value: string) {
  const normalized = redactPrivateText(value).replace(/^(?:备注|客户备注|资料记录)\s*[:：]?\s*/i, '').trim()
  if (!normalized) return ''
  const clauses = normalized.split(/[。！？；;\n]+/).map((item) => cleanClause(item, 90)).filter(Boolean)
  const signal = /目前|最近|正在|希望|想要|想|需要|目标|困扰|压力|考虑|变化|工作|关系|家庭|睡眠|客户|转型|不确定/
  const selected = clauses.filter((item) => signal.test(item)).slice(0, 2)
  const result = (selected.length ? selected : clauses.slice(0, 1)).join('；')
  return result.length > 90 ? `${result.slice(0, 89)}…` : result
}

function recordedContext(customer: OneLineCustomerData) {
  return [
    ['need', '当前关注', customer.need],
    ['goal', '目前希望', customer.goal],
    ['helpExpectation', '期待获得', customer.helpExpectation],
  ] as const
}

function fieldMeta(customer: OneLineCustomerData, field: string): ProfileMeta {
  return (customer.profileFieldMeta?.[field] || {}) as ProfileMeta
}

function sourceLabel(source?: string) {
  return ({
    AI_INFERENCE: 'AI推测',
    AI_EXTRACTED: 'AI提取',
    AI_EXTRACTED_CONFIRMED: 'AI提取后人工确认',
    MENTOR_OBSERVATION: '导师观察记录',
    MENTOR_FACTUAL_INPUT: '导师事实输入',
    MENTOR_CONFIRMED: '导师确认',
    IMPORTED_HISTORY: '历史导入',
    LEGACY_MIGRATION: '历史迁移',
  } as Record<string, string>)[source || ''] || ''
}

function buildSourceNotice(customer: OneLineCustomerData, usedFields: string[], note: string) {
  const pending = usedFields
    .map((field) => ({ field, meta: fieldMeta(customer, field) }))
    .filter(({ meta }) => meta.confirmed === false)
  const thirdParty = /第三方|朋友|家人|亲属|同事|导师转述|转述|代述/.test(`${customer.notes || ''} ${note}`)
  const parts: string[] = []
  if (pending.length) {
    const source = sourceLabel(pending[0].meta.source)
    parts.push(`${pending.length > 1 ? '部分资料' : '该资料'}${source ? `来自${source}，` : ''}待核实。`)
  }
  if (thirdParty) parts.push('部分内容来自第三方转述，需与客户本人核实。')
  return parts.join(' ')
}

function buildFingerprintCustomer(customer: OneLineCustomerData) {
  return {
    id: customer.id,
    source: customer.source,
    notes: customer.notes,
    need: customer.need,
    goal: customer.goal,
    helpExpectation: customer.helpExpectation,
    profileFields: customer.profileFields || {},
    profileVersion: customer.profileVersion || 0,
  }
}
export function createRuleOneLineUnderstanding(customer: OneLineCustomerData): OneLineUnderstanding {
  const fields = customer.profileFields || {}
  const usedFields: string[] = []
  const core: string[] = []
  const addCore = (field: string, label: string, raw: ProfileValue | string | undefined) => {
    const value = cleanClause(valueText(raw))
    if (!value) return
    usedFields.push(field)
    const phrase = field === 'current_core_issue' ? `目前主要困扰是${value}` : field === 'current_stressors' ? `近期承受${value}` : field === 'current_goal' ? `目前希望${value}` : field === 'current_expectation' ? `期待获得${value}` : `${label}为${value}`
    core.push(phrase)
  }
  for (const [field, label] of SUMMARY_FIELDS) addCore(field, label, fields[field])
  for (const [field, label, raw] of recordedContext(customer)) {
    const value = cleanClause(valueText(raw))
    if (!value) continue
    usedFields.push(field)
    core.push(`${label}${value}`)
  }

  const identity: string[] = []
  for (const [field, format] of IDENTITY_FIELDS) {
    const value = cleanClause(valueText(fields[field]))
    if (!value) continue
    usedFields.push(field)
    identity.push(format(value))
  }

  const note = customer.notes ? noteSummary(customer.notes) : ''
  if (note) usedFields.push('notes')
  const visibleParts = [...core.slice(0, 2), ...identity.slice(0, 3)]
  if (!visibleParts.length && note) visibleParts.push(`已记录：${note}`)
  if (!visibleParts.length) {
    visibleParts.push('当前尚未录入客户的核心情况、身份或需求信息。')
  } else if (note && visibleParts.length < 4 && !visibleParts.some((item) => item.includes(note))) {
    visibleParts.push(`已记录：${note}`)
  }
  const onlyGender = Boolean(fields.gender) && !core.length && identity.length === 1 && identity[0].startsWith('客户为') && !note
  const text = onlyGender
    ? `目前了解到${identity[0]}，其他背景与需求尚未录入`
    : visibleParts.length === 1 && /[。！？]$/.test(visibleParts[0]) ? visibleParts[0] : `${visibleParts.join('；')}。`
  return {
    text: text.slice(0, 220),
    inputFingerprint: understandingInputFingerprint({ customer: buildFingerprintCustomer(customer), evidenceItems: [] }),
    profileVersion: customer.profileVersion || 0,
    source: 'RULE',
    evidenceIds: [],
    sourceNotice: buildSourceNotice(customer, [...new Set(usedFields)], note),
    usedFields: [...new Set(usedFields)],
  }
}
export function selectOneLineUnderstanding({ local, understanding, meta }: { local: OneLineUnderstanding; understanding?: ExistingOneLineUnderstanding; meta?: ExistingOneLineMeta }) {
  const aiText = understanding?.one_line_understanding?.text?.trim() || ''
  // The backend fingerprint includes confirmed Evidence and conflicts unavailable to this page.
  // Compare the local snapshot captured when the server response was requested instead.
  const aiIsCurrent = Boolean(aiText && meta?.status === 'FRESH' && meta?.source !== 'STRUCTURED_FALLBACK' && meta?.clientSnapshotFingerprint === local.inputFingerprint && meta?.profileVersion === local.profileVersion)
  if (aiIsCurrent) {
    return { ...local, text: aiText, source: 'AI' as const, evidenceIds: understanding?.one_line_understanding?.evidence_ids || [] }
  }
  return local
}

export function mergeOneLineCustomer(customer: OneLineCustomerData, profile?: { customerId?: string; profileFields?: Customer['profileFields']; profileFieldMeta?: Customer['profileFieldMeta']; profileVersion?: number; profileMaterialization?: { rawNotes?: string } }) {
  if (!profile || profile.customerId !== customer.id) return customer
  const profileIsCurrent = customer.profileVersion === undefined || profile.profileVersion === undefined || profile.profileVersion >= customer.profileVersion
  if (!profileIsCurrent) return customer
  return {
    ...customer,
    profileFields: profile.profileFields ?? customer.profileFields,
    profileFieldMeta: profile.profileFieldMeta ?? customer.profileFieldMeta,
    profileVersion: profile.profileVersion ?? customer.profileVersion,
    notes: profile.profileMaterialization?.rawNotes ?? customer.notes,
  }
}
