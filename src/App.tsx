import { cloneElement, useEffect, useRef, useState } from 'react'
import * as React from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createGuardedLocalApi, createLocalApi } from './api'
import type { Appointment, AppointmentWorkflowStatus, Customer, CustomerGrade, CustomerDraftPreview, Database, EnrollmentDraft, FeedbackInput, ManualCustomerInput, ProfileDraft, ProfileMaterialization, ProfileUpdate, ProfileValue, Product, Staff } from './domain'
import { createLocalRepository } from './repositories'
import { createHttpApi, createLocalAsyncApi, type DocumentExtractionResult, type DocumentUploadInput, type FeedbackDraftInput, type SourceRecord, type SourceWorkspace, type WorkbenchApi } from './clientApi'
import { assembleCustomerContext, briefToText, createLocalBrief, createLocalCoreSummary, type AiBrief, type AiCoreSummary } from './customer-ai'
import { displayProfileValue, PROFILE_SECTIONS, profileSourceLabel, profileUpdateLabel } from './profile'
import { GlobalAIAssistant } from './GlobalAIAssistant'
import { DebugPanel, ReleaseIndicator, VersionStrip } from './DebugPanel'
import { applySpeechResults, emptySpeechTranscript, joinSpeechText, shouldRecoverSpeech, speechErrorMessage, speechTranscriptText, type SpeechTranscriptState } from './speech'
import { canStartCustomerSave } from './save-contract'
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { shouldResumeSource } from './processing-contract'
const repository = createLocalRepository()
const api = createLocalApi(repository)
const remoteBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
const dataMode = (import.meta.env.VITE_DATA_MODE as string | undefined) || (remoteBaseUrl ? 'production' : 'demo')
const staffStorage = dataMode === 'production' ? window.sessionStorage : window.localStorage
const workbenchApi: WorkbenchApi = remoteBaseUrl ? createHttpApi(remoteBaseUrl) : dataMode === 'production' ? createHttpApi('http://127.0.0.1:1') : createLocalAsyncApi(createGuardedLocalApi(repository))

type MePanel = 'account' | 'team'
type CustomerFilter = '待处理' | '待跟进' | '已完成'

const statusLabel: Record<AppointmentWorkflowStatus, string> = { WAIT_ASSIGN: '待分配', WAIT_FOLLOW_UP: '待跟进', WAIT_FEEDBACK: '待反馈', COMPLETED: '已完成' }
const statusTone: Record<AppointmentWorkflowStatus, 'amber' | 'blue' | 'rose' | 'green'> = { WAIT_ASSIGN: 'amber', WAIT_FOLLOW_UP: 'blue', WAIT_FEEDBACK: 'rose', COMPLETED: 'green' }
const statusRank: Record<AppointmentWorkflowStatus, number> = { WAIT_ASSIGN: 0, WAIT_FOLLOW_UP: 1, WAIT_FEEDBACK: 2, COMPLETED: 3 }
const PASSWORD_POLICY_HINT = '密码需为 5～64 位，可使用英文字母、数字和常见特殊符号；无需强制混合大小写、数字或符号。请避开明显弱密码和手机号。'
const MAX_DOCUMENT_SIZE_MB = Number(import.meta.env.VITE_MAX_DOCUMENT_SIZE_MB || '20') || 20
type BrowserSpeechResult = ArrayLike<{ transcript: string }> & { isFinal?: boolean }
type BrowserSpeechRecognitionInstance = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((event: { results: ArrayLike<BrowserSpeechResult>; resultIndex?: number }) => void) | null; onerror: ((event?: { error?: string }) => void) | null; onend: (() => void) | null }
type BrowserSpeechRecognition = new () => BrowserSpeechRecognitionInstance
type SourceCreateInput = { customerId: string; sourceType: string; rawText: string; sourcePerspective?: 'STAFF_REPORTED' | 'CUSTOMER_FIRST_PARTY'; fileRef?: string; notes?: string; document?: { filename: string; mimeType: string; extension: string; size: number; fileHash: string; charCount: number; extractedText: string } }

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function sourceFileInfo(fileRef?: string) {
  try { const value = JSON.parse(fileRef || ''); return value?.storage === 'TEMPORARY' ? value as { original_filename: string; file_type: string; size: number } : null } catch { return null }
}

function sourceStatusLabel(status: string) {
  return ({ UPLOADED: '正在整理', PROCESSING: '正在整理', COMPLETED: '已完成', REVIEW_REQUIRED: '需要确认', FAILED: '整理失败' } as Record<string, string>)[status] || '正在整理'
}

function sourceFailureMessage(error: unknown) {
  const code = (error as { code?: string })?.code
  if (code === 'UNSUPPORTED_DOCUMENT_FORMAT' || code === 'INVALID_DOCUMENT_MIME') return '当前支持 TXT、Markdown 和 Word（.docx）文件。'
  if (code === 'DOCX_CORRUPT' || code === 'DOCUMENT_TEXT_EMPTY') return '资料读取失败，请检查文件后重新上传。'
  return '已保存，AI整理失败，可稍后重试。'
}

function Avatar({ staff, size = 'md' }: { staff?: Staff; size?: 'sm' | 'md' | 'lg' }) { return <span className={`avatar avatar-${size}`}>{staff?.avatar ?? '客'}</span> }
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'rose' | 'dark' }) { return <span className={`badge badge-${tone}`}>{children}</span> }
function ButtonSpinner() { return <span className="button-spinner" aria-hidden="true" /> }
function GradeBadge({ grade }: { grade: CustomerGrade }) { return <span className={`grade grade-${grade}`}>{grade}</span> }
function SectionTitle({ title, action }: { title: string; action?: ReactNode }) { return <div className="section-title"><h2>{title}</h2>{action}</div> }
function roleName(staff: Staff) { return staff.permissionRole === 'MENTOR' ? '导师' : '管理员' }
function workflowStatus(appointment: Appointment): AppointmentWorkflowStatus { return appointment.status as AppointmentWorkflowStatus }

function Login({ api, onLogin }: { api: WorkbenchApi; onLogin: (account: Staff & { mustChangePassword?: boolean }) => void }) {
  const [phone, setPhone] = useState('15021512537')
  const [password, setPassword] = useState(dataMode === 'demo' ? '888888' : '')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); setLoading(true); setError(''); try { const account = await api.login(phone.trim(), password); onLogin(account) } catch (loginError) { setError(loginError instanceof Error ? loginError.message : '登录失败') } finally { setLoading(false) } }
  return <main className="login-page"><div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" /><section className="login-card"><div className="brand-lockup"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><div><strong>ASVA</strong><span>客户关怀系统</span></div></div><div className="login-copy"><div className="eyebrow">SERVICE FLOW</div><h1>看见流程，<br /><em>接住客户。</em></h1><p>预约进入，分配导师，完成跟进，再把反馈补全。</p></div><form onSubmit={submit} className="login-form"><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" autoComplete="username" /></label><label>密码<div className="code-row"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /><button type="button" className="text-button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? '隐藏' : '显示'}</button></div></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" type="submit" disabled={loading}>{loading && <ButtonSpinner />}{loading ? '正在验证…' : '进入工作台'} <span>→</span></button></form>{dataMode === 'demo' ? <div className="login-hint">仅 Demo：请使用本地演示密码</div> : <div className="login-hint">密码只在服务端校验，不会写入浏览器。</div>}</section></main>
}

function ChangePassword({ api, onComplete }: { api: WorkbenchApi; onComplete: () => void }) {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); if (newPassword !== confirmPassword) { setError('两次输入的新密码不一致'); return } setLoading(true); setError(''); try { await api.changePassword('', newPassword); onComplete() } catch (changeError) { setError(changeError instanceof Error ? changeError.message : '修改密码失败') } finally { setLoading(false) } }
  return <main className="login-page"><section className="login-card"><div className="eyebrow">FIRST LOGIN</div><h1>设置新密码</h1><p className="modal-lede">为了账号安全，请设置自己的登录密码。{PASSWORD_POLICY_HINT}</p><form onSubmit={submit} className="login-form"><label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" type="submit" disabled={loading}>{loading && <ButtonSpinner />}{loading ? '保存中…' : '确认修改'} <span>→</span></button></form></section></main>
}

