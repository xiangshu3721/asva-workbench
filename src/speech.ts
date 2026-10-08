export interface SpeechTranscriptState {
  finalSegments: string[]
  interimSegments: string[]
}

export const MAX_SPEECH_RESTARTS = 5

export function shouldRecoverSpeech({ keepListening, manualStop, permissionDenied, restartCount }: { keepListening: boolean; manualStop: boolean; permissionDenied: boolean; restartCount: number }) {
  return keepListening && !manualStop && !permissionDenied && restartCount < MAX_SPEECH_RESTARTS
}

export function emptySpeechTranscript(): SpeechTranscriptState {
  return { finalSegments: [], interimSegments: [] }
}

export function applySpeechResults(state: SpeechTranscriptState, results: ArrayLike<ArrayLike<{ transcript?: string; isFinal?: boolean }> & { isFinal?: boolean }>, resultIndex = 0) {
  const finalSegments = [...state.finalSegments]
  const interimSegments = [...state.interimSegments]
  for (let index = Math.max(0, resultIndex); index < results.length; index += 1) {
    const result = results[index]
    const transcript = String(result?.[0]?.transcript || '').trim()
    if (!transcript) continue
    if (result?.isFinal ?? result?.[0]?.isFinal) {
      finalSegments[index] = transcript
      interimSegments[index] = ''
    } else {
      interimSegments[index] = transcript
    }
  }
  return { finalSegments, interimSegments }
}

export function speechTranscriptText(state: SpeechTranscriptState, { finalOnly = false } = {}) {
  const length = Math.max(state.finalSegments.length, state.interimSegments.length)
  const segments = Array.from({ length }, (_, index) => finalOnly ? state.finalSegments[index] || '' : state.finalSegments[index] || state.interimSegments[index] || '')
  return segments.filter(Boolean).join(' ').trim()
}

export function joinSpeechText(existingText: string, nextText: string) {
  const existing = existingText.trim()
  const next = nextText.trim()
  return [existing, next].filter(Boolean).join(' ')
}

export function speechErrorMessage(error = '') {
  const messages: Record<string, string> = {
    'not-allowed': '浏览器没有允许麦克风，请检查权限后重试。',
    'service-not-allowed': '浏览器没有允许语音服务，请检查权限后重试。',
    'audio-capture': '没有找到可用麦克风，请检查设备后重试。',
    network: '语音识别网络暂时不可用，请改用文字输入。',
    'no-speech': '没有听到清晰语音，请继续说或改用文字输入。',
    aborted: '语音输入已停止。',
  }
  return messages[error] || '语音识别暂时不可用，请改用文字输入。'
}
