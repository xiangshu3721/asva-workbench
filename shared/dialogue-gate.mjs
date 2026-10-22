import crypto from 'node:crypto'

export const DIALOGUE_CLASSIFICATIONS = new Set(['NOT_DIALOGUE', 'ONE_SPEAKER', 'TWO_SPEAKERS', 'OVER_TWO_SPEAKERS', 'UNCERTAIN'])
export const DIALOGUE_SPEAKER_ROLES = new Set(['CUSTOMER', 'MENTOR', 'OTHER', 'UNKNOWN'])
export const DIALOGUE_GATE_PREFIX = '[ASVA_DIALOGUE_CONTEXT]'

const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
const base64url = (value) => Buffer.from(value).toString('base64url')
const fromBase64url = (value) => Buffer.from(value, 'base64url').toString('utf8')

function sign(value, secret) {
  return crypto.createHmac('sha256', String(secret || 'asva-local-dialogue-gate')).update(value).digest('base64url')
}

function safeSpeaker(raw, index) {
  const id = text(raw?.id || raw?.speaker_id || raw?.speakerId) || String.fromCharCode(65 + index)
  const suggestedRole = DIALOGUE_SPEAKER_ROLES.has(text(raw?.suggested_role || raw?.suggestedRole).toUpperCase()) ? text(raw?.suggested_role || raw?.suggestedRole).toUpperCase() : 'UNKNOWN'
  return { id: id.slice(0, 12), excerpt: text(raw?.excerpt || raw?.representative_excerpt || raw?.representativeExcerpt).slice(0, 240), suggestedRole, confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)) }
}

export function normalizeDialogueAssessment(raw, sourceText = '') {
  const requested = text(raw?.classification || raw?.dialogue_type || raw?.dialogueType).toUpperCase()
  let classification = DIALOGUE_CLASSIFICATIONS.has(requested) ? requested : 'UNCERTAIN'
  let speakers = Array.isArray(raw?.speakers) ? raw.speakers.slice(0, 4).map(safeSpeaker) : []
  if (classification === 'ONE_SPEAKER' && speakers.length !== 1) classification = 'UNCERTAIN'
  if (classification === 'TWO_SPEAKERS' && speakers.length !== 2) classification = 'UNCERTAIN'
  if (classification === 'OVER_TWO_SPEAKERS') speakers = speakers.slice(0, 4)
  if (classification === 'NOT_DIALOGUE') speakers = []
  return {
    classification,
    speakers,
    summary: text(raw?.summary || raw?.reason || (classification === 'NOT_DIALOGUE' ? '未识别为多人对话。' : '需要确认资料中的说话人归属。')).slice(0, 300),
    sourceCharCount: String(sourceText || '').length,
    requiresHumanConfirmation: classification !== 'NOT_DIALOGUE',
  }
}

export function createDialogueAnalysisToken({ contentHash, targetCustomerId = '', customerOperationId = '', assessment, secret, now = Date.now() }) {
  const payload = { v: 1, kind: 'DIALOGUE_ANALYSIS', contentHash: text(contentHash), targetCustomerId: text(targetCustomerId), customerOperationId: text(customerOperationId), assessment, issuedAt: now, expiresAt: now + 15 * 60 * 1000 }
  const encoded = base64url(JSON.stringify(payload))
  return `${encoded}.${sign(encoded, secret)}`
}

export function verifyDialogueToken(token, secret, now = Date.now()) {
  const [encoded, signature] = String(token || '').split('.')
  if (!encoded || !signature || sign(encoded, secret) !== signature) throw Object.assign(new Error('对话确认令牌无效，请重新识别资料。'), { code: 'DIALOGUE_GATE_INVALID', status: 409 })
  let payload
  try { payload = JSON.parse(fromBase64url(encoded)) } catch { throw Object.assign(new Error('对话确认令牌无效，请重新识别资料。'), { code: 'DIALOGUE_GATE_INVALID', status: 409 }) }
  if (payload?.v !== 1 || Number(payload.expiresAt) < now) throw Object.assign(new Error('对话确认已过期，请重新识别资料。'), { code: 'DIALOGUE_GATE_EXPIRED', status: 409 })
  return payload
}

