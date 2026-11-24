// Assessment report import proxy.
// ASVA calls assessmentReportDev's public endpoints to read reports
// using the linkSecret extracted from the user's pasted share URL.
// No importKey is needed — security is provided by the linkSecret.

import { normalizeStarReportPreview, parseStarShareUrl } from '../shared/assessment-import-star-contract.mjs'

// assessmentReportDev service base URL (same CloudBase environment)
const DEFAULT_REPORT_SERVICE_BASE = 'https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/assessment-report-dev'

const READ_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 256 * 1024 // 256 KB

/**
 * Read a report from assessmentReportDev using the public /v1/results/read endpoint.
 * The caller must have extracted reportId and linkSecret from the user's share URL.
 * 
 * @param {string} reportId - The report ID (e.g., rpt_xxx)
 * @param {string} linkSecret - The link secret from the share URL
 * @param {object} options - Optional overrides (serviceBase, fetch)
 * @returns {Promise<object>} The report data (sanitized preview)
 */
export async function readAssessmentReport(reportId, linkSecret, options = {}) {
  const serviceBase = options.serviceBase || process.env.ASSESSMENT_REPORT_SERVICE_BASE || DEFAULT_REPORT_SERVICE_BASE
  
  if (!reportId || !linkSecret) {
    throw Object.assign(new Error('缺少报告标识或链接密钥'), { code: 'INVALID_ARGUMENTS' })
  }

  const url = `${serviceBase}/v1/results/read`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)

  try {
    const fetchImpl = options.fetch || globalThis.fetch
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, linkSecret }),
      signal: controller.signal,
    })

    if (response.status === 404) {
      throw Object.assign(new Error('报告不存在或链接密钥不正确'), { code: 'REPORT_NOT_FOUND' })
    }
    if (!response.ok) {
      throw Object.assign(new Error(`报告服务返回 ${response.status}`), { code: 'SERVICE_ERROR', status: response.status })
    }

    // Read with size limit
    const reader = response.body.getReader()
    const chunks = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        throw Object.assign(new Error('报告数据超出大小限制'), { code: 'RESPONSE_TOO_LARGE' })
      }
      chunks.push(value)
    }

    const decoder = new TextDecoder()
    const text = chunks.map(chunk => decoder.decode(chunk)).join('')
    const report = JSON.parse(text)

    // Validate basic structure
    if (!report || typeof report !== 'object' || !report.reportId) {
      throw Object.assign(new Error('报告数据格式不正确'), { code: 'INVALID_RESPONSE' })
    }

    // Verify the reportId matches what was requested
    if (report.reportId !== reportId) {
      throw Object.assign(new Error('报告标识不匹配'), { code: 'REPORT_ID_MISMATCH' })
    }

    return report
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('报告服务请求超时'), { code: 'TIMEOUT' })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Import an assessment report from a share URL.
 * Parses the URL, reads the report, and generates a safe preview.
 * 
 * @param {string} shareUrl - The full share URL (https://...mindtest-web/r/#...)
 * @param {object} options - Optional overrides
 * @returns {Promise<object>} Safe preview data for the mentor to confirm
 */
export async function importAssessmentFromShareUrl(shareUrl, options = {}) {
  // Parse the share URL (validates format, extracts reportId + linkSecret)
  let parsed
  try {
    parsed = parseStarShareUrl(shareUrl)
  } catch (error) {
    throw Object.assign(new Error('分享链接格式不正确，请使用职业六芒星的完整分享链接'), { code: 'INVALID_SHARE_URL', cause: error })
  }

  const { reportId, linkSecret } = parsed

  // Read the report from assessmentReportDev
  const report = await readAssessmentReport(reportId, linkSecret, options)

  // Generate a safe preview (strips sensitive fields, validates star words)
  let preview
  try {
    preview = normalizeStarReportPreview(report, reportId)
  } catch (error) {
    throw Object.assign(new Error('报告内容不符合职业六芒星规范'), { code: 'INVALID_REPORT_CONTENT', cause: error })
  }

  return {
    reportId: preview.reportId,
    assessmentId: preview.assessmentId,
    assessmentName: preview.assessmentName,
    assessmentVersion: preview.assessmentVersion,
    completedAt: preview.completedAt,
    nickname: preview.nickname,
    keyMetrics: preview.keyMetrics,
    headline: preview.headline,
    summary: preview.summary,
    caution: preview.caution,
    shareUrl,
    source: 'assessment-import',
    importedAt: new Date().toISOString(),
  }
}

/**
 * Build the full share URL for a report (for display/link purposes).
 * Note: This does NOT validate the linkSecret — it's just formatting.
 */
export function buildShareUrl(reportId, linkSecret) {
  if (!reportId || !linkSecret) return null
  const id = reportId.startsWith('rpt_') ? reportId.slice(4) : reportId
  return `https://xiangshu3721.github.io/mindtest-web/r/#${id}.${linkSecret}`
}
