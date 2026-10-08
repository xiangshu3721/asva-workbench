import { describe, expect, it } from 'vitest'
import { applySpeechResults, emptySpeechTranscript, joinSpeechText, MAX_SPEECH_RESTARTS, shouldRecoverSpeech, speechErrorMessage, speechTranscriptText } from './speech'

describe('manual customer speech transcript handling', () => {
  it('keeps interim text visible and promotes final text without duplication', () => {
    let state = emptySpeechTranscript()
    state = applySpeechResults(state, [[{ transcript: '客户最近', isFinal: false }]] as any)
    expect(speechTranscriptText(state)).toBe('客户最近')
    state = applySpeechResults(state, [[{ transcript: '客户最近工作压力变大', isFinal: true }]] as any, 0)
    expect(speechTranscriptText(state)).toBe('客户最近工作压力变大')
    state = applySpeechResults(state, [[{ transcript: '客户最近工作压力变大', isFinal: true }]] as any, 0)
    expect(speechTranscriptText(state)).toBe('客户最近工作压力变大')
    expect(joinSpeechText('已有记录', speechTranscriptText(state, { finalOnly: true }))).toBe('已有记录 客户最近工作压力变大')
  })

  it('reports specific browser speech errors', () => {
    expect(speechErrorMessage('not-allowed')).toContain('麦克风')
    expect(speechErrorMessage('no-speech')).toContain('清晰语音')
    expect(speechErrorMessage('network')).toContain('网络')
  })

  it('recovers unexpected onend only while listening and stops at the restart limit', () => {
    expect(shouldRecoverSpeech({ keepListening: true, manualStop: false, permissionDenied: false, restartCount: 0 })).toBe(true)
    expect(shouldRecoverSpeech({ keepListening: false, manualStop: true, permissionDenied: false, restartCount: 0 })).toBe(false)
    expect(shouldRecoverSpeech({ keepListening: true, manualStop: false, permissionDenied: true, restartCount: 0 })).toBe(false)
    expect(shouldRecoverSpeech({ keepListening: true, manualStop: false, permissionDenied: false, restartCount: MAX_SPEECH_RESTARTS })).toBe(false)
  })
})
