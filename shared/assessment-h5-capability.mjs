// V1.3: Assessment H5 share capability registry.
// Only assessments with a real H5 share page can show "查看原报告".
// This list MUST match the assessments that have actual H5 share apps deployed.

/**
 * Assessment IDs that have real H5 share capability.
 * These assessments can show "查看原报告" button.
 */
export const H5_CAPABLE_ASSESSMENT_IDS = new Set([
  'star',
  'beattie-emotional-health',
  'beattie-anger',
  'beattie-fear',
  'beattie-drama',
  'beattie-guilt',
  'beattie-grief',
  'sefs',
])

/**
 * Check if an assessment has H5 share capability.
 */
export function hasH5ShareCapability(assessmentId) {
  return H5_CAPABLE_ASSESSMENT_IDS.has(assessmentId)
}

/**
 * Human-readable display names for assessment types.
 */
export const ASSESSMENT_DISPLAY_NAMES = {
  'star': '职业六芒星',
  'beattie-emotional-health': '情绪健康测试',
  'beattie-anger': '愤怒测试',
  'beattie-fear': '恐惧测试',
  'beattie-drama': '戏剧化与不幸成瘾测试',
  'beattie-guilt': '内疚测试',
  'beattie-grief': '悲痛与失落测试',
  'scl90': 'SCL-90 症状自评量表',
  'pdq4': 'PDQ-4+ 人格筛查',
  'ecr': 'ECR 成人依恋',
  'holland': '霍兰德职业兴趣',
  'loves5': '爱的5种语言',
  'zhenai': '珍爱金字塔',
  'root': '寻根之旅',
  'gcd': '个人充电',
  'sefs': '主观体验地图',
  'sensmap': '心力地图',
  'juying': '巨婴测评',
}
