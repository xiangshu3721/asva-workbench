export interface ConsultationAiDisplayStatus {
  label: string
  notice: string
}

/** AI-generated deeper understanding and rule-based consultation signals are independent. */
export function consultationAiDisplayStatus(
  status: string,
  error: string,
  hasConsultationSignals: boolean,
): ConsultationAiDisplayStatus {
  const refreshFailed = error.startsWith('重新整理失败：')
  const readFailed = Boolean(error) && !refreshFailed
  const label = status === 'FAILED' ? 'AI 理解未完成'
    : refreshFailed ? 'AI 更新未完成'
      : readFailed ? 'AI 读取未完成'
        : status === 'PROCESSING' ? 'AI 理解整理中'
          : status === 'STALE' ? 'AI 理解待更新'
            : status === 'FRESH' ? 'AI 理解已整理'
              : 'AI 理解状态待确认'

  const sourceNote = hasConsultationSignals
    ? '当前咨询线索仍可供初步核实。'
    : '当前先根据已有资料了解客户需要。'

  if (status === 'FAILED') return { label, notice: `AI 深度理解未完成；${sourceNote}` }
  if (status === 'PROCESSING') return { label, notice: `AI 深度理解正在整理；${sourceNote}` }
  if (refreshFailed) return { label, notice: `AI 深度理解更新未完成；${sourceNote}` }
  if (readFailed) return { label, notice: `AI 深度理解读取失败；${sourceNote}` }
  return { label, notice: '' }
}
