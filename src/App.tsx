import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createGuardedLocalApi, createLocalApi } from './api'
import type { Appointment, AppointmentWorkflowStatus, Customer, CustomerGrade, CustomerDraftPreview, Database, EnrollmentDraft, FeedbackInput, ManualCustomerInput, ProfileDraft, ProfileUpdate, ProfileValue, Product, Staff } from './domain'
import { createLocalRepository } from './repositories'
import { createHttpApi, createLocalAsyncApi, type FeedbackDraftInput, type WorkbenchApi } from './clientApi'
import { assembleCustomerContext, briefToText, createLocalBrief, createLocalCoreSummary, type AiBrief, type AiCoreSummary } from './customer-ai'
import { displayProfileValue, PROFILE_SECTIONS, profileSourceLabel, profileUpdateLabel } from './profile'
import { GlobalAIAssistant } from './GlobalAIAssistant'
const repository = createLocalRepository()
const api = createLocalApi(repository)
const remoteBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
const workbenchApi: WorkbenchApi = remoteBaseUrl ? createHttpApi(remoteBaseUrl) : createLocalAsyncApi(createGuardedLocalApi(repository))

type View = 'home' | 'customers' | 'me'
type MePanel = 'account' | 'team'
type CustomerFilter = '待处理' | '待跟进' | '已完成'

const statusLabel: Record<AppointmentWorkflowStatus, string> = { WAIT_ASSIGN: '待分配', WAIT_FOLLOW_UP: '待跟进', WAIT_FEEDBACK: '待反馈', COMPLETED: '已完成' }
const statusTone: Record<AppointmentWorkflowStatus, 'amber' | 'blue' | 'rose' | 'green'> = { WAIT_ASSIGN: 'amber', WAIT_FOLLOW_UP: 'blue', WAIT_FEEDBACK: 'rose', COMPLETED: 'green' }
const statusRank: Record<AppointmentWorkflowStatus, number> = { WAIT_ASSIGN: 0, WAIT_FOLLOW_UP: 1, WAIT_FEEDBACK: 2, COMPLETED: 3 }
type BrowserSpeechResult = ArrayLike<{ transcript: string }> & { isFinal?: boolean }
type BrowserSpeechRecognitionInstance = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((event: { results: ArrayLike<BrowserSpeechResult> }) => void) | null; onerror: ((event?: { error?: string }) => void) | null; onend: (() => void) | null }
type BrowserSpeechRecognition = new () => BrowserSpeechRecognitionInstance

function Avatar({ staff, size = 'md' }: { staff?: Staff; size?: 'sm' | 'md' | 'lg' }) { return <span className={`avatar avatar-${size}`}>{staff?.avatar ?? '客'}</span> }
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'rose' | 'dark' }) { return <span className={`badge badge-${tone}`}>{children}</span> }
function ButtonSpinner() { return <span className="button-spinner" aria-hidden="true" /> }
function GradeBadge({ grade }: { grade: CustomerGrade }) { return <span className={`grade grade-${grade}`}>{grade}</span> }
function SectionTitle({ title, action }: { title: string; action?: ReactNode }) { return <div className="section-title"><h2>{title}</h2>{action}</div> }
function roleName(staff: Staff) { return staff.permissionRole === 'MENTOR' ? '导师' : '管理员' }
function workflowStatus(appointment: Appointment): AppointmentWorkflowStatus { return appointment.status as AppointmentWorkflowStatus }

function Login({ api, onLogin }: { api: WorkbenchApi; onLogin: (staffId: string) => void }) {
  const [phone, setPhone] = useState('15021512537')
  const [code, setCode] = useState('888888')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); setLoading(true); setError(''); try { const account = await api.login(phone.trim(), code.trim()); onLogin(account.id) } catch (loginError) { setError(loginError instanceof Error ? loginError.message : '登录失败') } finally { setLoading(false) } }
  return <main className="login-page"><div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" /><section className="login-card"><div className="brand-lockup"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><div><strong>ASVA</strong><span>客户关怀系统</span></div></div><div className="login-copy"><div className="eyebrow">SERVICE FLOW</div><h1>看见流程，<br /><em>接住客户。</em></h1><p>预约进入，分配导师，完成跟进，再把反馈补全。</p></div><form onSubmit={submit} className="login-form"><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" /></label><label>验证码<div className="code-row"><input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" /><button type="button" className="text-button">获取验证码</button></div></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" type="submit" disabled={loading}>{loading && <ButtonSpinner />}{loading ? '正在验证…' : '进入工作台'} <span>→</span></button></form><div className="login-hint">演示验证码：888888 · 管理员 15021512537</div></section></main>
}

