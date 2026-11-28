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
    const base = normalizeStarReportPreview(report, report.reportId)
    // V1.3: Add displayPayload for enhanced card visualization
    const content = report.reportContent || report
    const keywords = Array.isArray(content.keywords) ? content.keywords.slice(0, 8) : []
    const drive = (base.keyMetrics.find(m => m.name === '底层动力') || {}).labels || []
    const pursue = (base.keyMetrics.find(m => m.name === '现实追求') || {}).labels || []
    base.displayPayload = {
      kind: 'star-hexagram',
      drive: { label: '底层动力', words: drive },
      pursue: { label: '现实追求', words: pursue },
      keywords,
      headline: base.headline,
    }
    return base
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

// ============ P1 Adapters ============

/**
 * loves5 (爱的5种语言) adapter
 */
registerAssessmentAdapter('loves5', {
  parsePreview(report) {
    const score = report.score || report.viewModel || {}
    const scores = score.scores || {}
    const primaries = score.primaries || []
    const primary = primaries[0] || score.primaryLoveLanguage || ''
    
    // Map love language codes to names
    const loveLanguageNames = {
      'A': '肯定的言词', 'words': '肯定的言词',
      'B': '精心的时刻', 'time': '精心的时刻',
      'C': '接受礼物', 'gifts': '接受礼物',
      'D': '服务的行动', 'service': '服务的行动',
      'E': '身体的接触', 'touch': '身体的接触'
    }
    
    const primaryName = loveLanguageNames[primary] || primary || '未确定'
    
    return {
      reportId: report.reportId,
      assessmentId: 'loves5',
      assessmentName: '爱的5种语言',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { name: '主要爱语', labels: [primaryName] }
      ],
      headline: primary ? `主要爱的语言: ${primaryName}` : '爱的语言评估完成',
      summary: buildLoves5Summary(scores),
      caution: ''
    }
  },
  
  keyMetrics(report) {
    const score = report.score || report.viewModel || {}
    const primaries = score.primaries || []
    const primary = primaries[0] || score.primaryLoveLanguage || ''
    const loveLanguageNames = {
      'A': '肯定的言词', 'words': '肯定的言词',
      'B': '精心的时刻', 'time': '精心的时刻',
      'C': '接受礼物', 'gifts': '接受礼物',
      'D': '服务的行动', 'service': '服务的行动',
      'E': '身体的接触', 'touch': '身体的接触'
    }
    return [
      { name: '主要爱语', labels: [loveLanguageNames[primary] || primary || '未确定'] }
    ]
  },
  
  headline(report) {
    const score = report.score || report.viewModel || {}
    const primaries = score.primaries || []
    const primary = primaries[0] || score.primaryLoveLanguage || ''
    const loveLanguageNames = {
      'A': '肯定的言词', 'words': '肯定的言词',
      'B': '精心的时刻', 'time': '精心的时刻',
      'C': '接受礼物', 'gifts': '接受礼物',
      'D': '服务的行动', 'service': '服务的行动',
      'E': '身体的接触', 'touch': '身体的接触'
    }
    const primaryName = loveLanguageNames[primary] || primary
    return primaryName ? `主要爱的语言: ${primaryName}` : '爱的语言评估完成'
  }
})

function buildLoves5Summary(scores) {
  if (!scores || Object.keys(scores).length === 0) return ''
  const loveLanguageNames = {
    'A': '肯定的言词', 'words': '肯定的言词',
    'B': '精心的时刻', 'time': '精心的时刻',
    'C': '接受礼物', 'gifts': '接受礼物',
    'D': '服务的行动', 'service': '服务的行动',
    'E': '身体的接触', 'touch': '身体的接触'
  }
  const items = Object.entries(scores)
    .map(([code, score]) => `${loveLanguageNames[code] || code}: ${score}`)
    .join(', ')
  return items
}

/**
 * zhenai (珍爱金字塔) adapter
 */
