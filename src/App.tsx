import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLocalApi } from './api'
import type { Appointment, AppointmentWorkflowStatus, Customer, CustomerGrade, Database, FeedbackInput, ProfileDraft, ProfileUpdate, Staff } from './domain'
import { createLocalRepository } from './repositories'
import { createHttpApi, createLocalAsyncApi, type FeedbackDraftInput, type WorkbenchApi } from './clientApi'
import { displayProfileValue, PROFILE_SECTIONS, profileSourceLabel, profileUpdateLabel } from './profile'

const repository = createLocalRepository()
const api = createLocalApi(repository)
const remoteBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
const workbenchApi: WorkbenchApi = remoteBaseUrl ? createHttpApi(remoteBaseUrl) : createLocalAsyncApi(api)

type View = 'home' | 'customers' | 'me'
type MePanel = 'account' | 'team'
type CustomerFilter = '待处理' | '跟进中' | '已完成'

const statusLabel: Record<AppointmentWorkflowStatus, string> = { WAIT_ASSIGN: '待分配', FOLLOWING: '跟进中', WAIT_FEEDBACK: '待反馈', COMPLETED: '已完成' }
const statusTone: Record<AppointmentWorkflowStatus, 'amber' | 'blue' | 'rose' | 'green'> = { WAIT_ASSIGN: 'amber', FOLLOWING: 'blue', WAIT_FEEDBACK: 'rose', COMPLETED: 'green' }
const statusRank: Record<AppointmentWorkflowStatus, number> = { WAIT_ASSIGN: 0, FOLLOWING: 1, WAIT_FEEDBACK: 2, COMPLETED: 3 }
type BrowserSpeechRecognition = new () => { lang: string; start: () => void; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null }

function Avatar({ staff, size = 'md' }: { staff?: Staff; size?: 'sm' | 'md' | 'lg' }) { return <span className={`avatar avatar-${size}`}>{staff?.avatar ?? '客'}</span> }
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'rose' | 'dark' }) { return <span className={`badge badge-${tone}`}>{children}</span> }
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
  return <main className="login-page"><div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" /><section className="login-card"><div className="brand-lockup"><span className="brand-mark">A</span><div><strong>ASVA</strong><span>成长服务工作台</span></div></div><div className="login-copy"><div className="eyebrow">SERVICE FLOW</div><h1>看见流程，<br /><em>接住客户。</em></h1><p>预约进入，分配导师，完成跟进，再把反馈补全。</p></div><form onSubmit={submit} className="login-form"><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" /></label><label>验证码<div className="code-row"><input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" /><button type="button" className="text-button">获取验证码</button></div></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" type="submit" disabled={loading}>{loading ? '正在验证…' : '进入工作台'} <span>→</span></button></form><div className="login-hint">演示验证码：888888 · 管理员 15021512537 · 导师 15021512539</div></section></main>
}

