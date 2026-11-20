// Stage 1A: pure, offline, star-only provider contract.
// No network I/O, no DB writes, and never log or expose a share bearer secret.
// Caller must keep parsed credentials server-side and use a FIXED provider API.
// Keep these bounds aligned with mindtest-web's reader and report service.
// mindtest-web/js/cloud-client.js uses randomToken(8) => 11-char ID suffix and
// randomToken(12) => 16-char secret; buildShareUrl strips the rpt_ prefix.
// Older links or manually copied links can contain the rpt_ prefix.
const SHARE_LINK = /^https:\/\/xiangshu3721\.github\.io\/mindtest-web\/r\/#(?:rpt_)?([A-Za-z0-9_-]{11,64})\.([A-Za-z0-9_-]{16,128})$/
const REPORT_ID = /^rpt_[A-Za-z0-9_-]{11,64}$/
const STAR_VERSION = 'star-words-31-v1'
// The provider accepts only these 31 published Star words. Keep the preview
// contract equally strict so a malformed provider response cannot introduce
// arbitrary content into ASVA's consultation surface.
const STAR_WORDS = new Set([
  '人际/归属感', '团队合作', '能帮助他人', '家庭', '朋友', '亲密关系', '有益于社会',
  '稳定', '安全', '健康', '乐趣', '物质保障', '工作与生活平衡', '符合我的道德观',
  '高收入', '被认可', '受尊重', '成就感', '成功', '名誉', '地位', '竞争', '权力',
  '创造性', '新鲜感', '自由', '挑战性', '冒险性', '多样性和变化性', '能发挥自己的才能', '有学习/成长的机会',
])
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const trimText = (value, max = 80) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const plainLabel = (value) => typeof value === 'string' && STAR_WORDS.has(value.trim())
const fail = (code) => Object.assign(new Error('测评链接或报告不符合当前导入规则'), { code })

/** This intentionally accepts ONLY the canonical published report page, never arbitrary URLs. */
export function parseStarShareUrl(input) {
  if (typeof input !== 'string' || input.length > 512) throw fail('ASSESSMENT_LINK_INVALID')
  const matched = SHARE_LINK.exec(input.trim())
  if (!matched) throw fail('ASSESSMENT_LINK_INVALID')
  const reportId = 'rpt_' + matched[1]
  if (!REPORT_ID.test(reportId)) throw fail('ASSESSMENT_LINK_INVALID')
  return { provider: 'mindtest-web', reportId, linkSecret: matched[2] }
}

/** Validates a provider's JSON, without treating its nickname as confirmed identity. */
export function normalizeStarReportPreview(report, expectedReportId) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw fail('ASSESSMENT_REPORT_INVALID')
  if (!REPORT_ID.test(String(expectedReportId || '')) || report.reportId !== expectedReportId) throw fail('ASSESSMENT_REPORT_MISMATCH')
  if (report.assessmentId !== 'star' || report.assessmentName !== '职业六芒星' ||
      report.assessmentVersion !== STAR_VERSION || report.schemaVersion !== '1.0.0') throw fail('ASSESSMENT_UNSUPPORTED')
  if (typeof report.completedAt !== 'string' || !ISO_TIME.test(report.completedAt) ||
      !Number.isFinite(Date.parse(report.completedAt))) throw fail('ASSESSMENT_REPORT_INVALID')
  const nickname = trimText(report.nickname, 64)
  const version = trimText(report.assessmentVersion, 64)
  if (!nickname || Array.from(nickname).length > 12 || version !== STAR_VERSION ||
      !Array.isArray(report.dimensions) || report.dimensions.length !== 2) throw fail('ASSESSMENT_REPORT_INVALID')
  const dims = Object.fromEntries(report.dimensions.map((item) => [item?.id, item]))
  if (!dims.drive || !dims.pursue) throw fail('ASSESSMENT_REPORT_INVALID')
  if (dims.drive.name !== '底层动力' || dims.pursue.name !== '现实追求' ||
      dims.drive.kind !== 'category' || dims.pursue.kind !== 'category' ||
      dims.drive.score !== null || dims.pursue.score !== null) throw fail('ASSESSMENT_REPORT_INVALID')
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