function WorkbenchApp() {
  const [loggedInStaffId, setLoggedInStaffId] = useState<string | null>(() => staffStorage.getItem('asva-demo-staff-v2'))
  const [mustChangePassword, setMustChangePassword] = useState(() => staffStorage.getItem('asva-password-change-required') === 'true')
  const [activeStaffId, setActiveStaffId] = useState(() => staffStorage.getItem('asva-demo-staff-v2') ?? 'staff-founder')
  const [mePanel, setMePanel] = useState<MePanel>('account')
  const location = useLocation()
  const navigate = useNavigate()
  const routeCustomerMatch = location.pathname.match(/^\/customers\/([^/]+)/)
  const selectedCustomerId = routeCustomerMatch ? decodeURIComponent(routeCustomerMatch[1]) : null
  const view = location.pathname.startsWith('/customers') ? 'customers' : location.pathname === '/me' ? 'me' : 'home'
  const [assignAppointmentId, setAssignAppointmentId] = useState<string | null>(null)
  const [feedbackAppointmentId, setFeedbackAppointmentId] = useState<string | null>(null)
  const [manualCustomerOpen, setManualCustomerOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [database, setDatabase] = useState<Database | null>(() => {
    if (remoteBaseUrl || dataMode === 'production') return null
    try { return api.dashboard(activeStaffId) } catch { return api.dashboard('staff-founder') }
  })
  const [loadError, setLoadError] = useState('')

  const activeStaff = database?.staff.find((item) => item.id === activeStaffId) ?? api.staff(activeStaffId) ?? repository.getDatabase().staff[0]
  const canSeeAll = activeStaff.permissionRole === 'ADMIN'

  useEffect(() => {
    if (!loggedInStaffId) return
    let cancelled = false
    setLoadError('')
    workbenchApi.dashboard(activeStaffId).then((next) => { if (!cancelled) setDatabase(next) }).catch((error: Error) => { if (!cancelled) setLoadError(error.message) })
    return () => { cancelled = true }
  }, [activeStaffId, loggedInStaffId, revision])

  useEffect(() => {
    const expire = () => {
      staffStorage.removeItem('asva-demo-staff-v2')
      staffStorage.removeItem('asva-password-change-required')
      window.sessionStorage.removeItem('asva_session_token')
      setLoggedInStaffId(null)
      setMustChangePassword(false)
    }
    window.addEventListener('asva-auth-expired', expire)
    return () => window.removeEventListener('asva-auth-expired', expire)
  }, [])

  useEffect(() => {
    if (loggedInStaffId && database && activeStaff.permissionRole !== 'ADMIN') {
      staffStorage.removeItem('asva-demo-staff-v2')
      setLoggedInStaffId(null)
      setActiveStaffId('staff-founder')
    }
  }, [activeStaff, database, loggedInStaffId])

  const finishLogin = (account: Staff & { mustChangePassword?: boolean }) => { staffStorage.setItem('asva-demo-staff-v2', account.id); if (account.mustChangePassword) { staffStorage.setItem('asva-password-change-required', 'true'); setMustChangePassword(true) } setLoggedInStaffId(account.id); setActiveStaffId(account.id) }
  if (!loggedInStaffId) return <Login api={workbenchApi} onLogin={finishLogin} />
  if (mustChangePassword) return <ChangePassword api={workbenchApi} onComplete={() => { staffStorage.removeItem('asva-password-change-required'); setMustChangePassword(false) }} />
  if (activeStaff.permissionRole !== 'ADMIN') return <Login api={workbenchApi} onLogin={finishLogin} />
  if (!database) return <main className="login-page"><section className="login-card"><div className="eyebrow">ASVA API</div><h1>正在连接工作台</h1><p>{loadError || '正在读取飞书预约和客户数据。'}</p>{loadError && <button className="primary-button full-width" onClick={() => setRevision((value) => value + 1)}>重新连接</button>}</section></main>
  const selectedCustomer = database.customers.find((item) => item.id === selectedCustomerId) ?? database.customers[0]
  const assignAppointment = database.appointments.find((item) => item.id === assignAppointmentId)
  const feedbackAppointment = database.appointments.find((item) => item.id === feedbackAppointmentId)
  const refresh = () => setRevision((value) => value + 1)
  const openCustomer = (id: string) => navigate(`/customers/${encodeURIComponent(id)}`)
  const assign = async (appointment: Appointment, mentorId: string) => { await workbenchApi.assignAppointment(activeStaff.id, appointment.id, mentorId); setAssignAppointmentId(null); refresh() }
  const completeFollowup = async (appointmentId: string) => { await workbenchApi.markFollowupDone(activeStaff.id, appointmentId); setFeedbackAppointmentId(appointmentId); refresh() }
  const saveFeedback = async (feedback: FeedbackInput) => { await workbenchApi.saveFeedback(activeStaff.id, feedback); setFeedbackAppointmentId(null); refresh() }
  const generateServiceSummary = (input: FeedbackDraftInput) => workbenchApi.serviceSummary(activeStaff.id, input)
  const generateProfile = (customerId: string, text: string) => workbenchApi.profileDraft(activeStaff.id, customerId, text)
  const confirmProfile = (customerId: string, updates: ProfileUpdate[]) => workbenchApi.confirmProfile(activeStaff.id, customerId, updates).then((saved) => { refresh(); return saved })
  const generateBrief = (input: { name: string; need: string; expectation: string }) => workbenchApi.brief(activeStaff.id, input)
  const generateIntelligence = (customer: Customer, currentDatabase: Database) => workbenchApi.customerIntelligence(activeStaff.id, { context: assembleCustomerContext(currentDatabase, customer.id) })
  const refreshCustomerSummary = async (customerId: string) => { const saved = await workbenchApi.refreshCustomerSummary(activeStaff.id, customerId); if (saved) setDatabase((current) => current ? { ...current, customers: current.customers.map((item) => item.id === customerId ? saved : item) } : current); return saved }
  const saveBrief = (customerId: string, brief: string) => workbenchApi.saveBrief(activeStaff.id, customerId, brief)
  const saveReferrer = (customerId: string, referrerName: string) => workbenchApi.updateCustomerReferrer(activeStaff.id, customerId, referrerName).then((saved) => { refresh(); return saved })
  const saveManualCustomer = async (input: ManualCustomerInput) => { const saved = await workbenchApi.createCustomer(activeStaff.id, input); setManualCustomerOpen(false); setDatabase(saved); refresh() }
  const previewManualCustomer = (input: ManualCustomerInput): Promise<CustomerDraftPreview> => workbenchApi.previewCustomer(activeStaff.id, input)
  const updateExistingCustomer = async (customerId: string, input: ManualCustomerInput) => { const saved = await workbenchApi.updateCustomer(activeStaff.id, customerId, input); setManualCustomerOpen(false); setDatabase(saved); refresh() }
  const updateCustomerEnrollments = async (customerId: string, enrollments: EnrollmentDraft[]) => { const saved = await workbenchApi.updateCustomerEnrollments(activeStaff.id, customerId, enrollments); setDatabase(saved); refresh() }
  const sourceWorkspace = (customerId: string) => workbenchApi.sourceWorkspace(activeStaff.id, customerId)
  const extractDocument = (input: DocumentUploadInput) => workbenchApi.extractDocument(activeStaff.id, input)
  const createSource = (input: SourceCreateInput) => workbenchApi.createSource(activeStaff.id, input)
  const processSource = (sourceId: string) => workbenchApi.processSource(activeStaff.id, sourceId).then((result) => { refresh(); return result })
  const reviewProposal = (proposalId: string, decision: 'CONFIRM' | 'REJECT') => workbenchApi.reviewProposal(activeStaff.id, proposalId, decision).then(() => { refresh() })
  const resolveConflict = (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => workbenchApi.resolveConflict(activeStaff.id, conflictId, resolution).then(() => { refresh() })

  const customerPage = <CustomersPage staff={activeStaff} database={database} canSeeAll={canSeeAll} selectedCustomer={selectedCustomer} onSelect={openCustomer} onAssign={(id) => setAssignAppointmentId(id)} onComplete={completeFollowup} onFeedback={(id) => setFeedbackAppointmentId(id)} onGenerateBrief={generateBrief} onGenerateIntelligence={generateIntelligence} onRefreshCustomerSummary={refreshCustomerSummary} onSaveBrief={saveBrief} onSaveReferrer={saveReferrer} onGenerateProfile={generateProfile} onConfirmProfile={confirmProfile} onUpdateEnrollments={updateCustomerEnrollments} onSourceWorkspace={sourceWorkspace} onExtractDocument={extractDocument} onCreateSource={createSource} onProcessSource={processSource} onReviewProposal={reviewProposal} onResolveConflict={resolveConflict} onAddCustomer={() => setManualCustomerOpen(true)} />
  const homePage = <HomePage staff={activeStaff} database={database} canSeeAll={canSeeAll} api={workbenchApi} onCustomer={openCustomer} onAssign={(id) => setAssignAppointmentId(id)} onComplete={completeFollowup} onFeedback={(id) => setFeedbackAppointmentId(id)} />
  const mePage = <MePage staff={activeStaff} database={database} panel={mePanel} onPanel={setMePanel} api={workbenchApi} onLogout={() => { staffStorage.removeItem('asva-demo-staff-v2'); staffStorage.removeItem('asva-password-change-required'); window.sessionStorage.removeItem('asva_session_token'); setLoggedInStaffId(null) }} />
  return <div className="app-shell"><aside className="side-rail"><div className="brand-lockup app-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><div><strong>ASVA</strong><span>客户关怀系统</span></div></div><nav className="side-nav"><NavLink to="/home" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><span className="nav-marker">今</span>首页</NavLink><NavLink to="/customers" className={({ isActive }) => `nav-item ${isActive || view === 'customers' ? 'active' : ''}`}><span className="nav-marker">客</span>客户</NavLink><NavLink to="/me" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><span className="nav-marker">我</span>我的</NavLink></nav><div className="rail-bottom"><button className="profile-chip" onClick={() => navigate('/me')}><Avatar staff={activeStaff} size="sm" /><span><strong>{activeStaff.name}</strong><small>{roleName(activeStaff)}</small></span><span className="chevron">⌄</span></button><small className="release-strip"><VersionStrip onOpen={() => window.dispatchEvent(new Event('asva-debug-change'))} /></small></div></aside><main className="main-content"><header className="topbar"><div className="mobile-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><span className="mobile-brand-copy"><strong>ASVA</strong><small>客户关怀系统</small></span></div><div className="topbar-right"><button className="avatar-button" aria-label="打开我的页面" onClick={() => navigate('/me')}><Avatar staff={activeStaff} /></button></div></header><div className="page-content"><Routes><Route path="/home" element={homePage} /><Route path="/customers" element={React.cloneElement(customerPage, { selectedCustomer: undefined })} /><Route path="/customers/:customerId" element={customerPage} /><Route path="/customers/:customerId/archive" element={customerPage} /><Route path="/me" element={mePage} /><Route path="/" element={<Navigate to="/home" replace />} /><Route path="*" element={<Navigate to="/home" replace />} /></Routes></div></main><nav className="bottom-nav"><NavLink to="/home" className={({ isActive }) => `bottom-item ${isActive ? 'active' : ''}`}><span>今</span>首页</NavLink><NavLink to="/customers" className={() => `bottom-item ${view === 'customers' ? 'active' : ''}`}><span>客</span>客户</NavLink><NavLink to="/me" className={({ isActive }) => `bottom-item ${isActive ? 'active' : ''}`}><span>我</span>我的</NavLink></nav>{assignAppointment && <AssignDialog appointment={assignAppointment} database={database} staffId={activeStaff.id} api={workbenchApi} onClose={() => setAssignAppointmentId(null)} onAssign={assign} />}{feedbackAppointment && <FeedbackForm appointment={feedbackAppointment} customer={database.customers.find((item) => item.id === feedbackAppointment.customerId)!} database={database} onClose={() => setFeedbackAppointmentId(null)} onSubmit={saveFeedback} onGenerateSummary={generateServiceSummary} onGenerateProfile={generateProfile} />}{manualCustomerOpen && <ManualCustomerDialog database={database} onClose={() => setManualCustomerOpen(false)} onPreview={previewManualCustomer} onCreate={saveManualCustomer} onUpdate={updateExistingCustomer} onOpenCustomer={(id) => { setManualCustomerOpen(false); openCustomer(id) }} />}<GlobalAIAssistant api={workbenchApi} staffId={activeStaff.id} customerId={selectedCustomerId ?? undefined} onCustomer={openCustomer} /><ReleaseIndicator api={workbenchApi} onDebug={() => window.dispatchEvent(new Event('asva-debug-change'))} /><DebugPanel api={workbenchApi} staff={activeStaff} dataMode={dataMode} /></div>
}

function HomePage({ staff, database, canSeeAll, api, onCustomer, onAssign, onComplete, onFeedback }: { staff: Staff; database: Database; canSeeAll: boolean; api: WorkbenchApi; onCustomer: (id: string) => void; onAssign: (id: string) => void; onComplete: (id: string) => Promise<void>; onFeedback: (id: string) => void }) {
  const [completingId, setCompletingId] = useState<string | null>(null)
  const complete = async (id: string) => { if (completingId) return; setCompletingId(id); try { await onComplete(id) } finally { setCompletingId(null) } }
  const appointments = database.appointments.filter((item) => workflowStatus(item) !== 'COMPLETED').sort((a, b) => statusRank[workflowStatus(a)] - statusRank[workflowStatus(b)] || a.createdAt.localeCompare(b.createdAt)).filter((item) => canSeeAll || workflowStatus(item) !== 'WAIT_ASSIGN')
  const counts = { WAIT_ASSIGN: appointments.filter((item) => workflowStatus(item) === 'WAIT_ASSIGN').length, WAIT_FOLLOW_UP: appointments.filter((item) => workflowStatus(item) === 'WAIT_FOLLOW_UP').length, WAIT_FEEDBACK: appointments.filter((item) => workflowStatus(item) === 'WAIT_FEEDBACK').length }
  return <div className="home-page"><div className="welcome-row"><div><div className="eyebrow">WORKFLOW</div><h1>{canSeeAll ? '客户关怀系统' : '我的流程'}<span className="period">。</span></h1><p className="page-lede">{canSeeAll ? `还有 ${appointments.length} 个预约流程待处理。` : `还有 ${appointments.length} 个分配给你的预约待处理。`}</p></div></div><ResourceBanners /><div className="state-summary"><StateCount label="待分配" value={counts.WAIT_ASSIGN} tone="amber" hidden={!canSeeAll} /><StateCount label="待跟进" value={counts.WAIT_FOLLOW_UP} tone="blue" /><StateCount label="待反馈" value={counts.WAIT_FEEDBACK} tone="rose" /></div><section className="surface task-surface"><SectionTitle title="待处理" action={<span className="quiet-label">按流程顺序</span>} />{appointments.length === 0 ? <div className="clear-state"><strong>当前没有未完成预约</strong><span>新的预约会从待分配开始。</span></div> : <div className="task-list">{appointments.map((appointment) => { const customer = database.customers.find((item) => item.id === appointment.customerId); if (!customer) return null; const status = workflowStatus(appointment); const mentor = database.staff.find((item) => item.id === appointment.assignedMentorId); const isCompleting = completingId === appointment.id; return <div className="workflow-row" key={appointment.id}><button className="workflow-main" onClick={() => onCustomer(customer.id)}><span className="workflow-avatar">{customer.initials}</span><span><strong>{customer.name}</strong><small>{appointment.topic} · <Badge tone={statusTone[status]}>{statusLabel[status]}</Badge>{canSeeAll && mentor && <> · {mentor.name}</>}</small></span></button>{status === 'WAIT_ASSIGN' && canSeeAll ? <button className="secondary-button small" onClick={() => onAssign(appointment.id)}>去分配</button> : status === 'WAIT_FOLLOW_UP' && !canSeeAll ? <button className="secondary-button small" disabled={isCompleting} onClick={() => void complete(appointment.id)}>{isCompleting && <ButtonSpinner />}{isCompleting ? '完成中…' : '完成跟进'}</button> : status === 'WAIT_FEEDBACK' ? <button className="secondary-button small" onClick={() => onFeedback(appointment.id)}>补充反馈</button> : <button className="row-arrow" onClick={() => onCustomer(customer.id)}>→</button>}</div> })}</div>}</section>{canSeeAll && <section className="home-dashboard"><DashboardPanel staffId={staff.id} api={api} /></section>}</div>
}

function ResourceBanners() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [isPaused, setIsPaused] = useState(false)
  const banners = [
    { className: 'resource-banner-site', src: 'assets/asva-official-banner.png', href: 'https://xiangshu3721.github.io/asva-official/index.html', label: '打开 ASVA 官网' },
    { className: 'resource-banner-mindtest', src: 'assets/asva-mindtest-banner.png', href: 'https://xiangshu3721.github.io/mindtest-web/', label: '打开 ASVA 常用心理测试' },
    { className: 'resource-banner-practice', src: 'assets/asva-practice-banner.png', href: 'https://xiangshu3721.github.io/asva-official/explore.html', label: '打开 ASVA 导师修炼包' },
  ]
  useEffect(() => {
    if (isPaused) return undefined
    const timer = window.setInterval(() => setActiveIndex((current) => (current + 1) % banners.length), 6000)
    return () => window.clearInterval(timer)
  }, [isPaused, banners.length])
  const moveTo = (index: number) => setActiveIndex((index + banners.length) % banners.length)
  return <section className="resource-banners" aria-label="ASVA 资源入口" onMouseEnter={() => setIsPaused(true)} onMouseLeave={() => setIsPaused(false)}>{banners.map((banner, index) => <a className={`resource-banner ${banner.className} ${index === activeIndex ? 'active' : ''}`} href={banner.href} target="_blank" rel="noreferrer" aria-label={banner.label} aria-hidden={index !== activeIndex} tabIndex={index === activeIndex ? 0 : -1} key={banner.src}><img className="resource-banner-image" src={`${import.meta.env.BASE_URL}${banner.src}`} alt={banner.label} /></a>)}<div className="resource-carousel-dots" role="tablist" aria-label="选择 Banner">{banners.map((banner, index) => <button className={index === activeIndex ? 'active' : ''} type="button" role="tab" aria-selected={index === activeIndex} aria-label={`第 ${index + 1} 张：${banner.label}`} onClick={() => moveTo(index)} key={banner.src} />)}</div></section>
}

function StateCount({ label, value, tone, hidden = false }: { label: string; value: number; tone: string; hidden?: boolean }) { if (hidden) return null; return <div className={`state-count state-${tone}`}><span>{label}</span><strong>{value}</strong></div> }

function appointmentForCustomer(customerId: string, database: Database) { const cases = database.appointments.filter((item) => item.customerId === customerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return cases.find((item) => workflowStatus(item) !== 'COMPLETED') ?? cases[0] }
function customerFilter(customer: Customer, database: Database): CustomerFilter { const appointment = appointmentForCustomer(customer.id, database); if (!appointment || workflowStatus(appointment) === 'COMPLETED') return '已完成'; if (workflowStatus(appointment) === 'WAIT_FOLLOW_UP') return '待跟进'; return '待处理' }

function CustomersPage({ staff, database, canSeeAll, selectedCustomer, onSelect, onAssign, onComplete, onFeedback, onGenerateBrief, onGenerateIntelligence, onRefreshCustomerSummary, onSaveBrief, onSaveReferrer, onGenerateProfile, onConfirmProfile, onUpdateEnrollments, onSourceWorkspace, onExtractDocument, onCreateSource, onProcessSource, onReviewProposal, onResolveConflict, onAddCustomer }: { staff: Staff; database: Database; canSeeAll: boolean; selectedCustomer?: Customer; onSelect: (id: string) => void; onAssign: (id: string) => void; onComplete: (id: string) => Promise<void>; onFeedback: (id: string) => void; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onGenerateIntelligence: (customer: Customer, database: Database) => Promise<{ summary: AiCoreSummary; brief: AiBrief }>; onRefreshCustomerSummary: (customerId: string) => Promise<Customer | undefined>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined>; onGenerateProfile: (customerId: string, text: string) => Promise<ProfileDraft>; onConfirmProfile: (customerId: string, updates: ProfileUpdate[]) => Promise<Customer>; onUpdateEnrollments: (customerId: string, enrollments: EnrollmentDraft[]) => Promise<void>; onSourceWorkspace: (customerId: string) => Promise<SourceWorkspace>; onExtractDocument: (input: DocumentUploadInput) => Promise<DocumentExtractionResult>; onCreateSource: (input: SourceCreateInput) => Promise<SourceRecord>; onProcessSource: (sourceId: string) => Promise<{ source: SourceRecord; evidenceItems: SourceWorkspace['evidenceItems']; proposals: SourceWorkspace['proposals']; conflicts: SourceWorkspace['conflicts'] }>; onReviewProposal: (proposalId: string, decision: 'CONFIRM' | 'REJECT') => Promise<void>; onResolveConflict: (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => Promise<void>; onAddCustomer: () => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CustomerFilter>('待处理')
  const [mentorFilter, setMentorFilter] = useState('')
  const [courseFilter, setCourseFilter] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const list = database.customers.filter((customer) => {
    if (customerFilter(customer, database) !== filter) return false
    if (mentorFilter === '__UNASSIGNED__' && customer.mentorId) return false
    if (mentorFilter && mentorFilter !== '__UNASSIGNED__' && customer.mentorId !== mentorFilter) return false
    if (courseFilter && !database.enrollments.some((item) => item.customerId === customer.id && item.productId === courseFilter && item.status !== 'CANCELLED')) return false
    if (!normalizedQuery) return true
    const mentor = database.staff.find((item) => item.id === customer.mentorId)
    const courses = database.enrollments.filter((item) => item.customerId === customer.id).map((item) => database.products.find((product) => product.id === item.productId)?.name || '').join(' ')
    return `${customer.name} ${customer.phone} ${customer.wechat || ''} ${customer.need} ${mentor?.name || ''} ${courses}`.toLowerCase().includes(normalizedQuery)
  })
  const mentors = database.staff.filter((item) => item.permissionRole === 'MENTOR')
  const courses = database.products.filter((product) => database.enrollments.some((item) => item.productId === product.id && item.status !== 'CANCELLED'))
  return <div className="customer-page"><div className="customer-list-column"><div className="page-heading"><div><div className="eyebrow">CUSTOMERS</div><h1>客户</h1><p>{canSeeAll ? '查看所有客户与客户服务档案。' : `${staff.name} 负责的客户。`}</p></div><button className="primary-button small" type="button" onClick={onAddCustomer}>新增客户</button></div><label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索昵称、手机号、微信号或主要问题" /></label><div className="filter-row customer-filters">{(['待处理', '待跟进', '已完成'] as CustomerFilter[]).map((item) => <button key={item} className={`filter-pill ${filter === item ? 'active' : ''}`} onClick={() => setFilter(item)}>{item}<span>{database.customers.filter((customer) => customerFilter(customer, database) === item).length}</span></button>)}</div>{canSeeAll && <div className="customer-entity-filters"><label>当前导师<select value={mentorFilter} onChange={(event) => setMentorFilter(event.target.value)}><option value="">全部导师</option><option value="__UNASSIGNED__">未分配</option>{mentors.map((mentor) => <option value={mentor.id} key={mentor.id}>{mentor.name}</option>)}</select></label><label>已报名课程<select value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)}><option value="">全部课程</option>{courses.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></label></div>}<div className="customer-list">{list.map((customer) => { const appointment = appointmentForCustomer(customer.id, database); const mentor = database.staff.find((item) => item.id === customer.mentorId); return <button key={customer.id} className={`customer-list-item ${selectedCustomer?.id === customer.id ? 'selected' : ''}`} onClick={() => onSelect(customer.id)}><span className="customer-avatar">{customer.initials}</span><span className="customer-list-main"><strong>{customer.name}<Badge tone={appointment ? statusTone[workflowStatus(appointment)] : 'neutral'}>{appointment ? statusLabel[workflowStatus(appointment)] : '无待处理'}</Badge></strong><span>{(appointment?.topic ?? customer.need) || '尚未记录当前困扰'}</span><small>{canSeeAll && mentor ? `${mentor.name} · ` : ''}{customer.notes || '尚未补充客户档案'}</small></span><span className="list-chevron">›</span></button> })}</div>{list.length === 0 && <div className="list-empty">这个状态下暂时没有客户。</div>}</div>{selectedCustomer ? <CustomerDetail customer={selectedCustomer} database={database} canSeeAll={canSeeAll} onAssign={onAssign} onComplete={onComplete} onFeedback={onFeedback} onGenerateBrief={onGenerateBrief} onGenerateIntelligence={onGenerateIntelligence} onRefreshCustomerSummary={onRefreshCustomerSummary} onSaveBrief={onSaveBrief} onSaveReferrer={onSaveReferrer} onGenerateProfile={onGenerateProfile} onConfirmProfile={onConfirmProfile} onUpdateEnrollments={onUpdateEnrollments} onSourceWorkspace={onSourceWorkspace} onExtractDocument={onExtractDocument} onCreateSource={onCreateSource} onProcessSource={onProcessSource} onReviewProposal={onReviewProposal} onResolveConflict={onResolveConflict} /> : <div className="empty-detail"><span>客</span><h2>选择一位客户</h2><p>从左侧列表打开客户服务档案。</p></div>}</div>
}

function LegacyCustomerDetail({ customer, database, canSeeAll, onAssign, onComplete, onFeedback, onGenerateBrief, onSaveBrief, onSaveReferrer }: { customer: Customer; database: Database; canSeeAll: boolean; onAssign: (id: string) => void; onComplete: (id: string) => Promise<void>; onFeedback: (id: string) => void; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined> }) {
  const mentor = database.staff.find((item) => item.id === customer.mentorId)
  const appointments = database.appointments.filter((item) => item.customerId === customer.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const current = appointments[0]
  const sessions = database.sessions.filter((item) => item.customerId === customer.id).slice(0, 3)
  const profile = { fields: customer.profileFields ?? {} }
  const [brief, setBrief] = useState(customer.brief)
  const [briefLoading, setBriefLoading] = useState(false)
  const [referrerName, setReferrerName] = useState(customer.referrerName)
  const [referrerEditing, setReferrerEditing] = useState(false)
  const [referrerSaving, setReferrerSaving] = useState(false)
  const [followupLoading, setFollowupLoading] = useState(false)
  const [referrerError, setReferrerError] = useState('')
  useEffect(() => { setBrief(customer.brief) }, [customer.id, customer.brief])
  useEffect(() => { setReferrerName(customer.referrerName); setReferrerEditing(false); setReferrerError('') }, [customer.id, customer.referrerName])
  const loadBrief = async () => { setBriefLoading(true); try { const nextBrief = await onGenerateBrief({ name: customer.name, need: customer.need, expectation: customer.helpExpectation }); await onSaveBrief(customer.id, nextBrief); setBrief(nextBrief) } finally { setBriefLoading(false) } }
  const saveReferrer = async () => { setReferrerSaving(true); setReferrerError(''); try { const saved = await onSaveReferrer(customer.id, referrerName); if (saved) { setReferrerName(saved.referrerName); setReferrerEditing(false) } } catch (error) { setReferrerError(error instanceof Error ? error.message : '保存失败') } finally { setReferrerSaving(false) } }
  const complete = async () => { if (followupLoading || !current) return; setFollowupLoading(true); try { await onComplete(current.id) } finally { setFollowupLoading(false) } }
  return <div className="detail-column"><div className="detail-header"><div className="detail-identity"><span className="detail-avatar">{customer.initials}</span><div><h1>{customer.name}<GradeBadge grade={customer.grade} /></h1><p>{customer.phone || customer.wechat || '未填写联系方式'}{customer.phone && customer.wechat ? ` · ${customer.wechat}` : ''} · {mentor ? `当前导师：${mentor.name}` : '待分配导师'}</p></div></div><div className="detail-actions">{canSeeAll && current && workflowStatus(current) !== 'COMPLETED' && <button className="secondary-button" onClick={() => onAssign(current.id)}>{current.assignedMentorId ? '更换导师' : '分配导师'}</button>}{current && workflowStatus(current) === 'WAIT_FOLLOW_UP' && <button className="primary-button" disabled={followupLoading} onClick={() => void complete()}>{followupLoading && <ButtonSpinner />}{followupLoading ? '完成中…' : '完成跟进'}</button>}{current && workflowStatus(current) === 'WAIT_FEEDBACK' && <button className="primary-button" onClick={() => onFeedback(current.id)}>补充反馈</button>}</div></div><div className="detail-body"><section className="detail-section basic-section"><SectionTitle title="基础信息" action={current && <Badge tone={statusTone[workflowStatus(current)]}>{statusLabel[workflowStatus(current)]}</Badge>} /><div className="basic-grid"><div><span>客户 ID</span><strong>{customer.id}</strong></div><div><span>是否付费</span><strong>{customer.paid ? '是' : '暂未'}</strong></div><div><span>SABC</span><strong><GradeBadge grade={customer.grade} /> <small>{customer.gradeSource}</small></strong></div><div><span>意向课程</span><strong>{customer.intendedCourse ?? '尚未判断'}</strong></div></div><div className="referrer-row"><div><span>介绍人</span>{canSeeAll && referrerEditing ? <input value={referrerName} onChange={(event) => setReferrerName(event.target.value)} placeholder="填写介绍人" aria-label="介绍人" /> : <strong>{referrerName || '未填写'}</strong>}{referrerError && <small className="referrer-error">{referrerError}</small>}</div>{canSeeAll && (referrerEditing ? <div className="referrer-actions"><button className="secondary-button small" type="button" onClick={() => { setReferrerName(customer.referrerName); setReferrerEditing(false) }}>取消</button><button className="primary-button small" type="button" disabled={referrerSaving} onClick={saveReferrer}>{referrerSaving && <ButtonSpinner />}{referrerSaving ? '保存中…' : '保存'}</button></div> : <button className="secondary-button small" type="button" onClick={() => setReferrerEditing(true)}>编辑</button>)}</div></section>{profile && <ProfileOverview profile={profile} />}<div className="detail-two-col"><section className="detail-section"><div className="card-kicker">当前困扰</div><h2 className="detail-copy">{customer.need}</h2></section><section className="detail-section"><div className="card-kicker">希望获得帮助</div><h2 className="detail-copy">{customer.helpExpectation}</h2></section></div><section className="brief-section"><div className="brief-label"><span>✦</span> AI 接待前 Brief <small>辅助信息</small></div>{brief ? <p>{brief}</p> : <div className="brief-empty"><p>当前还没有生成 Brief。</p><button className="secondary-button small" type="button" disabled={briefLoading} onClick={loadBrief}>{briefLoading && <ButtonSpinner />}{briefLoading ? '正在生成…' : '生成接待前 Brief'}</button></div>}<div className="brief-columns"><div><span>已确认</span>{customer.confirmedFacts.slice(0, 3).map((fact) => <p key={fact}>＋ {fact}</p>)}</div><div><span>待确认</span>{customer.aiQuestions.length ? customer.aiQuestions.slice(0, 2).map((fact) => <p key={fact}>？ {fact}</p>) : <p>暂无</p>}</div></div></section><section className="detail-section"><SectionTitle title="历史预约" />{appointments.map((appointment) => <div className="history-row" key={appointment.id}><span>{appointment.topic}</span><Badge tone={statusTone[workflowStatus(appointment)]}>{statusLabel[workflowStatus(appointment)]}</Badge></div>)}</section><section className="detail-section"><SectionTitle title="历史服务记录" />{sessions.length ? sessions.map((session) => <article className="service-record" key={session.id}><div className="service-record-top"><Badge tone="blue">{session.type}</Badge><span>{session.duration ? `${session.duration} 分钟` : '跟进反馈'}</span></div><strong>{session.topic}</strong><p>{session.note}</p>{session.aiSummary && <div className="record-summary"><span>✦ 辅助总结</span>{session.aiSummary}</div>}</article>) : <div className="inline-empty">还没有服务记录。</div>}</section><section className="detail-section note-section"><div className="card-kicker">备注</div><p>{customer.notes || '暂无备注。'}</p></section></div></div>
}

type CustomerDetailProps = { customer: Customer; database: Database; canSeeAll: boolean; onAssign: (id: string) => void; onComplete: (id: string) => Promise<void>; onFeedback: (id: string) => void; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onGenerateIntelligence: (customer: Customer, database: Database) => Promise<{ summary: AiCoreSummary; brief: AiBrief }>; onRefreshCustomerSummary: (customerId: string) => Promise<Customer | undefined>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined>; onGenerateProfile: (customerId: string, text: string) => Promise<ProfileDraft>; onConfirmProfile: (customerId: string, updates: ProfileUpdate[]) => Promise<Customer>; onUpdateEnrollments: (customerId: string, enrollments: EnrollmentDraft[]) => Promise<void>; onSourceWorkspace: (customerId: string) => Promise<SourceWorkspace>; onExtractDocument: (input: DocumentUploadInput) => Promise<DocumentExtractionResult>; onCreateSource: (input: SourceCreateInput) => Promise<SourceRecord>; onProcessSource: (sourceId: string) => Promise<{ source: SourceRecord; evidenceItems: SourceWorkspace['evidenceItems']; proposals: SourceWorkspace['proposals']; conflicts: SourceWorkspace['conflicts'] }>; onReviewProposal: (proposalId: string, decision: 'CONFIRM' | 'REJECT') => Promise<void>; onResolveConflict: (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => Promise<void> }

const detailProfileCards = [
  { title: 'TA是谁', keys: ['birth_date', 'age', 'gender', 'city', 'hometown', 'marital_status', 'children_summary'], labels: { birth_date: '出生日期', age: '年龄', gender: '性别', city: '现居', hometown: '家乡', marital_status: '婚姻状态', children_summary: '子女情况' } },
  { title: '家庭与关系', keys: ['family_summary', 'relationship_conflicts', 'support_system'], labels: { family_summary: '家庭背景', relationship_conflicts: '关系冲突', support_system: '支持系统' } },
  { title: '职业与事业', keys: ['occupation', 'industry', 'position', 'career_stage', 'career_problem', 'career_goal'], labels: { occupation: '职业', industry: '行业', position: '职位', career_stage: '阶段', career_problem: '事业困扰', career_goal: '事业目标' } },
  { title: '兴趣偏好', keys: ['hobbies', 'sports', 'reading', 'travel', 'art_preferences'], labels: { hobbies: '兴趣', sports: '运动', reading: '阅读', travel: '旅行', art_preferences: '艺术' } },
  { title: '性格特点', keys: ['personality_traits', 'communication_style', 'decision_style', 'strengths', 'common_blocks'], labels: { personality_traits: '性格', communication_style: '沟通方式', decision_style: '决策方式', strengths: '优势', common_blocks: '常见卡点' } },
  { title: '核心价值观', keys: ['core_values', 'family_values', 'career_values', 'growth_attitude'], labels: { core_values: '核心价值', family_values: '家庭价值', career_values: '事业价值', growth_attitude: '成长态度' } },
  { title: '当前资源', keys: ['current_resources', 'support_system', 'current_barriers', 'energy_state'], labels: { current_resources: '已有资源', support_system: '支持系统', current_barriers: '当前阻碍', energy_state: '状态' } },
] as const

function activeCustomerCase(customerId: string, database: Database) { return database.appointments.filter((item) => item.customerId === customerId && workflowStatus(item) !== 'COMPLETED').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] }
function detailDate(value?: string | null) { if (!value) return '暂无记录'; return value.replace(/^2026-/, '').replace(/-/g, '/').replace('T', ' ') }
function detailProfileText(value: ProfileValue | undefined) { return displayProfileValue(value ?? null) }
function customerProfileCompleteness(customer: Customer, courseCount: number) {
  const fields = customer.profileFields ?? {}
  const checks = [customer.name, customer.phone || customer.wechat, fields.age ?? fields.birth_year, fields.city, fields.marital_status ?? fields.relationship_status, fields.children_summary ?? fields.children_detail, fields.family_summary ?? fields.support_system, fields.occupation ?? fields.position, fields.industry, fields.career_stage ?? fields.job_status, fields.hobbies ?? fields.sports ?? fields.reading ?? fields.travel, fields.routine, fields.personality_traits ?? fields.self_description, fields.communication_style ?? fields.decision_style, fields.core_values, customer.need || fields.current_core_issue, customer.goal || fields.current_goal, fields.current_resources ?? fields.support_system, customer.mentorId, courseCount > 0 || customer.intendedCourse]
  return Math.round(checks.filter((item) => item !== null && item !== undefined && item !== '' && !(Array.isArray(item) && item.length === 0)).length / 20 * 100)
}

function profileRendererSections(customer: Customer): ProfileMaterialization['sections'] {
  if (customer.profileMaterialization?.sections) return customer.profileMaterialization.sections
  return detailProfileCards.map((card) => ({ title: card.title, emptyLabel: ['性格特点', '核心价值观', '兴趣偏好'].includes(card.title) ? '待了解' : '待补充', items: card.keys.map((key) => ({ label: card.labels[key as keyof typeof card.labels], text: detailProfileText(customer.profileFields?.[key]), evidenceIds: [], basis: [] })).filter((item) => item.text) }))
}

function CustomerProfileRenderer({ customer }: { customer: Customer }) {
  const sections = profileRendererSections(customer)
  const materialization = customer.profileMaterialization
  const coverage = materialization?.coverage.percentage ?? 0
  return <section className="customer-detail-section customer-profile-renderer"><SectionHeading title="当前客户档案" meta={`档案丰富度 ${coverage}%`} icon="●" action={<span className="section-note">只展示可靠资料</span>} /><div className="portrait-grid">{sections.map((section) => <article className="portrait-card" key={section.title}><h3>{section.title}</h3>{section.items.length ? <div className="portrait-facts">{section.items.map((item) => <div className="profile-renderer-fact" key={`${item.label}-${item.text}`}><span>{item.label}</span><strong>{item.text}</strong>{item.basis.length > 0 && <details><summary>查看依据</summary><div className="profile-basis">{item.basis.map((reference) => <p key={reference.evidenceId}>{reference.displayText}<small>{reference.excerpt}</small></p>)}</div></details>}</div>)}</div> : <span className="portrait-pending">{section.emptyLabel}</span>}</article>)}</div>{materialization?.lifeEvents.length ? <div className="profile-life-events"><h3>人生经历与变化</h3>{materialization.lifeEvents.slice(0, 8).map((event) => <article className="profile-life-event" key={event.id}><div><strong>{event.title}</strong>{event.occurredAt && <small>{event.occurredAt}</small>}</div><p>{event.detail}</p><details><summary>查看依据</summary><div className="profile-basis"><p>{event.basis[0]?.displayText}<small>{event.basis[0]?.excerpt}</small></p></div></details></article>)}</div> : null}</section>
}
function customerPaymentLabel(customer: Customer, enrollments: Database['enrollments']) {
  if (!enrollments.length) return customer.paid ? '已付费' : '暂未付费'
  const paid = enrollments.filter((item) => item.paymentStatus === 'PAID' || item.paid).length
  const unrecorded = enrollments.some((item) => !item.paymentStatus || item.paymentStatus === 'UNRECORDED')
  if (paid === enrollments.length && !unrecorded) return '已付费'
  if (paid > 0) return '部分记录缺失'
  return unrecorded ? '部分记录缺失' : '暂未付费'
}
function sourceLabel(source?: string) { return source === 'AI_INFERENCE' ? 'AI推断' : source === 'AI_EXTRACTED_CONFIRMED' ? 'AI提取 · 人工确认' : source === 'MENTOR_OBSERVATION' ? '导师观察' : source === 'MENTOR_FACTUAL_INPUT' || source === 'MENTOR_CONFIRMED' ? '导师事实输入' : source === 'ADMIN_CONFIRMED' ? '管理员确认' : source === 'STRUCTURED_INPUT' ? '结构化录入' : source === 'IMPORTED_HISTORY' || source === 'LEGACY_MIGRATION' ? '历史导入' : '客户明确表达' }

function CustomerDetail(props: CustomerDetailProps) {
  const { customer, database } = props
  const mentor = database.staff.find((item) => item.id === customer.mentorId)
  const currentCase = activeCustomerCase(customer.id, database)
  const appointments = database.appointments.filter((item) => item.customerId === customer.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const sessions = database.sessions.filter((item) => item.customerId === customer.id).sort((a, b) => b.date.localeCompare(a.date))
  const enrollments = database.enrollments.filter((item) => item.customerId === customer.id && item.status !== 'CANCELLED')
  const courses = enrollments.map((item) => ({ enrollment: item, product: database.products.find((product) => product.id === item.productId) })).filter((item) => item.product)
  const latestProfileChanges = database.profileChanges.filter((item) => item.customerId === customer.id).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  const latestProfileChange = latestProfileChanges[0]
  const latestOperator = latestProfileChange?.operatorId ? database.staff.find((item) => item.id === latestProfileChange.operatorId) : undefined
  const aiContext = assembleCustomerContext(database, customer.id)
  const [aiSummary, setAiSummary] = useState<AiCoreSummary>(() => customer.aiSummary ? customer.aiSummary as AiCoreSummary : createLocalCoreSummary(aiContext))
  const [brief, setBrief] = useState<AiBrief>(() => createLocalBrief(aiContext))
  const [briefLoading, setBriefLoading] = useState(false)
  const [editingEnrollments, setEditingEnrollments] = useState(false)
  useEffect(() => { const nextContext = assembleCustomerContext(database, customer.id); const nextSummary = customer.aiSummary ? customer.aiSummary as AiCoreSummary : createLocalCoreSummary(nextContext); setAiSummary(nextSummary); setBrief(createLocalBrief(nextContext, nextSummary)) }, [customer.id, customer.createdAt, customer.need, customer.goal, customer.helpExpectation, customer.profileUpdatedAt, customer.aiSummary, database.sessions.length, database.profileChanges.length])
  const summaryRefreshInFlight = useRef(false)
  useEffect(() => { if (!['STALE', 'FAILED'].includes(customer.aiSummaryStatus || '') || summaryRefreshInFlight.current) return; summaryRefreshInFlight.current = true; void props.onRefreshCustomerSummary(customer.id).then((saved) => { if (saved?.aiSummary) setAiSummary(saved.aiSummary as AiCoreSummary) }).catch(() => {}).finally(() => { summaryRefreshInFlight.current = false }) }, [customer.id, customer.aiSummaryStatus])
  const refreshBrief = async () => { setBriefLoading(true); try { const next = await props.onGenerateIntelligence(customer, database); await props.onSaveBrief(customer.id, briefToText(next.brief)); setAiSummary(next.summary); setBrief(next.brief) } finally { setBriefLoading(false) } }
  const recordService = () => { if (!currentCase) return; if (workflowStatus(currentCase) === 'WAIT_FOLLOW_UP') void props.onComplete(currentCase.id); else if (workflowStatus(currentCase) === 'WAIT_FEEDBACK') props.onFeedback(currentCase.id) }
  const completeness = customer.profileMaterialization?.coverage.percentage ?? customerProfileCompleteness(customer, courses.length)
  const activityCount = sessions.length + appointments.length + enrollments.length
  return <article className="customer-detail-page">
    <header className="customer-detail-header">
      <div className="customer-detail-identity"><span className="customer-detail-avatar">{customer.initials}</span><div><div className="customer-detail-name-row"><h1>{customer.name}</h1><GradeBadge grade={customer.grade} /></div><p className="customer-detail-id">{customer.id}</p><div className="customer-meta-row"><span>{customer.source || '历史数据导入'}</span>{mentor && <span>当前导师：{mentor.name}</span>}{customer.referrerName && <span>介绍人：{customer.referrerName}</span>}</div></div></div>
      <div className="customer-detail-status"><Badge tone={currentCase ? statusTone[workflowStatus(currentCase)] : 'neutral'}>{currentCase ? statusLabel[workflowStatus(currentCase)] : '无待处理'}</Badge><small>最近服务：{sessions[0] ? detailDate(sessions[0].date) : '暂无服务'}</small></div>
      <div className="customer-detail-metrics"><DetailMetric label="是否付费" value={customerPaymentLabel(customer, enrollments)} /><DetailMetric label="SABC" value={customer.grade} note={customer.gradeSource} /><DetailMetric label="已报名课程" value={`${courses.length} 门`} /><DetailMetric label="最近服务" value={sessions[0] ? detailDate(sessions[0].date).split(' ')[0] : '暂无'} note={sessions[0]?.topic} /></div>
      <div className="customer-detail-actions"><button className="primary-button" type="button" disabled={!currentCase} onClick={recordService}>记录服务</button><button className="secondary-button" type="button" onClick={() => { window.dispatchEvent(new Event('asva-open-source-composer')); document.getElementById('profile-supplement')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>＋ 补充档案</button>{props.canSeeAll && currentCase && <button className="secondary-button" type="button" onClick={() => props.onAssign(currentCase.id)}>{currentCase.assignedMentorId ? '更换导师' : '分配导师'}</button>}</div>
    </header>
    <div className="customer-profile-meta"><span>联系方式：{customer.phone || customer.wechat || '未记录'}{customer.phone && customer.wechat ? ` · ${customer.wechat}` : ''}</span><span>档案版本：v{customer.profileVersion ?? 0}</span></div>
    {latestProfileChange && <div className="recent-update-line">{detailDate(latestProfileChange.updatedAt)} · {latestOperator?.name || '管理员'} 更新了 {latestProfileChange.updateBatchId ? latestProfileChanges.filter((item) => item.updateBatchId === latestProfileChange.updateBatchId).length : 1} 项客户信息</div>}
    <section className="customer-detail-section customer-ai-summary"><SectionHeading title="AI 核心摘要" meta="AI生成 · 仅供参考" icon="✦" /><p className="summary-overview">{aiSummary.overview}</p><ul className="summary-bullets">{aiSummary.core_issues.map((item) => <li key={item}>{item}</li>)}</ul><div className="summary-facts"><SummaryFact title="核心困扰" value={aiSummary.core_issues.join('、')} tone="rose" /><SummaryFact title="优先议题" value={aiSummary.priority_topics.join('、')} tone="amber" /><SummaryFact title="当前目标" value={aiSummary.current_goals.join('、')} tone="green" /><SummaryFact title="服务安全风险" value={riskLabel(aiSummary.risk.level)} tone="blue" note={aiSummary.risk.reason} /></div><p className="summary-resource">已有资源：{aiSummary.resources.join('、')} · 信息把握度：{confidenceLabel(aiSummary.confidence)}</p></section>
    <CustomerProfileRenderer customer={customer} />
    <CustomerBrief brief={brief} loading={briefLoading} onRefresh={refreshBrief} />
    <CustomerCourseOverview courses={courses} sessions={sessions} completedAppointments={appointments.filter((item) => workflowStatus(item) === 'COMPLETED').length} activityCount={activityCount} completeness={completeness} canEdit={props.canSeeAll} onEdit={() => setEditingEnrollments(true)} />
    <CustomerHistory appointments={appointments} sessions={sessions} database={database} />
    <ProfileChangeHistory changes={database.profileChanges.filter((item) => item.customerId === customer.id)} />
    <EvidenceWorkspace customer={customer} onLoad={props.onSourceWorkspace} onExtractDocument={props.onExtractDocument} onCreate={props.onCreateSource} onProcess={props.onProcessSource} onResolveConflict={props.onResolveConflict} />
    {editingEnrollments && <EnrollmentEditor customer={customer} products={database.products.filter(activeProductForManualEntry)} enrollments={enrollments} onClose={() => setEditingEnrollments(false)} onSave={async (drafts) => { await props.onUpdateEnrollments(customer.id, drafts); setEditingEnrollments(false) }} />}
  </article>
}

function DetailMetric({ label, value, note }: { label: string; value: string; note?: string }) { return <div className="detail-metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div> }
function SectionHeading({ title, meta, icon, action }: { title: string; meta?: string; icon?: string; action?: ReactNode }) { return <div className="customer-section-heading"><div><h2><span className="section-icon">{icon}</span>{title}</h2>{meta && <small>{meta}</small>}</div>{action}</div> }
function SummaryFact({ title, value, note, tone }: { title: string; value: string; note?: string; tone: string }) { return <div className={`summary-fact summary-fact-${tone}`}><span>{title}</span><strong>{value}</strong>{note && <small>{note}</small>}</div> }
function riskLabel(level: AiCoreSummary['risk']['level']) { return ({ LOW: '低', MEDIUM: '中', HIGH: '高', UNASSESSED: '未评估' })[level] }
function confidenceLabel(level: AiCoreSummary['confidence']) { return ({ LOW: '低', MEDIUM: '中', HIGH: '高' })[level] }

function CustomerBrief({ brief, loading, onRefresh }: { brief: AiBrief; loading: boolean; onRefresh: () => Promise<void> }) {
  const cards = [
    { title: '已确认', tone: 'confirmed', items: brief.confirmed },
    { title: '待确认', tone: 'pending', items: brief.to_confirm },
    { title: '建议切入点', tone: 'entry', items: brief.entry_points },
    { title: '建议提问', tone: 'question', items: brief.suggested_questions },
  ]
  return <section className="customer-detail-section customer-brief"><div className="customer-section-heading brief-heading"><div><h2><span className="section-icon">✦</span>AI 接待前 Brief</h2><small>AI生成 · 仅供参考</small></div><button className="secondary-button small" type="button" disabled={loading} onClick={() => void onRefresh()}>{loading ? '刷新中…' : '刷新 Brief'}</button></div><p className="brief-lede">{brief.lede}</p><div className="brief-scroll">{cards.map((card) => <article className={`brief-card brief-card-${card.tone}`} key={card.title}><h3>{card.title}</h3><ul>{card.items.map((item) => <li key={item}>{item}</li>)}</ul></article>)}</div></section>
}

function CustomerCourseOverview({ courses, sessions, completedAppointments, activityCount, completeness, canEdit, onEdit }: { courses: Array<{ enrollment: Database['enrollments'][number]; product?: Product }>; sessions: Database['sessions']; completedAppointments: number; activityCount: number; completeness: number; canEdit: boolean; onEdit: () => void }) { return <section className="customer-detail-section"><SectionHeading title="已报名课程与服务概览" meta="已报名课程只读取 Enrollment" icon="▣" action={<span className="section-actions"><span className="section-note">档案完整度 {completeness}%</span>{canEdit && <button className="secondary-button small" type="button" onClick={onEdit}>编辑报名</button>}</span>} /><div className="overview-metrics"><DetailMetric label="已报名课程" value={`${courses.length} 门`} /><DetailMetric label="服务次数" value={`${sessions.length} 次`} /><DetailMetric label="已完成预约" value={`${completedAppointments} 次`} /><DetailMetric label="近30天互动" value={activityCount ? `${Math.min(100, activityCount * 20)}%` : '暂无数据'} /></div><div className="enrollment-list">{courses.length ? courses.map(({ enrollment, product }) => <div className="enrollment-row" key={enrollment.id}><div><strong>{product?.name || enrollment.productId}</strong><small>{enrollment.status} · 报名 {detailDate(enrollment.enrolledAt || enrollment.date)}</small></div><span className={enrollment.paymentStatus === 'PAID' || enrollment.paid ? 'enrollment-paid' : 'enrollment-unrecorded'}>{enrollment.paymentStatus === 'PAID' || enrollment.paid ? '已付费' : enrollment.paymentStatus === 'UNPAID' ? '暂未付费' : '未记录'}</span></div>) : <div className="detail-empty-line">暂无报名课程。</div>}</div><p className="course-intent-note">课程意向：{courses.length ? '另见客户当前档案中的“意向课程”' : '暂无正式报名；意向课程仍只表示兴趣，不代表已报名。'}</p></section> }

function EnrollmentEditor({ customer, products, enrollments, onClose, onSave }: { customer: Customer; products: Product[]; enrollments: Database['enrollments']; onClose: () => void; onSave: (drafts: EnrollmentDraft[]) => Promise<void> }) {
  const [selected, setSelected] = useState<string[]>(() => enrollments.map((item) => item.productId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const toggle = (productId: string) => setSelected((current) => current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId])
  const save = async () => { setSaving(true); setError(''); try { await onSave(selected.map((productId) => ({ productId }))) } catch (saveError) { setError(saveError instanceof Error ? saveError.message : '保存报名失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><section className="modal-card compact-modal"><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">ENROLLMENT EDIT</div><h2>编辑已报名课程</h2><p className="modal-lede">{customer.name} · 移除课程会保留历史并标记为 CANCELLED。</p><div className="enrollment-editor-list">{products.map((product) => <label key={product.id} className="enrollment-editor-option"><input type="checkbox" checked={selected.includes(product.id)} onChange={() => toggle(product.id)} />{product.name}</label>)}{!products.length && <div className="inline-empty">暂无 ACTIVE 产品。</div>}</div>{error && <p className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button type="button" className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存报名'}</button></div></section></div>
}

function CustomerHistory({ appointments, sessions, database }: { appointments: Database['appointments']; sessions: Database['sessions']; database: Database }) { const events = [...appointments.map((item) => ({ id: item.id, date: item.createdAt, type: '预约', title: item.topic, body: item.description || item.expectation, status: workflowStatus(item), mentorId: item.assignedMentorId })), ...sessions.map((item) => ({ id: item.id, date: item.date, type: '服务记录', title: item.topic, body: item.aiSummary || item.note, status: undefined, mentorId: item.mentorId }))].sort((a, b) => b.date.localeCompare(a.date)); return <section className="customer-detail-section"><SectionHeading title="历史记录" meta={`${events.length} 条`} icon="◷" action={<span className="history-filter">全部</span>} />{events.length ? <div className="history-timeline">{events.map((event) => { const mentor = database.staff.find((item) => item.id === event.mentorId); return <article className="history-event" key={event.id}><time>{detailDate(event.date)}</time><span className="history-dot" /><div><div className="history-event-title"><strong>{event.title}</strong>{event.status && <Badge tone={statusTone[event.status]}>{statusLabel[event.status]}</Badge>}</div><small>{event.type}{mentor ? ` · ${mentor.name}` : ''}</small><p>{event.body || '暂无详细记录。'}</p></div></article> })}</div> : <div className="detail-empty-line">还没有预约或服务记录。</div>}</section> }

function EvidenceWorkspace({ customer, onLoad, onExtractDocument, onCreate, onProcess, onResolveConflict }: { customer: Customer; onLoad: (customerId: string) => Promise<SourceWorkspace>; onExtractDocument: (input: DocumentUploadInput) => Promise<DocumentExtractionResult>; onCreate: (input: SourceCreateInput) => Promise<SourceRecord>; onProcess: (sourceId: string) => Promise<{ source: SourceRecord; evidenceItems: SourceWorkspace['evidenceItems']; proposals: SourceWorkspace['proposals']; conflicts: SourceWorkspace['conflicts'] }>; onResolveConflict: (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => Promise<void> }) {
  const [workspace, setWorkspace] = useState<SourceWorkspace>({ sources: [], evidenceItems: [], proposals: [], conflicts: [] })
  const [rawText, setRawText] = useState('')
  const [sourcePerspective, setSourcePerspective] = useState<'STAFF_REPORTED' | 'CUSTOMER_FIRST_PARTY'>('STAFF_REPORTED')
  const [attachedFile, setAttachedFile] = useState<File | null>(null)
  const [attachedDocument, setAttachedDocument] = useState<DocumentExtractionResult | null>(null)
  const [composerOpen, setComposerOpen] = useState(true)
  const [recording, setRecording] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [analysisSummary, setAnalysisSummary] = useState('')
  const processingRef = useRef(new Set<string>())
  const recognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null)
  const load = async () => { try { const next = await onLoad(customer.id); setWorkspace(next); return next } catch (loadError) { setError(loadError instanceof Error ? loadError.message : '资料读取失败'); return null } }
  useEffect(() => () => { recognitionRef.current?.stop(); processingRef.current.clear() }, [customer.id])
  useEffect(() => { const open = () => setComposerOpen(true); window.addEventListener('asva-open-source-composer', open); return () => window.removeEventListener('asva-open-source-composer', open) }, [])
  const toggleVoice = () => {
    if (recording) { recognitionRef.current?.stop(); recognitionRef.current = null; setRecording(false); return }
    const speechApi = window as Window & { SpeechRecognition?: BrowserSpeechRecognition; webkitSpeechRecognition?: BrowserSpeechRecognition }
    const Recognition = speechApi.SpeechRecognition || speechApi.webkitSpeechRecognition
    if (!Recognition) { setError('当前浏览器不支持语音输入，请改用文字或粘贴资料。'); return }
    const recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.continuous = true; recognition.interimResults = true
    recognition.onresult = (event) => { let next = ''; for (let index = 0; index < event.results.length; index += 1) next += `${next ? ' ' : ''}${event.results[index]?.[0]?.transcript || ''}`; if (next.trim()) setRawText(next.trim()) }
    recognition.onerror = () => { setError('没有识别到清晰语音，请继续说或直接编辑文字。'); setRecording(false) }
    recognition.onend = () => setRecording(false)
    recognitionRef.current = recognition; setError(''); setRecording(true); recognition.start()
  }
  const attachDocument = async (file: File) => {
    if (file.size > MAX_DOCUMENT_SIZE_MB * 1024 * 1024) { setAttachedFile(null); setAttachedDocument(null); setError('文件较大，请压缩后再上传。'); return }
    setAttachedFile(file); setAttachedDocument(null); setError(''); setMessage('正在读取资料…')
    try { const base64 = await fileToBase64(file); const extracted = await onExtractDocument({ filename: file.name, mimeType: file.type, extension: `.${file.name.toLowerCase().split('.').pop() || ''}`, size: file.size, base64 }); setAttachedDocument(extracted); setMessage(`已读取 ${extracted.char_count.toLocaleString()} 字`) } catch (extractError) { setAttachedFile(null); setAttachedDocument(null); setMessage(''); setError(sourceFailureMessage(extractError)) }
  }
  const mergeProcessed = (processed: { source: SourceRecord; evidenceItems: SourceWorkspace['evidenceItems']; proposals: SourceWorkspace['proposals']; conflicts: SourceWorkspace['conflicts'] }) => {
    setWorkspace((current) => ({ sources: [processed.source, ...current.sources.filter((item) => item.id !== processed.source.id)], evidenceItems: [...current.evidenceItems.filter((item) => item.sourceId !== processed.source.id), ...processed.evidenceItems], proposals: [...current.proposals.filter((item) => item.sourceId !== processed.source.id), ...processed.proposals], conflicts: [...current.conflicts.filter((item) => !processed.conflicts.some((conflict) => conflict.id === item.id)), ...processed.conflicts] }))
    const updated = processed.proposals.filter((item) => item.reviewStatus === 'CONFIRMED').length
    const confirmations = processed.conflicts.filter((item) => item.status === 'OPEN').length
    setAnalysisSummary(`已整理完成 · 更新 ${updated} 项 · 新增 ${processed.evidenceItems.length} 条记录 · 需要确认 ${confirmations} 项`)
  }
  useEffect(() => {
    let cancelled = false
    const reconcile = async () => {
      const next = await load()
      if (cancelled || !next) return
      for (const source of next.sources.filter((item) => shouldResumeSource(item))) {
        if (processingRef.current.has(source.id)) continue
        processingRef.current.add(source.id)
        try { mergeProcessed(await onProcess(source.id)) } catch { if (!cancelled) setMessage('已保存，正在整理；稍后可重试。') } finally { processingRef.current.delete(source.id) }
      }
    }
    void reconcile()
    const timer = window.setInterval(() => { void reconcile() }, 7000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [customer.id])
  const retrySource = async (sourceId: string) => {
    setSaving(true); setError('')
    try { mergeProcessed(await onProcess(sourceId)); setMessage('已重新识别并整理完成') } catch (processError) { await load(); setMessage(sourceFailureMessage(processError)) } finally { setSaving(false) }
  }
  const save = async () => {
    if ((!rawText.trim() && !attachedFile) || saving) return
    setSaving(true); setError(''); setMessage('')
    const saveStartedAt = performance.now()
    try {
      const document = attachedFile && attachedDocument ? { filename: attachedFile.name, mimeType: attachedFile.type, extension: `.${attachedFile.name.toLowerCase().split('.').pop() || ''}`, size: attachedFile.size, fileHash: attachedDocument.file_hash, charCount: attachedDocument.char_count, extractedText: attachedDocument.extracted_text } : undefined
      const source = await onCreate({ customerId: customer.id, sourceType: attachedFile ? 'FILE_UPLOAD' : 'TEXT_INPUT', rawText: attachedFile ? attachedDocument?.extracted_text || '' : rawText.trim(), sourcePerspective, notes: attachedFile ? rawText.trim() : undefined, document })
      const sourceSaveMs = Math.round(performance.now() - saveStartedAt)
      setSaving(false); setRawText(''); setAttachedFile(null); setAttachedDocument(null); setComposerOpen(false); setMessage(`已保存，正在整理 · ${sourceSaveMs}ms`); setAnalysisSummary('')
      void onProcess(source.id).then(mergeProcessed).then(() => setMessage('已整理完成')).catch(async (processError) => { await load(); setMessage(sourceFailureMessage(processError)) })
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : '资料保存失败'); setSaving(false) }
  }
  const resolve = async (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => { setSaving(true); try { await onResolveConflict(conflictId, resolution); await load() } catch (resolveError) { setError(resolveError instanceof Error ? resolveError.message : '冲突处理失败') } finally { setSaving(false) } }
  const grouped = (type: string) => workspace.evidenceItems.filter((item) => item.evidenceType === type)
  const fieldLabel = (field: string) => ({ birth_date: '出生日期', gender: '性别', phone: '手机号', wechat: '微信号' } as Record<string, string>)[field] || '稳定信息'
  return <section className="customer-detail-section profile-supplement" id="profile-supplement"><SectionHeading title="档案记录" meta={`已记录 ${workspace.sources.length} 份 · 待确认 ${workspace.conflicts.filter((item) => item.status === 'OPEN').length} 项`} icon="＋" action={<button className="secondary-button small" type="button" onClick={() => setComposerOpen((open) => !open)}>{composerOpen ? '收起' : '＋ 补充档案'}</button>} />{composerOpen && <><p className="supplement-note">写下补充说明，或上传一份资料；保存后系统会在后台读取并整理。</p><textarea value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder="可选：补充资料背景，例如：这是客户上周咨询后的整理资料。" /><div className="source-tools"><button className="secondary-button" type="button" onClick={toggleVoice}>{recording ? '结束录音' : '语音输入'}</button><label className="secondary-button file-button">上传资料<input type="file" accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void attachDocument(file) }} /></label><button className="primary-button" type="button" disabled={(!rawText.trim() && !(attachedFile && attachedDocument)) || saving || Boolean(attachedFile && !attachedDocument)} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></div><label className="perspective-toggle"><input type="checkbox" checked={sourcePerspective === 'CUSTOMER_FIRST_PARTY'} onChange={(event) => setSourcePerspective(event.target.checked ? 'CUSTOMER_FIRST_PARTY' : 'STAFF_REPORTED')} /> 这是客户本人原话 / 原始资料</label>{attachedFile && <small className="voice-note">📄 {attachedFile.name} · {attachedDocument ? `已读取 ${attachedDocument.char_count.toLocaleString()} 字` : '正在读取资料…'}</small>}{message && <small className="voice-note">{message}</small>}{error && <p className="form-error">{error}</p>}</>}{workspace.sources.slice(0, 8).map((source) => { const file = sourceFileInfo(source.fileRef); const resumable = shouldResumeSource(source) || source.processingStatus === 'FAILED'; return <div className="source-file-status" key={source.id}><span>{file ? `📄 ${file.original_filename}` : `✎ ${source.title || '文字资料'}`}</span><small>{sourceStatusLabel(source.processingStatus)}{source.processingError ? ` · ${source.processingError}` : ''}</small>{resumable && <button className="secondary-button small" type="button" disabled={saving} onClick={() => void retrySource(source.id)}>{source.processingStatus === 'FAILED' ? '重新整理' : '继续整理'}</button>}</div> })}{analysisSummary && <p className="analysis-summary">{analysisSummary}</p>}{workspace.conflicts.filter((item) => item.status === 'OPEN').map((conflict) => { const evidence = workspace.evidenceItems.find((item) => item.id === conflict.newEvidenceId); const source = workspace.sources.find((item) => item.id === evidence?.sourceId); return <div className="profile-draft-row conflict" key={conflict.id}><strong>需要确认：{fieldLabel(conflict.fieldKey)}</strong><span>当前：{displayProfileValue(conflict.currentValue as ProfileValue)}；资料中：{displayProfileValue(conflict.newValue as ProfileValue)}</span><small>来源：{source?.title || '资料记录'} · 可展开“查看整理依据”回看原文依据。</small><div className="review-actions"><button className="secondary-button small" type="button" disabled={saving} onClick={() => void resolve(conflict.id, 'KEEP_CURRENT')}>保留当前</button><button className="secondary-button small" type="button" disabled={saving} onClick={() => void resolve(conflict.id, 'MARK_UNKNOWN')}>暂不处理</button><button className="primary-button small" type="button" disabled={saving} onClick={() => void resolve(conflict.id, 'USE_NEW')}>使用新值</button></div></div> })}<details className="advanced-evidence"><summary>查看整理依据</summary><div className="evidence-results"><EvidenceGroup title="明确信息" items={grouped('FACT')} /><EvidenceGroup title="客户表达" items={grouped('SELF_MEANING')} /><EvidenceGroup title="导师观察" items={grouped('OBSERVATION')} /><EvidenceGroup title="AI提示（仅供参考）" items={grouped('HYPOTHESIS')} weak /></div></details></section>
}

function EvidenceGroup({ title, items, weak = false }: { title: string; items: SourceWorkspace['evidenceItems']; weak?: boolean }) { return <div className={`profile-section evidence-group ${weak ? 'evidence-group-weak' : ''}`}><h3>{title} <small>{items.length}</small></h3>{items.length ? <div className="profile-update-list">{items.map((item) => <div className="profile-update" key={item.id}><strong>{item.displayText}</strong><span>{item.sourceExcerpt}</span></div>)}</div> : <div className="profile-empty">暂无</div>}</div>}

function ProfileSupplement({ customer, onGenerate, onConfirm }: { customer: Customer; onGenerate: (customerId: string, text: string) => Promise<ProfileDraft>; onConfirm: (customerId: string, updates: ProfileUpdate[]) => Promise<Customer> }) {
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const recognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null)
  const voiceBaseTextRef = useRef('')
  const toggleVoice = () => {
    if (isRecording) { recognitionRef.current?.stop(); recognitionRef.current = null; setIsRecording(false); return }
    const speechApi = window as Window & { SpeechRecognition?: BrowserSpeechRecognition; webkitSpeechRecognition?: BrowserSpeechRecognition }
    const SpeechRecognition = speechApi.SpeechRecognition || speechApi.webkitSpeechRecognition
    if (!SpeechRecognition) { setVoiceError('当前浏览器不支持语音录入，请直接输入文字。'); return }
    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => { let transcript = ''; for (let index = 0; index < event.results.length; index += 1) { const part = event.results[index]?.[0]?.transcript?.trim(); if (part) transcript += `${transcript ? ' ' : ''}${part}` }; if (transcript) setText(`${voiceBaseTextRef.current.trim()}${voiceBaseTextRef.current.trim() ? ' ' : ''}${transcript}`) }
    recognition.onerror = () => setVoiceError('没有识别到清晰语音，请继续说或直接修改文字。')
    recognition.onend = () => { if (recognitionRef.current === recognition) recognitionRef.current = null; setIsRecording(false) }
    voiceBaseTextRef.current = text
    setVoiceError('')
    recognitionRef.current = recognition
    setIsRecording(true)
    try { recognition.start() } catch { recognitionRef.current = null; setIsRecording(false); setVoiceError('语音录入启动失败，请直接输入文字。') }
  }
  useEffect(() => () => { recognitionRef.current?.stop() }, [])
  const analyze = async () => { if (!text.trim() || loading) return; setLoading(true); try { setDraft(await onGenerate(customer.id, text.trim())) } finally { setLoading(false) } }
  const confirm = async () => { if (!draft?.updates.length || saving) return; setSaving(true); try { await onConfirm(customer.id, draft.updates); setDraft(null); setText('') } finally { setSaving(false) } }
  return <section className="customer-detail-section profile-supplement" id="profile-supplement"><SectionHeading title="补充客户档案" meta="语音或文字补充，AI先整理建议" icon="＋" /><p className="supplement-note">先记录新的事实，AI 会拆成字段更新建议；冲突信息会在确认前单独标记。</p><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="例如：客户最近已经离职，开始考虑自由职业，平时恢复了瑜伽。" /><div className="supplement-actions"><button className="secondary-button" type="button" onClick={toggleVoice}>{isRecording ? '结束录音' : '语音录入'}</button><button className="primary-button" type="button" disabled={!text.trim() || loading} onClick={() => void analyze()}>{loading ? 'AI分析中…' : '文字补充'}</button></div>{voiceError && <small className="voice-note">{voiceError}</small>}{draft && <div className="profile-draft"><strong>AI更新建议</strong>{draft.updates.length ? draft.updates.map((update) => <div className={`profile-draft-row ${update.conflict ? 'conflict' : ''}`} key={update.field}><span>{profileUpdateLabel(update)}</span><b>{update.conflict ? `${displayProfileValue(update.previousValue ?? null)} → ` : ''}{displayProfileValue(update.value)}</b><small>{sourceLabel(update.source)}{update.conflict ? ' · 与已有记录不同，确认后才覆盖' : ' · 待确认'}</small></div>) : <p>没有识别到新的档案信息，本次不写入。</p>}{draft.updates.length > 0 && <button className="primary-button" type="button" disabled={saving} onClick={() => void confirm()}>{saving ? '保存中…' : '确认更新档案'}</button>}</div>}</section>
}

function ProfileOverview({ profile }: { profile: { fields: Record<string, ProfileValue> } }) {
  const sections = PROFILE_SECTIONS.map((section) => ({ ...section, facts: section.fields.map((field) => ({ ...field, value: profile.fields[field.key] })).filter((field) => displayProfileValue(field.value) !== '') })).filter((section) => section.facts.length)
  return <section className="profile-overview"><SectionTitle title="人物画像" action={<span className="quiet-label">只展示已记录的信息</span>} />{sections.length ? sections.map((section) => <div className="profile-section" key={section.title}><h3>{section.title}</h3><div className="profile-facts">{section.facts.map((fact) => <div className="profile-fact" key={fact.key}><span className="profile-fact-label">{fact.label}</span><strong>{displayProfileValue(fact.value)}</strong></div>)}</div></div>) : <div className="profile-empty">还没有记录人物画像。导师可在服务反馈中用自然语言补充。</div>}</section>
}

function LegacyFeedbackForm({ appointment, customer, database, onClose, onSubmit, onGenerateSummary }: { appointment: Appointment; customer: Customer; database: Database; onClose: () => void; onSubmit: (feedback: FeedbackInput) => void | Promise<void>; onGenerateSummary: (input: FeedbackDraftInput) => Promise<{ summary: string; currentStatus: string; nextStep: string }> }) {
  const [step, setStep] = useState<'form' | 'review'>('form')
  const [topic, setTopic] = useState('')
  const [result, setResult] = useState('需要继续关注')
  const [coreNeed, setCoreNeed] = useState(customer.need)
  const [paid, setPaid] = useState(customer.paid)
  const [grade, setGrade] = useState<CustomerGrade>(customer.grade)
  const [course, setCourse] = useState(customer.intendedCourse ?? '')
  const [notes, setNotes] = useState(customer.notes)
  const [aiDraft, setAiDraft] = useState<{ summary: string; currentStatus: string; nextStep: string } | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!topic.trim() || !coreNeed.trim()) return; setAiLoading(true); try { setAiDraft(await onGenerateSummary({ topic: topic.trim(), result, coreNeed: coreNeed.trim(), paid, grade, intendedCourse: course || null, notes: notes.trim(), expectation: customer.helpExpectation })); setStep('review') } finally { setAiLoading(false) } }
  const confirm = () => onSubmit({ appointmentId: appointment.id, topic: topic.trim(), result, coreNeed: coreNeed.trim(), paid, grade, intendedCourse: course || null, notes: notes.trim(), aiSummary: aiDraft?.summary, aiStatus: aiDraft?.currentStatus, aiNextStep: aiDraft?.nextStep })
  return <div className="modal-backdrop"><form className="modal-card form-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose}>×</button>{step === 'form' ? <><div className="eyebrow">FOLLOW-UP FEEDBACK</div><h2>补充跟进反馈</h2><p className="modal-lede">{customer.name} · 先把本次预约的信息补全。</p><label>本次主要聊了什么？<textarea value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="记录本次沟通的核心内容。" autoFocus /></label><label>本次跟进结果<div className="option-grid">{['暂无进一步需求', '需要继续关注', '有课程 / 服务意向', '已付费', '需要其他导师支持'].map((item) => <button type="button" key={item} className={result === item ? 'option-button selected' : 'option-button'} onClick={() => setResult(item)}>{item}</button>)}</div></label><label>当前核心需求<input value={coreNeed} onChange={(event) => setCoreNeed(event.target.value)} /></label><div className="form-two-col"><label>是否付费<select value={paid ? '是' : '否'} onChange={(event) => setPaid(event.target.value === '是')}><option>否</option><option>是</option></select></label><label>SABC<select value={grade} onChange={(event) => setGrade(event.target.value as CustomerGrade)}>{['S', 'A', 'B', 'C'].map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="form-two-col"><label>意向课程<select value={course} onChange={(event) => setCourse(event.target.value)}><option value="">尚未判断</option>{database.products.map((product) => <option key={product.id} value={product.name}>{product.name}</option>)}</select></label><label>备注<input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label></div><button className="primary-button full-width" type="submit" disabled={aiLoading || !topic.trim() || !coreNeed.trim()}>{aiLoading ? '正在整理…' : '生成 AI 整理'} <span>→</span></button></> : <><div className="eyebrow">CONFIRM FEEDBACK</div><h2>确认跟进信息</h2><p className="modal-lede">AI 只提供整理建议，保存前请由导师确认。</p><div className="review-block"><span>跟进后信息整理</span><p>{aiDraft?.summary}</p></div><div className="review-block"><span>当前客户状态</span><p>{aiDraft?.currentStatus}</p></div><div className="review-block"><span>下一步建议</span><p>{aiDraft?.nextStep}</p></div><div className="review-block"><span>将保存的信息</span><p>核心需求：{coreNeed}。付费：{paid ? '是' : '否'}。SABC：{grade}。意向课程：{course || '尚未判断'}。</p></div><div className="review-actions"><button type="button" className="secondary-button" onClick={() => setStep('form')}>返回修改</button><button type="button" className="primary-button" onClick={confirm}>确认并完成 <span>→</span></button></div></>}</form></div>
}


function activeProductForManualEntry(product: Product) { return product.active !== false && product.status === '在售' }

function ManualCustomerDialog({ database, onClose, onPreview, onCreate, onUpdate, onOpenCustomer }: { database: Database; onClose: () => void; onPreview: (input: ManualCustomerInput) => Promise<CustomerDraftPreview>; onCreate: (input: ManualCustomerInput) => Promise<void>; onUpdate: (customerId: string, input: ManualCustomerInput) => Promise<void>; onOpenCustomer: (customerId: string) => void }) {
  const products = database.products.filter(activeProductForManualEntry)
  const [step, setStep] = useState<'form' | 'duplicate'>('form')
  const [nickname, setNickname] = useState('')
  const [phone, setPhone] = useState('')
  const [wechat, setWechat] = useState('')
  const [situation, setSituation] = useState('')
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [productMenuOpen, setProductMenuOpen] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [draft, setDraft] = useState<CustomerDraftPreview>({ duplicates: [], updates: [] })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [voiceHint, setVoiceHint] = useState('')
  const [voiceState, setVoiceState] = useState<'IDLE' | 'LISTENING' | 'RECOVERING' | 'ERROR'>('IDLE')
  const [voiceSupported, setVoiceSupported] = useState<boolean | null>(null)
  const [voicePermission, setVoicePermission] = useState<'UNKNOWN' | 'REQUESTED' | 'DENIED'>('UNKNOWN')
  const [voiceLastEvent, setVoiceLastEvent] = useState('none')
  const [voiceError, setVoiceError] = useState('')
  const operationIdRef = useRef(`customer-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const [isRecording, setIsRecording] = useState(false)
  const recognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null)
  const keepRecordingRef = useRef(false)
  const existingTextRef = useRef('')
  const voiceTextRef = useRef('')
  const speechStateRef = useRef<SpeechTranscriptState>(emptySpeechTranscript())
  const restartCountRef = useRef(0)
  const restartTimerRef = useRef<number | null>(null)
  const input = (): ManualCustomerInput => {
    const enrollments: EnrollmentDraft[] = selectedProductIds.map((productId) => ({ productId }))
    return { operationId: operationIdRef.current, nickname, phone, wechat, situation, needsFollowup: false, mentorId: null, source: '管理员手动录入', caseSource: 'ADMIN_MANUAL', enrollments, confirmedNotSame: step === 'duplicate' && draft.identity?.result === 'POSSIBLE_MATCH' }
  }
  const toggleProduct = (productId: string) => setSelectedProductIds((ids) => ids.includes(productId) ? ids.filter((id) => id !== productId) : [...ids, productId])
  const visibleProducts = products.filter((product) => product.name.toLowerCase().includes(productQuery.trim().toLowerCase()))
  useEffect(() => () => { keepRecordingRef.current = false; if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current); recognitionRef.current?.stop() }, [])
  const toggleVoice = () => {
    if (isRecording) {
      keepRecordingRef.current = false
      setVoiceLastEvent('manual-stop')
      recognitionRef.current?.stop()
      recognitionRef.current = null
      setIsRecording(false)
      setVoiceState('IDLE')
      setVoiceHint('录音已结束。')
      return
    }
    const speechApi = window as Window & { SpeechRecognition?: BrowserSpeechRecognition; webkitSpeechRecognition?: BrowserSpeechRecognition }
    const SpeechRecognition = speechApi.SpeechRecognition || speechApi.webkitSpeechRecognition
    setVoiceSupported(Boolean(SpeechRecognition))
    if (!SpeechRecognition) { setVoiceState('ERROR'); setVoiceError('unsupported'); setVoiceLastEvent('unsupported'); setVoiceHint('当前浏览器不支持语音输入，请直接输入文字。'); return }
    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      setVoiceLastEvent('result')
      const nextSpeechState = applySpeechResults(speechStateRef.current, event.results, event.resultIndex || 0)
      speechStateRef.current = nextSpeechState
      const nextSituation = joinSpeechText(existingTextRef.current, speechTranscriptText(nextSpeechState))
      voiceTextRef.current = nextSituation
      setSituation(nextSituation)
      setVoiceHint('正在录音，文字会实时显示，再次点击结束。')
    }
    recognition.onerror = (event) => {
      const error = event?.error || ''
      setVoiceLastEvent(`error:${error || 'unknown'}`)
      setVoiceError(error)
      setVoiceState('ERROR')
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        setVoicePermission('DENIED')
        keepRecordingRef.current = false
        setIsRecording(false)
        recognitionRef.current = null
        setVoiceHint(speechErrorMessage(error))
        return
      }
      setVoiceHint(speechErrorMessage(error))
    }
    recognition.onend = () => {
      setVoiceLastEvent('end')
      if (keepRecordingRef.current && recognitionRef.current === recognition) {
        existingTextRef.current = joinSpeechText(existingTextRef.current, speechTranscriptText(speechStateRef.current, { finalOnly: true }))
        voiceTextRef.current = existingTextRef.current
        speechStateRef.current = emptySpeechTranscript()
        restartCountRef.current += 1
        if (!shouldRecoverSpeech({ keepListening: keepRecordingRef.current, manualStop: false, permissionDenied: false, restartCount: restartCountRef.current })) {
          keepRecordingRef.current = false
          recognitionRef.current = null
          setIsRecording(false)
          setVoiceState('ERROR')
          setVoiceError('restart-limit')
          setVoiceHint('语音识别多次中断，请再次点击开始或改用文字输入。')
          return
        }
        setVoiceState('RECOVERING')
        setVoiceHint('语音识别正在恢复，请继续说。')
        restartTimerRef.current = window.setTimeout(() => {
          if (!keepRecordingRef.current || recognitionRef.current !== recognition) return
          try { recognition.start(); setVoiceState('LISTENING'); setVoiceLastEvent('restart') } catch { setVoiceLastEvent('restart-failed') }
        }, 250)
        return
      }
      if (recognitionRef.current === recognition) recognitionRef.current = null
      setIsRecording(false)
      setVoiceState('IDLE')
    }
    existingTextRef.current = situation
    voiceTextRef.current = situation
    speechStateRef.current = emptySpeechTranscript()
    restartCountRef.current = 0
    setVoicePermission('REQUESTED')
    setVoiceError('')
    keepRecordingRef.current = true
    recognitionRef.current = recognition
    setIsRecording(true)
    setVoiceState('LISTENING')
    setVoiceLastEvent('start')
    setVoiceHint('正在录音，再次点击结束。')
    try { recognition.start() } catch {
      keepRecordingRef.current = false
      recognitionRef.current = null
      setIsRecording(false)
      setVoiceState('ERROR')
      setVoiceError('start-failed')
      setVoiceHint('语音输入启动失败，请直接输入文字。')
    }
  }
  const preview = async (event: FormEvent) => { event.preventDefault(); if (!canStartCustomerSave(saving)) return; setError(''); setSaving(true); const payload = input(); try { const result = await onPreview(payload); setDraft({ duplicates: result.duplicates, identity: result.identity, updates: [] }); if (result.duplicates.length) setStep('duplicate'); else await onCreate(payload) } catch (submitError) { setError(submitError instanceof Error ? submitError.message : '保存客户失败') } finally { setSaving(false) } }
  const submit = async (payload = input()) => { if (!canStartCustomerSave(saving)) return; setSaving(true); setError(''); try { await onCreate(payload) } catch (submitError) { setError(submitError instanceof Error ? submitError.message : '保存客户失败') } finally { setSaving(false) } }
  const updateExisting = async () => { const match = draft.duplicates[0]; if (!match || !canStartCustomerSave(saving)) return; setSaving(true); setError(''); try { await onUpdate(match.customer.id, input()) } catch (submitError) { setError(submitError instanceof Error ? submitError.message : '更新客户失败') } finally { setSaving(false) } }
  const selectedProductNames = selectedProductIds.map((id) => products.find((product) => product.id === id)?.name).filter(Boolean)
  return <div className="modal-backdrop"><form className="modal-card form-modal" onSubmit={preview}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button>{step === 'form' && <><div className="eyebrow">NEW CUSTOMER</div><h2>新增客户</h2><p className="modal-lede">先录入客户基础信息，课程报名详情可在客户详情页继续维护；新增客户不会自动创建预约。</p><label>客户昵称 *<input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="例如：林知微" autoFocus /></label><div className="form-two-col contact-row"><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" /></label><label>微信号<input value={wechat} onChange={(event) => setWechat(event.target.value)} /></label></div><p className="field-hint contact-hint">手机号和微信号至少填写一项，便于后续联系和客户去重。</p><label>目前已报名课程<div className="multi-select"><button type="button" className="multi-select-trigger" aria-expanded={productMenuOpen} onClick={() => setProductMenuOpen((open) => !open)}>{selectedProductNames.length ? <span className="selected-tags">{selectedProductNames.map((name) => <span className="selected-tag" key={name}>{name}</span>)}</span> : <span className="multi-select-placeholder">请选择已报名课程</span>}<span className="multi-select-chevron">⌄</span></button>{productMenuOpen && <div className="multi-select-menu"><input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder="搜索课程名称" aria-label="搜索课程名称" autoFocus />{visibleProducts.length ? <div className="multi-select-options">{visibleProducts.map((product) => <label className="multi-select-option" key={product.id}><input type="checkbox" checked={selectedProductIds.includes(product.id)} onChange={() => toggleProduct(product.id)} /><span>{product.name}</span></label>)}</div> : <span className="inline-empty">没有找到匹配课程。</span>}</div>}</div>{!products.length && <span className="field-hint">暂无启用课程，请先在「ASVA 产品」中启用课程。</span>}</label><label>客户情况<textarea value={situation} onChange={(event) => setSituation(event.target.value)} placeholder="描述客户当前的困扰、目标或背景。" /><button type="button" className={isRecording ? 'voice-button primary-button full-width recording' : 'voice-button primary-button full-width'} onClick={toggleVoice} aria-pressed={isRecording}><span aria-hidden="true">⌕</span> {isRecording ? '结束录音' : '语音转文字'}</button></label>{voiceHint && <p className="ai-form-note">{voiceHint}</p>}{voiceSupported !== null && <p className="voice-debug" data-testid="voice-debug">语音调试：支持 {voiceSupported ? 'YES' : 'NO'} · 权限 {voicePermission} · 状态 {voiceState} · 最近事件 {voiceLastEvent}{voiceError ? ` · 错误 ${voiceError}` : ''}</p>}{error && <p className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button></div></>}{step === 'duplicate' && <><div className="eyebrow">POSSIBLE DUPLICATE</div><h2>发现可能重复客户</h2><p className="modal-lede">已选课程：{selectedProductNames.join('、') || '无'}。同名只做可能重复提醒；手机号或微信号命中现有客户时必须打开原档案更新。</p>{draft.duplicates.map((match) => <div className="review-block" key={match.customer.id}><strong>{match.customer.name}</strong><span>{match.matchedBy === 'phone' ? '手机号相同' : match.matchedBy === 'wechat' ? '微信号相同' : match.matchedBy === 'nickname_exact' ? '昵称相同' : '昵称相近'} · {match.customer.need || '暂无当前困扰'}</span><div className="review-actions"><button type="button" className="secondary-button small" onClick={() => onOpenCustomer(match.customer.id)}>查看客户</button><button type="button" className="secondary-button small" onClick={updateExisting}>更新已有客户</button></div></div>)}{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={() => setStep('form')}>返回修改</button>{draft.identity?.result === 'POSSIBLE_MATCH' && <button type="button" className="primary-button" disabled={saving} onClick={() => submit(input())}>确认不是同一人并保存</button>}</div></>}</form></div>
}

function AssignDialog({ appointment, database, staffId, api, onClose, onAssign }: { appointment: Appointment; database: Database; staffId: string; api: WorkbenchApi; onClose: () => void; onAssign: (appointment: Appointment, mentorId: string) => Promise<void> }) {
  const [mentors, setMentors] = useState<Staff[]>([])
  const [mentorId, setMentorId] = useState(appointment.assignedMentorId ?? '')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const customer = database.customers.find((item) => item.id === appointment.customerId)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.teamSnapshot(staffId, 'ACTIVE').then((items) => {
      if (cancelled) return
      const liveMentors = items.map((item) => item.mentor).filter((mentor) => mentor.status === 'ACTIVE')
      setMentors(liveMentors)
      setMentorId((current) => current && liveMentors.some((mentor) => mentor.id === current) ? current : liveMentors[0]?.id ?? '')
    }).catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : '读取可分配导师失败') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [api, staffId])
  const submit = async () => { if (!mentorId || submitting) return; setSubmitting(true); setError(''); try { await onAssign(appointment, mentorId) } catch (submitError) { setError(submitError instanceof Error ? submitError.message : '分配失败') } finally { setSubmitting(false) } }
  return <div className="modal-backdrop" onMouseDown={() => { if (!submitting) onClose() }}><section className="modal-card compact-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={onClose} disabled={submitting}>×</button><div className="eyebrow">ASSIGN MENTOR</div><h2>{appointment.assignedMentorId ? '更换导师' : '分配导师'}</h2><p className="modal-lede">为 <strong>{customer?.name}</strong> 选择负责导师。分配后会写入预约和客户当前导师。</p>{loading ? <div className="inline-empty">正在读取最新的 ACTIVE 导师…</div> : mentors.length ? <><div className="mentor-choice-list">{mentors.map((mentor) => <button type="button" key={mentor.id} className={`mentor-choice ${mentor.id === mentorId ? 'selected' : ''}`} disabled={submitting} onClick={() => setMentorId(mentor.id)}><Avatar staff={mentor} /><span><strong>{mentor.name}</strong><small>{mentor.specialty || '导师'}</small></span><span className="choice-check">{mentor.id === mentorId ? '✓' : ''}</span></button>)}</div>{appointment.status === 'WAIT_FEEDBACK' && <p className="panel-note">该预约已进入待反馈，更换导师只调整后续业务归属，不会回退流程状态。</p>}{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" disabled={!mentorId || submitting} aria-busy={submitting} onClick={() => void submit()}>{submitting && <ButtonSpinner />}{submitting ? (appointment.assignedMentorId ? '更换中…' : '分配中…') : <>确认{appointment.assignedMentorId ? '更换' : '分配'} <span>→</span></>}</button></> : <div className="inline-empty">{error || '当前没有可分配的 ACTIVE 导师。'}</div>}</section></div>
}

function MePage({ staff, database, panel, onPanel, api, onLogout }: { staff: Staff; database: Database; panel: MePanel; onPanel: (panel: MePanel) => void; api: WorkbenchApi; onLogout: () => void }) {
  const isAdmin = staff.permissionRole === 'ADMIN'
  return <div className="me-page"><div className="profile-hero"><Avatar staff={staff} size="lg" /><div><div className="eyebrow">MY ACCOUNT</div><h1>{staff.name}</h1><p>{roleName(staff)} · {staff.specialty}</p></div></div><div className="me-switcher"><button className={panel === 'account' ? 'active' : ''} onClick={() => onPanel('account')}>账号信息</button>{isAdmin && <button className={panel === 'team' ? 'active' : ''} onClick={() => onPanel('team')}>导师管理</button>}</div>{panel === 'account' && <AccountPanel staff={staff} database={database} api={api} />}{panel === 'team' && isAdmin && <TeamPanel staffId={staff.id} database={database} api={api} />}<button className="logout-button" onClick={onLogout}>退出当前账号</button></div>
}

function AccountPanel({ staff, database, api }: { staff: Staff; database: Database; api: WorkbenchApi }) {
  const [open, setOpen] = useState(false)
  return <><section className="surface settings-card"><div className="settings-row"><span>显示身份</span><Badge tone="blue">{roleName(staff)}</Badge></div><div className="settings-row"><span>权限角色</span><strong>{staff.permissionRole}</strong></div><div className="settings-row"><span>可查看客户</span><strong>{staff.permissionRole === 'MENTOR' ? `${database.customers.length} 位分配客户` : '全部客户'}</strong></div><div className="settings-row"><span>数据权限</span><small>{staff.permissionRole === 'MENTOR' ? '仅自己的预约、客户与服务记录' : '全部预约、客户、导师与看板'}</small></div><div className="settings-row"><span>登录安全</span><button className="secondary-button small" type="button" onClick={() => setOpen(true)}>修改个人密码</button></div></section>{open && <SelfPasswordDialog api={api} onClose={() => setOpen(false)} />}</>
}

function maskPhone(phone: string) { return phone.length >= 7 ? phone.slice(0, 3) + '****' + phone.slice(-4) : phone }

function TeamPanel({ staffId, database, api }: { staffId: string; database: Database; api: WorkbenchApi }) {
  const [teams, setTeams] = useState<Awaited<ReturnType<WorkbenchApi['teamSnapshot']>> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formMentor, setFormMentor] = useState<Staff | 'create' | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>[number] | null>(null)
  const [resetTarget, setResetTarget] = useState<Staff | null>(null)
  const [error, setError] = useState('')

  const reload = async () => {
    setError('')
    try {
      const items = await api.teamSnapshot(staffId)
      setTeams(items)
      setSelectedId((current) => current && items.some((item) => item.mentor.id === current) ? current : items[0]?.mentor.id ?? null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取导师列表失败')
    }
  }

  useEffect(() => { void reload() }, [api, staffId])

  const selected = teams?.find((item) => item.mentor.id === selectedId)
  const save = async (input: { name: string; phone: string }) => {
    if (formMentor === 'create') await api.createMentor(staffId, input)
    else if (formMentor) await api.updateMentor(staffId, formMentor.id, input)
    setFormMentor(null)
    await reload()
  }
  const deactivate = async () => {
    if (!deactivateTarget) return
    await api.deactivateMentor(staffId, deactivateTarget.mentor.id)
    setDeactivateTarget(null)
    await reload()
  }

  if (!teams) return <div className="management-panel"><p>{error || '正在读取团队数据…'}</p></div>
  return <div className="management-panel">
    <SectionTitle title="导师管理" action={<button className="primary-button small" type="button" onClick={() => setFormMentor('create')}>新增导师</button>} />
    {error && <p className="form-error">{error}</p>}
    <p className="panel-note">手机号暂不开放导师登录，仅用于业务归属。停用会关闭新分配，不删除历史客户与服务记录。</p>
    <div className="team-list">{teams.map((item) => <button type="button" key={item.mentor.id} className={'team-row ' + (selectedId === item.mentor.id ? 'selected' : '')} onClick={() => setSelectedId(item.mentor.id)}>
      <Avatar staff={item.mentor} size="sm" />
      <span><strong>{item.mentor.name}</strong><small>{maskPhone(item.mentor.phone)} · 负责客户 {item.customerCount}</small></span>
      <span className="team-counts"><Badge tone={item.mentor.status === 'ACTIVE' ? 'green' : 'neutral'}>{item.mentor.status === 'ACTIVE' ? '在职' : '已停用'}</Badge><b>{item.waitFollowUp}</b><small>待跟进</small><b>{item.waitFeedback}</b><small>待反馈</small></span>
    </button>)}</div>
    {selected && <section className="mentor-detail">
      <div className="mentor-detail-heading"><div><h3>{selected.mentor.name}</h3><p>{selected.mentor.phone} · {selected.mentor.status === 'ACTIVE' ? '可分配，不可登录' : '历史账户，只读'}</p></div><Badge tone={selected.mentor.status === 'ACTIVE' ? 'green' : 'neutral'}>{selected.mentor.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'}</Badge></div>
      <p>待跟进 {selected.waitFollowUp} · 待反馈 {selected.waitFeedback} · 已完成 {selected.completed}</p>
      {database.customers.filter((customer) => customer.mentorId === selected.mentor.id).slice(0, 6).map((customer) => <div className="mini-customer" key={customer.id}><span>{customer.initials}</span><strong>{customer.name}</strong><small>{customer.need}</small></div>)}
      {selected.mentor.status === 'ACTIVE' ? <div className="mentor-actions"><button className="secondary-button small" type="button" onClick={() => setFormMentor(selected.mentor)}>编辑账号</button><button className="secondary-button small" type="button" onClick={() => setResetTarget(selected.mentor)}>重置密码</button><button className="secondary-button small danger-button" type="button" onClick={() => setDeactivateTarget(selected)}>停用账号</button></div> : <small className="mentor-readonly">该账号已停用，保留用于历史记录，不能重新启用或承接新客户。</small>}
    </section>}
    {formMentor && <MentorFormDialog mentor={formMentor === 'create' ? undefined : formMentor} onClose={() => setFormMentor(null)} onSubmit={save} />}
    {resetTarget && <PasswordResetDialog staff={resetTarget} api={api} actorId={staffId} onClose={() => setResetTarget(null)} onComplete={() => { setResetTarget(null); setError('密码已重置；下次登录必须修改个人密码。') }} />}
    {deactivateTarget && <MentorDeactivateDialog snapshot={deactivateTarget} onClose={() => setDeactivateTarget(null)} onConfirm={deactivate} />}
  </div>
}

function PasswordResetDialog({ staff, api, actorId, onClose, onComplete }: { staff: Staff; api: WorkbenchApi; actorId: string; onClose: () => void; onComplete: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); if (password !== confirm) { setError('两次输入的密码不一致'); return } setSaving(true); setError(''); try { await api.resetPassword(actorId, staff.id, password); onComplete() } catch (resetError) { setError(resetError instanceof Error ? resetError.message : '重置密码失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><form className="modal-card compact-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">RESET PASSWORD</div><h2>重置{staff.name}的密码</h2><p className="modal-lede">重置后旧 Session 立即失效，下一次登录必须修改个人密码。{PASSWORD_POLICY_HINT}</p><label>新密码<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>确认新密码<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving && <ButtonSpinner />}{saving ? '重置中…' : '确认重置'}</button></div></form></div>
}

function SelfPasswordDialog({ api, onClose }: { api: WorkbenchApi; onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); if (newPassword !== confirm) { setError('两次输入的新密码不一致'); return } setSaving(true); setError(''); try { await api.changePassword(currentPassword, newPassword); onClose() } catch (changeError) { setError(changeError instanceof Error ? changeError.message : '修改密码失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><form className="modal-card compact-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">CHANGE PASSWORD</div><h2>修改密码</h2><p className="modal-lede">{PASSWORD_POLICY_HINT}</p><label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label><label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><label>确认新密码<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving && <ButtonSpinner />}{saving ? '保存中…' : '保存新密码'}</button></div></form></div>
}

function MentorFormDialog({ mentor, onClose, onSubmit }: { mentor?: Staff; onClose: () => void; onSubmit: (input: { name: string; phone: string }) => Promise<void> }) {
  const [name, setName] = useState(mentor?.name ?? '')
  const [phone, setPhone] = useState(mentor?.phone ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try { await onSubmit({ name: name.trim(), phone: phone.trim() }) } catch (submitError) { setError(submitError instanceof Error ? submitError.message : '保存失败') } finally { setSaving(false) }
  }
  return <div className="modal-backdrop"><form className="modal-card compact-modal form-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">MENTOR ACCOUNT</div><h2>{mentor ? '编辑导师' : '新增导师'}</h2><p className="modal-lede">只需填写昵称和手机号。手机号不能与其他在职账户重复。</p><label>导师昵称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：王老师" autoFocus /></label><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" placeholder="11 位手机号" /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" type="submit" disabled={saving} aria-busy={saving}>{saving && <ButtonSpinner />}{saving ? '保存中…' : '保存账号'} <span>→</span></button></form></div>
}

function MentorDeactivateDialog({ snapshot, onClose, onConfirm }: { snapshot: Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>[number]; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const blocked = snapshot.waitFollowUp > 0 || snapshot.waitFeedback > 0
  const confirm = async () => { setSaving(true); setError(''); try { await onConfirm() } catch (confirmError) { setError(confirmError instanceof Error ? confirmError.message : '停用失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><section className="modal-card compact-modal"><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">DEACTIVATE ACCOUNT</div><h2>停用{snapshot.mentor.name}？</h2>{blocked ? <><p className="modal-lede">当前不能停用：该导师还有未完成客户。请先把待跟进和待反馈预约重新分配。</p><div className="review-block"><span>待处理数量</span><p>待跟进 {snapshot.waitFollowUp} · 待反馈 {snapshot.waitFeedback}</p></div><button className="secondary-button full-width" type="button" onClick={onClose}>知道了</button></> : <><p className="modal-lede">停用后不能登录，也不会出现在新的导师分配选项中；历史客户和服务记录会保留。</p>{error && <p className="form-error">{error}</p>}<div className="review-actions"><button className="secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="button" disabled={saving} aria-busy={saving} onClick={confirm}>{saving && <ButtonSpinner />}{saving ? '停用中…' : '确认停用'}</button></div></>}</section></div>
}

function DashboardPanel({ staffId, api }: { staffId: string; api: WorkbenchApi }) { const [data, setData] = useState<Awaited<ReturnType<WorkbenchApi['dashboardSnapshot']>> | null>(null); useEffect(() => { let cancelled = false; api.dashboardSnapshot(staffId).then((snapshot) => { if (!cancelled) setData(snapshot) }); return () => { cancelled = true } }, [api, staffId]); if (!data) return <div className="dashboard-panel"><p>正在读取数据看板…</p></div>; const statusItems: Array<[AppointmentWorkflowStatus, string]> = [['WAIT_ASSIGN', '待分配'], ['WAIT_FOLLOW_UP', '待跟进'], ['WAIT_FEEDBACK', '待反馈'], ['COMPLETED', '已完成']]; const maxTrend = Math.max(...data.customerTrend.map((item) => item.value), 1); const maxLoad = Math.max(...data.mentorLoad.map((item) => item.count), 1); return <div className="dashboard-panel"><SectionTitle title="基础数据看板" action={<span className="quiet-label">业务状态</span>} /><div className="board-metrics"><BoardMetric label="客户总数" value={data.customerCount} /><BoardMetric label="本月新增客户" value={data.monthNewCustomers} /><BoardMetric label="本月预约数" value={data.monthAppointments} /><BoardMetric label="本月已完成预约" value={data.monthCompleted} /><BoardMetric label="付费客户数" value={data.paidCustomers} /><BoardMetric label="导师总数" value={data.mentorCount} /></div><section className="chart-card"><h3>预约处理状态</h3><div className="status-bars">{statusItems.map(([status, label]) => <div className="status-bar-row" key={status}><span>{label}</span><div><i className={`bar-${status.toLowerCase()}`} style={{ width: `${Math.max(data.statusCounts[status] * 24, data.statusCounts[status] ? 24 : 0)}px` }} /></div><b>{data.statusCounts[status]}</b></div>)}</div></section><div className="chart-two-col"><section className="chart-card"><h3>客户新增趋势</h3><div className="trend-chart">{data.customerTrend.map((item) => <div className="trend-column" key={item.label}><div className="trend-bar" style={{ height: `${Math.max(item.value / maxTrend * 80, item.value ? 14 : 3)}px` }} /><span>{item.label}月</span><b>{item.value}</b></div>)}</div></section><section className="chart-card"><h3>导师客户量</h3><div className="load-chart">{data.mentorLoad.map((item) => <div className="load-row" key={item.name}><span>{item.name}</span><div><i style={{ width: `${item.count / maxLoad * 100}%` }} /></div><b>{item.count}</b></div>)}</div></section></div></div> }
function BoardMetric({ label, value }: { label: string; value: number }) { return <div className="board-metric"><span>{label}</span><strong>{value}</strong></div> }

function FeedbackForm({ appointment, customer, database: _database, onClose, onSubmit, onGenerateSummary, onGenerateProfile }: { appointment: Appointment; customer: Customer; database: Database; onClose: () => void; onSubmit: (feedback: FeedbackInput) => void | Promise<void>; onGenerateSummary: (input: FeedbackDraftInput) => Promise<{ summary: string; currentStatus: string; nextStep: string }>; onGenerateProfile: (customerId: string, text: string) => Promise<ProfileDraft> }) {
  const [step, setStep] = useState<'form' | 'review'>('form')
  const [situation, setSituation] = useState('')
  const [profileText, setProfileText] = useState('')
  const [result, setResult] = useState('继续跟进')
  const [aiDraft, setAiDraft] = useState<{ summary: string; currentStatus: string; nextStep: string } | null>(null)
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ updates: [] })
  const [aiLoading, setAiLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const startVoice = () => {
    const speechApi = window as Window & { SpeechRecognition?: BrowserSpeechRecognition; webkitSpeechRecognition?: BrowserSpeechRecognition }
    const SpeechRecognition = speechApi.SpeechRecognition || speechApi.webkitSpeechRecognition
    if (!SpeechRecognition) { setVoiceError('当前浏览器暂不支持语音输入，请直接输入文字。'); return }
    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.onresult = (event) => setProfileText((value) => `${value}${value ? ' ' : ''}${event.results[0][0].transcript}`)
    recognition.onerror = () => setVoiceError('没有识别到清晰语音，请改用文字补充。')
    setVoiceError('正在听，请说说客户现在的情况…')
    recognition.start()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!situation.trim() && !profileText.trim()) return
    setAiLoading(true)
    setVoiceError('')
    try {
      const input = { topic: situation.trim() || profileText.trim(), result, coreNeed: customer.need, paid: customer.paid, grade: customer.grade, intendedCourse: customer.intendedCourse, notes: situation.trim(), expectation: customer.helpExpectation }
      const [summary, profile] = await Promise.all([onGenerateSummary(input), profileText.trim() ? onGenerateProfile(customer.id, profileText.trim()) : Promise.resolve({ updates: [] })])
      setAiDraft(summary)
      setProfileDraft(profile)
      setStep('review')
    } finally { setAiLoading(false) }
  }
  const finish = async (updates: ProfileUpdate[]) => { if (saving) return; setSaving(true); setSaveError(''); try { await onSubmit({ appointmentId: appointment.id, topic: situation.trim() || profileText.trim() || '本次沟通', result, coreNeed: customer.need, paid: customer.paid, grade: customer.grade, intendedCourse: customer.intendedCourse, notes: situation.trim(), profileText: profileText.trim(), profileUpdates: updates, aiSummary: aiDraft?.summary, aiStatus: aiDraft?.currentStatus, aiNextStep: aiDraft?.nextStep }) } catch (saveErrorValue) { setSaveError(saveErrorValue instanceof Error ? saveErrorValue.message : '保存服务记录失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><form className="modal-card form-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button>{step === 'form' ? <><div className="eyebrow">SERVICE RECORD</div><h2>记录本次沟通</h2><p className="modal-lede">{customer.name} · 用几句话记录事实，AI 帮你整理。</p><label>本次主要聊了什么？<textarea value={situation} onChange={(event) => setSituation(event.target.value)} placeholder="例如：客户说最近工作压力变大，想先把每天的节奏稳住。" autoFocus /></label><label>说说这个客户现在的情况<small className="field-hint">可以输入，也可以使用浏览器支持的语音输入。</small><textarea value={profileText} onChange={(event) => setProfileText(event.target.value)} placeholder="例如：36 岁，住在杭州，从事设计，已婚，有一个女儿，喜欢瑜伽和旅行。" /><button type="button" className="secondary-button small voice-button" onClick={startVoice} disabled={aiLoading || saving}>⌕ 语音输入</button>{voiceError && <small className="voice-note">{voiceError}</small>}</label><label>本次结果<div className="option-grid">{['继续跟进', '暂时结束', '有课程 / 服务意向', '需要转介'].map((item) => <button type="button" key={item} className={result === item ? 'option-button selected' : 'option-button'} disabled={aiLoading || saving} onClick={() => setResult(item)}>{item}</button>)}</div></label><button className="primary-button full-width" type="submit" disabled={aiLoading || saving || (!situation.trim() && !profileText.trim())} aria-busy={aiLoading}>{aiLoading && <ButtonSpinner />}{aiLoading ? '正在整理…' : '生成 AI 整理'} <span>→</span></button></> : <><div className="eyebrow">CONFIRM RECORD</div><h2>确认本次整理</h2><p className="modal-lede">AI 只提供整理建议；画像更新在你确认后才会写入客户档案。</p>{saveError && <p className="form-error">{saveError}</p>}<div className="review-block"><span>本次总结</span><p>{aiDraft?.summary}</p></div><div className="review-block"><span>当前客户状态</span><p>{aiDraft?.currentStatus}</p></div><div className="review-block"><span>下一步跟进建议</span><p>{aiDraft?.nextStep}</p></div><div className="review-block"><span>本次发现 · {profileDraft.updates.length} 项</span>{profileDraft.updates.length ? <div className="profile-update-list">{profileDraft.updates.map((update) => <div className={`profile-update ${update.conflict ? 'conflict' : ''}`} key={update.field}><strong>{profileUpdateLabel(update)}</strong><span>{update.conflict ? `${displayProfileValue(update.previousValue ?? null)} → ` : ''}{displayProfileValue(update.value)}</span><small>{profileSourceLabel(update.source || 'MENTOR_OBSERVATION')} · {update.conflict ? '与已有记录不同，请确认' : '待确认'}</small></div>)}</div> : <p>没有识别到新的画像信息，本次只保存服务记录。</p>}</div><div className="review-actions"><button type="button" className="secondary-button" onClick={() => setStep('form')} disabled={saving}>返回修改</button><button type="button" className="secondary-button" onClick={() => void finish([])} disabled={saving}>{saving && <ButtonSpinner />}忽略画像更新</button><button type="button" className="primary-button" onClick={() => void finish(profileDraft.updates)} disabled={saving} aria-busy={saving}>{saving && <ButtonSpinner />}{saving ? '保存中…' : '全部确认并完成'} <span>→</span></button></div></>}</form></div>
}

function ProfileChangeHistory({ changes }: { changes: Database['profileChanges'] }) { const sorted = [...changes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); return <section className="customer-detail-section"><SectionHeading title="档案变更历史" meta={`${sorted.length} 条`} icon="↺" />{sorted.length ? <div className="history-timeline">{sorted.map((change) => <article className="history-event" key={change.id}><time>{detailDate(change.updatedAt)}</time><span className="history-dot" /><div><div className="history-event-title"><strong>{change.fieldName || change.field}</strong></div><small>{sourceLabel(change.source)} · {change.confirmed ? '已确认' : '待确认'}</small><p>{displayProfileValue(change.newValue) || '已清空'}</p></div></article>)}</div> : <div className="detail-empty-line">还没有档案变更记录。</div>}</section> }

export default function App() { return <HashRouter><WorkbenchApp /></HashRouter> }