registerAssessmentAdapter('zhenai', {
  parsePreview(report) {
    const view = report.reportContent?.viewModel || {}
    const scores = view.scores || {}
    const dims = view.dims || []
    const lowest = view.lowest || ''
    const total = view.total
    
    // Map dimension keys to names
    const dimNames = {
      'A': '自我价值', 'B': '亲密关系', 'C': '家庭关系',
      'D': '社交关系', 'E': '职业成就', 'F': '身心健康'
    }
    
    const lowestName = dimNames[lowest] || lowest || ''
    
    return {
      reportId: report.reportId,
      assessmentId: 'zhenai',
      assessmentName: '珍爱金字塔',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { name: '最薄弱层', labels: [lowestName || '未确定'] },
        { name: '总分', labels: [total != null ? String(total) : '-'] }
      ],
      headline: lowestName ? `最薄弱的一层: ${lowestName}` : '珍爱金字塔评估完成',
      summary: buildZhenaiSummary(dims, dimNames),
      caution: ''
    }
  },
  
  keyMetrics(report) {
    const view = report.reportContent?.viewModel || {}
    const lowest = view.lowest || ''
    const total = view.total
    const dimNames = {
      'A': '自我价值', 'B': '亲密关系', 'C': '家庭关系',
      'D': '社交关系', 'E': '职业成就', 'F': '身心健康'
    }
    return [
      { name: '最薄弱层', labels: [dimNames[lowest] || lowest || '未确定'] },
      { name: '总分', labels: [total != null ? String(total) : '-'] }
    ]
  },
  
  headline(report) {
    const view = report.reportContent?.viewModel || {}
    const lowest = view.lowest || ''
    const dimNames = {
      'A': '自我价值', 'B': '亲密关系', 'C': '家庭关系',
      'D': '社交关系', 'E': '职业成就', 'F': '身心健康'
    }
    const lowestName = dimNames[lowest] || lowest
    return lowestName ? `最薄弱的一层: ${lowestName}` : '珍爱金字塔评估完成'
  }
})

function buildZhenaiSummary(dims, dimNames) {
  if (!Array.isArray(dims) || dims.length === 0) return ''
  return dims
    .map(d => `${dimNames[d.key] || d.key}: ${d.score || '-'}`)
    .join(', ')
}

/**
 * root (寻根之旅/生命成长地图) adapter
 */
registerAssessmentAdapter('root', {
  parsePreview(report) {
    const view = report.reportContent?.viewModel || {}
    const dimensions = view.dimensions || []
    const modules = view.modules || []
    const headline = view.headline || ''
    
    // Extract top 2 dimensions by score
    const topDims = dimensions
      .filter(d => d.score != null)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 2)
    
    const topDimNames = topDims.map(d => d.name).filter(Boolean)
    
    return {
      reportId: report.reportId,
      assessmentId: 'root',
      assessmentName: '寻根之旅',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { name: '核心能力', labels: topDimNames.length > 0 ? topDimNames : ['未确定'] }
      ],
      headline: headline || (topDimNames.length > 0 ? `核心能力: ${topDimNames.join('、')}` : '生命成长地图评估完成'),
      summary: `${dimensions.length} 个维度, ${modules.length} 个模块`,
      caution: ''
    }
  },
  
  keyMetrics(report) {
    const view = report.reportContent?.viewModel || {}
    const dimensions = view.dimensions || []
    const topDims = dimensions
      .filter(d => d.score != null)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 2)
    const topDimNames = topDims.map(d => d.name).filter(Boolean)
    return [
      { name: '核心能力', labels: topDimNames.length > 0 ? topDimNames : ['未确定'] }
    ]
  },
  
  headline(report) {
    const view = report.reportContent?.viewModel || {}
    const headline = view.headline || ''
    const dimensions = view.dimensions || []
    const topDims = dimensions
      .filter(d => d.score != null)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 2)
    const topDimNames = topDims.map(d => d.name).filter(Boolean)
    return headline || (topDimNames.length > 0 ? `核心能力: ${topDimNames.join('、')}` : '生命成长地图评估完成')
  }
})

/**
 * gcd (个人充电) adapter
 */
