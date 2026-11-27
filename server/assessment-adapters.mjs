// V1.1: Unified assessment adapter registry
// Each assessment type registers its own parser for preview generation

import { normalizeStarReportPreview } from '../shared/assessment-import-star-contract.mjs'

/**
 * Adapter registry - maps assessmentId to its specific adapter
 * Each adapter must implement:
 * - parsePreview(report): generates safe preview for mentor confirmation
 * - keyMetrics(report): extracts core metrics for card display
 * - headline(report): generates one-line summary
 */
const adapterRegistry = new Map()

/**
 * Register an assessment adapter
 */
export function registerAssessmentAdapter(assessmentId, adapter) {
  if (!assessmentId || typeof assessmentId !== 'string') {
    throw new Error('assessmentId must be a non-empty string')
  }
  if (!adapter || typeof adapter.parsePreview !== 'function') {
    throw new Error('adapter must implement parsePreview function')
  }
  adapterRegistry.set(assessmentId, adapter)
}

/**
 * Get adapter for a specific assessment
 */
export function getAssessmentAdapter(assessmentId) {
  return adapterRegistry.get(assessmentId) || null
}

/**
 * Check if an assessment is supported
 */
export function isAssessmentSupported(assessmentId) {
  return adapterRegistry.has(assessmentId)
}

/**
 * List all supported assessments
 */
export function listSupportedAssessments() {
  return Array.from(adapterRegistry.keys())
}

// ============ Built-in Adapters ============

/**
 * Star (职业六芒星) adapter - already implemented
 */
registerAssessmentAdapter('star', {
  parsePreview(report) {
    return normalizeStarReportPreview(report, report.reportId)
  },
  
  keyMetrics(report) {
    // Extract drive and pursue words
    const content = report.reportContent || report
    const drive = content.driveWords || []
    const pursue = content.pursueWords || []
    
    return [
      {
        name: '底层动力',
        labels: drive.slice(0, 3)
      },
      {
        name: '现实追求',
        labels: pursue.slice(0, 3)
      }
    ]
  },
  
  headline(report) {
    const content = report.reportContent || report
    const keywords = content.keywords || []
    return keywords.length > 0 
      ? `核心关键词:${keywords.slice(0, 5).join('、')}`
      : ''
  }
})

/**
 * SCL-90 (症状自评量表) adapter
 */
registerAssessmentAdapter('scl90', {
  parsePreview(report) {
    // Extract core SCL-90 metrics
    const score = report.score || report.viewModel || {}
    const gsi = score.gsi ?? null
    const total = score.total ?? null
    const positiveCount = score.positiveCount ?? null
    
    return {
      reportId: report.reportId,
      assessmentId: 'scl90',
      assessmentName: 'SCL-90 症状自评量表',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { name: '总分', labels: [String(total || '-')] },
        { name: '阳性项目', labels: [String(positiveCount || '-')] }
      ],
      headline: gsi != null 
        ? `总症状指数(GSI): ${gsi.toFixed(2)}`
        : '症状自评筛查完成',
      summary: buildScl90Summary(score),
      caution: score.crisis ? '存在危机信号,请优先关注' : ''
    }
  },
  
  keyMetrics(report) {
    const score = report.score || report.viewModel || {}
    return [
      { name: '总分', labels: [String(score.total || '-')] },
      { name: '阳性项目', labels: [String(score.positiveCount || '-')] }
    ]
  },
  
  headline(report) {
    const score = report.score || report.viewModel || {}
    const positive = score.positive
    if (positive === true) return '筛查阳性,建议关注'
    if (positive === false) return '筛查阴性'
    return '症状自评筛查完成'
  }
})

