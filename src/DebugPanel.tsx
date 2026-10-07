import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getApiRequestTraces, type HealthMetadata, type WorkbenchApi } from './clientApi'
import type { Staff } from './domain'

const DEBUG_KEY = 'asva_debug_enabled'
const frontendMetaUrl = `${import.meta.env.BASE_URL}build-meta.json`

function isDebugRequested() {
  return new URLSearchParams(window.location.search).get('debug') === '1' || window.localStorage.getItem(DEBUG_KEY) === 'true'
}

export function VersionStrip({ onOpen }: { onOpen: () => void }) {
  const [clicks, setClicks] = useState(0)
  const trigger = () => {
    const next = clicks + 1
    setClicks(next >= 5 ? 0 : next)
    if (next >= 5) { window.localStorage.setItem(DEBUG_KEY, 'true'); window.dispatchEvent(new Event('asva-debug-change')); onOpen() }
  }
  const mode = (import.meta.env.VITE_DATA_MODE as string | undefined) || (import.meta.env.VITE_API_BASE_URL ? 'production' : 'demo')
  return <button type="button" onClick={trigger} title="连续点击 5 次打开调试" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', font: 'inherit', textAlign: 'left', padding: 0 }}>{mode === 'demo' ? 'DEMO · 本地数据' : 'PRODUCTION · 真实数据'} · ASVA Stage 0</button>
}

function Row({ label, children }: { label: string; children: ReactNode }) { return <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', borderBottom: '1px solid #eef0f4', padding: '7px 0' }}><span style={{ color: '#667085' }}>{label}</span><strong style={{ textAlign: 'right', maxWidth: '68%', overflowWrap: 'anywhere' }}>{children}</strong></div> }

export function DebugPanel({ api, staff, dataMode }: { api: WorkbenchApi; staff?: Staff; dataMode: string }) {
  const [enabled, setEnabled] = useState(isDebugRequested)
  const [open, setOpen] = useState(isDebugRequested)
  const [health, setHealth] = useState<HealthMetadata | null>(null)
  const [frontend, setFrontend] = useState<Record<string, unknown> | null>(null)
  const [traces, setTraces] = useState(getApiRequestTraces())

  useEffect(() => {
    const update = () => { const next = isDebugRequested(); setEnabled(next); if (next) setOpen(true) }
    window.addEventListener('asva-debug-change', update)
    return () => window.removeEventListener('asva-debug-change', update)
  }, [])
  useEffect(() => {
    if (!enabled || !staff || staff.permissionRole !== 'ADMIN') return undefined
    let cancelled = false
    void api.health().then((value) => { if (!cancelled) setHealth(value) }).catch(() => undefined)
    void fetch(frontendMetaUrl).then((response) => response.json()).then((value) => { if (!cancelled) setFrontend(value) }).catch(() => undefined)
    const timer = window.setInterval(() => setTraces(getApiRequestTraces()), 1000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [api, enabled, staff])
  if (!enabled || !staff || staff.permissionRole !== 'ADMIN' || !open) return null
  const feCounter = Number(frontend?.releaseCounter)
  const beCounter = Number(health?.releaseCounter)
  const match = Number.isFinite(feCounter) && Number.isFinite(beCounter) ? feCounter === beCounter : null
  const close = () => setOpen(false)
  return <aside aria-label="ASVA 调试面板" style={{ position: 'fixed', zIndex: 30, top: 16, right: 16, width: 'min(430px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', overflow: 'auto', background: '#fff', border: '1px solid #dfe3eb', borderRadius: 18, boxShadow: '0 16px 50px rgba(31,41,55,.18)', padding: 18, color: '#172033' }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><div><strong>Debug Mode</strong><small style={{ display: 'block', color: '#667085' }}>默认关闭 · 仅管理员可见</small></div><button type="button" onClick={close} aria-label="关闭调试面板">关闭</button></header>
    <section style={{ marginTop: 12 }}><Row label="版本比对">{match === null ? 'UNKNOWN' : match ? 'VERSION_MATCH' : 'VERSION_MISMATCH'}</Row><Row label="前端版本">{String(frontend?.release || 'UNKNOWN')} · R{String(feCounter || 0).padStart(3, '0')}</Row><Row label="后端版本">{health?.release || 'UNKNOWN'} · R{String(beCounter || 0).padStart(3, '0')}</Row><Row label="环境">{health?.environment || dataMode}</Row><Row label="数据源">{health?.dataMode === 'demo' || dataMode === 'demo' ? 'DEMO_LOCAL' : 'FEISHU'}</Row><Row label="认证">Auth Mode: {health?.authMode || 'UNKNOWN'} · Auth State: AUTHENTICATED · Role: {staff.permissionRole} · token {window.sessionStorage.getItem('asva_session_token') ? 'present' : 'absent'}</Row><Row label="功能开关">{Object.entries(health?.featureFlags || {}).map(([key, value]) => `${key}=${value}`).join('，') || 'none'}</Row></section>
    <section style={{ marginTop: 16 }}><strong>最近 API 请求（内存 20 条）</strong>{traces.length ? traces.map((trace, index) => <div key={`${trace.time}-${index}`} style={{ padding: '7px 0', borderBottom: '1px solid #eef0f4', fontSize: 12 }}><div>{trace.result} · {trace.status ?? 'NETWORK'} · {trace.duration}ms · {trace.method} {trace.path}</div><span style={{ color: '#667085' }}>{trace.request_id || 'no request id'} · {trace.time}</span></div>) : <p style={{ color: '#667085' }}>暂无请求记录</p>}</section>
    <p style={{ marginBottom: 0, color: '#667085', fontSize: 12 }}>调试信息不包含密钥、JWT、完整手机号、聊天正文或 OTP。</p>
  </aside>
}