registerAssessmentAdapter('gcd', {
  parsePreview(report) {
    const view = report.reportContent?.viewModel || {}
    const score = view.score
    const band = view.band || {}
    const topDim = view.topDim || ''
    
    // Map dimension keys to names
    const dimNames = {
      'body': '身体', 'emotion': '情绪', 'mind': '思维', 'spirit': '精神'
    }
    
    const bandLabel = band.label || ''
    const topDimName = dimNames[topDim] || topDim || ''
    
    return {
      reportId: report.reportId,
      assessmentId: 'gcd',
      assessmentName: '个人充电',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { name: '电量', labels: [score != null ? `${score}/100` : '-'] },
        { name: '状态', labels: [bandLabel || '未确定'] }
      ],
      headline: bandLabel ? `当前状态: ${bandLabel}` : '个人充电评估完成',
      summary: topDimName ? `耗电最多: ${topDimName}` : '',
      caution: ''
    }
  },
  
  keyMetrics(report) {
    const view = report.reportContent?.viewModel || {}
    const score = view.score
    const band = view.band || {}
    return [
      { name: '电量', labels: [score != null ? `${score}/100` : '-'] },
      { name: '状态', labels: [band.label || '未确定'] }
    ]
  },
  
  headline(report) {
    const view = report.reportContent?.viewModel || {}
    const band = view.band || {}
    return band.label ? `当前状态: ${band.label}` : '个人充电评估完成'
  }
})

// ============ P2 Adapters ============

/**
 * sefs (主观体验地图) adapter
 */
registerAssessmentAdapter('sefs', {
  parsePreview(report) {
    // V1.3 fix: SEFS reports store data in multiple paths depending on version:
    // - viewModel: { total, scores: [], levels: [] } — scores/levels as parallel arrays
    // - reportContent.dimensions: [{ name, score, max, level, id }] — full dimension metadata
    // The previous adapter only read viewModel.dimensions (which doesn't exist),
    // causing total=null and top dimension='未确定' for all stored SEFS reports.
    const view = report.reportContent?.viewModel || report.score || report.viewModel || {}
    const total = view.total ?? null

    // Read dimensions with full metadata (name, score, max) from multiple possible paths:
    // 1. Top-level dimensions (actual snapshot structure: report.dimensions)
    // 2. reportContent.dimensions (some SEFS versions nest here)
    // 3. viewModel.dimensions or viewModel.items (alternative formats)
    const topDims = Array.isArray(report.dimensions) ? report.dimensions : []
    const rcDims = Array.isArray(report.reportContent?.dimensions) ? report.reportContent.dimensions : []
    const viewDims = Array.isArray(view.dimensions) ? view.dimensions : []
    const viewItems = Array.isArray(view.items) ? view.items : []
    const rawDims = topDims.length > 0 ? topDims : (rcDims.length > 0 ? rcDims : (viewDims.length > 0 ? viewDims : viewItems))

    // If dimensions have names but no scores, merge scores from viewModel.scores
    const viewScores = Array.isArray(view.scores) ? view.scores : []
    const allDims = rawDims.map((d, i) => ({
      name: d.name || '',
      score: d.score != null ? d.score : (viewScores[i] ?? null),
      max: d.max != null ? d.max : null,
    })).filter(d => d.score != null)

    // Extract top dimensions sorted by score
    const orderedDims = [...allDims] // preserve original order
    const sortedDims = [...orderedDims].sort((a, b) => (b.score || 0) - (a.score || 0))
    const topDim = sortedDims[0]
    const top3 = sortedDims.slice(0, 3)

    // Determine fixed max score per dimension from actual data
    // Use the first dimension's max if available; fallback to 24 (SEFS standard: 6 items × 4-point scale)
    const dimMax = allDims.length > 0 && allDims[0].max != null ? allDims[0].max : 24

    const base = {
      reportId: report.reportId,
      assessmentId: 'sefs',
      assessmentName: '主观体验地图',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { name: '总分', labels: [total != null ? String(total) : '-'] },
        { name: '最高维度', labels: [topDim?.name || '未确定'] }
      ],
      headline: total != null ? `总分: ${total}` : '主观体验评估完成',
      summary: topDim ? `${topDim.name}: ${topDim.score}` : '',
      caution: '',
    }

    // V1.3: Add displayPayload for radar chart visualization
    // Use actual max score per dimension from data (not normalizing to current max)
    base.displayPayload = {
      kind: 'sefs-radar',
      total: total ?? null,
      topDimension: topDim ? { name: topDim.name || '', score: topDim.score } : null,
      top3: top3.map(d => ({ name: d.name || '', score: d.score ?? 0 })),
      maxScorePerDim: dimMax,
      radarAxes: orderedDims.slice(0, 8).map(d => ({
        name: d.name || '',
        score: d.score ?? 0,
        maxScore: d.max != null ? d.max : dimMax,
      })),
      headline: base.headline,
    }

    return base
  },

  keyMetrics(report) {
    const view = report.reportContent?.viewModel || report.score || report.viewModel || {}
    const total = view.total ?? null
    const topDims = Array.isArray(report.dimensions) ? report.dimensions : []
    const rcDims = Array.isArray(report.reportContent?.dimensions) ? report.reportContent.dimensions : []
    const viewDims = Array.isArray(view.dimensions) ? view.dimensions : []
    const viewItems = Array.isArray(view.items) ? view.items : []
    const rawDims = topDims.length > 0 ? topDims : (rcDims.length > 0 ? rcDims : (viewDims.length > 0 ? viewDims : viewItems))
    const viewScores = Array.isArray(view.scores) ? view.scores : []
    const allDims = rawDims.map((d, i) => ({
      name: d.name || '',
      score: d.score != null ? d.score : (viewScores[i] ?? null),
    })).filter(d => d.score != null)
    const topDim = allDims
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0]
    return [
      { name: '总分', labels: [total != null ? String(total) : '-'] },
      { name: '最高维度', labels: [topDim?.name || '未确定'] }
    ]
  },

  headline(report) {
    const view = report.reportContent?.viewModel || report.score || report.viewModel || {}
    const total = view.total ?? null
    return total != null ? `总分: ${total}` : '主观体验评估完成'
  }
})