function buildScl90Summary(score) {
  const factors = score.factors || []
  if (factors.length === 0) return ''
  
  const topFactors = factors
    .filter(f => f.score != null && f.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  
  if (topFactors.length === 0) return '各因子分均在正常范围内'
  
  return `偏重维度: ${topFactors.map(f => f.name).join('、')}`
}

/**
 * PDQ-4+ (人格筛查) adapter
 */
registerAssessmentAdapter('pdq4', {
  parsePreview(report) {
    const score = report.score || report.viewModel || {}
    const types = score.screenedTypes || []
    
    return {
      reportId: report.reportId,
      assessmentId: 'pdq4',
      assessmentName: 'PDQ-4+ 人格筛查',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { 
          name: '筛查类型', 
          labels: types.length > 0 ? types.slice(0, 3) : ['未达筛查界值']
        }
      ],
      headline: types.length > 0
        ? `筛查提示: ${types.slice(0, 3).join('、')}`
        : '人格筛查未见明显提示',
      summary: `共筛查 ${types.length} 种人格类型`,
      caution: types.length > 0 ? '筛查结果仅供参考,不代表诊断' : ''
    }
  },
  
  keyMetrics(report) {
    const types = (report.score || report.viewModel || {}).screenedTypes || []
    return [
      { 
        name: '筛查类型', 
        labels: types.length > 0 ? types.slice(0, 3) : ['未达界值']
      }
    ]
  },
  
  headline(report) {
    const types = (report.score || report.viewModel || {}).screenedTypes || []
    return types.length > 0
      ? `筛查提示: ${types.slice(0, 2).join('、')}`
      : '人格筛查未见明显提示'
  }
})

/**
 * ECR (成人依恋) adapter
 */
registerAssessmentAdapter('ecr', {
  parsePreview(report) {
    const score = report.score || report.viewModel || {}
    const avoidance = score.avoidance ?? null
    const anxiety = score.anxiety ?? null
    const attachmentType = score.attachmentType || ''
    
    return {
      reportId: report.reportId,
      assessmentId: 'ecr',
      assessmentName: 'ECR 成人依恋',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { 
          name: '依恋类型', 
          labels: [attachmentType || '未分类']
        }
      ],
      headline: attachmentType
        ? `依恋类型: ${attachmentType}`
        : '成人依恋评估完成',
      summary: buildEcrSummary(avoidance, anxiety),
      caution: ''
    }
  },
  
  keyMetrics(report) {
    const score = report.score || report.viewModel || {}
    return [
      { 
        name: '依恋类型', 
        labels: [score.attachmentType || '未分类']
      }
    ]
  },
  
  headline(report) {
    const type = (report.score || report.viewModel || {}).attachmentType || ''
    return type ? `依恋类型: ${type}` : '成人依恋评估完成'
  }
})

function buildEcrSummary(avoidance, anxiety) {
  if (avoidance == null || anxiety == null) return ''
  return `回避维度: ${avoidance.toFixed(1)}, 焦虑维度: ${anxiety.toFixed(1)}`
}

/**
 * Holland (霍兰德职业兴趣) adapter
 */
registerAssessmentAdapter('holland', {
  parsePreview(report) {
    const score = report.score || report.viewModel || {}
    const codes = score.hollandCodes || []
    const primary = codes[0] || ''
    
    return {
      reportId: report.reportId,
      assessmentId: 'holland',
      assessmentName: '霍兰德职业兴趣',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { 
          name: '主要倾向', 
          labels: primary ? [formatHollandCode(primary)] : ['未分类']
        }
      ],
      headline: primary
        ? `职业兴趣: ${formatHollandCode(primary)}`
        : '职业兴趣评估完成',
      summary: codes.length > 0
        ? `兴趣代码: ${codes.slice(0, 3).map(formatHollandCode).join('-')}`
        : '',
      caution: ''
    }
  },
  
  keyMetrics(report) {
    const codes = (report.score || report.viewModel || {}).hollandCodes || []
    return [
      { 
        name: '主要倾向', 
        labels: codes[0] ? [formatHollandCode(codes[0])] : ['未分类']
      }
    ]
  },
  
  headline(report) {
    const codes = (report.score || report.viewModel || {}).hollandCodes || []
    return codes[0] ? `职业兴趣: ${formatHollandCode(codes[0])}` : '职业兴趣评估完成'
  }
})

function formatHollandCode(code) {
  const names = {
    'R': '现实型(R)',
    'I': '研究型(I)',
    'A': '艺术型(A)',
    'S': '社会型(S)',
    'E': '企业型(E)',
    'C': '常规型(C)'
  }
  return names[code] || code
}

// ============ Future Adapters (P1/P2) ============

/**
 * Placeholder for loves5, zhenai, root, gcd, etc.
 * These will be implemented based on real data contracts
 */

// Export for testing
export const _adapterRegistry = adapterRegistry
