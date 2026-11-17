// Stage 1A: pure, offline, star-only provider contract.
// No network I/O, no DB writes, and never log or expose a share bearer secret.
// Caller must keep parsed credentials server-side and use a FIXED provider API.
const SHARE_LINK = /^https:\/\/xiangshu3721\.github\.io\/mindtest-web\/r\/#((?:rpt_)?[A-Za-z0-9_-]{11,64})\.([A-Za-z0-9_-]{16,128})$/
const REPORT_ID = /^rpt_[A-Za-z0-9_-]{11,64}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const trimText = (value, max = 80) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const plainLabel = (value) => typeof value === 'string' && value.trim().length > 0 &&
  value.trim().length <= 24 && !/[<>{}\r\n\u0000-\u001f]/.test(value)
const fail = (code) => Object.assign(new Error('测评链接或报告不符合当前导入规则'), { code })

/** This intentionally accepts ONLY the canonical published report page, never arbitrary URLs. */
export function parseStarShareUrl(input) {
  if (typeof input !== 'string' || input.length > 512) throw fail('ASSESSMENT_LINK_INVALID')
  const matched = SHARE_LINK.exec(input.trim())
  if (!matched) throw fail('ASSESSMENT_LINK_INVALID')
  const reportId = matched[1].startsWith('rpt_') ? matched[1] : 'rpt_' + matched[1]
  if (!REPORT_ID.test(reportId)) throw fail('ASSESSMENT_LINK_INVALID')
  return { provider: 'mindtest-web', reportId, linkSecret: matched[2] }
}

/** Validates a provider's JSON, without treating its nickname as confirmed identity. */
export function normalizeStarReportPreview(report, expectedReportId) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw fail('ASSESSMENT_REPORT_INVALID')
  if (!REPORT_ID.test(String(expectedReportId || '')) || report.reportId !== expectedReportId) throw fail('ASSESSMENT_REPORT_MISMATCH')
  if (report.assessmentId !== 'star' || report.schemaVersion !== '1.0.0') throw fail('ASSESSMENT_UNSUPPORTED')
  if (typeof report.completedAt !== 'string' || !ISO_TIME.test(report.completedAt) ||
      !Number.isFinite(Date.parse(report.completedAt))) throw fail('ASSESSMENT_REPORT_INVALID')
  const nickname = trimText(report.nickname, 64)
  const version = trimText(report.assessmentVersion, 64)
  if (!nickname || !version || !Array.isArray(report.dimensions) || report.dimensions.length !== 2) throw fail('ASSESSMENT_REPORT_INVALID')
  const dims = Object.fromEntries(report.dimensions.map((item) => [item?.id, item]))
  if (!dims.drive || !dims.pursue) throw fail('ASSESSMENT_REPORT_INVALID')
  const drive = dims.drive.labels
  const pursue = dims.pursue.labels
  if (![drive, pursue].every((arr) => Array.isArray(arr) && arr.length === 3 && arr.every(plainLabel) &&
    new Set(arr).size === 3)) throw fail('ASSESSMENT_REPORT_INVALID')
  if (drive.some((word) => pursue.includes(word))) throw fail('ASSESSMENT_REPORT_INVALID')
  // Derive display copy from validated labels, not arbitrary HTML or unverified AI prose.
  const safeDrive = drive.map((v) => v.trim())
  const safePursue = pursue.map((v) => v.trim())
  return {
    provider: 'mindtest-web', reportId: expectedReportId,
    assessmentId: 'star', assessmentName: '职业六芒星',
    assessmentVersion: version, schemaVersion: '1.0.0',
    nickname, completedAt: report.completedAt,
    keyMetrics: [
      { id: 'drive', name: '底层动力', labels: safeDrive },
      { id: 'pursue', name: '现实追求', labels: safePursue },
    ],
    headline: '底层动力：' + safeDrive.join('、'),
    summary: '现实追求：' + safePursue.join('、'),
    caution: '自我整理结果，不是职业或心理诊断。',
    // No share URL, linkSecret, ownerToken, full report, consent or raw answers.
  }
}