export function finalizeDialogueConfirmation({ analysisToken, contentHash, targetCustomerId = '', customerOperationId = '', speakerId = '', secret, now = Date.now() }) {
  const analysis = verifyDialogueToken(analysisToken, secret, now)
  if (analysis.kind !== 'DIALOGUE_ANALYSIS' || !analysis.assessment || analysis.contentHash !== text(contentHash) || analysis.targetCustomerId !== text(targetCustomerId) || analysis.customerOperationId !== text(customerOperationId)) throw Object.assign(new Error('资料、客户或操作已变化，请重新识别。'), { code: 'DIALOGUE_GATE_CONTEXT_MISMATCH', status: 409 })
  const classification = analysis.assessment?.classification
  if (classification === 'OVER_TWO_SPEAKERS') throw Object.assign(new Error('资料包含超过两位说话人，请先拆分资料后再保存。'), { code: 'DIALOGUE_OVER_TWO_SPEAKERS', status: 422 })
  if (classification === 'UNCERTAIN') throw Object.assign(new Error('暂时无法确认说话人，请标注说话人或整理文本后重试。'), { code: 'DIALOGUE_UNCERTAIN', status: 422 })
  const resolvedSpeakerId = classification === 'ONE_SPEAKER'
    ? text(speakerId) || text(analysis.assessment?.speakers?.[0]?.id)
    : classification === 'TWO_SPEAKERS' ? text(speakerId) : ''
  if (classification !== 'NOT_DIALOGUE') {
    const speaker = (analysis.assessment?.speakers || []).find((item) => item.id === resolvedSpeakerId)
    if (!speaker) throw Object.assign(new Error('请明确选择对应当前客户的说话人。'), { code: 'DIALOGUE_SPEAKER_REQUIRED', status: 422 })
  }
  const payload = { v: 1, kind: 'DIALOGUE_CONFIRMATION', contentHash: analysis.contentHash, targetCustomerId: analysis.targetCustomerId, customerOperationId: analysis.customerOperationId, classification, speakers: analysis.assessment.speakers, currentCustomerSpeakerId: classification === 'NOT_DIALOGUE' ? '' : resolvedSpeakerId, confirmedAt: now, expiresAt: now + 30 * 60 * 1000 }
  const encoded = base64url(JSON.stringify(payload))
  return { dialogueConfirmation: `${encoded}.${sign(encoded, secret)}`, ...payload }
}

export function verifyDialogueConfirmation({ token, contentHash, targetCustomerId = '', customerOperationId = '', secret, now = Date.now() }) {
  const payload = verifyDialogueToken(token, secret, now)
  if (payload.kind !== 'DIALOGUE_CONFIRMATION' || payload.contentHash !== text(contentHash) || payload.targetCustomerId !== text(targetCustomerId) || payload.customerOperationId !== text(customerOperationId)) throw Object.assign(new Error('对话确认与当前资料或客户不匹配，请重新确认。'), { code: 'DIALOGUE_CONFIRMATION_MISMATCH', status: 409 })
  if (!['NOT_DIALOGUE', 'ONE_SPEAKER', 'TWO_SPEAKERS'].includes(payload.classification)) throw Object.assign(new Error('该资料不能自动保存，请先重新整理说话人。'), { code: 'DIALOGUE_NOT_SAVEABLE', status: 422 })
  return payload
}

export function serializeDialogueContext(payload) {
  return `${DIALOGUE_GATE_PREFIX}${JSON.stringify({ classification: payload.classification, currentCustomerSpeakerId: payload.currentCustomerSpeakerId, targetCustomerId: payload.targetCustomerId, customerOperationId: payload.customerOperationId })}`
}

export function parseDialogueContext(notes) {
  const value = String(notes || '')
  const index = value.indexOf(DIALOGUE_GATE_PREFIX)
  if (index < 0) return null
  try { return JSON.parse(value.slice(index + DIALOGUE_GATE_PREFIX.length)) } catch { return null }
}

export function stripDialogueContext(notes) {
  const value = String(notes || '')
  const index = value.indexOf(DIALOGUE_GATE_PREFIX)
  return index < 0 ? value : value.slice(0, index).trim()
}