function App() {
  const [loggedInStaffId, setLoggedInStaffId] = useState<string | null>(() => window.localStorage.getItem('asva-demo-staff-v2'))
  const [activeStaffId, setActiveStaffId] = useState(() => window.localStorage.getItem('asva-demo-staff-v2') ?? 'staff-founder')
  const [view, setView] = useState<View>('home')
  const [mePanel, setMePanel] = useState<MePanel>('account')
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>('C00001298')
  const [assignAppointmentId, setAssignAppointmentId] = useState<string | null>(null)
  const [feedbackAppointmentId, setFeedbackAppointmentId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [database, setDatabase] = useState<Database | null>(() => remoteBaseUrl ? null : api.dashboard(activeStaffId))
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

  if (!loggedInStaffId) return <Login api={workbenchApi} onLogin={(id) => { window.localStorage.setItem('asva-demo-staff-v2', id); setLoggedInStaffId(id); setActiveStaffId(id) }} />
  if (!database) return <main className="login-page"><section className="login-card"><div className="eyebrow">ASVA API</div><h1>正在连接工作台</h1><p>{loadError || '正在读取飞书预约和客户数据。'}</p>{loadError && <button className="primary-button full-width" onClick={() => setRevision((value) => value + 1)}>重新连接</button>}</section></main>
  const selectedCustomer = database.customers.find((item) => item.id === selectedCustomerId) ?? database.customers[0]
  const assignAppointment = database.appointments.find((item) => item.id === assignAppointmentId)
  const feedbackAppointment = database.appointments.find((item) => item.id === feedbackAppointmentId)
  const refresh = () => setRevision((value) => value + 1)
  const openCustomer = (id: string) => { setSelectedCustomerId(id); setView('customers') }
  const assign = async (appointment: Appointment, mentorId: string) => { await workbenchApi.assignAppointment(activeStaff.id, appointment.id, mentorId); setAssignAppointmentId(null); refresh() }
  const completeFollowup = async (appointmentId: string) => { await workbenchApi.markFollowupDone(activeStaff.id, appointmentId); setFeedbackAppointmentId(appointmentId); refresh() }
  const saveFeedback = async (feedback: FeedbackInput) => { await workbenchApi.saveFeedback(activeStaff.id, feedback); setFeedbackAppointmentId(null); refresh() }
  const generateServiceSummary = (input: FeedbackDraftInput) => workbenchApi.serviceSummary(input)
  const generateProfile = (customerId: string, text: string) => workbenchApi.profileDraft(activeStaff.id, customerId, text)
  const generateBrief = (input: { name: string; need: string; expectation: string }) => workbenchApi.brief(input)
  const saveBrief = (customerId: string, brief: string) => workbenchApi.saveBrief(activeStaff.id, customerId, brief)
  const saveReferrer = (customerId: string, referrerName: string) => workbenchApi.updateCustomerReferrer(activeStaff.id, customerId, referrerName).then((saved) => { refresh(); return saved })

  return <div className="app-shell"><aside className="side-rail"><div className="brand-lockup app-brand"><span className="brand-mark">A</span><div><strong>ASVA</strong><span>工作台</span></div></div><div className="rail-context"><span className="live-dot" /> 状态工作流</div><nav className="side-nav">{([['home', '首页', '今'], ['customers', '客户', '客'], ['me', '我的', '我']] as Array<[View, string, string]>).map(([id, label, marker]) => <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => setView(id)}><span className="nav-marker">{marker}</span>{label}</button>)}</nav><div className="rail-bottom"><div className="rail-note"><span>当前视图</span><strong>{canSeeAll ? '全局预约流程' : '我的客户流程'}</strong></div><button className="profile-chip" onClick={() => setView('me')}><Avatar staff={activeStaff} size="sm" /><span><strong>{activeStaff.name}</strong><small>{roleName(activeStaff)}</small></span><span className="chevron">⌄</span></button></div></aside><main className="main-content"><header className="topbar"><div className="mobile-brand"><span className="brand-mark">A</span><strong>ASVA</strong></div><div className="topbar-right"><div className="role-switch"><span>当前身份</span><select value={activeStaff.id} onChange={(event) => { setActiveStaffId(event.target.value); setView('home') }}>{database.staff.filter((staff) => staff.status === 'ACTIVE').map((staff) => <option key={staff.id} value={staff.id}>{staff.name} · {roleName(staff)}</option>)}</select></div><button className="avatar-button" aria-label="打开我的页面" onClick={() => setView('me')}><Avatar staff={activeStaff} /></button></div></header><div className="page-content">{view === 'home' && <HomePage staff={activeStaff} database={database} canSeeAll={canSeeAll} api={workbenchApi} onCustomer={openCustomer} onAssign={(id) => setAssignAppointmentId(id)} onComplete={completeFollowup} onFeedback={(id) => { setSelectedCustomerId(database.appointments.find((item) => item.id === id)?.customerId ?? null); setFeedbackAppointmentId(id) }} />}{view === 'customers' && <CustomersPage staff={activeStaff} database={database} canSeeAll={canSeeAll} selectedCustomer={selectedCustomer} onSelect={openCustomer} onAssign={(id) => setAssignAppointmentId(id)} onComplete={completeFollowup} onFeedback={(id) => setFeedbackAppointmentId(id)} onGenerateBrief={generateBrief} onSaveBrief={saveBrief} onSaveReferrer={saveReferrer} />}{view === 'me' && <MePage staff={activeStaff} database={database} panel={mePanel} onPanel={setMePanel} api={workbenchApi} onLogout={() => { window.localStorage.removeItem('asva-demo-staff-v2'); setLoggedInStaffId(null) }} />}</div></main><nav className="bottom-nav">{([['home', '首页', '今'], ['customers', '客户', '客'], ['me', '我的', '我']] as Array<[View, string, string]>).map(([id, label, marker]) => <button key={id} className={view === id ? 'bottom-item active' : 'bottom-item'} onClick={() => setView(id)}><span>{marker}</span>{label}</button>)}</nav>{assignAppointment && <AssignDialog appointment={assignAppointment} database={database} onClose={() => setAssignAppointmentId(null)} onAssign={assign} />}{feedbackAppointment && <FeedbackForm appointment={feedbackAppointment} customer={database.customers.find((item) => item.id === feedbackAppointment.customerId)!} database={database} onClose={() => setFeedbackAppointmentId(null)} onSubmit={saveFeedback} onGenerateSummary={generateServiceSummary} onGenerateProfile={generateProfile} />}</div>
}