function App() {
  const [loggedInStaffId, setLoggedInStaffId] = useState<string | null>(() => window.localStorage.getItem('asva-demo-staff-v2'))
  const [activeStaffId, setActiveStaffId] = useState(() => window.localStorage.getItem('asva-demo-staff-v2') ?? 'staff-founder')
  const [view, setView] = useState<View>('home')
  const [mePanel, setMePanel] = useState<MePanel>('account')
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>('C00001298')
  const [assignAppointmentId, setAssignAppointmentId] = useState<string | null>(null)
  const [feedbackAppointmentId, setFeedbackAppointmentId] = useState<string | null>(null)
  const [manualCustomerOpen, setManualCustomerOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [database, setDatabase] = useState<Database | null>(() => {
    if (remoteBaseUrl) return null
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
    if (loggedInStaffId && database && activeStaff.permissionRole !== 'ADMIN') {
      window.localStorage.removeItem('asva-demo-staff-v2')
      setLoggedInStaffId(null)
      setActiveStaffId('staff-founder')
    }
  }, [activeStaff, database, loggedInStaffId])

  if (!loggedInStaffId) return <Login api={workbenchApi} onLogin={(id) => { window.localStorage.setItem('asva-demo-staff-v2', id); setLoggedInStaffId(id); setActiveStaffId(id) }} />
  if (activeStaff.permissionRole !== 'ADMIN') return <Login api={workbenchApi} onLogin={(id) => { window.localStorage.setItem('asva-demo-staff-v2', id); setLoggedInStaffId(id); setActiveStaffId(id) }} />
  if (!database) return <main className="login-page"><section className="login-card"><div className="eyebrow">ASVA API</div><h1>正在连接工作台</h1><p>{loadError || '正在读取飞书预约和客户数据。'}</p>{loadError && <button className="primary-button full-width" onClick={() => setRevision((value) => value + 1)}>重新连接</button>}</section></main>
  const selectedCustomer = database.customers.find((item) => item.id === selectedCustomerId) ?? database.customers[0]
  const assignAppointment = database.appointments.find((item) => item.id === assignAppointmentId)
  const feedbackAppointment = database.appointments.find((item) => item.id === feedbackAppointmentId)
  const refresh = () => setRevision((value) => value + 1)
  const openCustomer = (id: string) => { setSelectedCustomerId(id); setView('customers') }
  const assign = async (appointment: Appointment, mentorId: string) => { await workbenchApi.assignAppointment(activeStaff.id, appointment.id, mentorId); setAssignAppointmentId(null); refresh() }
  const completeFollowup = async (appointmentId: string) => { await workbenchApi.markFollowupDone(activeStaff.id, appointmentId); setFeedbackAppointmentId(appointmentId); refresh() }
  const saveFeedback = async (feedback: FeedbackInput) => { await workbenchApi.saveFeedback(activeStaff.id, feedback); setFeedbackAppointmentId(null); refresh() }
  const generateServiceSummary = (input: FeedbackDraftInput) => workbenchApi.serviceSummary(activeStaff.id, input)
  const generateProfile = (customerId: string, text: string) => workbenchApi.profileDraft(activeStaff.id, customerId, text)
  const confirmProfile = (customerId: string, updates: ProfileUpdate[]) => workbenchApi.confirmProfile(activeStaff.id, customerId, updates).then((saved) => { refresh(); return saved })
  const generateBrief = (input: { name: string; need: string; expectation: string }) => workbenchApi.brief(activeStaff.id, input)
  const generateIntelligence = (customer: Customer, currentDatabase: Database) => workbenchApi.customerIntelligence(activeStaff.id, { context: assembleCustomerContext(currentDatabase, customer.id) })
  const saveBrief = (customerId: string, brief: string) => workbenchApi.saveBrief(activeStaff.id, customerId, brief)
  const saveReferrer = (customerId: string, referrerName: string) => workbenchApi.updateCustomerReferrer(activeStaff.id, customerId, referrerName).then((saved) => { refresh(); return saved })
  const saveManualCustomer = async (input: ManualCustomerInput) => { const saved = await workbenchApi.createCustomer(activeStaff.id, input); setManualCustomerOpen(false); setDatabase(saved); refresh() }
  const previewManualCustomer = (input: ManualCustomerInput): Promise<CustomerDraftPreview> => workbenchApi.previewCustomer(activeStaff.id, input)
  const updateExistingCustomer = async (customerId: string, input: ManualCustomerInput) => { const saved = await workbenchApi.updateCustomer(activeStaff.id, customerId, input); setManualCustomerOpen(false); setDatabase(saved); refresh() }

  return <div className="app-shell"><aside className="side-rail"><div className="brand-lockup app-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><div><strong>ASVA</strong><span>客户关怀系统</span></div></div><nav className="side-nav">{([['home', '首页', '今'], ['customers', '客户', '客'], ['me', '我的', '我']] as Array<[View, string, string]>).map(([id, label, marker]) => <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => setView(id)}><span className="nav-marker">{marker}</span>{label}</button>)}</nav><div className="rail-bottom"><div className="rail-note"><span>当前视图</span><strong>{canSeeAll ? '导师 AI 工作台' : '我的客户流程'}</strong></div><button className="profile-chip" onClick={() => setView('me')}><Avatar staff={activeStaff} size="sm" /><span><strong>{activeStaff.name}</strong><small>{roleName(activeStaff)}</small></span><span className="chevron">⌄</span></button></div></aside><main className="main-content"><header className="topbar"><div className="mobile-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><span className="mobile-brand-copy"><strong>ASVA</strong><small>客户关怀系统</small></span></div><div className="topbar-right"><button className="avatar-button" aria-label="打开我的页面" onClick={() => setView('me')}><Avatar staff={activeStaff} /></button></div></header><div className="page-content">{view === 'home' && <HomePage staff={activeStaff} database={database} canSeeAll={canSeeAll} api={workbenchApi} onCustomer={openCustomer} onAssign={(id) => setAssignAppointmentId(id)} onComplete={completeFollowup} onFeedback={(id) => { setSelectedCustomerId(database.appointments.find((item) => item.id === id)?.customerId ?? null); setFeedbackAppointmentId(id) }} />}{view === 'customers' && <CustomersPage staff={activeStaff} database={database} canSeeAll={canSeeAll} selectedCustomer={selectedCustomer} onSelect={openCustomer} onAssign={(id) => setAssignAppointmentId(id)} onComplete={completeFollowup} onFeedback={(id) => setFeedbackAppointmentId(id)} onGenerateBrief={generateBrief} onGenerateIntelligence={generateIntelligence} onSaveBrief={saveBrief} onSaveReferrer={saveReferrer} onGenerateProfile={generateProfile} onConfirmProfile={confirmProfile} onAddCustomer={() => setManualCustomerOpen(true)} />}{view === 'me' && <MePage staff={activeStaff} database={database} panel={mePanel} onPanel={setMePanel} api={workbenchApi} onLogout={() => { window.localStorage.removeItem('asva-demo-staff-v2'); setLoggedInStaffId(null) }} />}</div></main><nav className="bottom-nav">{([['home', '首页', '今'], ['customers', '客户', '客'], ['me', '我的', '我']] as Array<[View, string, string]>).map(([id, label, marker]) => <button key={id} className={view === id ? 'bottom-item active' : 'bottom-item'} onClick={() => setView(id)}><span>{marker}</span>{label}</button>)}</nav>{assignAppointment && <AssignDialog appointment={assignAppointment} database={database} staffId={activeStaff.id} api={workbenchApi} onClose={() => setAssignAppointmentId(null)} onAssign={assign} />}{feedbackAppointment && <FeedbackForm appointment={feedbackAppointment} customer={database.customers.find((item) => item.id === feedbackAppointment.customerId)!} database={database} onClose={() => setFeedbackAppointmentId(null)} onSubmit={saveFeedback} onGenerateSummary={generateServiceSummary} onGenerateProfile={generateProfile} />}{manualCustomerOpen && <ManualCustomerDialog database={database} onClose={() => setManualCustomerOpen(false)} onPreview={previewManualCustomer} onCreate={saveManualCustomer} onUpdate={updateExistingCustomer} onOpenCustomer={(id) => { setManualCustomerOpen(false); openCustomer(id) }} />}<GlobalAIAssistant api={workbenchApi} staffId={activeStaff.id} customerId={selectedCustomerId ?? undefined} onCustomer={openCustomer} /></div>
}

function HomePage({ staff, database, canSeeAll, api, onCustomer, onAssign, onComplete, onFeedback }: { staff: Staff; database: Database; canSeeAll: boolean; api: WorkbenchApi; onCustomer: (id: string) => void; onAssign: (id: string) => void; onComplete: (id: string) => Promise<void>; onFeedback: (id: string) => void }) {
  const [completingId, setCompletingId] = useState<string | null>(null)
  const complete = async (id: string) => { if (completingId) return; setCompletingId(id); try { await onComplete(id) } finally { setCompletingId(null) } }
  const appointments = database.appointments.filter((item) => workflowStatus(item) !== 'COMPLETED').sort((a, b) => statusRank[workflowStatus(a)] - statusRank[workflowStatus(b)] || a.createdAt.localeCompare(b.createdAt)).filter((item) => canSeeAll || workflowStatus(item) !== 'WAIT_ASSIGN')
  const counts = { WAIT_ASSIGN: appointments.filter((item) => workflowStatus(item) === 'WAIT_ASSIGN').length, WAIT_FOLLOW_UP: appointments.filter((item) => workflowStatus(item) === 'WAIT_FOLLOW_UP').length, WAIT_FEEDBACK: appointments.filter((item) => workflowStatus(item) === 'WAIT_FEEDBACK').length }
  return <div className="home-page"><div className="welcome-row"><div><div className="eyebrow">WORKFLOW</div><h1>{canSeeAll ? '客户关怀系统' : '我的流程'}<span className="period">。</span></h1><p className="page-lede">{canSeeAll ? `还有 ${appointments.length} 个预约流程待处理。` : `还有 ${appointments.length} 个分配给你的预约待处理。`}</p></div></div><ResourceBanners /><div className="state-summary"><StateCount label="待分配" value={counts.WAIT_ASSIGN} tone="amber" hidden={!canSeeAll} /><StateCount label="待跟进" value={counts.WAIT_FOLLOW_UP} tone="blue" /><StateCount label="待反馈" value={counts.WAIT_FEEDBACK} tone="rose" /></div><section className="surface task-surface"><SectionTitle title="待处理" action={<span className="quiet-label">按流程顺序</span>} />{appointments.length === 0 ? <div className="clear-state"><strong>当前没有未完成预约</strong><span>新的预约会从待分配开始。</span></div> : <div className="task-list">{appointments.map((appointment) => { const customer = database.customers.find((item) => item.id === appointment.customerId); if (!customer) return null; const status = workflowStatus(appointment); const mentor = database.staff.find((item) => item.id === appointment.assignedMentorId); const isCompleting = completingId === appointment.id; return <div className="workflow-row" key={appointment.id}><button className="workflow-main" onClick={() => onCustomer(customer.id)}><span className="workflow-avatar">{customer.initials}</span><span><strong>{customer.name}</strong><small>{appointment.topic} · <Badge tone={statusTone[status]}>{statusLabel[status]}</Badge>{canSeeAll && mentor && <> · {mentor.name}</>}</small></span></button>{status === 'WAIT_ASSIGN' && canSeeAll ? <button className="secondary-button small" onClick={() => onAssign(appointment.id)}>去分配</button> : status === 'WAIT_FOLLOW_UP' && !canSeeAll ? <button className="secondary-button small" disabled={isCompleting} onClick={() => void complete(appointment.id)}>{isCompleting && <ButtonSpinner />}{isCompleting ? '完成中…' : '完成跟进'}</button> : status === 'WAIT_FEEDBACK' ? <button className="secondary-button small" onClick={() => onFeedback(appointment.id)}>补充反馈</button> : <button className="row-arrow" onClick={() => onCustomer(customer.id)}>→</button>}</div> })}</div>}</section><div className="flow-note"><span>状态流</span><strong>待分配 → 待跟进 → 待反馈 → 已完成</strong></div>{canSeeAll && <section className="home-dashboard"><DashboardPanel staffId={staff.id} api={api} /></section>}</div>
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

function CustomersPage({ staff, database, canSeeAll, selectedCustomer, onSelect, onAssign, onComplete, onFeedback, onGenerateBrief, onGenerateIntelligence, onSaveBrief, onSaveReferrer, onGenerateProfile, onConfirmProfile, onAddCustomer }: { staff: Staff; database: Database; canSeeAll: boolean; selectedCustomer?: Customer; onSelect: (id: string) => void; onAssign: (id: string) => void; onComplete: (id: string) => Promise<void>; onFeedback: (id: string) => void; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onGenerateIntelligence: (customer: Customer, database: Database) => Promise<{ summary: AiCoreSummary; brief: AiBrief }>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined>; onGenerateProfile: (customerId: string, text: string) => Promise<ProfileDraft>; onConfirmProfile: (customerId: string, updates: ProfileUpdate[]) => Promise<Customer>; onAddCustomer: () => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CustomerFilter>('待处理')
  const list = database.customers.filter((customer) => customerFilter(customer, database) === filter && `${customer.name}${customer.need}`.includes(query))
  return <div className="customer-page"><div className="customer-list-column"><div className="page-heading"><div><div className="eyebrow">CUSTOMERS</div><h1>客户</h1><p>{canSeeAll ? '查看所有客户与客户服务档案。' : `${staff.name} 负责的客户。`}</p></div><button className="primary-button small" type="button" onClick={onAddCustomer}>新增客户</button></div><label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索昵称或主要问题" /></label><div className="filter-row customer-filters">{(['待处理', '待跟进', '已完成'] as CustomerFilter[]).map((item) => <button key={item} className={`filter-pill ${filter === item ? 'active' : ''}`} onClick={() => setFilter(item)}>{item}<span>{database.customers.filter((customer) => customerFilter(customer, database) === item).length}</span></button>)}</div><div className="customer-list">{list.map((customer) => { const appointment = appointmentForCustomer(customer.id, database); const mentor = database.staff.find((item) => item.id === customer.mentorId); return <button key={customer.id} className={`customer-list-item ${selectedCustomer?.id === customer.id ? 'selected' : ''}`} onClick={() => onSelect(customer.id)}><span className="customer-avatar">{customer.initials}</span><span className="customer-list-main"><strong>{customer.name}<Badge tone={appointment ? statusTone[workflowStatus(appointment)] : 'neutral'}>{appointment ? statusLabel[workflowStatus(appointment)] : '无待处理'}</Badge></strong><span>{(appointment?.topic ?? customer.need) || '尚未记录当前困扰'}</span><small>{canSeeAll && mentor ? `${mentor.name} · ` : ''}{customer.notes || '尚未补充客户档案'}</small></span><span className="list-chevron">›</span></button> })}</div>{list.length === 0 && <div className="list-empty">这个状态下暂时没有客户。</div>}</div>{selectedCustomer ? <CustomerDetail customer={selectedCustomer} database={database} canSeeAll={canSeeAll} onAssign={onAssign} onComplete={onComplete} onFeedback={onFeedback} onGenerateBrief={onGenerateBrief} onGenerateIntelligence={onGenerateIntelligence} onSaveBrief={onSaveBrief} onSaveReferrer={onSaveReferrer} onGenerateProfile={onGenerateProfile} onConfirmProfile={onConfirmProfile} /> : <div className="empty-detail"><span>客</span><h2>选择一位客户</h2><p>从左侧列表打开客户服务档案。</p></div>}</div>
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

type CustomerDetailProps = { customer: Customer; database: Database; canSeeAll: boolean; onAssign: (id: string) => void; onComplete: (id: string) => Promise<void>; onFeedback: (id: string) => void; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onGenerateIntelligence: (customer: Customer, database: Database) => Promise<{ summary: AiCoreSummary; brief: AiBrief }>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined>; onGenerateProfile: (customerId: string, text: string) => Promise<ProfileDraft>; onConfirmProfile: (customerId: string, updates: ProfileUpdate[]) => Promise<Customer> }

const detailProfileCards = [
  { title: '家庭与关系', keys: ['marital_status', 'children_summary', 'family_summary', 'relationship_conflicts', 'support_system'], labels: { marital_status: '关系状态', children_summary: '子女情况', family_summary: '家庭背景', relationship_conflicts: '关系冲突', support_system: '支持系统' } },
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
function customerPaymentLabel(customer: Customer, enrollments: Database['enrollments']) {
  if (!enrollments.length) return customer.paid ? '已付费' : '暂未付费'
  const paid = enrollments.filter((item) => item.paymentStatus === 'PAID' || item.paid).length
  const unrecorded = enrollments.some((item) => !item.paymentStatus || item.paymentStatus === 'UNRECORDED')
  if (paid === enrollments.length && !unrecorded) return '已付费'
  if (paid > 0) return '部分记录缺失'
  return unrecorded ? '部分记录缺失' : '暂未付费'
}
function sourceLabel(source?: string) { return source === 'AI_INFERENCE' ? 'AI推断' : source === 'MENTOR_OBSERVATION' ? '导师观察' : source === 'MENTOR_CONFIRMED' ? '导师确认' : '客户明确表达' }

function CustomerDetail(props: CustomerDetailProps) {
  const { customer, database } = props
  const mentor = database.staff.find((item) => item.id === customer.mentorId)
  const currentCase = activeCustomerCase(customer.id, database)
  const appointments = database.appointments.filter((item) => item.customerId === customer.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const sessions = database.sessions.filter((item) => item.customerId === customer.id).sort((a, b) => b.date.localeCompare(a.date))
  const enrollments = database.enrollments.filter((item) => item.customerId === customer.id && item.status !== 'CANCELLED')
  const courses = enrollments.map((item) => ({ enrollment: item, product: database.products.find((product) => product.id === item.productId) })).filter((item) => item.product)
  const aiContext = assembleCustomerContext(database, customer.id)
  const [aiSummary, setAiSummary] = useState<AiCoreSummary>(() => createLocalCoreSummary(aiContext))
  const [brief, setBrief] = useState<AiBrief>(() => createLocalBrief(aiContext))
  const [briefLoading, setBriefLoading] = useState(false)
  useEffect(() => { const nextContext = assembleCustomerContext(database, customer.id); const nextSummary = createLocalCoreSummary(nextContext); setAiSummary(nextSummary); setBrief(createLocalBrief(nextContext, nextSummary)) }, [customer.id, customer.createdAt, customer.need, customer.goal, customer.helpExpectation, customer.profileUpdatedAt, database.sessions.length, database.profileChanges.length])
  const refreshBrief = async () => { setBriefLoading(true); try { const next = await props.onGenerateIntelligence(customer, database); await props.onSaveBrief(customer.id, briefToText(next.brief)); setAiSummary(next.summary); setBrief(next.brief) } finally { setBriefLoading(false) } }
  const recordService = () => { if (!currentCase) return; if (workflowStatus(currentCase) === 'WAIT_FOLLOW_UP') void props.onComplete(currentCase.id); else if (workflowStatus(currentCase) === 'WAIT_FEEDBACK') props.onFeedback(currentCase.id) }
  const completeness = customerProfileCompleteness(customer, courses.length)
  const activityCount = sessions.length + appointments.length + enrollments.length
  return <article className="customer-detail-page">
    <header className="customer-detail-header">
      <div className="customer-detail-identity"><span className="customer-detail-avatar">{customer.initials}</span><div><div className="customer-detail-name-row"><h1>{customer.name}</h1><GradeBadge grade={customer.grade} /></div><p className="customer-detail-id">{customer.id}</p><div className="customer-meta-row"><span>{customer.source || '历史数据导入'}</span>{mentor && <span>当前导师：{mentor.name}</span>}{customer.referrerName && <span>介绍人：{customer.referrerName}</span>}</div></div></div>
      <div className="customer-detail-status"><Badge tone={currentCase ? statusTone[workflowStatus(currentCase)] : 'neutral'}>{currentCase ? statusLabel[workflowStatus(currentCase)] : '无待处理'}</Badge><small>最近服务：{sessions[0] ? detailDate(sessions[0].date) : '暂无服务'}</small></div>
      <div className="customer-detail-metrics"><DetailMetric label="是否付费" value={customerPaymentLabel(customer, enrollments)} /><DetailMetric label="SABC" value={customer.grade} note={customer.gradeSource} /><DetailMetric label="已报名课程" value={`${courses.length} 门`} /><DetailMetric label="最近服务" value={sessions[0] ? detailDate(sessions[0].date).split(' ')[0] : '暂无'} note={sessions[0]?.topic} /></div>
      <div className="customer-detail-actions"><button className="primary-button" type="button" disabled={!currentCase} onClick={recordService}>记录服务</button><button className="secondary-button" type="button" onClick={() => document.getElementById('profile-supplement')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>更新画像</button>{props.canSeeAll && currentCase && <button className="secondary-button" type="button" onClick={() => props.onAssign(currentCase.id)}>{currentCase.assignedMentorId ? '更换导师' : '分配导师'}</button>}</div>
    </header>
    <section className="customer-detail-section customer-ai-summary"><SectionHeading title="AI 核心摘要" meta="AI生成 · 仅供参考" icon="✦" /><p className="summary-overview">{aiSummary.overview}</p><ul className="summary-bullets">{aiSummary.core_issues.map((item) => <li key={item}>{item}</li>)}</ul><div className="summary-facts"><SummaryFact title="核心困扰" value={aiSummary.core_issues.join('、')} tone="rose" /><SummaryFact title="优先议题" value={aiSummary.priority_topics.join('、')} tone="amber" /><SummaryFact title="当前目标" value={aiSummary.current_goals.join('、')} tone="green" /><SummaryFact title="服务安全风险" value={riskLabel(aiSummary.risk.level)} tone="blue" note={aiSummary.risk.reason} /></div><p className="summary-resource">已有资源：{aiSummary.resources.join('、')} · 信息把握度：{confidenceLabel(aiSummary.confidence)}</p></section>
    <section className="customer-detail-section"><SectionHeading title="人物画像" meta={`已记录 ${completeness}%`} icon="●" action={<span className="section-note">只显示已有数据</span>} /><div className="portrait-grid">{detailProfileCards.map((card) => { const facts = card.keys.map((key) => ({ key, label: card.labels[key as keyof typeof card.labels], value: customer.profileFields?.[key], meta: customer.profileFieldMeta?.[key] })).filter((item) => detailProfileText(item.value) !== ''); return <article className="portrait-card" key={card.title}><h3>{card.title}</h3>{facts.length ? <div className="portrait-facts">{facts.map((fact) => <div key={fact.key}><span>{fact.label}</span><strong>{detailProfileText(fact.value)}</strong>{fact.meta && <small>{sourceLabel(fact.meta.source)}</small>}</div>)}</div> : <span className="portrait-pending">待补充</span>}</article> })}</div></section>
    <CustomerBrief brief={brief} loading={briefLoading} onRefresh={refreshBrief} />
    <CustomerCourseOverview courses={courses} sessions={sessions} completedAppointments={appointments.filter((item) => workflowStatus(item) === 'COMPLETED').length} activityCount={activityCount} completeness={completeness} />
    <CustomerHistory appointments={appointments} sessions={sessions} database={database} />
    <ProfileSupplement customer={customer} onGenerate={props.onGenerateProfile} onConfirm={props.onConfirmProfile} />
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

function CustomerCourseOverview({ courses, sessions, completedAppointments, activityCount, completeness }: { courses: Array<{ enrollment: Database['enrollments'][number]; product?: Product }>; sessions: Database['sessions']; completedAppointments: number; activityCount: number; completeness: number }) { return <section className="customer-detail-section"><SectionHeading title="课程与服务概览" meta="数据来自课程报名与服务记录" icon="▣" action={<span className="section-note">档案完整度 {completeness}%</span>} /><div className="overview-metrics"><DetailMetric label="已报名课程" value={`${courses.length} 门`} /><DetailMetric label="服务次数" value={`${sessions.length} 次`} /><DetailMetric label="已完成预约" value={`${completedAppointments} 次`} /><DetailMetric label="近30天互动" value={activityCount ? `${Math.min(100, activityCount * 20)}%` : '暂无数据'} /></div><div className="enrollment-list">{courses.length ? courses.map(({ enrollment, product }) => <div className="enrollment-row" key={enrollment.id}><div><strong>{product?.name || enrollment.productId}</strong><small>{enrollment.status} · 报名 {detailDate(enrollment.enrolledAt || enrollment.date)}</small></div><span className={enrollment.paymentStatus === 'PAID' || enrollment.paid ? 'enrollment-paid' : 'enrollment-unrecorded'}>{enrollment.paymentStatus === 'PAID' || enrollment.paid ? '已付费' : enrollment.paymentStatus === 'UNPAID' ? '暂未付费' : '未记录'}</span></div>) : <div className="detail-empty-line">暂无报名课程。</div>}</div></section> }

function CustomerHistory({ appointments, sessions, database }: { appointments: Database['appointments']; sessions: Database['sessions']; database: Database }) { const events = [...appointments.map((item) => ({ id: item.id, date: item.createdAt, type: '预约', title: item.topic, body: item.description || item.expectation, status: workflowStatus(item), mentorId: item.assignedMentorId })), ...sessions.map((item) => ({ id: item.id, date: item.date, type: '服务记录', title: item.topic, body: item.aiSummary || item.note, status: undefined, mentorId: item.mentorId }))].sort((a, b) => b.date.localeCompare(a.date)); return <section className="customer-detail-section"><SectionHeading title="历史记录" meta={`${events.length} 条`} icon="◷" action={<span className="history-filter">全部</span>} />{events.length ? <div className="history-timeline">{events.map((event) => { const mentor = database.staff.find((item) => item.id === event.mentorId); return <article className="history-event" key={event.id}><time>{detailDate(event.date)}</time><span className="history-dot" /><div><div className="history-event-title"><strong>{event.title}</strong>{event.status && <Badge tone={statusTone[event.status]}>{statusLabel[event.status]}</Badge>}</div><small>{event.type}{mentor ? ` · ${mentor.name}` : ''}</small><p>{event.body || '暂无详细记录。'}</p></div></article> })}</div> : <div className="detail-empty-line">还没有预约或服务记录。</div>}</section> }

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
  const [needsFollowup, setNeedsFollowup] = useState(true)
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [productMenuOpen, setProductMenuOpen] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [draft, setDraft] = useState<CustomerDraftPreview>({ duplicates: [], updates: [] })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [voiceHint, setVoiceHint] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const recognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null)
  const keepRecordingRef = useRef(false)
  const voiceBaseSituationRef = useRef('')
  const voiceTextRef = useRef('')
  const input = (): ManualCustomerInput => {
    const enrollments: EnrollmentDraft[] = selectedProductIds.map((productId) => ({ productId }))
    return { nickname, phone, wechat, situation, needsFollowup, mentorId: null, source: '管理员手动录入', caseSource: 'ADMIN_MANUAL', enrollments, confirmedNotSame: step === 'duplicate' }
  }
  const toggleProduct = (productId: string) => setSelectedProductIds((ids) => ids.includes(productId) ? ids.filter((id) => id !== productId) : [...ids, productId])
  const visibleProducts = products.filter((product) => product.name.toLowerCase().includes(productQuery.trim().toLowerCase()))
  useEffect(() => () => { keepRecordingRef.current = false; recognitionRef.current?.stop() }, [])
  const toggleVoice = () => {
    if (isRecording) {
      keepRecordingRef.current = false
      recognitionRef.current?.stop()
      recognitionRef.current = null
      setIsRecording(false)
      setVoiceHint('录音已结束。')
      return
    }
    const speechApi = window as Window & { SpeechRecognition?: BrowserSpeechRecognition; webkitSpeechRecognition?: BrowserSpeechRecognition }
    const SpeechRecognition = speechApi.SpeechRecognition || speechApi.webkitSpeechRecognition
    if (!SpeechRecognition) { setVoiceHint('当前浏览器不支持语音输入，请直接输入文字。'); return }
    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      let transcript = ''
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result?.[0]?.transcript?.trim()
        if (text) transcript += `${transcript ? ' ' : ''}${text}`
      }
      if (!transcript) return
      const base = voiceBaseSituationRef.current.trim()
      const nextSituation = `${base}${base ? ' ' : ''}${transcript}`
      voiceTextRef.current = nextSituation
      setSituation(nextSituation)
      setVoiceHint('正在录音，文字会实时显示，再次点击结束。')
    }
    recognition.onerror = (event) => {
      if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
        keepRecordingRef.current = false
        setIsRecording(false)
        recognitionRef.current = null
        setVoiceHint('浏览器没有允许麦克风，请直接输入文字。')
        return
      }
      setVoiceHint('没有识别到清晰语音，请继续说或再次点击结束。')
    }
    recognition.onend = () => {
      if (keepRecordingRef.current && recognitionRef.current === recognition) {
        voiceBaseSituationRef.current = voiceTextRef.current
        window.setTimeout(() => {
          if (!keepRecordingRef.current || recognitionRef.current !== recognition) return
          try { recognition.start() } catch { /* 浏览器仍在切换状态时，等待下一次 end 事件 */ }
        }, 80)
        return
      }
      if (recognitionRef.current === recognition) recognitionRef.current = null
      setIsRecording(false)
    }
    voiceBaseSituationRef.current = situation
    voiceTextRef.current = situation
    keepRecordingRef.current = true
    recognitionRef.current = recognition
    setIsRecording(true)
    setVoiceHint('正在录音，再次点击结束。')
    try { recognition.start() } catch {
      keepRecordingRef.current = false
      recognitionRef.current = null
      setIsRecording(false)
      setVoiceHint('语音输入启动失败，请直接输入文字。')
    }
  }
  const preview = async (event: FormEvent) => { event.preventDefault(); setError(''); setSaving(true); const payload = input(); try { const result = await onPreview(payload); setDraft({ duplicates: result.duplicates, updates: [] }); if (result.duplicates.length) setStep('duplicate'); else await onCreate(payload) } catch (submitError) { setError(submitError instanceof Error ? submitError.message : '保存客户失败') } finally { setSaving(false) } }
  const submit = async (payload = input()) => { setSaving(true); setError(''); try { await onCreate(payload) } catch (submitError) { setError(submitError instanceof Error ? submitError.message : '保存客户失败') } finally { setSaving(false) } }
  const updateExisting = async () => { const match = draft.duplicates[0]; if (!match) return; setSaving(true); setError(''); try { await onUpdate(match.customer.id, input()) } catch (submitError) { setError(submitError instanceof Error ? submitError.message : '更新客户失败') } finally { setSaving(false) } }
  const selectedProductNames = selectedProductIds.map((id) => products.find((product) => product.id === id)?.name).filter(Boolean)
  return <div className="modal-backdrop"><form className="modal-card form-modal" onSubmit={preview}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button>{step === 'form' && <><div className="eyebrow">NEW CUSTOMER</div><h2>新增客户</h2><p className="modal-lede">先录入客户基础信息，课程报名详情可在客户详情页继续维护。</p><label>客户昵称 *<input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="例如：林知微" autoFocus /></label><div className="form-two-col contact-row"><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" /></label><label>微信号<input value={wechat} onChange={(event) => setWechat(event.target.value)} /></label></div><p className="field-hint contact-hint">手机号和微信号至少填写一项，便于后续联系和客户去重。</p><label>目前已报名课程<div className="multi-select"><button type="button" className="multi-select-trigger" aria-expanded={productMenuOpen} onClick={() => setProductMenuOpen((open) => !open)}>{selectedProductNames.length ? <span className="selected-tags">{selectedProductNames.map((name) => <span className="selected-tag" key={name}>{name}</span>)}</span> : <span className="multi-select-placeholder">请选择已报名课程</span>}<span className="multi-select-chevron">⌄</span></button>{productMenuOpen && <div className="multi-select-menu"><input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder="搜索课程名称" aria-label="搜索课程名称" autoFocus />{visibleProducts.length ? <div className="multi-select-options">{visibleProducts.map((product) => <label className="multi-select-option" key={product.id}><input type="checkbox" checked={selectedProductIds.includes(product.id)} onChange={() => toggleProduct(product.id)} /><span>{product.name}</span></label>)}</div> : <span className="inline-empty">没有找到匹配课程。</span>}</div>}</div>{!products.length && <span className="field-hint">暂无启用课程，请先在「ASVA 产品」中启用课程。</span>}</label><label>客户情况<textarea value={situation} onChange={(event) => setSituation(event.target.value)} placeholder="描述客户当前的困扰、目标或背景。" /><button type="button" className={isRecording ? 'voice-button primary-button full-width recording' : 'voice-button primary-button full-width'} onClick={toggleVoice} aria-pressed={isRecording}><span aria-hidden="true">⌕</span> {isRecording ? '结束录音' : '语音转文字'}</button></label>{voiceHint && <p className="ai-form-note">{voiceHint}</p>}<label className="check-line"><input type="checkbox" checked={needsFollowup} onChange={(event) => setNeedsFollowup(event.target.checked)} /> 需要安排跟进</label>{error && <p className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button></div></>}{step === 'duplicate' && <><div className="eyebrow">POSSIBLE DUPLICATE</div><h2>发现可能重复客户</h2><p className="modal-lede">已选课程：{selectedProductNames.join('、') || '无'}。确认后会把课程基础关系合并到已有档案。</p>{draft.duplicates.map((match) => <div className="review-block" key={match.customer.id}><strong>{match.customer.name}</strong><span>{match.matchedBy === 'phone' ? '手机号相同' : match.matchedBy === 'wechat' ? '微信号相同' : match.matchedBy === 'nickname_exact' ? '昵称相同' : '昵称相近'} · {match.customer.need || '暂无当前困扰'}</span><div className="review-actions"><button type="button" className="secondary-button small" onClick={() => onOpenCustomer(match.customer.id)}>查看客户</button><button type="button" className="secondary-button small" onClick={updateExisting}>更新已有客户</button></div></div>)}{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={() => setStep('form')}>返回修改</button><button type="button" className="primary-button" disabled={saving} onClick={() => submit(input())}>确认不是同一人并保存</button></div></>}</form></div>
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
  return <div className="me-page"><div className="profile-hero"><Avatar staff={staff} size="lg" /><div><div className="eyebrow">MY ACCOUNT</div><h1>{staff.name}</h1><p>{roleName(staff)} · {staff.specialty}</p></div></div><div className="me-switcher"><button className={panel === 'account' ? 'active' : ''} onClick={() => onPanel('account')}>账号信息</button>{isAdmin && <button className={panel === 'team' ? 'active' : ''} onClick={() => onPanel('team')}>导师管理</button>}</div>{panel === 'account' && <AccountPanel staff={staff} database={database} />}{panel === 'team' && isAdmin && <TeamPanel staffId={staff.id} database={database} api={api} />}<button className="logout-button" onClick={onLogout}>退出当前账号</button></div>
}

function AccountPanel({ staff, database }: { staff: Staff; database: Database }) { return <section className="surface settings-card"><div className="settings-row"><span>显示身份</span><Badge tone="blue">{roleName(staff)}</Badge></div><div className="settings-row"><span>权限角色</span><strong>{staff.permissionRole}</strong></div><div className="settings-row"><span>可查看客户</span><strong>{staff.permissionRole === 'MENTOR' ? `${database.customers.length} 位分配客户` : '全部客户'}</strong></div><div className="settings-row"><span>数据权限</span><small>{staff.permissionRole === 'MENTOR' ? '仅自己的预约、客户与服务记录' : '全部预约、客户、导师与看板'}</small></div></section> }

function maskPhone(phone: string) { return phone.length >= 7 ? phone.slice(0, 3) + '****' + phone.slice(-4) : phone }

function TeamPanel({ staffId, database, api }: { staffId: string; database: Database; api: WorkbenchApi }) {
  const [teams, setTeams] = useState<Awaited<ReturnType<WorkbenchApi['teamSnapshot']>> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formMentor, setFormMentor] = useState<Staff | 'create' | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>[number] | null>(null)
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
      {selected.mentor.status === 'ACTIVE' ? <div className="mentor-actions"><button className="secondary-button small" type="button" onClick={() => setFormMentor(selected.mentor)}>编辑账号</button><button className="secondary-button small danger-button" type="button" onClick={() => setDeactivateTarget(selected)}>停用账号</button></div> : <small className="mentor-readonly">该账号已停用，保留用于历史记录，不能重新启用或承接新客户。</small>}
    </section>}
    {formMentor && <MentorFormDialog mentor={formMentor === 'create' ? undefined : formMentor} onClose={() => setFormMentor(null)} onSubmit={save} />}
    {deactivateTarget && <MentorDeactivateDialog snapshot={deactivateTarget} onClose={() => setDeactivateTarget(null)} onConfirm={deactivate} />}
  </div>
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

export default App
