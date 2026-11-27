// V1.2: Extract assessment summaries for AI customer understanding.
// Converts ACTIVE assessment bindings into structured summaries that can be
// included in the understanding context without sending raw answer data.
//
// Rules:
// - Only ACTIVE, non-revoked bindings with customer consent participate.
// - Summaries are derived from the stored preview (keyMetrics, headline, summary).
// - Raw answer data is never sent to the model.
// - Missing or invalid data is represented as empty, not defaulted to "normal".

import crypto from 'node:crypto'

export const ASSESSMENT_UNDERSTANDING_VERSION = 'assessment-understanding-v1'

/**
 * Assessment types that are currently supported for AI understanding.
 * Only assessments with real H5 share capability are included.
 */
const SUPPORTED_ASSESSMENT_IDS = new Set([
  'star',
  'beattie-emotional-health',
  'beattie-anger',
  'beattie-fear',
  'beattie-drama',
  'beattie-guilt',
  'beattie-grief',
])

/**
 * Human-readable assessment names for context display.
 */
const ASSESSMENT_DISPLAY_NAMES = {
  'star': '职业六芒星',
  'beattie-emotional-health': '情绪健康测试',
  'beattie-anger': '愤怒测试',
  'beattie-fear': '恐惧测试',
  'beattie-drama': '戏剧化与不幸成瘾测试',
  'beattie-guilt': '内疚测试',
  'beattie-grief': '悲痛与失落测试',
}

/**
 * Check if an assessment binding is eligible for AI understanding.
 */
function isEligibleForUnderstanding(binding) {
  if (!binding) return false
  if (binding.status !== 'ACTIVE') return false
  if (binding.sourceRevoked || binding.localRevoked) return false
  if (!SUPPORTED_ASSESSMENT_IDS.has(binding.assessmentId)) return false
  // Preview must exist and contain basic data
  if (!binding.preview || typeof binding.preview !== 'object') return false
  if (!binding.preview.assessmentId) return false
  return true
}

/**
 * Extract a safe, structured summary from an assessment binding's preview.
 * Returns null if the binding is not eligible.
 */
export function extractAssessmentSummary(binding) {
  if (!isEligibleForUnderstanding(binding)) return null

  const preview = binding.preview
  const keyMetrics = Array.isArray(preview.keyMetrics)
    ? preview.keyMetrics
        .filter((m) => m && typeof m === 'object' && m.name)
        .map((m) => ({
          name: String(m.name || '').slice(0, 40),
          labels: Array.isArray(m.labels)
            ? m.labels.filter((l) => typeof l === 'string' && l.trim()).map((l) => String(l).slice(0, 80)).slice(0, 5)
            : [],
        }))
        .filter((m) => m.labels.length > 0)
        .slice(0, 4)
    : []

  const headline = typeof preview.headline === 'string'
    ? preview.headline.slice(0, 200)
    : ''

  const summary = typeof preview.summary === 'string'
    ? preview.summary.slice(0, 400)
    : ''

  const caution = typeof preview.caution === 'string'
    ? preview.caution.slice(0, 200)
    : ''

  return {
    binding_id: binding.bindingId || '',
    assessment_id: preview.assessmentId || binding.assessmentId || '',
    assessment_name: ASSESSMENT_DISPLAY_NAMES[preview.assessmentId || binding.assessmentId] || preview.assessmentName || binding.assessmentName || '',
    assessment_version: preview.assessmentVersion || binding.assessmentVersion || '',
    completed_at: preview.completedAt || binding.completedAt || '',
    headline,
    summary,
    caution,
    key_metrics: keyMetrics,
    // Content hash for fingerprinting - changes when preview changes
    content_hash: binding.snapshotHash || '',
  }
}

/**
 * Extract all eligible assessment summaries from a list of bindings.
 * Filters out ineligible bindings and returns only valid summaries.
 */
export function extractAllAssessmentSummaries(bindings) {
  if (!Array.isArray(bindings)) return []
  return bindings
    .map(extractAssessmentSummary)
    .filter(Boolean)
}

/**
 * Build the assessment_summaries section for the understanding context.
 * This is the structure that gets included in the context sent to the model.
 */
export function buildAssessmentContextSection(summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    return {
      version: ASSESSMENT_UNDERSTANDING_VERSION,
      available: false,
      count: 0,
      summaries: [],
      note: '',
    }
  }

  return {
    version: ASSESSMENT_UNDERSTANDING_VERSION,
    available: true,
    count: summaries.length,
    summaries: summaries.map((s) => ({
      assessment_id: s.assessment_id,
      assessment_name: s.assessment_name,
      completed_at: s.completed_at,
      headline: s.headline,
      summary: s.summary,
      caution: s.caution,
      key_metrics: s.key_metrics,
      assessment_evidence_ref: `ASM-${s.binding_id.slice(-6)}`,
    })),
    note: '以上是已完成并导入的心理测评结果摘要。这些是客户自评的结构化整理，不是临床诊断。职业六芒星反映客户自述的内在动力和价值追求；情绪系列测评反映客户自评的情绪表现。区分事实、自评结果与推测。',
  }
}

/**
 * Compute a fingerprint hash for the assessment data.
 * Used to detect when assessments have changed and understanding needs refresh.
 */
export function assessmentFingerprint(bindings) {
  const summaries = extractAllAssessmentSummaries(bindings)
  if (summaries.length === 0) return ''
  const stable = summaries
    .map((s) => `${s.assessment_id}:${s.content_hash}:${s.assessment_version}:${s.completed_at}`)
    .sort()
    .join('|')
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16)
}