function HomePage({ staff, database, canSeeAll, api, onCustomer, onAssign, onComplete, onFeedback }: { staff: Staff; database: Database; canSeeAll: boolean; api: WorkbenchApi; onCustomer: (id: string) => void; onAssign: (id: string) => void; onComplete: (id: string) => void; onFeedback: (id: string) => void }) {
  const appointments = database.appointments.filter((item) => workflowStatus(item) !== 'COMPLETED').sort((a, b) => statusRank[workflowStatus(a)] - statusRank[workflowStatus(b)] || a.createdAt.localeCompare(b.createdAt)).filter((item) => canSeeAll || workflowStatus(item) !== 'WAIT_ASSIGN')
  const counts = { WAIT_ASSIGN: appointments.filter((item) => workflowStatus(item) === 'WAIT_ASSIGN').length, FOLLOWING: appointments.filter((item) => workflowStatus(item) === 'FOLLOWING').length, WAIT_FEEDBACK: appointments.filter((item) => workflowStatus(item) === 'WAIT_FEEDBACK').length }
  return <div className="home-page"><div className="welcome-row"><div><div className="eyebrow">WORKFLOW</div><h1>{canSeeAll ? '全局流程' : '我的流程'}<span className="period">。</span></h1><p className="page-lede">{canSeeAll ? `还有 ${appointments.length} 个预约流程待处理。` : `还有 ${appointments.length} 个分配给你的预约待处理。`}</p></div></div><div className="state-summary"><StateCount label="待分配" value={counts.WAIT_ASSIGN} tone="amber" hidden={!canSeeAll} /><StateCount label="跟进中" value={counts.FOLLOWING} tone="blue" /><StateCount label="待反馈" value={counts.WAIT_FEEDBACK} tone="rose" /></div><section className="surface task-surface"><SectionTitle title="待处理" action={<span className="quiet-label">按流程顺序</span>} />{appointments.length === 0 ? <div className="clear-state"><strong>当前没有未完成预约</strong><span>新的预约会从待分配开始。</span></div> : <div className="task-list">{appointments.map((appointment) => { const customer = database.customers.find((item) => item.id === appointment.customerId); if (!customer) return null; const status = workflowStatus(appointment); const mentor = database.staff.find((item) => item.id === appointment.assignedMentorId); return <div className="workflow-row" key={appointment.id}><button className="workflow-main" onClick={() => onCustomer(customer.id)}><span className="workflow-avatar">{customer.initials}</span><span><strong>{customer.name}</strong><small>{appointment.topic} · <Badge tone={statusTone[status]}>{statusLabel[status]}</Badge>{canSeeAll && mentor && <> · {mentor.name}</>}</small></span></button>{status === 'WAIT_ASSIGN' && canSeeAll ? <button className="secondary-button small" onClick={() => onAssign(appointment.id)}>去分配</button> : status === 'FOLLOWING' && !canSeeAll ? <button className="secondary-button small" onClick={() => onComplete(appointment.id)}>完成跟进</button> : status === 'WAIT_FEEDBACK' ? <button className="secondary-button small" onClick={() => onFeedback(appointment.id)}>补充反馈</button> : <button className="row-arrow" onClick={() => onCustomer(customer.id)}>→</button>}</div> })}</div>}</section><div className="flow-note"><span>状态流</span><strong>待分配 → 跟进中 → 待反馈 → 已完成</strong></div>{canSeeAll && <section className="home-dashboard"><DashboardPanel staffId={staff.id} api={api} /></section>}</div>
}

function StateCount({ label, value, tone, hidden = false }: { label: string; value: number; tone: string; hidden?: boolean }) { if (hidden) return null; return <div className={`state-count state-${tone}`}><span>{label}</span><strong>{value}</strong></div> }

