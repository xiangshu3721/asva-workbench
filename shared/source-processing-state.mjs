const CODE_PATTERN = /^[A-Z0-9_]+$/

function errorCode(error) {
  const code = typeof error === 'string' ? error : error?.code || error?.serverCode
  return typeof code === 'string' && CODE_PATTERN.test(code) ? code : ''
}

export function processingErrorMessage(error) {
  const code = errorCode(error)
  if (!code) return ''
  if (code.startsWith('FEISHU_')) return '保存暂时失败，请稍后重试。'
  return '智能整理暂时失败，可重新整理。'
}

export function sourceProcessingPresentation(status, error = '', stale = false) {
  if (status === 'FAILED') return { label: '已保存 · 整理暂时失败', message: '资料已保存，智能整理暂时失败。', canRetry: true }
  if (status === 'COMPLETED') return { label: '已保存 · 整理完成', message: '', canRetry: false }
  if (status === 'REVIEW_REQUIRED') return { label: '已保存 · 等待确认', message: '', canRetry: false }
  if (status === 'PROCESSING' && stale) return { label: '已保存 · 整理超时', message: '资料已保存，整理状态超时，请确认后重新整理。', canRetry: true }
  if (status === 'UPLOADED' || status === 'PROCESSING') return { label: '已保存 · 正在整理', message: '资料已保存，正在智能整理。', canRetry: true }
  if (error) return { label: '已保存 · 整理暂时失败', message: '资料已保存，智能整理暂时失败。', canRetry: true }
  return { label: '已保存 · 正在整理', message: '资料已保存，正在智能整理。', canRetry: true }
}

export function persistenceFailureMessage(error) {
  const code = errorCode(error)
  if (code === 'UNSUPPORTED_DOCUMENT_FORMAT' || code === 'INVALID_DOCUMENT_MIME') return '当前支持 TXT、Markdown 和 Word（.docx）文件。'
  if (code === 'DOCX_CORRUPT' || code === 'DOCUMENT_TEXT_EMPTY') return '资料读取失败，请检查文件后重新上传。'
  return '保存暂时失败，内容还在，请稍后再试。'
}

export function aiFailureMessage() {
  return '资料已保存，智能整理暂时失败。'
}
