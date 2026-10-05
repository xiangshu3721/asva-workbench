import { useEffect, useRef, useState } from 'react'
import type { AssistantQueryContext, AssistantQueryResult, AssistantResultRecord, WorkbenchApi } from './clientApi'

type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; result?: AssistantQueryResult }

const STORAGE_KEY = 'asva-ai-chat-v1'
const suggestions = ['查一下林知微', '现在有多少待分配预约？', '上个月觉塑报名了哪些客户？', '哪个导师目前客户最多？']

function readHistory(): ChatMessage[] {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) as ChatMessage[] : []
  } catch { return [] }
}

export function GlobalAIAssistant({ api, staffId, customerId, onCustomer }: { api: WorkbenchApi; staffId: string; customerId?: string; onCustomer: (customerId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>(readHistory)
  const [thinking, setThinking] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceReplies, setVoiceReplies] = useState(true)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  const lastQuery = [...messages].reverse().find((message) => message.role === 'assistant')?.result?.continuation
  const context: AssistantQueryContext = { page: customerId ? 'CUSTOMER_DETAIL' : undefined, customerId, lastQuery }

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-30))) } catch { /* local history is optional */ }
  }, [messages])

  const stopSpeaking = () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    setSpeakingId(null)
  }

  const speak = (text: string, messageId: string) => {
    if (!voiceReplies || !('speechSynthesis' in window)) return
    stopSpeaking()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.onstart = () => setSpeakingId(messageId)
    utterance.onend = () => setSpeakingId(null)
    utterance.onerror = () => setSpeakingId(null)
    window.speechSynthesis.speak(utterance)
  }

  const send = async (value = input) => {
    const question = value.trim()
    if (!question || thinking) return
    stopSpeaking()
    setInput('')
    setError('')
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: 'user', text: question }
    setMessages((current) => [...current, userMessage])
    setThinking(true)
    try {
      const result = await api.assistantQuery(staffId, question, context)
      const assistantId = `assistant-${Date.now()}`
      setMessages((current) => [...current, { id: assistantId, role: 'assistant', text: result.answer, result }])
      window.setTimeout(() => speak(result.answer, assistantId), 0)
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : '这次数据查询没有成功，请再试一次。')
    } finally { setThinking(false) }
  }

  const startVoice = () => {
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    stopSpeaking()
    const speechWindow = window as Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
    if (!Recognition) { setError('当前浏览器暂不支持语音输入，请直接输入文字。'); return }
    const recognition = new Recognition()
    recognition.lang = 'zh-CN'
    recognition.interimResults = false
    recognition.onresult = (event) => { setInput(event.results[0]?.[0]?.transcript ?? '') }
    recognition.onerror = () => { setError('没有听清，可以再说一次。'); setListening(false) }
    recognition.onend = () => { recognitionRef.current = null; setListening(false) }
    setError('')
    setListening(true)
    recognitionRef.current = recognition
    recognition.start()
  }

  const clear = () => { stopSpeaking(); setMessages([]); setError('') }
  const openCustomer = (id: string) => { setOpen(false); onCustomer(id) }

  return <>
    {!open && <button className="ai-fab" type="button" aria-label="打开 AI 助手" onClick={() => setOpen(true)}><span className="ai-spark">✦</span><span>AI 助手</span></button>}
    {open && <div className="ai-panel-backdrop" onMouseDown={() => setOpen(false)}><section className="ai-panel" onMouseDown={(event) => event.stopPropagation()}>
      <header className="ai-panel-header"><button type="button" className="ai-back-button" onClick={() => setOpen(false)} aria-label="关闭 AI 助手">←</button><div><strong>AI 助手</strong><small>只读查询工作台数据</small></div><button type="button" className="ai-clear-button" onClick={clear}>清空</button></header>
      <div className="ai-chat-body" aria-live="polite">
        {!messages.length && <div className="ai-welcome"><span className="ai-welcome-mark">✦</span><h2>想查什么，直接告诉我。</h2><p>我会基于当前工作台数据回答，不会自动修改客户或预约。</p><div className="ai-suggestions">{suggestions.map((suggestion) => <button type="button" key={suggestion} disabled={thinking} onClick={() => send(suggestion)}>{suggestion}<span>→</span></button>)}</div></div>}
        {messages.map((message) => <article className={`ai-message ${message.role}`} key={message.id}><div className="ai-message-bubble">{message.text}</div>{message.role === 'assistant' && message.result && <AssistantResult result={message.result} onCustomer={openCustomer} speaking={speakingId === message.id} onSpeak={() => speak(message.text, message.id)} />}</article>)}
        {thinking && <div className="ai-thinking"><span /><span /><span />AI 正在思考</div>}
      </div>
      <div className="ai-panel-footer"><div className="ai-voice-setting"><span>语音回复</span><button type="button" className={voiceReplies ? 'voice-toggle on' : 'voice-toggle'} onClick={() => { setVoiceReplies((value) => !value); stopSpeaking() }} aria-pressed={voiceReplies}>{voiceReplies ? '开' : '关'}</button>{speakingId && <button type="button" className="ai-stop-speaking" onClick={stopSpeaking}>停止播放</button>}</div>{error && <p className="ai-error">{error}</p>}<form className="ai-input-row" onSubmit={(event) => { event.preventDefault(); void send() }}><button type="button" className="ai-plus-button" disabled aria-label="附件暂未开放">＋</button><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder="说点什么……" rows={1} aria-label="输入问题" /><button type="button" className={listening ? 'ai-mic-button listening' : 'ai-mic-button'} disabled={thinking} onClick={startVoice} aria-label={listening ? '正在听你说' : '语音输入'}>{listening ? '听' : '⌕'}</button><button className="ai-send-button" type="submit" disabled={!input.trim() || thinking} aria-busy={thinking}>{thinking && <span className="button-spinner" aria-hidden="true" />}{thinking ? '查询中…' : '发送'}</button></form>{listening && <small className="ai-listening">正在听你说…</small>}</div>
    </section></div>}
  </>
}