/**
 * sensmap (心力地图) adapter
 */
registerAssessmentAdapter('sensmap', {
  parsePreview(report) {
    const view = report.reportContent?.viewModel || {}
    const dimensions = view.dimensions || []
    
    // Map dimension IDs to names
    const dimNames = {
      'F': '身体感受', 'R': '关系感受', 'E': '情绪感受', 'M': '思维感受'
    }
    
    // Extract top dimension
    const topDim = dimensions
      .filter(d => d.score != null)
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0]
    
    const topDimName = topDim ? (dimNames[topDim.id] || topDim.name || topDim.id) : ''
    
    return {
      reportId: report.reportId,
      assessmentId: 'sensmap',
      assessmentName: '心力地图',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { name: '敏感维度', labels: [topDimName || '未确定'] }
      ],
      headline: topDimName ? `最敏感维度: ${topDimName}` : '心力地图评估完成',
      summary: `${dimensions.length} 个维度`,
      caution: ''
    }
  },
  
  keyMetrics(report) {
    const view = report.reportContent?.viewModel || {}
    const dimensions = view.dimensions || []
    const dimNames = {
      'F': '身体感受', 'R': '关系感受', 'E': '情绪感受', 'M': '思维感受'
    }
    const topDim = dimensions
      .filter(d => d.score != null)
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0]
    const topDimName = topDim ? (dimNames[topDim.id] || topDim.name || topDim.id) : ''
    return [
      { name: '敏感维度', labels: [topDimName || '未确定'] }
    ]
  },
  
  headline(report) {
    const view = report.reportContent?.viewModel || {}
    const dimensions = view.dimensions || []
    const dimNames = {
      'F': '身体感受', 'R': '关系感受', 'E': '情绪感受', 'M': '思维感受'
    }
    const topDim = dimensions
      .filter(d => d.score != null)
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0]
    const topDimName = topDim ? (dimNames[topDim.id] || topDim.name || topDim.id) : ''
    return topDimName ? `最敏感维度: ${topDimName}` : '心力地图评估完成'
  }
})

/**
 * juying (巨婴测评) adapter
 */
registerAssessmentAdapter('juying', {
  parsePreview(report) {
    const score = report.score || report.viewModel || {}
    const total = score.total
    const band = score.band || result.band || ''
    
    // Map band IDs to names
    const bandNames = {
      'mature': '心智成熟',
      'partial': '有部分巨婴特质',
      'infant': '巨婴',
      'child': '儿童状态'
    }
    
    const bandName = bandNames[band] || band || ''
    
    return {
      reportId: report.reportId,
      assessmentId: 'juying',
      assessmentName: '巨婴测评',
      assessmentVersion: report.assessmentVersion || '1.0',
      completedAt: report.completedAt || report.createdAt,
      nickname: report.nickname || '',
      keyMetrics: [
        { name: '总分', labels: [total != null ? String(total) : '-'] },
        { name: '分档', labels: [bandName || '未确定'] }
      ],
      headline: bandName ? `分档: ${bandName}` : '巨婴测评完成',
      summary: total != null ? `总分: ${total}` : '',
      caution: '非严肃科学,仅供理解学习'
    }
  },
  
  keyMetrics(report) {
    const score = report.score || report.viewModel || {}
    const total = score.total
    const band = score.band || report.result?.band || ''
    const bandNames = {
      'mature': '心智成熟',
      'partial': '有部分巨婴特质',
      'infant': '巨婴',
      'child': '儿童状态'
    }
    return [
      { name: '总分', labels: [total != null ? String(total) : '-'] },
      { name: '分档', labels: [bandNames[band] || band || '未确定'] }
    ]
  },
  
  headline(report) {
    const score = report.score || report.viewModel || {}
    const band = score.band || report.result?.band || ''
    const bandNames = {
      'mature': '心智成熟',
      'partial': '有部分巨婴特质',
      'infant': '巨婴',
      'child': '儿童状态'
    }
    const bandName = bandNames[band] || band
    return bandName ? `分档: ${bandName}` : '巨婴测评完成'
  }
})