function appointmentForCustomer(customerId: string, database: Database) { return database.appointments.filter((item) => item.customerId === customerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] }
function customerFilter(customer: Customer, database: Database): CustomerFilter { const appointment = appointmentForCustomer(customer.id, database); if (!appointment || workflowStatus(appointment) === 'COMPLETED') return '已完成'; if (workflowStatus(appointment) === 'FOLLOWING') return '跟进中'; return '待处理' }

function CustomersPage({ staff, database, canSeeAll, selectedCustomer, onSelect, onAssign, onComplete, onFeedback, onGenerateBrief, onSaveBrief, onSaveReferrer }: { staff: Staff; database: Database; canSeeAll: boolean; selectedCustomer?: Customer; onSelect: (id: string) => void; onAssign: (id: string) => void; onComplete: (id: string) => void; onFeedback: (id: string) => void; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined> }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CustomerFilter>('待处理')
  const list = database.customers.filter((customer) => customerFilter(customer, database) === filter && `${customer.name}${customer.need}`.includes(query))
  return <div className="customer-page"><div className="customer-list-column"><div className="page-heading"><div><div className="eyebrow">CUSTOMERS</div><h1>客户</h1><p>{canSeeAll ? '查看所有预约流程中的客户。' : `${staff.name} 负责的客户。`}</p></div></div><label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索昵称或主要问题" /></label><div className="filter-row customer-filters">{(['待处理', '跟进中', '已完成'] as CustomerFilter[]).map((item) => <button key={item} className={`filter-pill ${filter === item ? 'active' : ''}`} onClick={() => setFilter(item)}>{item}<span>{database.customers.filter((customer) => customerFilter(customer, database) === item).length}</span></button>)}</div><div className="customer-list">{list.map((customer) => { const appointment = appointmentForCustomer(customer.id, database); const mentor = database.staff.find((item) => item.id === customer.mentorId); return <button key={customer.id} className={`customer-list-item ${selectedCustomer?.id === customer.id ? 'selected' : ''}`} onClick={() => onSelect(customer.id)}><span className="customer-avatar">{customer.initials}</span><span className="customer-list-main"><strong>{customer.name}<Badge tone={statusTone[appointment ? workflowStatus(appointment) : 'COMPLETED']}>{appointment ? statusLabel[workflowStatus(appointment)] : '已完成'}</Badge></strong><span>{appointment?.topic ?? customer.need}</span><small>{canSeeAll && mentor ? `${mentor.name} · ` : ''}{customer.notes || '暂无备注'}</small></span><span className="list-chevron">›</span></button> })}</div>{list.length === 0 && <div className="list-empty">这个状态下暂时没有客户。</div>}</div>{selectedCustomer ? <CustomerDetail customer={selectedCustomer} database={database} canSeeAll={canSeeAll} onAssign={onAssign} onComplete={onComplete} onFeedback={onFeedback} onGenerateBrief={onGenerateBrief} onSaveBrief={onSaveBrief} onSaveReferrer={onSaveReferrer} /> : <div className="empty-detail"><span>客</span><h2>选择一位客户</h2><p>从左侧列表打开客户服务信息。</p></div>}</div>
}