function AssistantResult({ result, onCustomer, speaking, onSpeak }: { result: AssistantQueryResult; onCustomer: (id: string) => void; speaking: boolean; onSpeak: () => void }) {
  const records = result.records ?? result.candidates ?? []
  const detailFields = result.records?.[0]?.fields
  return <div className="ai-result">{result.customerId && <button type="button" className="ai-detail-link" onClick={() => onCustomer(result.customerId!)}>查看客户详情 <span>→</span></button>}{detailFields && <div className="ai-detail-fields">{detailFields.map((field) => <div key={field.label}><span>{field.label}</span><strong>{field.value}</strong></div>)}</div>}{result.candidates && <div className="ai-result-list">{records.map((record) => <ResultRow key={record.id} record={record} onCustomer={onCustomer} />)}</div>}{result.records && !detailFields && <div className="ai-result-list">{records.slice(0, 20).map((record) => <ResultRow key={record.id} record={record} onCustomer={onCustomer} />)}</div>}{result.pagination?.has_more && <small className="ai-pagination-note">已显示前 {result.pagination.limit} 条，共 {result.pagination.total} 条。可以缩小条件继续查询。</small>}{result.dataBasis?.length ? <details className="ai-data-basis"><summary>查看数据依据</summary>{result.dataBasis.map((basis, index) => <div key={`${basis.metric || 'query'}-${index}`}><span>{basis.metric || '查询结果'}</span><small>{basis.source.join('、')} · {basis.row_count} 条{basis.coverage && !basis.coverage.complete ? ' · 数据源不完整' : ''}</small></div>)}</details> : null}<button type="button" className={speaking ? 'ai-replay speaking' : 'ai-replay'} onClick={onSpeak} aria-label="播放 AI 回复">{speaking ? 'AI 正在说话…' : '播放语音'}</button></div>
}

function ResultRow({ record, onCustomer }: { record: AssistantResultRecord; onCustomer: (id: string) => void }) { return <button type="button" className="ai-result-row" onClick={() => record.customerId && onCustomer(record.customerId)}><span><strong>{record.name}</strong><small>{record.mentor ? `导师：${record.mentor}` : record.detail}{record.date ? ` · ${record.date}` : ''}</small></span><b>{record.amount === undefined ? '→' : `¥${record.amount.toLocaleString('zh-CN')}`}</b></button> }

type SpeechRecognitionLike = { lang: string; interimResults: boolean; results: ArrayLike<ArrayLike<{ transcript: string }>>; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }
