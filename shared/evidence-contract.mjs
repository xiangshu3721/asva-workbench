import crypto from 'node:crypto'

export const SOURCE_TYPES = new Set(['TEXT_INPUT', 'VOICE_TRANSCRIPT', 'PASTED_TRANSCRIPT', 'FILE_UPLOAD', 'SERVICE_TRANSCRIPT', 'IMPORTED_TEXT'])
export const RESERVED_SOURCE_TYPES = new Set(['AUDIO_FILE', 'PDF', 'DOCX', 'CHAT_EXPORT'])
export const SOURCE_STATUSES = new Set(['UPLOADED', 'PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED', 'FAILED'])
export const EVIDENCE_TYPES = new Set(['FACT', 'SELF_MEANING', 'OBSERVATION', 'HYPOTHESIS'])
export const SEMANTIC_KINDS = new Set(['PROFILE_FIELD', 'CURRENT_STATE', 'EVENT', 'RELATIONSHIP', 'RESOURCE', 'NEED', 'GOAL', 'PREFERENCE', 'OTHER'])
export const EVIDENCE_REVIEW_STATUSES = new Set(['PENDING_REVIEW', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'])
export const PROPOSAL_ACTIONS = new Set(['ADD', 'UPDATE', 'APPEND', 'KEEP_CURRENT', 'REVIEW_REQUIRED'])
export const CHANGE_TYPES = new Set(['NEW_INFORMATION', 'STATE_CHANGE', 'FACT_CONTRADICTION', 'CUMULATIVE_ADDITION', 'SUBJECTIVE_DIFFERENCE', 'NO_CHANGE'])
export const CONFLICT_TYPES = new Set(['FACT_CONTRADICTION', 'POSSIBLE_STATE_CHANGE', 'SUBJECTIVE_DIFFERENCE', 'SOURCE_DISAGREEMENT'])
export const CONFLICT_STATUSES = new Set(['OPEN', 'RESOLVED', 'DISMISSED'])
export const CONFLICT_RESOLUTIONS = new Set(['USE_NEW', 'KEEP_CURRENT', 'KEEP_BOTH', 'MARK_UNKNOWN'])

export const PROFILE_FIELD_ALIASES = { current_city: 'city', current_occupation: 'occupation', current_job_status: 'job_status' }
export const STABLE_FACT_FIELDS = new Set(['birth_date', 'gender', 'phone', 'wechat'])
export const CUMULATIVE_FIELDS = new Set(['hobbies', 'sports', 'reading', 'travel', 'art_preferences', 'important_experiences', 'resources'])
export const SUBJECTIVE_FIELDS = new Set(['self_description', 'personality_traits', 'communication_style', 'decision_style', 'emotion_expression', 'stress_response', 'conflict_style', 'action_style', 'core_values', 'family_values', 'career_values', 'money_values', 'relationship_values', 'success_definition', 'happiness_definition', 'freedom_definition', 'growth_attitude'])

export function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`
}

export function contentHash(value) {
  return crypto.createHash('sha256').update(String(value || '').replace(/\r\n/g, '\n').trim()).digest('hex')
}

export function normalizeText(value, max = 20000) { return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max) }

export function chunkText(value, maxChars = 4000) {
  const source = String(value || '').replace(/\r\n/g, '\n')
  if (source.length <= maxChars) return [{ text: source, charStart: 0, charEnd: source.length, paragraphIndex: 0 }]
  const paragraphs = source.split(/\n{2,}/)
  const chunks = []
  let current = ''
  let start = 0
  let paragraphIndex = 0
  const flush = () => { if (!current) return; chunks.push({ text: current, charStart: start, charEnd: start + current.length, paragraphIndex }); current = '' }
  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph
    if (next.length <= maxChars) { current = next; continue }
    flush()
    if (paragraph.length <= maxChars) { current = paragraph; start = source.indexOf(paragraph, start); paragraphIndex += 1; continue }
    for (let offset = 0; offset < paragraph.length; offset += maxChars) {
      const text = paragraph.slice(offset, offset + maxChars)
      const absoluteStart = source.indexOf(text, start)
      chunks.push({ text, charStart: absoluteStart, charEnd: absoluteStart + text.length, paragraphIndex })
    }
    start = source.indexOf(paragraph, start) + paragraph.length
    paragraphIndex += 1
  }
  flush()
  return chunks.filter((item) => item.text.trim())
}

export function normalizeEvidenceCandidate(candidate, { sourceId, chunk, extractionBatchId, model = 'deepseek-chat', modelVersion = 'v1', promptVersion = 'evidence-v1' } = {}) {
  if (!candidate || typeof candidate !== 'object') return null
  const evidenceType = String(candidate.evidence_type || '').toUpperCase()
  const semanticKind = String(candidate.semantic_kind || '').toUpperCase()
  if (!EVIDENCE_TYPES.has(evidenceType) || !SEMANTIC_KINDS.has(semanticKind)) return null
  const fieldKey = PROFILE_FIELD_ALIASES[String(candidate.field_key || '').trim()] || String(candidate.field_key || '').trim()
  const value = candidate.value === null || candidate.value === undefined ? '' : typeof candidate.value === 'string' || typeof candidate.value === 'number' || typeof candidate.value === 'boolean' || Array.isArray(candidate.value) ? candidate.value : ''
  const displayText = normalizeText(candidate.display_text, 500)
  const excerpt = normalizeText(candidate.source_excerpt, 500)
  if (!displayText || !excerpt || !String(value).trim()) return null
  const confidence = Number(candidate.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  const locator = candidate.locator && typeof candidate.locator === 'object' ? candidate.locator : {}
  return {
    sourceId: sourceId || null,
    evidenceType,
    semanticKind,
    fieldKey: fieldKey || null,
    standardValue: value,
    displayText,
    sourceExcerpt: excerpt,
    locator: { charStart: Number.isFinite(Number(locator.char_start)) ? Number(locator.char_start) : chunk?.charStart, charEnd: Number.isFinite(Number(locator.char_end)) ? Number(locator.char_end) : chunk?.charEnd, paragraphIndex: Number.isFinite(Number(locator.paragraph_index)) ? Number(locator.paragraph_index) : chunk?.paragraphIndex },
    occurredAt: typeof candidate.occurred_at === 'string' ? candidate.occurred_at.slice(0, 80) : '',
    confidence: Math.max(0, Math.min(1, confidence)),
    reviewStatus: 'PENDING_REVIEW',
    extractionBatchId: extractionBatchId || '',
    model,
    modelVersion,
    promptVersion,
  }
}

export function dedupeEvidence(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = [item.evidenceType, item.semanticKind, item.fieldKey, JSON.stringify(item.standardValue), item.sourceExcerpt].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function classifyEvidenceChange(evidence, currentValue) {
  const hasCurrent = currentValue !== null && currentValue !== undefined && String(currentValue) !== ''
  if (!hasCurrent) return { action: 'ADD', changeType: 'NEW_INFORMATION', conflictType: null }
  if (STABLE_FACT_FIELDS.has(evidence.fieldKey)) return { action: 'REVIEW_REQUIRED', changeType: 'FACT_CONTRADICTION', conflictType: 'FACT_CONTRADICTION' }
  if (CUMULATIVE_FIELDS.has(evidence.fieldKey)) return { action: 'APPEND', changeType: 'CUMULATIVE_ADDITION', conflictType: null }
  if (SUBJECTIVE_FIELDS.has(evidence.fieldKey) || evidence.evidenceType === 'SELF_MEANING' || evidence.evidenceType === 'OBSERVATION') return { action: 'REVIEW_REQUIRED', changeType: 'SUBJECTIVE_DIFFERENCE', conflictType: 'SUBJECTIVE_DIFFERENCE' }
  if (evidence.semanticKind === 'CURRENT_STATE' || ['city', 'occupation', 'job_status', 'marital_status', 'relationship_status', 'current_goal'].includes(evidence.fieldKey)) return { action: 'UPDATE', changeType: 'STATE_CHANGE', conflictType: 'POSSIBLE_STATE_CHANGE' }
  return { action: 'REVIEW_REQUIRED', changeType: 'SOURCE_DISAGREEMENT', conflictType: 'SOURCE_DISAGREEMENT' }
}

export function sourcePerspectiveFromRole(sourceRole) {
  if (sourceRole === 'MENTOR') return 'MENTOR_OBSERVATION'
  if (sourceRole === 'CUSTOMER') return 'CUSTOMER_FIRST_PARTY'
  return 'STAFF_REPORTED'
}

export function proposalId(evidenceId, fieldKey) { return stableId('PRP', `${evidenceId}:${fieldKey || ''}`) }
export function conflictId(fieldKey, currentEvidenceId, newEvidenceId) { return stableId('CFL', `${fieldKey}:${currentEvidenceId || ''}:${newEvidenceId || ''}`) }