function CustomerDetail({ customer, database, canSeeAll, onAssign, onComplete, onFeedback, onGenerateBrief, onSaveBrief, onSaveReferrer }: { customer: Customer; database: Database; canSeeAll: boolean; onAssign: (id: string) => void; onComplete: (id: string) => void; onFeedback: (id: string) => void; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined> }) {
  const mentor = database.staff.find((item) => item.id === customer.mentorId)
  const appointments = database.appointments.filter((item) => item.customerId === customer.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const current = appointments[0]
  const sessions = database.sessions.filter((item) => item.customerId === customer.id).slice(0, 3)
  const profile = database.profiles.find((item) => item.customerId === customer.id)
  const [brief, setBrief] = useState(customer.brief)
  const [briefLoading, setBriefLoading] = useState(false)
  const [referrerName, setReferrerName] = useState(customer.referrerName)
  const [referrerEditing, setReferrerEditing] = useState(false)
  const [referrerSaving, setReferrerSaving] = useState(false)
  const [referrerError, setReferrerError] = useState('')
  useEffect(() => { setBrief(customer.brief) }, [customer.id, customer.brief])
  useEffect(() => { setReferrerName(customer.referrerName); setReferrerEditing(false); setReferrerError('') }, [customer.id, customer.referrerName])
  const loadBrief = async () => { setBriefLoading(true); try { const nextBrief = await onGenerateBrief({ name: customer.name, need: customer.need, expectation: customer.helpExpectation }); await onSaveBrief(customer.id, nextBrief); setBrief(nextBrief) } finally { setBriefLoading(false) } }
  const saveReferrer = async () => { setReferrerSaving(true); setReferrerError(''); try { const saved = await onSaveReferrer(customer.id, referrerName); if (saved) { setReferrerName(saved.referrerName); setReferrerEditing(false) } } catch (error) { setReferrerError(error instanceof Error ? error.message : '保存失败') } finally { setReferrerSaving(false) } }
  return <div className="detail-column"><div className="detail-header"><div className="detail-identity"><span className="detail-avatar">{customer.initials}</span><div><h1>{customer.name}<GradeBadge grade={customer.grade} /></h1><p>{customer.phone} · {mentor ? `当前导师：${mentor.name}` : '待分配导师'}</p></div></div><div className="detail-actions">{canSeeAll && current && workflowStatus(current) !== 'COMPLETED' && <button className="secondary-button" onClick={() => onAssign(current.id)}>{current.assignedMentorId ? '更换导师' : '分配导师'}</button>}{current && workflowStatus(current) === 'FOLLOWING' && <button className="primary-button" onClick={() => onComplete(current.id)}>完成跟进</button>}{current && workflowStatus(current) === 'WAIT_FEEDBACK' && <button className="primary-button" onClick={() => onFeedback(current.id)}>补充反馈</button>}</div></div><div className="detail-body"><section className="detail-section basic-section"><SectionTitle title="基础信息" action={current && <Badge tone={statusTone[workflowStatus(current)]}>{statusLabel[workflowStatus(current)]}</Badge>} /><div className="basic-grid"><div><span>客户 ID</span><strong>{customer.id}</strong></div><div><span>是否付费</span><strong>{customer.paid ? '是' : '暂未'}</strong></div><div><span>SABC</span><strong><GradeBadge grade={customer.grade} /> <small>{customer.gradeSource}</small></strong></div><div><span>意向课程</span><strong>{customer.intendedCourse ?? '尚未判断'}</strong></div></div><div className="referrer-row"><div><span>介绍人</span>{canSeeAll && referrerEditing ? <input value={referrerName} onChange={(event) => setReferrerName(event.target.value)} placeholder="填写介绍人" aria-label="介绍人" /> : <strong>{referrerName || '未填写'}</strong>}{referrerError && <small className="referrer-error">{referrerError}</small>}</div>{canSeeAll && (referrerEditing ? <div className="referrer-actions"><button className="secondary-button small" type="button" onClick={() => { setReferrerName(customer.referrerName); setReferrerEditing(false) }}>取消</button><button className="primary-button small" type="button" disabled={referrerSaving} onClick={saveReferrer}>{referrerSaving ? '保存中…' : '保存'}</button></div> : <button className="secondary-button small" type="button" onClick={() => setReferrerEditing(true)}>编辑</button>)}</div></section>{profile && <ProfileOverview profile={profile} />}<div className="detail-two-col"><section className="detail-section"><div className="card-kicker">当前困扰</div><h2 className="detail-copy">{customer.need}</h2></section><section className="detail-section"><div className="card-kicker">希望获得帮助</div><h2 className="detail-copy">{customer.helpExpectation}</h2></section></div><section className="brief-section"><div className="brief-label"><span>✦</span> AI 接待前 Brief <small>辅助信息</small></div>{brief ? <p>{brief}</p> : <div className="brief-empty"><p>当前还没有生成 Brief。</p><button className="secondary-button small" type="button" disabled={briefLoading} onClick={loadBrief}>{briefLoading ? '正在生成…' : '生成接待前 Brief'}</button></div>}<div className="brief-columns"><div><span>已确认</span>{customer.confirmedFacts.slice(0, 3).map((fact) => <p key={fact}>＋ {fact}</p>)}</div><div><span>待确认</span>{customer.aiQuestions.length ? customer.aiQuestions.slice(0, 2).map((fact) => <p key={fact}>？ {fact}</p>) : <p>暂无</p>}</div></div></section><section className="detail-section"><SectionTitle title="历史预约" />{appointments.map((appointment) => <div className="history-row" key={appointment.id}><span>{appointment.topic}</span><Badge tone={statusTone[workflowStatus(appointment)]}>{statusLabel[workflowStatus(appointment)]}</Badge></div>)}</section><section className="detail-section"><SectionTitle title="历史服务记录" />{sessions.length ? sessions.map((session) => <article className="service-record" key={session.id}><div className="service-record-top"><Badge tone="blue">{session.type}</Badge><span>{session.duration ? `${session.duration} 分钟` : '跟进反馈'}</span></div><strong>{session.topic}</strong><p>{session.note}</p>{session.aiSummary && <div className="record-summary"><span>✦ 辅助总结</span>{session.aiSummary}</div>}</article>) : <div className="inline-empty">还没有服务记录。</div>}</section><section className="detail-section note-section"><div className="card-kicker">备注</div><p>{customer.notes || '暂无备注。'}</p></section></div></div>
}

function ProfileOverview({ profile }: { profile: NonNullable<Database['profiles']>[number] }) {
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

function AssignDialog({ appointment, database, onClose, onAssign }: { appointment: Appointment; database: Database; onClose: () => void; onAssign: (appointment: Appointment, mentorId: string) => void }) { const mentors = database.staff.filter((item) => item.permissionRole === 'MENTOR' && item.status === 'ACTIVE'); const [mentorId, setMentorId] = useState(appointment.assignedMentorId ?? mentors[0]?.id ?? ''); const customer = database.customers.find((item) => item.id === appointment.customerId); return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal-card compact-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={onClose}>×</button><div className="eyebrow">ASSIGN MENTOR</div><h2>{appointment.assignedMentorId ? '更换导师' : '分配导师'}</h2><p className="modal-lede">为 <strong>{customer?.name}</strong> 选择负责导师。分配后状态会进入“跟进中”。</p>{mentors.length ? <><div className="mentor-choice-list">{mentors.map((mentor) => <button type="button" key={mentor.id} className={`mentor-choice ${mentor.id === mentorId ? 'selected' : ''}`} onClick={() => setMentorId(mentor.id)}><Avatar staff={mentor} /><span><strong>{mentor.name}</strong><small>{mentor.specialty || '导师'}</small></span><span className="choice-check">{mentor.id === mentorId ? '✓' : ''}</span></button>)}</div><button className="primary-button full-width" disabled={!mentorId} onClick={() => onAssign(appointment, mentorId)}>确认分配 <span>→</span></button></> : <div className="inline-empty">当前没有可分配的 ACTIVE 导师。</div>}</section></div> }

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
    <p className="panel-note">手机号用于登录。停用只会关闭登录和新分配，不删除历史客户与服务记录。</p>
    <div className="team-list">{teams.map((item) => <button type="button" key={item.mentor.id} className={'team-row ' + (selectedId === item.mentor.id ? 'selected' : '')} onClick={() => setSelectedId(item.mentor.id)}>
      <Avatar staff={item.mentor} size="sm" />
      <span><strong>{item.mentor.name}</strong><small>{maskPhone(item.mentor.phone)} · 负责客户 {item.customerCount}</small></span>
      <span className="team-counts"><Badge tone={item.mentor.status === 'ACTIVE' ? 'green' : 'neutral'}>{item.mentor.status === 'ACTIVE' ? '在职' : '已停用'}</Badge><b>{item.following}</b><small>跟进中</small><b>{item.waitFeedback}</b><small>待反馈</small></span>
    </button>)}</div>
    {selected && <section className="mentor-detail">
      <div className="mentor-detail-heading"><div><h3>{selected.mentor.name}</h3><p>{selected.mentor.phone} · {selected.mentor.status === 'ACTIVE' ? '可登录、可分配' : '历史账户，只读'}</p></div><Badge tone={selected.mentor.status === 'ACTIVE' ? 'green' : 'neutral'}>{selected.mentor.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'}</Badge></div>
      <p>跟进中 {selected.following} · 待反馈 {selected.waitFeedback} · 已完成 {selected.completed}</p>
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
  return <div className="modal-backdrop"><form className="modal-card compact-modal form-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose}>×</button><div className="eyebrow">MENTOR ACCOUNT</div><h2>{mentor ? '编辑导师' : '新增导师'}</h2><p className="modal-lede">只需填写昵称和手机号。手机号不能与其他在职账户重复。</p><label>导师昵称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：王老师" autoFocus /></label><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" placeholder="11 位手机号" /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" type="submit" disabled={saving}>{saving ? '保存中…' : '保存账号'} <span>→</span></button></form></div>
}

function MentorDeactivateDialog({ snapshot, onClose, onConfirm }: { snapshot: Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>[number]; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const blocked = snapshot.following > 0 || snapshot.waitFeedback > 0
  const confirm = async () => { setSaving(true); setError(''); try { await onConfirm() } catch (confirmError) { setError(confirmError instanceof Error ? confirmError.message : '停用失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><section className="modal-card compact-modal"><button type="button" className="modal-close" onClick={onClose}>×</button><div className="eyebrow">DEACTIVATE ACCOUNT</div><h2>停用{snapshot.mentor.name}？</h2>{blocked ? <><p className="modal-lede">当前不能停用：该导师还有未完成客户。请先把跟进中和待反馈预约重新分配。</p><div className="review-block"><span>待处理数量</span><p>跟进中 {snapshot.following} · 待反馈 {snapshot.waitFeedback}</p></div><button className="secondary-button full-width" type="button" onClick={onClose}>知道了</button></> : <><p className="modal-lede">停用后不能登录，也不会出现在新的导师分配选项中；历史客户和服务记录会保留。</p>{error && <p className="form-error">{error}</p>}<div className="review-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={saving} onClick={confirm}>{saving ? '停用中…' : '确认停用'}</button></div></>}</section></div>
}

function DashboardPanel({ staffId, api }: { staffId: string; api: WorkbenchApi }) { const [data, setData] = useState<Awaited<ReturnType<WorkbenchApi['dashboardSnapshot']>> | null>(null); useEffect(() => { let cancelled = false; api.dashboardSnapshot(staffId).then((snapshot) => { if (!cancelled) setData(snapshot) }); return () => { cancelled = true } }, [api, staffId]); if (!data) return <div className="dashboard-panel"><p>正在读取数据看板…</p></div>; const statusItems: Array<[AppointmentWorkflowStatus, string]> = [['WAIT_ASSIGN', '待分配'], ['FOLLOWING', '跟进中'], ['WAIT_FEEDBACK', '待反馈'], ['COMPLETED', '已完成']]; const maxTrend = Math.max(...data.customerTrend.map((item) => item.value), 1); const maxLoad = Math.max(...data.mentorLoad.map((item) => item.count), 1); return <div className="dashboard-panel"><SectionTitle title="基础数据看板" action={<span className="quiet-label">业务状态</span>} /><div className="board-metrics"><BoardMetric label="客户总数" value={data.customerCount} /><BoardMetric label="本月新增客户" value={data.monthNewCustomers} /><BoardMetric label="本月预约数" value={data.monthAppointments} /><BoardMetric label="本月已完成预约" value={data.monthCompleted} /><BoardMetric label="付费客户数" value={data.paidCustomers} /><BoardMetric label="导师总数" value={data.mentorCount} /></div><section className="chart-card"><h3>预约处理状态</h3><div className="status-bars">{statusItems.map(([status, label]) => <div className="status-bar-row" key={status}><span>{label}</span><div><i className={`bar-${status.toLowerCase()}`} style={{ width: `${Math.max(data.statusCounts[status] * 24, data.statusCounts[status] ? 24 : 0)}px` }} /></div><b>{data.statusCounts[status]}</b></div>)}</div></section><div className="chart-two-col"><section className="chart-card"><h3>客户新增趋势</h3><div className="trend-chart">{data.customerTrend.map((item) => <div className="trend-column" key={item.label}><div className="trend-bar" style={{ height: `${Math.max(item.value / maxTrend * 80, item.value ? 14 : 3)}px` }} /><span>{item.label}月</span><b>{item.value}</b></div>)}</div></section><section className="chart-card"><h3>导师客户量</h3><div className="load-chart">{data.mentorLoad.map((item) => <div className="load-row" key={item.name}><span>{item.name}</span><div><i style={{ width: `${item.count / maxLoad * 100}%` }} /></div><b>{item.count}</b></div>)}</div></section></div></div> }
function BoardMetric({ label, value }: { label: string; value: number }) { return <div className="board-metric"><span>{label}</span><strong>{value}</strong></div> }

function FeedbackForm({ appointment, customer, database: _database, onClose, onSubmit, onGenerateSummary, onGenerateProfile }: { appointment: Appointment; customer: Customer; database: Database; onClose: () => void; onSubmit: (feedback: FeedbackInput) => void | Promise<void>; onGenerateSummary: (input: FeedbackDraftInput) => Promise<{ summary: string; currentStatus: string; nextStep: string }>; onGenerateProfile: (customerId: string, text: string) => Promise<ProfileDraft> }) {
  const [step, setStep] = useState<'form' | 'review'>('form')
  const [situation, setSituation] = useState('')
  const [profileText, setProfileText] = useState('')
  const [result, setResult] = useState('继续跟进')
  const [aiDraft, setAiDraft] = useState<{ summary: string; currentStatus: string; nextStep: string } | null>(null)
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ updates: [] })
  const [aiLoading, setAiLoading] = useState(false)
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
  const finish = (updates: ProfileUpdate[]) => onSubmit({ appointmentId: appointment.id, topic: situation.trim() || profileText.trim() || '本次沟通', result, coreNeed: customer.need, paid: customer.paid, grade: customer.grade, intendedCourse: customer.intendedCourse, notes: situation.trim(), profileText: profileText.trim(), profileUpdates: updates, aiSummary: aiDraft?.summary, aiStatus: aiDraft?.currentStatus, aiNextStep: aiDraft?.nextStep })
  return <div className="modal-backdrop"><form className="modal-card form-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose}>×</button>{step === 'form' ? <><div className="eyebrow">SERVICE RECORD</div><h2>记录本次沟通</h2><p className="modal-lede">{customer.name} · 用几句话记录事实，AI 帮你整理。</p><label>本次主要聊了什么？<textarea value={situation} onChange={(event) => setSituation(event.target.value)} placeholder="例如：客户说最近工作压力变大，想先把每天的节奏稳住。" autoFocus /></label><label>说说这个客户现在的情况<small className="field-hint">可以输入，也可以使用浏览器支持的语音输入。</small><textarea value={profileText} onChange={(event) => setProfileText(event.target.value)} placeholder="例如：36 岁，住在杭州，从事设计，已婚，有一个女儿，喜欢瑜伽和旅行。" /><button type="button" className="secondary-button small voice-button" onClick={startVoice}>⌕ 语音输入</button>{voiceError && <small className="voice-note">{voiceError}</small>}</label><label>本次结果<div className="option-grid">{['继续跟进', '暂时结束', '有课程 / 服务意向', '需要转介'].map((item) => <button type="button" key={item} className={result === item ? 'option-button selected' : 'option-button'} onClick={() => setResult(item)}>{item}</button>)}</div></label><button className="primary-button full-width" type="submit" disabled={aiLoading || (!situation.trim() && !profileText.trim())}>{aiLoading ? '正在整理…' : '生成 AI 整理'} <span>→</span></button></> : <><div className="eyebrow">CONFIRM RECORD</div><h2>确认本次整理</h2><p className="modal-lede">AI 只提供整理建议；画像更新在你确认后才会写入客户档案。</p><div className="review-block"><span>本次总结</span><p>{aiDraft?.summary}</p></div><div className="review-block"><span>当前客户状态</span><p>{aiDraft?.currentStatus}</p></div><div className="review-block"><span>下一步跟进建议</span><p>{aiDraft?.nextStep}</p></div><div className="review-block"><span>本次发现 · {profileDraft.updates.length} 项</span>{profileDraft.updates.length ? <div className="profile-update-list">{profileDraft.updates.map((update) => <div className={`profile-update ${update.conflict ? 'conflict' : ''}`} key={update.field}><strong>{profileUpdateLabel(update)}</strong><span>{update.conflict ? `${displayProfileValue(update.previousValue ?? null)} → ` : ''}{displayProfileValue(update.value)}</span><small>{profileSourceLabel(update.source || 'MENTOR_OBSERVATION')} · {update.conflict ? '与已有记录不同，请确认' : '待确认'}</small></div>)}</div> : <p>没有识别到新的画像信息，本次只保存服务记录。</p>}</div><div className="review-actions"><button type="button" className="secondary-button" onClick={() => setStep('form')}>返回修改</button><button type="button" className="secondary-button" onClick={() => finish([])}>忽略画像更新</button><button type="button" className="primary-button" onClick={() => finish(profileDraft.updates)}>全部确认并完成 <span>→</span></button></div></>}</form></div>
}

export default App