/**
 * Beattie emotional health series adapter factory
 */
function createBeattieAdapter(assessmentId, assessmentName) {
  // Beattie level → color mapping for card visualization
  const LEVEL_COLORS = {
    '轻微': '#4caf50',
    '轻度': '#8bc34a',
    '中等': '#ff9800',
    '偏高': '#f44336',
    '严重': '#b71c1c',
  }

  return {
    parsePreview(report) {
      const view = report.reportContent?.viewModel || {}
      const total = view.total
      const maxPossible = view.maxPossible
      const band = view.band || {}
      const chapter = view.chapter || ''
      const subScales = Array.isArray(view.subScales) ? view.subScales : []
      
      const bandText = band.text || '未确定'
      // Determine color from band text
      const color = Object.entries(LEVEL_COLORS).find(([key]) => bandText.includes(key))?.[1] || '#9e9e9e'
      
      const base = {
        reportId: report.reportId,
        assessmentId,
        assessmentName,
        assessmentVersion: report.assessmentVersion || '1.0',
        completedAt: report.completedAt || report.createdAt,
        nickname: report.nickname || '',
        keyMetrics: [
          { name: '总分', labels: [total != null ? `${total}/${maxPossible || '-'}` : '-'] },
          { name: '等级', labels: [bandText] }
        ],
        headline: bandText !== '未确定' ? `等级: ${bandText}` : `${assessmentName}完成`,
        summary: chapter ? `第 ${chapter} 章` : '',
        caution: '',
      }
      
      // V1.3: Add displayPayload for enhanced card visualization
      base.displayPayload = {
        kind: 'beattie-gauge',
        total: total ?? null,
        maxPossible: maxPossible ?? null,
        percentage: total != null && maxPossible ? Math.round((total / maxPossible) * 100) : null,
        level: bandText,
        color,
        chapter: chapter || null,
        subScales: subScales.slice(0, 6).map((s) => ({
          name: s.name || '',
          score: s.score ?? null,
          maxScore: s.maxScore ?? null,
        })),
        headline: base.headline,
      }
      
      return base
    },
    
    keyMetrics(report) {
      const view = report.reportContent?.viewModel || {}
      const total = view.total
      const maxPossible = view.maxPossible
      const band = view.band || {}
      return [
        { name: '总分', labels: [total != null ? `${total}/${maxPossible || '-'}` : '-'] },
        { name: '等级', labels: [band.text || '未确定'] }
      ]
    },
    
    headline(report) {
      const view = report.reportContent?.viewModel || {}
      const band = view.band || {}
      return band.text ? `等级: ${band.text}` : `${assessmentName}完成`
    }
  }
}

// Register all 6 Beattie assessments
registerAssessmentAdapter('beattie-emotional-health', createBeattieAdapter('beattie-emotional-health', '情绪健康测试'))
registerAssessmentAdapter('beattie-anger', createBeattieAdapter('beattie-anger', '愤怒测试'))
registerAssessmentAdapter('beattie-fear', createBeattieAdapter('beattie-fear', '恐惧测试'))
registerAssessmentAdapter('beattie-drama', createBeattieAdapter('beattie-drama', '戏剧化与不幸成瘾测试'))
registerAssessmentAdapter('beattie-guilt', createBeattieAdapter('beattie-guilt', '内疚测试'))
registerAssessmentAdapter('beattie-grief', createBeattieAdapter('beattie-grief', '悲痛与失落测试'))

// Export for testing
export const _adapterRegistry = adapterRegistry
