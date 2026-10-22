import { useEffect, useRef, useState } from 'react'
import { applySpeechResults, emptySpeechTranscript, joinSpeechText, shouldRecoverSpeech, speechErrorMessage, speechTranscriptText, type SpeechTranscriptState } from './speech'

type BrowserSpeechResult = ArrayLike<{ transcript: string }> & { isFinal?: boolean }
type BrowserSpeechRecognitionInstance = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((event: { results: ArrayLike<BrowserSpeechResult>; resultIndex?: number }) => void) | null; onerror: ((event?: { error?: string }) => void) | null; onend: (() => void) | null }
type BrowserSpeechRecognition = new () => BrowserSpeechRecognitionInstance

export function useSpeechInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [isRecording, setIsRecording] = useState(false)
  const [voiceState, setVoiceState] = useState<'IDLE' | 'LISTENING' | 'RECOVERING' | 'ERROR'>('IDLE')
  const [voiceSupported, setVoiceSupported] = useState<boolean | null>(null)
  const [voicePermission, setVoicePermission] = useState<'UNKNOWN' | 'REQUESTED' | 'DENIED'>('UNKNOWN')
  const [voiceLastEvent, setVoiceLastEvent] = useState('none')
  const [voiceError, setVoiceError] = useState('')
  const [voiceHint, setVoiceHint] = useState('')
  const voiceErrorRef = useRef('')
  const recognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null)
  const keepRecordingRef = useRef(false)
  const currentTextRef = useRef(value)
  const speechStateRef = useRef<SpeechTranscriptState>(emptySpeechTranscript())
  const restartCountRef = useRef(0)
  const restartTimerRef = useRef<number | null>(null)

  useEffect(() => { currentTextRef.current = value }, [value])

  const commitTranscript = (finalOnly: boolean) => {
    const next = joinSpeechText(currentTextRef.current, speechTranscriptText(speechStateRef.current, { finalOnly }))
    currentTextRef.current = next
    speechStateRef.current = emptySpeechTranscript()
    onChange(next)
  }

  const stop = () => {
    keepRecordingRef.current = false
    setVoiceLastEvent('manual-stop')
    commitTranscript(false)
    const recognition = recognitionRef.current
    recognitionRef.current = null
    recognition?.stop()
    if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current)
    restartTimerRef.current = null
    setIsRecording(false)
    setVoiceState('IDLE')
    voiceErrorRef.current = ''
    setVoiceHint('录音已结束，文字已保留。')
  }

  const toggle = () => {
    if (isRecording) { stop(); return }
    const speechApi = window as Window & { SpeechRecognition?: BrowserSpeechRecognition; webkitSpeechRecognition?: BrowserSpeechRecognition }
    const Recognition = speechApi.SpeechRecognition || speechApi.webkitSpeechRecognition
    setVoiceSupported(Boolean(Recognition))
    if (!Recognition) {
      setVoiceState('ERROR')
      setVoiceError('unsupported')
      setVoiceLastEvent('unsupported')
      setVoiceHint('当前浏览器不支持语音输入，请直接输入文字。')
      return
    }
    const recognition = new Recognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      setVoiceLastEvent('result')
      const nextState = applySpeechResults(speechStateRef.current, event.results, event.resultIndex || 0)
      speechStateRef.current = nextState
      const nextText = joinSpeechText(currentTextRef.current, speechTranscriptText(nextState))
      onChange(nextText)
      setVoiceHint('正在录音，文字会实时显示，再次点击结束。')
    }
    recognition.onerror = (event) => {
      const error = event?.error || 'unknown'
      commitTranscript(false)
      setVoiceLastEvent(`error:${error}`)
      setVoiceError(error)
      voiceErrorRef.current = error
      setVoiceState('ERROR')
      if (error === 'not-allowed' || error === 'service-not-allowed') setVoicePermission('DENIED')
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'aborted'].includes(error)) {
        keepRecordingRef.current = false
        setIsRecording(false)
        setVoiceHint(speechErrorMessage(error))
      } else {
        setVoiceHint(speechErrorMessage(error))
      }
    }
    recognition.onend = () => {
      setVoiceLastEvent('end')
      if (keepRecordingRef.current && recognitionRef.current === recognition) {
        commitTranscript(true)
        restartCountRef.current += 1
        if (!shouldRecoverSpeech({ keepListening: true, manualStop: false, permissionDenied: voicePermission === 'DENIED', restartCount: restartCountRef.current })) {
          keepRecordingRef.current = false
          recognitionRef.current = null
          setIsRecording(false)
          setVoiceState('ERROR')
          setVoiceError('restart-limit')
          voiceErrorRef.current = 'restart-limit'
          setVoiceHint('语音识别多次中断，请再次点击开始或改用文字输入。')
          return
        }
        setVoiceState('RECOVERING')
        setVoiceHint('语音识别正在恢复，请继续说。')
        restartTimerRef.current = window.setTimeout(() => {
          if (!keepRecordingRef.current || recognitionRef.current !== recognition) return
          try { recognition.start(); setVoiceState('LISTENING'); setVoiceLastEvent('restart') } catch {
            keepRecordingRef.current = false
            recognitionRef.current = null
            setIsRecording(false)
            setVoiceState('ERROR')
            setVoiceError('start-failed')
            voiceErrorRef.current = 'start-failed'
            setVoiceLastEvent('restart-failed')
            setVoiceHint(speechErrorMessage('start-failed'))
          }
        }, 250)
        return
      }
      if (recognitionRef.current === recognition) recognitionRef.current = null
      setIsRecording(false)
      if (!voiceErrorRef.current) setVoiceState('IDLE')
    }
    currentTextRef.current = value
    speechStateRef.current = emptySpeechTranscript()
    restartCountRef.current = 0
    setVoicePermission('REQUESTED')
    setVoiceError('')
    voiceErrorRef.current = ''
    setVoiceLastEvent('start')
    setVoiceHint('正在录音，再次点击结束。')
    keepRecordingRef.current = true
    recognitionRef.current = recognition
    setIsRecording(true)
    setVoiceState('LISTENING')
    try { recognition.start() } catch {
      keepRecordingRef.current = false
      recognitionRef.current = null
      setIsRecording(false)
      setVoiceState('ERROR')
      setVoiceError('start-failed')
      voiceErrorRef.current = 'start-failed'
      setVoiceHint('语音输入启动失败，请检查浏览器麦克风权限后重试。')
    }
  }

  useEffect(() => () => {
    keepRecordingRef.current = false
    if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current)
    recognitionRef.current?.stop()
  }, [])

  return { isRecording, voiceState, voiceSupported, voicePermission, voiceLastEvent, voiceError, voiceHint, toggle, stop }
}
