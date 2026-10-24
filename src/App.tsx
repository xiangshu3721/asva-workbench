import { cloneElement, useCallback, useEffect, useRef, useState } from 'react'
import * as React from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createGuardedLocalApi, createLocalApi } from './api'
import type { Appointment, AppointmentWorkflowStatus, Customer, CustomerGrade, CustomerDraftPreview, CustomerSalesUnderstandingV1, CustomerUnderstandingV1, Database, DialogueAssessment, DialogueConfirmation, EnrollmentDraft, FeedbackInput, ManualCustomerInput, MentorAccountResult, ProfileDraft, ProfileMaterialization, ProfileUpdate, ProfileValue, Product, Staff, UnderstandingInsight } from './domain'
import { createLocalRepository } from './repositories'
import { clearPendingCustomerMutation, createHttpApi, createLocalAsyncApi, readPendingCustomerMutation, rememberPendingCustomerMutation, type BasicDashboard, type CustomerMutationResult, type CustomerProfileResponse, type CustomerSalesUnderstandingResponse, type CustomerUnderstandingResponse, type SafetyAssessmentResponse, type DocumentExtractionResult, type DocumentUploadInput, type FeedbackDraftInput, type SourceRecord, type SourceSaveStatus, type SourceWorkspace, type WorkbenchApi } from './clientApi'
import { assembleCustomerContext, type AiBrief, type AiCoreSummary } from './customer-ai'
import { displayProfileValue, PROFILE_SECTIONS, profileSourceLabel, profileUpdateLabel } from './profile'
import { humanizeEvidenceType, humanizeLevel, humanizeProcessingStatus, humanizeStrategy, humanizeTiming, sanitizeUserVisibleText } from './presentationCopy'
import { clearAssistantHistory, GlobalAIAssistant } from './GlobalAIAssistant'
import { DebugPanel, ReleaseIndicator } from './DebugPanel'
import { canStartCustomerSave } from './save-contract'
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { isStaleProcessing, shouldResumeSource } from './processing-contract'
import { releasesMatch } from './release-meta'
// @ts-expect-error Shared runtime module intentionally stays framework-neutral.
import { aiFailureMessage, persistenceFailureMessage, sourceProcessingPresentation } from '../shared/source-processing-state.mjs'
import { canCommitCustomerResponse, createCustomerScopedState, isCustomerScopedStateFor, type CustomerScopedState } from './customer-switch-safety'
// @ts-expect-error Shared runtime module intentionally stays framework-neutral.
import { PASSWORD_POLICY_CODES, PASSWORD_POLICY_MESSAGES, validatePassword } from '../shared/password-policy.mjs'
// @ts-expect-error Shared runtime module intentionally stays framework-neutral.
import { accountAvatar, accountPanelFor, accountRoleLabel } from '../shared/account-identity.mjs'
import { clearAccessToken, readAccessToken, readAccessTokenIdentity, readLastLoginPhone, writeLastLoginPhone } from './auth-storage'
import { runtimeConfig } from './runtime-config'
import { createResourceCache, type ResourceCache } from './app-data-cache'
import { clearSessionSnapshots, readSessionSnapshot, writeSessionSnapshot } from './session-snapshots'
import { sortProductsForSelection } from './product-order'
import { buildMentorCopyText, insertMentorSnapshot, publicMentorSummary, reconcileMentorSnapshot, type TemporaryMentorCredential } from './mentor-account-ux'
import { isSourceSavePending, shouldStartSourceAi, transitionSourceSaveState, type SourceSaveState } from './save-reliability'
// @ts-expect-error Shared runtime module intentionally stays framework-neutral.
import { validateCustomerContacts } from '../shared/customer-foundation.mjs'
const repository = createLocalRepository()
const api = createLocalApi(repository)
const appEnv = runtimeConfig.appEnv
const dataMode = runtimeConfig.dataMode
const remoteBaseUrl = runtimeConfig.apiBaseUrl
const isRemoteStaff = appEnv !== 'mock'
const staffStorage = window.localStorage
const workbenchApi: WorkbenchApi = appEnv === 'mock' ? createLocalAsyncApi(createGuardedLocalApi(repository)) : createHttpApi(remoteBaseUrl)
type DialogueGateHandlers = { identify: (input: { text: string; targetCustomerId?: string; customerOperationId?: string }) => Promise<DialogueAssessment>; confirm: (input: { analysisToken: string; contentHash: string; targetCustomerId?: string; customerOperationId?: string; speakerId?: string }) => Promise<DialogueConfirmation> }
let dialogueGateHandlers: DialogueGateHandlers | null = null
function requireDialogueGateHandlers() { if (!dialogueGateHandlers) throw new Error('对话安全门禁尚未准备好，请刷新页面后重试。'); return dialogueGateHandlers }

type MePanel = 'account' | 'team'
const PASSWORD_POLICY_HINT = '密码需为 5～64 位，可使用英文字母、数字和常见特殊符号；无需强制混合大小写、数字或符号。请避开明显弱密码和手机号。'
function passwordErrorMessage(error: unknown) {
  const code = (error as { serverCode?: string; code?: string })?.serverCode || (error as { code?: string })?.code
  return (code && PASSWORD_POLICY_MESSAGES[code]) || (error instanceof Error ? error.message : '密码不符合要求')
}
function validatePasswordInput(value: string) {
  try { validatePassword(value); return '' } catch (error) { return passwordErrorMessage(error) }
}
function getConfirmPasswordError(newPassword: string, confirmPassword: string) {
  if (!confirmPassword) return ''
  return newPassword === confirmPassword ? '' : PASSWORD_POLICY_MESSAGES[PASSWORD_POLICY_CODES.CONFIRM_MISMATCH]
}
type CustomerFilter = '待处理' | '待跟进' | '已完成'

const statusLabel: Record<AppointmentWorkflowStatus, string> = { WAIT_ASSIGN: '待分配', WAIT_FOLLOW_UP: '待跟进', WAIT_FEEDBACK: '待反馈', COMPLETED: '已完成' }
const statusTone: Record<AppointmentWorkflowStatus, 'amber' | 'blue' | 'rose' | 'green'> = { WAIT_ASSIGN: 'amber', WAIT_FOLLOW_UP: 'blue', WAIT_FEEDBACK: 'rose', COMPLETED: 'green' }
const statusRank: Record<AppointmentWorkflowStatus, number> = { WAIT_ASSIGN: 0, WAIT_FOLLOW_UP: 1, WAIT_FEEDBACK: 2, COMPLETED: 3 }
const MAX_DOCUMENT_SIZE_MB = Number(import.meta.env.VITE_MAX_DOCUMENT_SIZE_MB || '20') || 20
type SourceCreateInput = { customerId: string; sourceType: string; rawText: string; operationId?: string; customerOperationId?: string; dialogueConfirmation: string; sourcePerspective?: 'STAFF_REPORTED' | 'CUSTOMER_FIRST_PARTY'; fileRef?: string; notes?: string; document?: { filename: string; mimeType: string; extension: string; size: number; fileHash: string; charCount: number; extractedText: string } }
type CustomerSourceUpload = { operationId: string; filename: string; mimeType: string; extension: string; size: number; fileHash: string; charCount: number; extractedText: string; dialogueConfirmation?: string }

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function sourceFileInfo(fileRef?: string) {
  try { const value = JSON.parse(fileRef || ''); return value?.storage === 'TEMPORARY' ? value as { original_filename: string; file_type: string; size: number } : null } catch { return null }
}

function sourceFailureMessage(error: unknown, phase: 'save' | 'ai' = 'ai') {
  const code = (error as { serverCode?: string; code?: string })?.serverCode || (error as { code?: string })?.code
  return phase === 'save' || (typeof code === 'string' && code.startsWith('FEISHU_')) ? persistenceFailureMessage({ code }) : aiFailureMessage({ code })
}
function customerSaveFailureMessage(error: unknown) {
  const code = (error as { serverCode?: string; code?: string })?.serverCode || (error as { code?: string })?.code
  if (code === 'CUSTOMER_SAVE_UNKNOWN') return '保存结果暂时无法确认，原内容仍保留。请稍后查询或重试。'
  if (code === 'CUSTOMER_SAVE_CONFIRMED_FAILED') return '客户保存已确认失败，填写内容仍保留，请修正后重试。'
  if (code === 'REQUEST_TIMEOUT' || code === 'NETWORK_UNREACHABLE' || code === 'CORS_PREFLIGHT_FAILED' || code === 'CORS_ERROR') return '保存结果暂未确认，原内容仍保留。请稍后重试，系统会继续使用同一操作编号核对，避免重复创建客户。'
  return sourceFailureMessage(error, 'save')
}

function Avatar({ staff, size = 'md' }: { staff?: Staff; size?: 'sm' | 'md' | 'lg' }) { return <span className={`avatar avatar-${size}`}>{accountAvatar(staff?.name)}</span> }
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'rose' | 'dark' }) { return <span className={`badge badge-${tone}`}>{children}</span> }
function ButtonSpinner() { return <span className="button-spinner" aria-hidden="true" /> }
function GradeBadge({ grade }: { grade: CustomerGrade }) { return <span className={`grade grade-${grade}`}>{grade}</span> }
function SectionTitle({ title, action }: { title: string; action?: ReactNode }) { return <div className="section-title"><h2>{title}</h2>{action}</div> }
function roleName(staff: Staff) { return accountRoleLabel(staff.permissionRole) }
function staffStatusLabel(status: Staff['status']) { return status === 'ACTIVE' ? '在职' : '已停用' }
const DASHBOARD_TTL_MS = 90_000
const MENTOR_TTL_MS = 180_000
const DATABASE_TTL_MS = 45_000
const LOADING_DELAY_MS = 200
const SESSION_SNAPSHOT_TTL_MS = 30 * 60 * 1000
const appStartedAt = typeof performance === 'undefined' ? 0 : performance.now()
type StaffSnapshot = Pick<Staff, 'id' | 'name' | 'role' | 'permissionRole' | 'status' | 'loginEnabled' | 'displayRole' | 'title' | 'specialty' | 'avatar'> & { authVersion: number }
function staffSessionIdentity(staffId: string) {
  const tokenIdentity = readAccessTokenIdentity()
  const authVersion = tokenIdentity?.staffId === staffId ? tokenIdentity.authVersion : 0
  return `${staffId}:${authVersion}`
}
const dashboardCacheKey = (staffId: string) => `dashboard:${staffSessionIdentity(staffId)}`
const basicDashboardCacheKey = (staffId: string) => `dashboard-basic:${staffSessionIdentity(staffId)}:scoped`
const mentorCacheKey = (staffId: string, status = '') => `mentors:${staffSessionIdentity(staffId)}:${status || 'all'}`
const staffSnapshotKey = (staffId: string) => `asva:session:staff:${staffSessionIdentity(staffId)}`
const basicDashboardSnapshotKey = (staffId: string) => `asva:session:dashboard:${staffSessionIdentity(staffId)}:scoped`
const mentorSnapshotKey = (staffId: string) => `asva:session:mentors:${staffSessionIdentity(staffId)}:all`
const customerDetailCacheKey = (staffId: string, customerId: string) => `customer-detail:${staffSessionIdentity(staffId)}:${customerId}`
const customerResourceScope = (staffId: string, permissionRole: string) => `${staffSessionIdentity(staffId)}:${permissionRole || 'UNKNOWN'}`
const customerUnderstandingCacheKey = (staffId: string, permissionRole: string, customerId: string) => `customer-understanding:${customerResourceScope(staffId, permissionRole)}:${customerId}`
const customerSalesUnderstandingCacheKey = (staffId: string, permissionRole: string, customerId: string) => `customer-sales-understanding:${customerResourceScope(staffId, permissionRole)}:${customerId}`
const customerProfileCacheKey = (staffId: string, permissionRole: string, customerId: string, dataVersion = 0) => `customer-profile:${customerResourceScope(staffId, permissionRole)}:${customerId}:v${dataVersion}`
const sourceWorkspaceCacheKey = (staffId: string, permissionRole: string, customerId: string) => `source-workspace:${customerResourceScope(staffId, permissionRole)}:${customerId}`
function mergeCustomerDetail(directory: Database, detail: Database, customerId: string): Database {
  const replaceCustomerScoped = <T extends { customerId: string }>(current: T[], next: T[]) => [...current.filter((item) => item.customerId !== customerId), ...next]
  const detailCustomer = detail.customers.find((item) => item.id === customerId)
  return {
    ...directory,
    customers: detailCustomer ? directory.customers.map((item) => item.id === customerId ? detailCustomer : item) : directory.customers,
    appointments: replaceCustomerScoped(directory.appointments, detail.appointments),
    sessions: replaceCustomerScoped(directory.sessions, detail.sessions),
    enrollments: replaceCustomerScoped(directory.enrollments, detail.enrollments),
    profileChanges: replaceCustomerScoped(directory.profileChanges, detail.profileChanges),
    staff: detail.staff.length ? detail.staff : directory.staff,
    products: detail.products.length ? detail.products : directory.products,
  }
}
function mergeDirectoryCustomer(current: Customer | undefined, next: Customer): Customer {
  if (!current) return next
  const merged = { ...current, ...next }
  const detailOnlyKeys: Array<keyof Customer> = ['profileFields', 'profileFieldMeta', 'profileMaterialization', 'profileMaterializationLoaded', 'understanding', 'understandingStatus', 'understandingMeta', 'salesUnderstanding', 'salesUnderstandingStatus', 'salesUnderstandingMeta', 'safety', 'safetyStatus', 'safetyMeta', 'brief']
  for (const key of detailOnlyKeys) {
    if (current[key] !== undefined && (next[key] === undefined || (key === 'profileMaterializationLoaded' && current[key] === true))) merged[key] = current[key] as never
  }
  return merged
}
function mergeDirectoryDatabase(current: Database | null, next: Database): Database {
  if (!current) return next
  return { ...next, customers: next.customers.map((item) => mergeDirectoryCustomer(current.customers.find((candidate) => candidate.id === item.id), item)) }
}
function emptyDirectoryDatabase(staff: Staff): Database {
  return { staff: [staff], customers: [], appointments: [], sessions: [], followups: [], products: [], enrollments: [], profileChanges: [] }
}
function toStaffSnapshot(staff: Staff): StaffSnapshot { return { id: staff.id, name: staff.name, role: staff.role, permissionRole: staff.permissionRole, status: staff.status, loginEnabled: staff.loginEnabled, displayRole: staff.displayRole, title: staff.title, specialty: staff.specialty, avatar: staff.avatar, authVersion: Number((staff as Staff & { authVersion?: number }).authVersion || readAccessTokenIdentity()?.authVersion || 0) } }
function fromStaffSnapshot(snapshot: StaffSnapshot): Staff { return { ...snapshot, phone: '' } }
function logAppPerformance(metric: string, extra: Record<string, unknown> = {}) { if (import.meta.env.DEV) console.info('[ASVA_PERF]', JSON.stringify({ metric, value_ms: Math.round(performance.now() - appStartedAt), ...extra })) }
function useDelayedLoading(active: boolean, delayMs = LOADING_DELAY_MS) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!active) { setVisible(false); return undefined }
    const timer = window.setTimeout(() => setVisible(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [active, delayMs])
  return active && visible
}
function AppBootLoading({ error, onRetry }: { error?: string; onRetry?: () => void }) { return <main className="login-page app-boot-loading" aria-busy="true"><section className="login-card"><div className="eyebrow">ASVA</div><h1>正在进入工作台…</h1><p>{error || '正在准备工作台，请稍候。'}</p>{error && onRetry && <button className="primary-button full-width" type="button" onClick={onRetry}>重新连接</button>}</section></main> }
function AppDataLoading({ error, onRetry }: { error?: string; onRetry?: () => void }) { const visible = useDelayedLoading(true); return <section className={`surface app-data-loading ${visible ? '' : 'app-data-loading-quiet'}`} aria-busy="true">{visible && <><div className="inline-loading-mark" aria-hidden="true" /><h2>{error ? '工作台数据暂时无法更新' : '正在加载…'}</h2>{error ? <><p>{error}</p>{onRetry && <button className="secondary-button small" type="button" onClick={onRetry}>重新加载</button>}</> : <p>页面很快就会准备好。</p>}</>}</section> }
function workflowStatus(appointment: Appointment): AppointmentWorkflowStatus { return appointment.status as AppointmentWorkflowStatus }
function Login({ api, onLogin }: { api: WorkbenchApi; onLogin: (account: Staff & { mustChangePassword?: boolean }) => void }) {
  const [phone, setPhone] = useState(() => readLastLoginPhone())
  const [password, setPassword] = useState(appEnv === 'mock' ? '888888' : '')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); setLoading(true); setError(''); try { const normalizedPhone = phone.trim(); const account = await api.login(normalizedPhone, password); writeLastLoginPhone(normalizedPhone); onLogin(account) } catch (loginError) { setError(loginError instanceof Error ? loginError.message : '登录失败') } finally { setLoading(false) } }
  return <main className="login-page"><div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" /><section className="login-card"><div className="brand-lockup"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><div><strong>ASVA</strong><span>客户关怀系统</span></div></div><div className="login-copy"><div className="eyebrow">SERVICE FLOW</div><h1>看见客户，<br /><em>传递空静爱。</em></h1><p>资料进入，管理员从客户档案开始工作。</p></div><form onSubmit={submit} className="login-form"><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" autoComplete="username" /></label><label>密码<div className="code-row"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /><button type="button" className="text-button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? '隐藏' : '显示'}</button></div></label>{(error || runtimeConfig.configurationError) && <p className="form-error">{error || runtimeConfig.configurationError}</p>}<button className="primary-button full-width" type="submit" disabled={loading}>{loading && <ButtonSpinner />}{loading ? '正在验证…' : '进入工作台'} <span>→</span></button></form>{appEnv === 'mock' ? <div className="login-hint">仅 Mock：请使用本地演示密码</div> : <div className="login-hint">密码只在服务端校验，不会写入浏览器。</div>}</section></main>
}

function ChangePassword({ api, onComplete }: { api: WorkbenchApi; onComplete: () => void }) {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [newPasswordError, setNewPasswordError] = useState('')
  const [confirmPasswordError, setConfirmPasswordError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const nextError = validatePasswordInput(newPassword)
    const confirmError = !confirmPassword ? '请再次输入新密码' : getConfirmPasswordError(newPassword, confirmPassword)
    setNewPasswordError(nextError)
    setConfirmPasswordError(confirmError)
    setError('')
    if (nextError || confirmError) return
    setLoading(true)
    try { await api.changePassword('', newPassword); onComplete() } catch (changeError) { setNewPasswordError(passwordErrorMessage(changeError)) } finally { setLoading(false) }
  }
  return <main className="login-page"><section className="login-card"><div className="eyebrow">FIRST LOGIN</div><h1>设置新密码</h1><p className="modal-lede">为了账号安全，请设置自己的登录密码。{PASSWORD_POLICY_HINT} 新密码不能与初始密码相同。</p><form onSubmit={submit} className="login-form"><label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => { setNewPassword(event.target.value); setNewPasswordError(''); setError(''); setConfirmPasswordError(getConfirmPasswordError(event.target.value, confirmPassword)) }} />{newPasswordError && <span className="form-error">{newPasswordError}</span>}</label><label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setConfirmPasswordError(getConfirmPasswordError(newPassword, event.target.value)); setError('') }} />{confirmPasswordError && <span className="form-error">{confirmPasswordError}</span>}</label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" type="submit" disabled={loading}>{loading && <ButtonSpinner />}{loading ? '保存中…' : '确认修改'} <span>→</span></button></form></section></main>
}

function WorkbenchApp() {
  const [loggedInStaffId, setLoggedInStaffId] = useState<string | null>(() => {
    if (appEnv === 'mock') return staffStorage.getItem('asva-demo-staff-v2')
    const tokenIdentity = readAccessTokenIdentity()
    return tokenIdentity?.staffId || (readAccessToken() ? staffStorage.getItem('asva-demo-staff-v2') : null)
  })
  const [currentStaff, setCurrentStaff] = useState<Staff | null>(() => {
    if (!isRemoteStaff) return loggedInStaffId ? api.staff(loggedInStaffId) ?? null : null
    if (!loggedInStaffId) return null
    const snapshot = readSessionSnapshot<StaffSnapshot>(staffSnapshotKey(loggedInStaffId), SESSION_SNAPSHOT_TTL_MS)
    return snapshot ? fromStaffSnapshot(snapshot) : null
  })
  const dataCacheRef = useRef<ResourceCache | null>(null)
  if (!dataCacheRef.current) {
    dataCacheRef.current = createResourceCache()
    if (loggedInStaffId) {
      const dashboardSnapshot = readSessionSnapshot<BasicDashboard>(basicDashboardSnapshotKey(loggedInStaffId), SESSION_SNAPSHOT_TTL_MS)
      if (dashboardSnapshot) dataCacheRef.current.set(basicDashboardCacheKey(loggedInStaffId), dashboardSnapshot)
      const mentorSnapshot = readSessionSnapshot<Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>>(mentorSnapshotKey(loggedInStaffId), SESSION_SNAPSHOT_TTL_MS)
      if (mentorSnapshot) dataCacheRef.current.set(mentorCacheKey(loggedInStaffId), mentorSnapshot)
    }
  }
  const dataCache = dataCacheRef.current
  const [mustChangePassword, setMustChangePassword] = useState(() => staffStorage.getItem('asva-password-change-required') === 'true')
  const [authRestoring, setAuthRestoring] = useState(() => isRemoteStaff && Boolean(readAccessToken()) && !currentStaff)
  const [identityLoading, setIdentityLoading] = useState(Boolean(loggedInStaffId && isRemoteStaff))
  const [identityError, setIdentityError] = useState('')
  const validatedStaffRef = useRef<string | null>(null)
  const shellPerformanceLoggedRef = useRef(false)
  const [mePanel, setMePanel] = useState<MePanel>('account')
  const location = useLocation()
  const navigate = useNavigate()
  const routeCustomerMatch = location.pathname.match(/^\/customers\/([^/]+)/)
  const selectedCustomerId = routeCustomerMatch ? decodeURIComponent(routeCustomerMatch[1]) : null
  const view = location.pathname.startsWith('/customers') ? 'customers' : location.pathname === '/me' ? 'me' : 'home'
  const [manualCustomerOpen, setManualCustomerOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [database, setDatabase] = useState<Database | null>(() => {
    if (remoteBaseUrl || dataMode === 'production') return null
    if (!loggedInStaffId) return null
    try { return api.dashboard(loggedInStaffId) } catch { return null }
  })
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let cancelled = false
    const frontendMetaUrl = `${import.meta.env.BASE_URL}build-meta.json`
    Promise.all([
      workbenchApi.health(),
      fetch(frontendMetaUrl).then((response) => response.ok ? response.json() : null).catch(() => null),
    ]).then(([backend, frontend]) => {
      if (cancelled) return
      const frontendRelease = frontend?.release || 'UNKNOWN'
      const backendRelease = backend.release || 'UNKNOWN'
      const versionCompatible = releasesMatch(frontend, backend)
      const handshake = {
        'Frontend Environment': appEnv,
        'Frontend Release': frontendRelease,
        'API Base': remoteBaseUrl || 'UNSET',
        'Backend Reachable': 'YES',
        'Backend Environment': backend.appEnv || backend.environment || 'UNKNOWN',
        'Backend Release': backendRelease,
        'Version Compatible': versionCompatible === null ? 'UNKNOWN' : versionCompatible ? 'YES' : 'NO',
        'Auth Mode': backend.authMode || 'UNKNOWN',
        'Data Mode': backend.dataMode || 'UNKNOWN',
      }
      console.info('[ASVA][ENVIRONMENT_HANDSHAKE]', handshake)
      const mismatches = [
        runtimeConfig.configurationError ? 'FRONTEND_CONFIGURATION' : '',
        backend.appEnv && appEnv !== 'invalid' && backend.appEnv !== appEnv ? 'ENVIRONMENT_MISMATCH' : '',
        versionCompatible === false ? 'VERSION_MISMATCH' : '',
        appEnv !== 'mock' && backend.dataMode !== 'production' ? 'DATA_MODE_MISMATCH' : '',
      ].filter(Boolean)
      if (mismatches.length) console.warn('[ASVA][ENVIRONMENT_MISMATCH]', { mismatches, handshake })
    }).catch((error: unknown) => {
      if (!cancelled) console.warn('[ASVA][ENVIRONMENT_HANDSHAKE]', { 'Backend Reachable': 'NO', code: (error as { code?: string })?.code || 'UNKNOWN', message: error instanceof Error ? error.message : 'health check failed' })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (authRestoring) return
    if (!loggedInStaffId) {
      setCurrentStaff(null)
      setIdentityLoading(false)
      return
    }
    if (!isRemoteStaff && currentStaff?.id === loggedInStaffId) {
      setIdentityLoading(false)
      return
    }
    if (validatedStaffRef.current === loggedInStaffId) {
      setIdentityLoading(false)
      return
    }
    let cancelled = false
    validatedStaffRef.current = loggedInStaffId
    setIdentityLoading(true)
    setIdentityError('')
    const loadCurrentStaff = isRemoteStaff ? workbenchApi.staff(loggedInStaffId) : Promise.resolve(api.staff(loggedInStaffId))
    loadCurrentStaff.then((profile) => {
      if (cancelled) return
      if (!profile) throw new Error('账号不存在')
      writeSessionSnapshot(staffSnapshotKey(profile.id), toStaffSnapshot(profile))
      setCurrentStaff(profile)
      setDatabase(dataCache.get<Database>(dashboardCacheKey(profile.id)) ?? null)
      setMePanel('account')
      setIdentityLoading(false)
    }).catch((error: Error) => {
      if (cancelled) return
      clearSessionSnapshots()
      dataCache.invalidatePrefix('')
      setCurrentStaff(null)
      setLoggedInStaffId(null)
      setIdentityError(error.message || '登录状态已失效，请重新登录')
      setIdentityLoading(false)
    })
    return () => { cancelled = true }
  }, [authRestoring, currentStaff?.id, dataCache, loggedInStaffId])

  useEffect(() => {
    if (!authRestoring) return undefined
    let cancelled = false
    setIdentityLoading(true)
    workbenchApi.staff('').then((profile) => {
      if (cancelled) return
      if (!profile) throw new Error('账号不存在')
      writeSessionSnapshot(staffSnapshotKey(profile.id), toStaffSnapshot(profile))
      validatedStaffRef.current = profile.id
      setCurrentStaff(profile)
      setDatabase(dataCache.get<Database>(dashboardCacheKey(profile.id)) ?? null)
      setLoggedInStaffId(profile.id)
      setAuthRestoring(false)
      setIdentityLoading(false)
    }).catch((error: Error) => {
      if (cancelled) return
      clearAccessToken()
      clearSessionSnapshots()
      clearAssistantHistory()
      dataCache.invalidatePrefix('')
      staffStorage.removeItem('asva-demo-staff-v2')
      staffStorage.removeItem('asva-password-change-required')
      setCurrentStaff(null)
      setLoggedInStaffId(null)
      setMustChangePassword(false)
      setAuthRestoring(false)
      setIdentityError(error.message || '登录状态已失效，请重新登录')
      setIdentityLoading(false)
    })
    return () => { cancelled = true }
  }, [authRestoring, dataCache])

  const activeStaff = currentStaff
  const canSeeAll = activeStaff?.permissionRole === 'ADMIN'
  const [customerSaveRecoveryMessage, setCustomerSaveRecoveryMessage] = useState('')

  useEffect(() => {
    if (!activeStaff || authRestoring || identityLoading) return undefined
    const pending = readPendingCustomerMutation()
    if (!pending) return undefined
    if (pending.actorId !== activeStaff.id) { clearPendingCustomerMutation(pending.operationId); return undefined }
    let cancelled = false
    workbenchApi.customerSaveStatus(activeStaff.id, pending.operationId, pending.customerId).then((status) => {
      if (cancelled) return
      if ((status.status === 'PERSISTED' || status.status === 'COMMITTED') && status.customer) {
        applyCustomerMutation({ customer: status.customer, enrollments: status.enrollments || [], profileChanges: status.profileChanges || [], createdCustomerId: status.createdCustomerId || status.customerId, customerCreated: status.customerCreated === true, persistenceStatus: status.persistenceStatus || 'COMMITTED', mutation: status.mutation })
        clearPendingCustomerMutation(pending.operationId)
        setCustomerSaveRecoveryMessage('已恢复并确认上一笔客户保存结果。')
      } else if (status.status === 'UNKNOWN') {
        setCustomerSaveRecoveryMessage('上一笔客户保存结果暂时无法确认，原操作仍保留，请稍后重试。')
      } else if (status.status === 'FAILED') {
        clearPendingCustomerMutation(pending.operationId)
        setCustomerSaveRecoveryMessage('上一笔客户保存已确认失败，原操作内容需要重新提交。')
      }
    }).catch(() => { if (!cancelled) setCustomerSaveRecoveryMessage('上一笔客户保存结果暂时无法确认，请稍后查询。') })
    return () => { cancelled = true }
  }, [activeStaff?.id, authRestoring, identityLoading])

  useEffect(() => {
    if (!activeStaff || shellPerformanceLoggedRef.current) return
    shellPerformanceLoggedRef.current = true
    logAppPerformance('APP_SHELL_VISIBLE_MS', { warm_staff_snapshot: true })
  }, [activeStaff])

  useEffect(() => {
    if (view !== 'customers' || !loggedInStaffId || !currentStaff || authRestoring || identityLoading) return
    let cancelled = false
    const staffId = currentStaff.id
    const dashboardKey = dashboardCacheKey(staffId)
    const cachedDatabase = dataCache.get<Database>(dashboardKey)
    const startedAt = performance.now()
    setDatabase(cachedDatabase ?? null)
    setLoadError('')
    const forceRefresh = revision > 0
    dataCache.load(dashboardKey, () => workbenchApi.customerDirectory(staffId), { ttlMs: DATABASE_TTL_MS, force: forceRefresh }).then((next) => { if (!cancelled) { setDatabase((current) => mergeDirectoryDatabase(current, next)); logAppPerformance('CUSTOMER_DIRECTORY_READY_MS', { duration_ms: Math.round(performance.now() - startedAt), from_cache: Boolean(cachedDatabase) }) } }).catch((error: Error) => { if (!cancelled && !dataCache.get<Database>(dashboardKey)) setLoadError(error.message) })
    void dataCache.load(basicDashboardCacheKey(staffId), () => workbenchApi.basicDashboard(staffId), { ttlMs: DASHBOARD_TTL_MS, force: forceRefresh }).catch(() => undefined)
    const prefetchMentors = () => { if (currentStaff.permissionRole === 'ADMIN') void dataCache.load(mentorCacheKey(staffId), () => workbenchApi.teamSnapshot(staffId), { ttlMs: MENTOR_TTL_MS }).catch(() => undefined) }
    const idleApi = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    const hasIdleCallback = typeof idleApi.requestIdleCallback === 'function'
    const idleWindow = hasIdleCallback ? idleApi.requestIdleCallback(prefetchMentors, { timeout: 1200 }) : window.setTimeout(prefetchMentors, 200)
    return () => { cancelled = true; if (typeof idleApi.cancelIdleCallback === 'function' && hasIdleCallback) idleApi.cancelIdleCallback(idleWindow); else window.clearTimeout(idleWindow) }
  }, [authRestoring, currentStaff, dataCache, identityLoading, loggedInStaffId, revision, view])

  useEffect(() => {
    if (!currentStaff || !database || !selectedCustomerId || !database.customers.some((item) => item.id === selectedCustomerId)) return undefined
    const key = customerDetailCacheKey(currentStaff.id, selectedCustomerId)
    let cancelled = false
    const startedAt = performance.now()
    const cachedDetail = dataCache.get<Database>(key)
    dataCache.load(key, () => workbenchApi.customerDetail(currentStaff.id, selectedCustomerId), { ttlMs: DATABASE_TTL_MS }).then((detail) => {
      if (cancelled) return
      setDatabase((current) => current ? mergeCustomerDetail(current, detail, selectedCustomerId) : current)
      logAppPerformance('CUSTOMER_DETAIL_READY_MS', { duration_ms: Math.round(performance.now() - startedAt), from_cache: Boolean(cachedDetail) })
    }).catch((error: Error) => {
      if (!cancelled && import.meta.env.DEV) console.warn('[ASVA_PERF]', JSON.stringify({ metric: 'CUSTOMER_DETAIL_ERROR', message: error.message }))
    })
    return () => { cancelled = true }
  }, [currentStaff?.id, database?.customers.length, dataCache, selectedCustomerId])

  useEffect(() => {
    const expire = () => {
      staffStorage.removeItem('asva-demo-staff-v2')
      staffStorage.removeItem('asva-password-change-required')
      clearAccessToken()
      clearSessionSnapshots()
      dataCache.invalidatePrefix('')
      setCurrentStaff(null)
      setDatabase(null)
      setMePanel('account')
      setLoggedInStaffId(null)
      setMustChangePassword(false)
      setAuthRestoring(false)
    }
    window.addEventListener('asva-auth-expired', expire)
    return () => window.removeEventListener('asva-auth-expired', expire)
  }, [dataCache])

  const finishLogin = (account: Staff & { mustChangePassword?: boolean }) => { clearSessionSnapshots(); clearAssistantHistory(); dataCache.invalidatePrefix(''); writeSessionSnapshot(staffSnapshotKey(account.id), toStaffSnapshot(account)); validatedStaffRef.current = account.id; staffStorage.setItem('asva-demo-staff-v2', account.id); if (account.mustChangePassword) { staffStorage.setItem('asva-password-change-required', 'true'); setMustChangePassword(true) } else { staffStorage.removeItem('asva-password-change-required'); setMustChangePassword(false) } setCurrentStaff(account); setDatabase(null); setIdentityLoading(false); setMePanel('account'); setLoggedInStaffId(account.id); setAuthRestoring(false) }
  if (authRestoring) return <AppBootLoading />
  if (!loggedInStaffId) return <Login api={workbenchApi} onLogin={finishLogin} />
  if (mustChangePassword) return <ChangePassword api={workbenchApi} onComplete={() => { staffStorage.removeItem('asva-password-change-required'); setMustChangePassword(false) }} />
  if (!activeStaff) return <AppBootLoading error={identityError || undefined} onRetry={identityError ? () => { clearSessionSnapshots(); dataCache.invalidatePrefix(''); staffStorage.removeItem('asva-demo-staff-v2'); staffStorage.removeItem('asva-password-change-required'); clearAccessToken(); setLoggedInStaffId(null); setMustChangePassword(false); setAuthRestoring(false) } : undefined} />
  if (activeStaff.status !== 'ACTIVE') return <Login api={workbenchApi} onLogin={finishLogin} />
  const selectedCustomer = selectedCustomerId ? database?.customers.find((item) => item.id === selectedCustomerId) : database?.customers[0]
  const refresh = () => { setRevision((value) => value + 1) }
  const setDatabaseSnapshot = (next: Database) => { dataCache.set(dashboardCacheKey(activeStaff.id), next); setDatabase(next) }
  const invalidateCustomerResources = (customerId: string) => {
    dataCache.invalidate(customerDetailCacheKey(activeStaff.id, customerId))
    const scope = customerResourceScope(activeStaff.id, activeStaff.permissionRole)
    for (const prefix of [`customer-profile:${scope}:${customerId}:`, `source-workspace:${scope}:${customerId}`]) dataCache.invalidatePrefix(prefix)
  }
  const applyCustomerMutation = (result: CustomerMutationResult | Database) => {
    if ('customers' in result) {
      setDatabaseSnapshot(result)
      return
    }
    invalidateCustomerResources(result.customer.id)
    setDatabase((current) => {
      if (!current) return current
      const hasCustomer = current.customers.some((item) => item.id === result.customer.id)
      const customers = hasCustomer
        ? current.customers.map((item) => item.id === result.customer.id ? result.customer : item)
        : [...current.customers, result.customer]
      const enrollments = [...current.enrollments.filter((item) => item.customerId !== result.customer.id), ...result.enrollments]
      const profileChanges = [...current.profileChanges.filter((item) => item.customerId !== result.customer.id), ...(result.profileChanges || [])]
      const next = { ...current, customers, enrollments, profileChanges }
      dataCache.set(dashboardCacheKey(activeStaff.id), next)
      return next
    })
  }
  const openCustomer = (id: string) => navigate(`/customers/${encodeURIComponent(id)}`)
  const generateProfile = (customerId: string, text: string) => workbenchApi.profileDraft(activeStaff.id, customerId, text)
  const confirmProfile = (customerId: string, updates: ProfileUpdate[]) => workbenchApi.confirmProfile(activeStaff.id, customerId, updates).then((saved) => { refresh(); return saved })
  const generateBrief = (input: { name: string; need: string; expectation: string }) => workbenchApi.brief(activeStaff.id, input)
  const generateIntelligence = (customer: Customer, currentDatabase: Database) => workbenchApi.customerIntelligence(activeStaff.id, { context: assembleCustomerContext(currentDatabase, customer.id) })
  const refreshCustomerSummary = async (customerId: string) => { const saved = await workbenchApi.refreshCustomerSummary(activeStaff.id, customerId); if (saved) setDatabase((current) => current ? { ...current, customers: current.customers.map((item) => item.id === customerId ? saved : item) } : current); return saved }
  const getCustomerUnderstanding = (customerId: string) => workbenchApi.getCustomerUnderstanding(activeStaff.id, customerId)
  const refreshCustomerUnderstanding = async (customerId: string, force = false) => { const result = await workbenchApi.refreshCustomerUnderstanding(activeStaff.id, customerId, force); setDatabase((current) => current ? { ...current, customers: current.customers.map((item) => item.id === customerId ? { ...item, understanding: result.understanding || undefined, understandingStatus: result.status, understandingMeta: result.meta } : item) } : current); return result }
  const getCustomerSalesUnderstanding = (customerId: string) => workbenchApi.getCustomerSalesUnderstanding(activeStaff.id, customerId)
  const refreshCustomerSalesUnderstanding = async (customerId: string, force = false) => { const result = await workbenchApi.refreshCustomerSalesUnderstanding(activeStaff.id, customerId, force); setDatabase((current) => current ? { ...current, customers: current.customers.map((item) => item.id === customerId ? { ...item, salesUnderstanding: result.salesUnderstanding || undefined, salesUnderstandingStatus: result.status, salesUnderstandingMeta: result.meta } : item) } : current); return result }
  const loadCustomerProfile = (customerId: string) => workbenchApi.customerProfile(activeStaff.id, customerId)
  const getCustomerSafetyAssessment = (customerId: string) => workbenchApi.getCustomerSafetyAssessment(activeStaff.id, customerId)
  const refreshCustomerSafetyAssessment = (customerId: string, force = false) => workbenchApi.refreshCustomerSafetyAssessment(activeStaff.id, customerId, force)
  const saveBrief = (customerId: string, brief: string) => workbenchApi.saveBrief(activeStaff.id, customerId, brief)
  const saveReferrer = (customerId: string, referrerName: string) => workbenchApi.updateCustomerReferrer(activeStaff.id, customerId, referrerName).then((saved) => { refresh(); return saved })
  const saveCustomerUpload = async (customerId: string, upload: CustomerSourceUpload, customerOperationId = '') => {
    const saveStartedAt = performance.now()
    const sourceInput: SourceCreateInput = { customerId, sourceType: 'FILE_UPLOAD', rawText: upload.extractedText, operationId: upload.operationId, customerOperationId, dialogueConfirmation: upload.dialogueConfirmation || '', sourcePerspective: 'STAFF_REPORTED', notes: '新增客户上传资料', document: { filename: upload.filename, mimeType: upload.mimeType, extension: upload.extension, size: upload.size, fileHash: upload.fileHash, charCount: upload.charCount, extractedText: upload.extractedText } }
    let source: SourceRecord | null = null
    let recoveredAfterTimeout = false
    try { source = await workbenchApi.createSource(activeStaff.id, sourceInput) } catch {
      const recovered = await workbenchApi.sourceStatus(activeStaff.id, customerId, upload.operationId).catch(() => null)
      if (recovered?.source) { source = recovered.source; recoveredAfterTimeout = true }
      else throw new Error('客户已创建，资料保存待确认，可稍后重试。')
    }
    if (source?.id) logAppPerformance('SOURCE_SAVE_PERSIST_MS', { duration_ms: Math.round(performance.now() - saveStartedAt), recovered: recoveredAfterTimeout })
  }
  const saveManualCustomer = async (input: ManualCustomerInput, upload?: CustomerSourceUpload) => {
    const saveStartedAt = performance.now()
    rememberPendingCustomerMutation({ actorId: activeStaff.id, operationId: input.operationId || '', kind: 'CREATE', startedAt: new Date().toISOString() })
    let saved: CustomerMutationResult
    try { saved = await workbenchApi.createCustomer(activeStaff.id, input) } catch (error) { if ((error as { serverCode?: string })?.serverCode !== 'CUSTOMER_SAVE_UNKNOWN') clearPendingCustomerMutation(input.operationId); throw error }
    clearPendingCustomerMutation(input.operationId)
    logAppPerformance('CUSTOMER_SAVE_PERSIST_MS', { duration_ms: Math.round(performance.now() - saveStartedAt) })
    applyCustomerMutation(saved)
    if (!upload) { setManualCustomerOpen(false); return }
    const customerId = saved.createdCustomerId
    await saveCustomerUpload(customerId, upload, input.operationId || '')
    setManualCustomerOpen(false)
    openCustomer(customerId)
  }
  const previewManualCustomer = (input: ManualCustomerInput): Promise<CustomerDraftPreview> => workbenchApi.previewCustomer(activeStaff.id, input)
  const updateExistingCustomer = async (customerId: string, input: ManualCustomerInput, upload?: CustomerSourceUpload) => { const saveStartedAt = performance.now(); rememberPendingCustomerMutation({ actorId: activeStaff.id, operationId: input.operationId || '', customerId, kind: 'UPDATE', startedAt: new Date().toISOString() }); let saved: CustomerMutationResult; try { saved = await workbenchApi.updateCustomer(activeStaff.id, customerId, input) } catch (error) { if ((error as { serverCode?: string })?.serverCode !== 'CUSTOMER_SAVE_UNKNOWN') clearPendingCustomerMutation(input.operationId); throw error }; clearPendingCustomerMutation(input.operationId); logAppPerformance('CUSTOMER_SAVE_PERSIST_MS', { duration_ms: Math.round(performance.now() - saveStartedAt) }); applyCustomerMutation(saved); if (upload) await saveCustomerUpload(customerId, upload); setManualCustomerOpen(false); openCustomer(customerId) }
  const updateCustomerEnrollments = async (customerId: string, enrollments: EnrollmentDraft[]) => { const saved = await workbenchApi.updateCustomerEnrollments(activeStaff.id, customerId, enrollments); setDatabaseSnapshot(saved); refresh() }
  const sourceWorkspace = (customerId: string) => workbenchApi.sourceWorkspace(activeStaff.id, customerId)
  const sourceStatus = (customerId: string, operationId: string) => workbenchApi.sourceStatus(activeStaff.id, customerId, operationId)
  const extractDocument = (input: DocumentUploadInput) => workbenchApi.extractDocument(activeStaff.id, input)
  const identifyDialogue = (input: { text: string; targetCustomerId?: string; customerOperationId?: string }) => workbenchApi.identifyDialogue(activeStaff.id, input)
  const confirmDialogue = (input: { analysisToken: string; contentHash: string; targetCustomerId?: string; customerOperationId?: string; speakerId?: string }) => workbenchApi.confirmDialogue(activeStaff.id, input)
  dialogueGateHandlers = { identify: identifyDialogue, confirm: confirmDialogue }
  const createSource = (input: SourceCreateInput) => workbenchApi.createSource(activeStaff.id, input)
  const processSource = (sourceId: string, force = false) => workbenchApi.processSource(activeStaff.id, sourceId, force).then((result) => { invalidateCustomerResources(result.source.customerId); dataCache.invalidatePrefix(`customer-understanding:${customerResourceScope(activeStaff.id, activeStaff.permissionRole)}:${result.source.customerId}`); refresh(); return result })
  const reviewProposal = (proposalId: string, decision: 'CONFIRM' | 'REJECT') => workbenchApi.reviewProposal(activeStaff.id, proposalId, decision).then(() => { refresh() })
  const resolveConflict = (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => workbenchApi.resolveConflict(activeStaff.id, conflictId, resolution).then(() => { refresh() })
  const overrideServiceNecessity = (input: { entityType: 'source' | 'evidence'; id: string; serviceNecessity: 'LOW' | 'RELEVANT' | 'CRITICAL' }) => workbenchApi.overrideServiceNecessity(activeStaff.id, input)

  const customerPage = <CustomersPage key={`${activeStaff.id}:${staffSessionIdentity(activeStaff.id)}`} staff={activeStaff} database={database || emptyDirectoryDatabase(activeStaff)} directoryLoading={!database} dataReady={!identityLoading} directoryError={loadError} onDirectoryRetry={() => setRevision((value) => value + 1)} canSeeAll={canSeeAll} selectedCustomer={identityLoading ? undefined : selectedCustomer} resourceCache={dataCache} profileRefreshRevision={revision} onSelect={openCustomer} onGenerateBrief={generateBrief} onGenerateIntelligence={generateIntelligence} onRefreshCustomerSummary={refreshCustomerSummary} onGetUnderstanding={getCustomerUnderstanding} onRefreshUnderstanding={refreshCustomerUnderstanding} onGetSalesUnderstanding={getCustomerSalesUnderstanding} onRefreshSalesUnderstanding={refreshCustomerSalesUnderstanding} onGetSafetyAssessment={getCustomerSafetyAssessment} onRefreshSafetyAssessment={refreshCustomerSafetyAssessment} onSaveBrief={saveBrief} onSaveReferrer={saveReferrer} onGenerateProfile={generateProfile} onConfirmProfile={confirmProfile} onUpdateEnrollments={updateCustomerEnrollments} onLoadCustomerProfile={loadCustomerProfile} onSourceWorkspace={sourceWorkspace} onSourceStatus={sourceStatus} onExtractDocument={extractDocument} onCreateSource={createSource} onProcessSource={processSource} onReviewProposal={reviewProposal} onResolveConflict={resolveConflict} onOverrideServiceNecessity={overrideServiceNecessity} onAddCustomer={() => setManualCustomerOpen(true)} />
  const homePage = <HomePage staff={activeStaff} api={workbenchApi} cache={dataCache} cacheRevision={revision} dataReady={!identityLoading} onCustomers={(query = '') => navigate(`/customers${query}`)} />
  const mePage = <MePage staff={activeStaff} panel={mePanel} onPanel={setMePanel} api={workbenchApi} cache={dataCache} dataReady={!identityLoading} onLogout={() => { staffStorage.removeItem('asva-demo-staff-v2'); staffStorage.removeItem('asva-password-change-required'); clearAccessToken(); clearSessionSnapshots(); clearAssistantHistory(); dataCache.invalidatePrefix(''); setCurrentStaff(null); setDatabase(null); setMePanel('account'); setLoggedInStaffId(null); setMustChangePassword(false); setAuthRestoring(false) }} />
  return <div className="app-shell"><aside className="side-rail"><div className="brand-lockup app-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><div><strong>ASVA</strong><span>客户关怀系统</span></div></div><nav className="side-nav"><NavLink to="/home" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><span className="nav-marker">今</span>首页</NavLink><NavLink to="/customers" className={({ isActive }) => `nav-item ${isActive || view === 'customers' ? 'active' : ''}`}><span className="nav-marker">客</span>客户</NavLink><NavLink to="/me" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><span className="nav-marker">我</span>我的</NavLink></nav><div className="rail-bottom"><button className="profile-chip" onClick={() => navigate('/me')}><Avatar staff={activeStaff} size="sm" /><span><strong>{activeStaff.name}</strong><small>{roleName(activeStaff)}</small></span><span className="chevron">⌄</span></button></div></aside><main className="main-content"><header className="topbar"><div className="mobile-brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}assets/asva-logo.png`} alt="ASVA" /><span className="mobile-brand-copy"><strong>ASVA</strong><small>客户关怀系统</small></span></div><div className="topbar-right"><button className="avatar-button" aria-label="打开我的页面" onClick={() => navigate('/me')}><Avatar staff={activeStaff} /></button></div></header><div className="page-content">{customerSaveRecoveryMessage && <div className="customer-save-recovery-banner" role="status">{customerSaveRecoveryMessage}<button type="button" className="secondary-button small" onClick={() => setCustomerSaveRecoveryMessage('')}>知道了</button></div>}<Routes><Route path="/home" element={homePage} /><Route path="/customers" element={database?.customers[0] ? <Navigate to={`/customers/${encodeURIComponent(database.customers[0].id)}`} replace /> : customerPage} /><Route path="/customers/:customerId" element={customerPage} /><Route path="/customers/:customerId/archive" element={customerPage} /><Route path="/me" element={mePage} /><Route path="/" element={<Navigate to="/home" replace />} /><Route path="*" element={<Navigate to="/home" replace />} /></Routes></div></main><nav className="bottom-nav"><NavLink to="/home" className={({ isActive }) => `bottom-item ${isActive ? 'active' : ''}`}><span>今</span>首页</NavLink><NavLink to="/customers" className={() => `bottom-item ${view === 'customers' ? 'active' : ''}`}><span>客</span>客户</NavLink><NavLink to="/me" className={({ isActive }) => `bottom-item ${isActive ? 'active' : ''}`}><span>我</span>我的</NavLink></nav>{manualCustomerOpen && database && <ManualCustomerDialog database={database} onClose={() => setManualCustomerOpen(false)} onPreview={previewManualCustomer} onExtractDocument={extractDocument} onCreate={saveManualCustomer} onUpdate={updateExistingCustomer} onOpenCustomer={(id) => { setManualCustomerOpen(false); openCustomer(id) }} />}<GlobalAIAssistant key={staffSessionIdentity(activeStaff.id)} api={workbenchApi} staffId={activeStaff.id} storageScope={staffSessionIdentity(activeStaff.id)} customerId={selectedCustomerId ?? undefined} onCustomer={openCustomer} /><ReleaseIndicator api={workbenchApi} onDebug={() => window.dispatchEvent(new Event('asva-debug-change'))} /><DebugPanel api={workbenchApi} staff={activeStaff} dataMode={dataMode} /></div>
}

function HomePage({ staff, api, cache, cacheRevision, dataReady, onCustomers }: { staff: Staff; api: WorkbenchApi; cache: ResourceCache; cacheRevision: number; dataReady: boolean; onCustomers: (query?: string) => void }) {
  return <div className="home-page"><div className="welcome-row"><div><div className="eyebrow">ASVA WORKBENCH</div><h1>欢迎回来，{staff.name}<span className="period">。</span></h1><p className="page-lede">这里是客户档案入口，从资料与依据开始。</p></div></div><ResourceBanners /><HomeDataDashboard staffId={staff.id} api={api} cache={cache} cacheRevision={cacheRevision} dataReady={dataReady} onCustomers={onCustomers} /></div>
}

function HomeDataDashboard({ staffId, api, cache, cacheRevision, dataReady, onCustomers }: { staffId: string; api: WorkbenchApi; cache: ResourceCache; cacheRevision: number; dataReady: boolean; onCustomers: (query?: string) => void }) {
  const cacheKey = basicDashboardCacheKey(staffId)
  const [dashboard, setDashboard] = useState<BasicDashboard | null>(() => cache.get<BasicDashboard>(cacheKey) ?? null)
  const [loading, setLoading] = useState(() => !cache.get<BasicDashboard>(cacheKey))
  const loadingVisible = useDelayedLoading(loading)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!dataReady) return undefined
    let cancelled = false
    const startedAt = performance.now()
    const cached = cache.get<BasicDashboard>(cacheKey)
    if (cached) { setDashboard(cached); setLoading(false) }
    else setLoading(true)
    setError('')
    cache.load(cacheKey, () => api.basicDashboard(staffId), { ttlMs: DASHBOARD_TTL_MS, force: cacheRevision > 0 }).then((next) => { writeSessionSnapshot(basicDashboardSnapshotKey(staffId), next); logAppPerformance('DASHBOARD_RENDER_MS', { duration_ms: Math.round(performance.now() - startedAt), from_cache: Boolean(cached) }); if (!cancelled) setDashboard(next) }).catch((loadError: Error) => { if (!cancelled && !cached) setError(loadError.message || '数据暂时加载失败') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [api, cache, cacheKey, cacheRevision, dataReady, staffId])
  if (!dataReady) return <section className="surface task-surface home-dashboard dashboard-loading-quiet" aria-busy="true"><SectionTitle title="基础数据看板" /></section>
  if (loading && !loadingVisible) return <section className="surface task-surface home-dashboard dashboard-loading-quiet" aria-busy="true"><SectionTitle title="基础数据看板" /></section>
  if (loading) return <section className="surface task-surface home-dashboard" aria-busy="true"><SectionTitle title="基础数据看板" /><div className="dashboard-skeleton" aria-label="基础数据看板加载中"><span /><span /><span /><span /></div><div className="dashboard-chart-skeleton"><span /><span /></div></section>
  if (error || !dashboard) return <section className="surface task-surface home-dashboard"><SectionTitle title="基础数据看板" /><div className="dashboard-error"><p>{error || '数据暂时加载失败'}</p><button className="secondary-button small" type="button" onClick={() => { setError(''); setLoading(true); void cache.refresh(cacheKey, () => api.basicDashboard(staffId)).then(setDashboard).catch((loadError: Error) => setError(loadError.message || '数据暂时加载失败')).finally(() => setLoading(false)) }}>重新加载</button></div></section>
  const metrics = [
    { label: '客户总数', value: dashboard.customer_total, onClick: () => onCustomers() },
    { label: '本周新增客户数', value: dashboard.new_customers_this_week },
    { label: '已报名客户', value: dashboard.enrolled_customer_total },
    { label: '待补充档案', value: dashboard.profile_pending_total },
  ]
  const colors = ['#168d7b', '#23a878', '#67c6a0', '#a4dbc2', '#d1eee0', '#e7f6ee']
  let cursor = 0
  const donutStops = dashboard.course_enrollment_distribution.map((item, index) => { const start = cursor; cursor += item.percentage; return `${colors[index % colors.length]} ${start}% ${cursor}%` }).join(', ')
  const donutStyle = { '--dashboard-donut': donutStops ? `conic-gradient(${donutStops})` : '#e9f3ee' } as React.CSSProperties
  const maxOwnerCount = Math.max(1, ...dashboard.customer_owner_distribution.map((item) => item.customer_count))
  return <section className="surface task-surface home-dashboard"><div className="dashboard-heading"><div><SectionTitle title="基础数据看板" /><p>快速掌握客户、课程与客户归属情况</p></div></div><div className="dashboard-metric-grid">{metrics.map((metric, index) => { const content = <><span className="dashboard-metric-mark">0{index + 1}</span><span className="dashboard-metric-label">{metric.label}</span><strong>{metric.value}</strong></>; return metric.onClick ? <button className="dashboard-metric dashboard-metric-action" type="button" onClick={metric.onClick} key={metric.label}>{content}</button> : <div className="dashboard-metric" key={metric.label}>{content}</div> })}</div><div className="dashboard-chart-grid"><section className="dashboard-chart-card"><div className="dashboard-chart-title"><h3>报名课程情况</h3><span>{dashboard.active_enrollment_total ? `${dashboard.active_enrollment_total} 人次` : '暂无数据'}</span></div>{dashboard.active_enrollment_total ? <div className="dashboard-donut-layout"><div className="dashboard-donut" style={donutStyle}><span><strong>{dashboard.active_enrollment_total}</strong><small>报名人次</small></span></div><div className="dashboard-legend">{dashboard.course_enrollment_distribution.map((item, index) => <div className="dashboard-legend-row" key={item.course_id}><i style={{ background: colors[index % colors.length] }} /><span>{item.course_name}</span><strong>{item.enrollment_count}人次</strong><small>{item.percentage}%</small></div>)}</div></div> : <div className="dashboard-empty">暂无报名数据</div>}</section><section className="dashboard-chart-card"><div className="dashboard-chart-title"><h3>客户归属分布</h3><span>按当前导师</span></div>{dashboard.customer_owner_distribution.length ? <div className="dashboard-owner-list">{dashboard.customer_owner_distribution.map((item) => <div className="dashboard-owner-row" key={item.staff_id || item.staff_name}><div className="dashboard-owner-label"><span>{item.staff_name}</span><strong>{item.customer_count}</strong></div><div className="dashboard-owner-track"><i style={{ width: `${Math.max(4, item.customer_count / maxOwnerCount * 100)}%` }} /></div></div>)}</div> : <div className="dashboard-empty">暂无客户归属数据</div>}</section></div><section className="dashboard-insights"><h3>管理提示</h3>{dashboard.management_insights.length ? <ul>{dashboard.management_insights.map((item) => <li key={item.type}>{item.text}</li>)}</ul> : <p>暂无需要特别关注的管理提示。</p>}</section></section>
}

function ResourceBanners() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [isPaused, setIsPaused] = useState(false)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipedRef = useRef(false)
  const banners = [
    { className: 'resource-banner-site', src: 'assets/asva-official-banner.jpg', desktopWebp: 'assets/asva-official-banner.webp', mobileWebp: 'assets/asva-official-banner-mobile.webp', href: 'https://xiangshu3721.github.io/asva-official/index.html', label: '打开 ASVA 官网' },
    { className: 'resource-banner-mindtest', src: 'assets/asva-mindtest-banner.jpg', desktopWebp: 'assets/asva-mindtest-banner.webp', mobileWebp: 'assets/asva-mindtest-banner-mobile.webp', href: 'https://xiangshu3721.github.io/mindtest-web/', label: '打开 ASVA 常用心理测试' },
    { className: 'resource-banner-practice', src: 'assets/asva-practice-banner.jpg', desktopWebp: 'assets/asva-practice-banner.webp', mobileWebp: 'assets/asva-practice-banner-mobile.webp', href: 'https://xiangshu3721.github.io/asva-official/explore.html', label: '打开 ASVA 导师修炼包' },
  ]
  useEffect(() => {
    if (isPaused) return undefined
    const timer = window.setInterval(() => setActiveIndex((current) => (current + 1) % banners.length), 6000)
    return () => window.clearInterval(timer)
  }, [isPaused, banners.length])
  const moveTo = (index: number) => setActiveIndex((index + banners.length) % banners.length)
  const handleTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    const touch = event.touches[0]
    if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY }
    swipedRef.current = false
  }
  const handleTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current
    const touch = event.changedTouches[0]
    touchStartRef.current = null
    if (!start || !touch) return
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) < 40 || Math.abs(deltaX) <= Math.abs(deltaY)) return
    swipedRef.current = true
    moveTo(activeIndex + (deltaX < 0 ? 1 : -1))
  }
  const handleTouchCancel = () => { touchStartRef.current = null; swipedRef.current = false }
  const handleBannerClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!swipedRef.current) return
    event.preventDefault()
    swipedRef.current = false
  }
  return <section className="resource-banners" aria-label="ASVA 资源入口" onMouseEnter={() => setIsPaused(true)} onMouseLeave={() => setIsPaused(false)} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchCancel}>{banners.map((banner, index) => <a className={`resource-banner ${banner.className} ${index === activeIndex ? 'active' : ''}`} href={banner.href} target="_blank" rel="noreferrer" aria-label={banner.label} aria-hidden={index !== activeIndex} tabIndex={index === activeIndex ? 0 : -1} onClick={handleBannerClick} key={banner.src}>{index === activeIndex && <picture><source media="(max-width: 780px)" srcSet={`${import.meta.env.BASE_URL}${banner.mobileWebp}`} type="image/webp" /><source srcSet={`${import.meta.env.BASE_URL}${banner.desktopWebp}`} type="image/webp" /><img className="resource-banner-image" src={`${import.meta.env.BASE_URL}${banner.src}`} alt={banner.label} width="1600" height="533" loading="eager" decoding="async" fetchPriority={index === 0 ? 'high' : 'auto'} onLoad={() => logAppPerformance('BANNER_IMAGE_LOAD_MS', { banner_index: index + 1 })} /></picture>}</a>)}<div className="resource-carousel-dots" role="tablist" aria-label="选择 Banner">{banners.map((banner, index) => <button className={index === activeIndex ? 'active' : ''} type="button" role="tab" aria-selected={index === activeIndex} aria-label={`第 ${index + 1} 张：${banner.label}`} onClick={() => moveTo(index)} key={banner.src} />)}</div></section>
}

function CustomersPage({ staff, database, directoryLoading, dataReady, directoryError, onDirectoryRetry, canSeeAll, selectedCustomer, resourceCache, onSelect, onGenerateBrief, onGenerateIntelligence, onRefreshCustomerSummary, onGetUnderstanding, onRefreshUnderstanding, onGetSalesUnderstanding, onRefreshSalesUnderstanding, onGetSafetyAssessment, onRefreshSafetyAssessment, onSaveBrief, onSaveReferrer, onGenerateProfile, onConfirmProfile, onUpdateEnrollments, onLoadCustomerProfile, onSourceWorkspace, onSourceStatus, onExtractDocument, onCreateSource, onProcessSource, onReviewProposal, onResolveConflict, onOverrideServiceNecessity, onAddCustomer, profileRefreshRevision }: { staff: Staff; database: Database; directoryLoading: boolean; dataReady: boolean; directoryError: string; onDirectoryRetry: () => void; canSeeAll: boolean; selectedCustomer?: Customer; resourceCache: ResourceCache; onSelect: (id: string) => void; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onGenerateIntelligence: (customer: Customer, database: Database) => Promise<{ summary: AiCoreSummary; brief: AiBrief }>; onRefreshCustomerSummary: (customerId: string) => Promise<Customer | undefined>; onGetUnderstanding: (customerId: string) => Promise<CustomerUnderstandingResponse>; onRefreshUnderstanding: (customerId: string, force?: boolean) => Promise<CustomerUnderstandingResponse>; onGetSalesUnderstanding: (customerId: string) => Promise<CustomerSalesUnderstandingResponse>; onRefreshSalesUnderstanding: (customerId: string, force?: boolean) => Promise<CustomerSalesUnderstandingResponse>; onGetSafetyAssessment: (customerId: string) => Promise<SafetyAssessmentResponse>; onRefreshSafetyAssessment: (customerId: string, force?: boolean) => Promise<SafetyAssessmentResponse>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined>; onGenerateProfile: (customerId: string, text: string) => Promise<ProfileDraft>; onConfirmProfile: (customerId: string, updates: ProfileUpdate[]) => Promise<Customer>; onUpdateEnrollments: (customerId: string, enrollments: EnrollmentDraft[]) => Promise<void>; onLoadCustomerProfile: (customerId: string) => Promise<CustomerProfileResponse>; onSourceWorkspace: (customerId: string) => Promise<SourceWorkspace>; onSourceStatus: (customerId: string, operationId: string) => Promise<SourceSaveStatus>; onExtractDocument: (input: DocumentUploadInput) => Promise<DocumentExtractionResult>; onCreateSource: (input: SourceCreateInput) => Promise<SourceRecord>; onProcessSource: (sourceId: string, force?: boolean) => Promise<{ source: SourceRecord; evidenceItems: SourceWorkspace['evidenceItems']; proposals: SourceWorkspace['proposals']; conflicts: SourceWorkspace['conflicts'] }>; onReviewProposal: (proposalId: string, decision: 'CONFIRM' | 'REJECT') => Promise<void>; onResolveConflict: (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => Promise<void>; onOverrideServiceNecessity: (input: { entityType: 'source' | 'evidence'; id: string; serviceNecessity: 'LOW' | 'RELEVANT' | 'CRITICAL' }) => Promise<SourceWorkspace>; onAddCustomer: () => void; profileRefreshRevision: number }) {
  const [query, setQuery] = useState('')
  const showDirectoryLoading = directoryLoading || !dataReady
  const normalizedQuery = query.trim().toLowerCase()
  const list = database.customers.filter((customer) => !normalizedQuery || `${customer.name} ${customer.phone} ${customer.wechat || ''} ${customer.need} ${customer.notes}`.toLowerCase().includes(normalizedQuery))
  return <div className="customer-page"><div className="customer-list-column"><div className="page-heading"><div><div className="eyebrow">CUSTOMERS</div><h1>客户</h1><p>{canSeeAll ? '查看所有客户与客户档案。' : `${staff.name} 创建的客户档案。`}</p></div><button className="primary-button small" type="button" onClick={onAddCustomer} disabled={showDirectoryLoading}>新增客户</button></div><label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索昵称、手机号或主要问题" disabled={showDirectoryLoading} /></label>{showDirectoryLoading ? <div className="customer-list customer-list-loading" aria-busy="true"><div className="customer-list-skeleton" /><div className="customer-list-skeleton" /><div className="customer-list-skeleton" /></div> : <div className="customer-list">{list.map((customer) => { const course = database.enrollments.find((item) => item.customerId === customer.id && item.status !== 'CANCELLED'); const product = course ? database.products.find((item) => item.id === course.productId) : undefined; const tags = [product?.name || ''].filter(Boolean).slice(0, 2); const coverage = customer.profileMaterialization?.coverage.percentage ?? 0; const helper = product?.name || (coverage < 50 ? '档案较少' : customer.profileUpdatedAt ? `最近更新 ${detailDate(customer.profileUpdatedAt).split(' ')[0]}` : '档案已建立'); return <button key={customer.id} className={`customer-list-item ${selectedCustomer?.id === customer.id ? 'selected' : ''}`} onClick={() => onSelect(customer.id)}><span className="customer-avatar">{customer.initials}</span><span className="customer-list-main"><strong>{customer.name}{tags.length > 0 && <span className="customer-list-tags">{tags.map((tag) => <em key={tag}>{tag}</em>)}</span>}</strong><span>{customer.need || '尚未记录当前困扰'}</span><small>{helper}</small></span><span className="list-chevron">›</span></button> })}</div>}{!showDirectoryLoading && list.length === 0 && <div className="list-empty">{directoryError ? <><p>{directoryError}</p><button className="secondary-button small" type="button" onClick={onDirectoryRetry}>重新加载</button></> : '暂时没有匹配的客户。'}</div>}</div>{selectedCustomer ? <CustomerDetail customer={selectedCustomer} database={database} canSeeAll={canSeeAll} resourceCache={resourceCache} staffId={staff.id} permissionRole={staff.permissionRole} profileRefreshRevision={profileRefreshRevision} onGenerateBrief={onGenerateBrief} onGenerateIntelligence={onGenerateIntelligence} onRefreshCustomerSummary={onRefreshCustomerSummary} onGetUnderstanding={onGetUnderstanding} onRefreshUnderstanding={onRefreshUnderstanding} onGetSalesUnderstanding={onGetSalesUnderstanding} onRefreshSalesUnderstanding={onRefreshSalesUnderstanding} onGetSafetyAssessment={onGetSafetyAssessment} onRefreshSafetyAssessment={onRefreshSafetyAssessment} onSaveBrief={onSaveBrief} onSaveReferrer={onSaveReferrer} onGenerateProfile={onGenerateProfile} onConfirmProfile={onConfirmProfile} onUpdateEnrollments={onUpdateEnrollments} onLoadCustomerProfile={onLoadCustomerProfile} onSourceWorkspace={onSourceWorkspace} onSourceStatus={onSourceStatus} onExtractDocument={onExtractDocument} onCreateSource={onCreateSource} onProcessSource={onProcessSource} onReviewProposal={onReviewProposal} onResolveConflict={onResolveConflict} onOverrideServiceNecessity={onOverrideServiceNecessity} /> : <div className="empty-detail"><span>客</span><h2>{showDirectoryLoading ? '正在准备客户列表' : '选择一位客户'}</h2><p>{showDirectoryLoading ? '客户列表会先显示，详细资料按需加载。' : '从左侧列表打开客户档案。'}</p></div>}</div>
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

type CustomerDetailProps = { customer: Customer; database: Database; canSeeAll: boolean; staffId: string; resourceCache: ResourceCache; onGenerateBrief: (input: { name: string; need: string; expectation: string }) => Promise<string>; onGenerateIntelligence: (customer: Customer, database: Database) => Promise<{ summary: AiCoreSummary; brief: AiBrief }>; onRefreshCustomerSummary: (customerId: string) => Promise<Customer | undefined>; onGetUnderstanding: (customerId: string) => Promise<CustomerUnderstandingResponse>; onRefreshUnderstanding: (customerId: string, force?: boolean) => Promise<CustomerUnderstandingResponse>; onGetSalesUnderstanding: (customerId: string) => Promise<CustomerSalesUnderstandingResponse>; onRefreshSalesUnderstanding: (customerId: string, force?: boolean) => Promise<CustomerSalesUnderstandingResponse>; onGetSafetyAssessment: (customerId: string) => Promise<SafetyAssessmentResponse>; onRefreshSafetyAssessment: (customerId: string, force?: boolean) => Promise<SafetyAssessmentResponse>; onSaveBrief: (customerId: string, brief: string) => Promise<Customer | undefined>; onSaveReferrer: (customerId: string, referrerName: string) => Promise<Customer | undefined>; onGenerateProfile: (customerId: string, text: string) => Promise<ProfileDraft>; onConfirmProfile: (customerId: string, updates: ProfileUpdate[]) => Promise<Customer>; onUpdateEnrollments: (customerId: string, enrollments: EnrollmentDraft[]) => Promise<void>; onLoadCustomerProfile: (customerId: string) => Promise<CustomerProfileResponse>; onSourceWorkspace: (customerId: string) => Promise<SourceWorkspace>; onSourceStatus: (customerId: string, operationId: string) => Promise<SourceSaveStatus>; onExtractDocument: (input: DocumentUploadInput) => Promise<DocumentExtractionResult>; onCreateSource: (input: SourceCreateInput) => Promise<SourceRecord>; onProcessSource: (sourceId: string, force?: boolean) => Promise<{ source: SourceRecord; evidenceItems: SourceWorkspace['evidenceItems']; proposals: SourceWorkspace['proposals']; conflicts: SourceWorkspace['conflicts'] }>; onReviewProposal: (proposalId: string, decision: 'CONFIRM' | 'REJECT') => Promise<void>; onResolveConflict: (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => Promise<void>; onOverrideServiceNecessity: (input: { entityType: 'source' | 'evidence'; id: string; serviceNecessity: 'LOW' | 'RELEVANT' | 'CRITICAL' }) => Promise<SourceWorkspace> }

const detailProfileCards = [
  { title: 'TA是谁', keys: ['birth_date', 'age', 'gender', 'city', 'hometown', 'marital_status', 'children_summary'], labels: { birth_date: '出生日期', age: '年龄', gender: '性别', city: '现居', hometown: '家乡', marital_status: '婚姻状态', children_summary: '子女情况' } },
  { title: '家庭与关系', keys: ['family_summary', 'relationship_conflicts', 'support_system'], labels: { family_summary: '家庭背景', relationship_conflicts: '关系冲突', support_system: '支持系统' } },
  { title: '职业与事业', keys: ['occupation', 'industry', 'position', 'career_stage', 'career_problem', 'career_goal'], labels: { occupation: '职业', industry: '行业', position: '职位', career_stage: '阶段', career_problem: '事业困扰', career_goal: '事业目标' } },
  { title: '兴趣偏好', keys: ['hobbies', 'sports', 'reading', 'travel', 'art_preferences'], labels: { hobbies: '兴趣', sports: '运动', reading: '阅读', travel: '旅行', art_preferences: '艺术' } },
  { title: '性格特点', keys: ['personality_traits', 'communication_style', 'decision_style', 'strengths', 'common_blocks'], labels: { personality_traits: '性格', communication_style: '沟通方式', decision_style: '决策方式', strengths: '优势', common_blocks: '常见卡点' } },
  { title: '核心价值观', keys: ['core_values', 'family_values', 'career_values', 'growth_attitude'], labels: { core_values: '核心价值', family_values: '家庭价值', career_values: '事业价值', growth_attitude: '成长态度' } },
  { title: '当前资源', keys: ['current_resources', 'support_system', 'current_barriers', 'energy_state'], labels: { current_resources: '已有资源', support_system: '支持系统', current_barriers: '当前阻碍', energy_state: '状态' } },
] as const

function detailDate(value?: string | null) { if (!value) return '暂无记录'; return value.replace(/^2026-/, '').replace(/-/g, '/').replace('T', ' ') }
function friendlyDetailDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
function detailProfileText(value: ProfileValue | undefined) { return displayProfileValue(value ?? null) }
function customerProfileFact(customer: Customer, key: string) { return detailProfileText(customer.profileFields?.[key]).trim() }
function profileRendererSections(customer: Customer): ProfileMaterialization['sections'] {
  if (customer.profileMaterializationLoaded !== false && customer.profileMaterialization?.sections?.length) return customer.profileMaterialization.sections
  return detailProfileCards.map((card) => ({ title: card.title, emptyLabel: ['性格特点', '核心价值观', '兴趣偏好'].includes(card.title) ? '待了解' : '待补充', items: card.keys.map((key) => ({ label: card.labels[key as keyof typeof card.labels], text: detailProfileText(customer.profileFields?.[key]), evidenceIds: [], basis: [] })).filter((item) => item.text) }))
}

type EvidenceDisplayInput = { id: string; sourceId?: string; displayText?: string | null; excerpt?: string | null; sourceTitle?: string; typeLabel?: string }
type EvidenceDisplayItem = EvidenceDisplayInput & { displayText: string; excerpt: string; evidenceIds: string[]; sourceIds: string[] }

function normalizeEvidenceDisplayText(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, '').replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').toLocaleLowerCase()
}

function dedupeEvidenceDisplay(items: EvidenceDisplayInput[]): EvidenceDisplayItem[] {
  const result: EvidenceDisplayItem[] = []
  for (const item of items) {
    const displayText = sanitizeUserVisibleText(item.displayText || '')
    const excerptValue = sanitizeUserVisibleText(item.excerpt || '')
    const displayKey = normalizeEvidenceDisplayText(displayText)
    const excerptKey = normalizeEvidenceDisplayText(excerptValue)
    const excerpt = excerptKey === displayKey ? '' : excerptValue
    if (!displayKey && !excerptKey) continue
    const existing = result.find((candidate) => normalizeEvidenceDisplayText(candidate.displayText) === displayKey && displayKey)
    if (!existing) {
      result.push({ ...item, displayText, excerpt, evidenceIds: [item.id], sourceIds: item.sourceId ? [item.sourceId] : [] })
      continue
    }
    const existingExcerptKey = normalizeEvidenceDisplayText(existing.excerpt)
    const sameExcerpt = existingExcerptKey === excerptKey
    const moreSpecific = excerptKey && (!existingExcerptKey || excerptKey.includes(existingExcerptKey))
    const lessSpecific = existingExcerptKey && (!excerptKey || existingExcerptKey.includes(excerptKey))
    if (sameExcerpt || moreSpecific || lessSpecific) {
      if (moreSpecific && !lessSpecific) existing.excerpt = excerpt
      existing.evidenceIds.push(item.id)
      if (item.sourceId && !existing.sourceIds.includes(item.sourceId)) existing.sourceIds.push(item.sourceId)
      continue
    }
    result.push({ ...item, displayText, excerpt, evidenceIds: [item.id], sourceIds: item.sourceId ? [item.sourceId] : [] })
  }
  return result
}

function CustomerProfileRenderer({ customer, profile, loading, error, onLoad, refreshKey = 0 }: { customer: Customer; profile?: CustomerProfileResponse; loading: boolean; error: string; onLoad: (force?: boolean) => Promise<void>; refreshKey?: number }) {
  const [open, setOpen] = useState(false)
  const lastLoadedRefreshKeyRef = useRef<number | null>(null)
  const onLoadRef = useRef(onLoad)
  useEffect(() => { onLoadRef.current = onLoad }, [onLoad])
  useEffect(() => {
    if (!open) return
    const force = lastLoadedRefreshKeyRef.current !== null && refreshKey !== lastLoadedRefreshKeyRef.current
    lastLoadedRefreshKeyRef.current = refreshKey
    void onLoadRef.current(force)
  }, [open, refreshKey])
  const hydratedCustomer = profile ? { ...customer, profileFields: profile.profileFields, profileFieldMeta: profile.profileFieldMeta, profileUpdatedAt: profile.profileUpdatedAt, profileSchemaVersion: profile.profileSchemaVersion, profileVersion: profile.profileVersion, profileMaterialization: profile.profileMaterialization, profileMaterializationLoaded: true } : customer
  const sections = profileRendererSections(hydratedCustomer).map((section) => ({ ...section, title: sanitizeUserVisibleText(section.title), items: section.items.map((item) => ({ ...item, label: sanitizeUserVisibleText(item.label), text: sanitizeUserVisibleText(item.text), basis: dedupeEvidenceDisplay(item.basis.map((reference) => ({ id: reference.evidenceId, sourceId: reference.sourceId, displayText: reference.displayText, excerpt: reference.excerpt }))) })) }))
  const materialization = hydratedCustomer.profileMaterialization
  const coverage = materialization?.coverage.percentage ?? 0
  const provisionalItems = (materialization?.provisionalItems || []).map((item) => ({ ...item, label: sanitizeUserVisibleText(item.label), text: sanitizeUserVisibleText(item.text), basis: dedupeEvidenceDisplay(item.basis.map((reference) => ({ id: reference.evidenceId, sourceId: reference.sourceId, displayText: reference.displayText, excerpt: reference.excerpt }))) }))
  const provisionalForSection = (title: string) => provisionalItems.filter((item) => item.sectionTitle === title)
  const displaySections = [...sections, ...[...new Set(provisionalItems.map((item) => item.sectionTitle))].filter((title) => !sections.some((section) => section.title === title)).map((title) => ({ title, emptyLabel: '待补充', items: [] }))]
  const lifeEvents = materialization?.lifeEvents || []
  const rawNotes = materialization?.rawNotes || ''
  const visibleSectionItemCount = displaySections.reduce((count, section) => count + section.items.filter((item) => item.text.trim()).length + provisionalForSection(section.title).filter((item) => item.text.trim()).length, 0)
  const itemCount = visibleSectionItemCount + lifeEvents.length + (rawNotes ? 1 : 0)
  const hasBaseProfileFields = Object.values(hydratedCustomer.profileFields || {}).some((value) => detailProfileText(value).trim())
  const hasDisplayContent = itemCount > 0 || hasBaseProfileFields
  const showInitialLoading = loading && !profile
  const fieldItems = displaySections.flatMap((section) => section.items)
  const hasConfirmed = fieldItems.some((item) => ['已确认', '人工已确认', 'AI提取 · 人工确认'].includes(item.statusLabel || ''))
  const hasEntered = fieldItems.some((item) => item.statusLabel === '已录入') || Boolean(rawNotes)
  const hasProvisional = provisionalItems.length > 0
  const coverageLabel = showInitialLoading ? '正在读取档案' : error && !profile ? '档案读取失败' : !profile ? '展开后读取' : !hasDisplayContent ? '暂无可展示资料' : hasProvisional && (hasConfirmed || hasEntered) ? '已确认资料与待核实资料' : hasProvisional ? '待核实资料' : hasConfirmed ? '已确认资料' : hasEntered ? '已录入资料' : '已录入资料'
  const autoStatusMessage = profile?.autoOrganizeStatus === 'PROCESSING'
    ? 'AI正在整理资料，原始资料已保存。'
    : profile?.autoOrganizeStatus === 'FAILED'
      ? 'AI整理失败，将自动重试，原始资料已保留。'
      : profile?.autoOrganizeStatus === 'REVIEW_REQUIRED'
        ? 'AI整理完成，部分信息待核实。'
        : profile?.autoOrganizeStatus === 'NO_USABLE_OUTPUT'
          ? '本次整理未生成可展示资料，原始资料已保留。'
          : profile?.autoOrganizeStatus === 'COMPLETED'
            ? 'AI整理完成，档案已更新。'
            : profile?.autoOrganizeStatus === 'PENDING'
              ? 'AI整理等待后台恢复，原始资料已保留。'
              : ''
  const profileContent = showInitialLoading ? <p className="detail-empty-line">正在读取该客户的确认档案…</p>
    : error && !profile ? <div className="detail-empty-line"><p>档案暂时读取失败，客户基础资料不受影响。</p><button className="secondary-button small" type="button" onClick={() => void onLoad()}>重新读取档案</button></div>
      : !profile ? <p className="detail-empty-line">展开后按需读取该客户的确认档案。</p>
          : !hasDisplayContent ? <p className="detail-empty-line">暂无可展示资料。已保存的原始资料仍可在“原始资料与查看依据”中查看。</p>
          : <>
            {rawNotes && <details className="profile-original-notes"><summary>查看原始资料</summary><p>{sanitizeUserVisibleText(rawNotes)}</p></details>}
            <div className="portrait-grid">
              {displaySections.filter((section) => section.items.length > 0 || provisionalForSection(section.title).length > 0).map((section) => <article className="portrait-card" key={section.title}>
                <h3>{section.title}</h3>
                <div className="portrait-facts">
                  {section.items.map((item) => <div className="profile-renderer-fact" key={`${item.label}-${item.text}`}>
                    <span>{item.label}{item.statusLabel && <em className="profile-item-status">{item.statusLabel}</em>}</span><strong>{item.text}</strong>
                    {item.basis.length > 0 && <details><summary>查看依据</summary><div className="profile-basis">{item.basis.map((reference) => <p key={reference.evidenceIds.join('|')} data-evidence-ids={reference.evidenceIds.join(',')}>{reference.displayText}{reference.excerpt && <small>{reference.excerpt}</small>}</p>)}</div></details>}
                  </div>)}
                  {provisionalForSection(section.title).map((item) => <div className="profile-renderer-fact profile-renderer-provisional" key={`provisional-${item.evidenceId}`}>
                    <span>{item.label}{item.statusLabel && <em className="profile-item-status">{item.statusLabel}</em>}</span><strong>{item.text}</strong>
                    {item.basis.length > 0 && <details><summary>查看依据</summary><div className="profile-basis">{item.basis.map((reference) => <p key={reference.evidenceIds.join('|')} data-evidence-ids={reference.evidenceIds.join(',')}>{reference.displayText}{reference.excerpt && <small>{reference.excerpt}</small>}</p>)}</div></details>}
                  </div>)}
                </div>
              </article>)}
            </div>
            {lifeEvents.length ? <div className="profile-life-events"><h3>人生经历与变化</h3>{lifeEvents.slice(0, 8).map((event) => <article className="profile-life-event" key={event.id}>
              <div><strong>{event.title}</strong>{event.occurredAt && <small>{event.occurredAt}</small>}</div>
              <p>{event.detail}</p>
              {event.basis.length > 0 && <details><summary>查看依据</summary><div className="profile-basis">{dedupeEvidenceDisplay(event.basis.map((reference) => ({ id: reference.evidenceId, sourceId: reference.sourceId, displayText: reference.displayText, excerpt: reference.excerpt }))).map((reference) => <p key={reference.evidenceIds.join('|')} data-evidence-ids={reference.evidenceIds.join(',')}>{reference.displayText}{reference.excerpt && <small>{reference.excerpt}</small>}</p>)}</div></details>}
            </article>)}</div> : null}
          </>
  return <section className="customer-detail-section customer-profile-renderer"><details className="record-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span><strong>客户档案</strong><small>{coverageLabel}</small></span><b>{showInitialLoading ? '读取中' : open ? '收起档案' : '展开档案'}</b></summary><div className="record-disclosure-body">{autoStatusMessage && <p className="profile-refresh-note">{autoStatusMessage}</p>}{profileContent}{profile && loading && <p className="profile-refresh-note">正在后台更新档案，当前内容仍可查看。</p>}{profile && error && <p className="profile-refresh-note">最新档案暂时无法更新，当前内容仍保留。</p>}</div></details></section>
}
function customerPaymentLabel(customer: Customer, enrollments: Database['enrollments']) {
  if (!enrollments.length) return customer.paid ? '已付费' : '暂未付费'
  const paid = enrollments.filter((item) => item.paymentStatus === 'PAID' || item.paid).length
  const unrecorded = enrollments.some((item) => !item.paymentStatus || item.paymentStatus === 'UNRECORDED')
  if (paid === enrollments.length && !unrecorded) return '已付费'
  if (paid > 0) return '部分记录缺失'
  return unrecorded ? '部分记录缺失' : '暂未付费'
}
function sourceLabel(source?: string) { return source === 'MANUAL' ? '人工修改' : source === 'AI_INFERENCE' ? 'AI推断' : source === 'AI_EXTRACTED' ? 'AI提取 · 待核实' : source === 'AI_EXTRACTED_CONFIRMED' ? 'AI提取 · 人工确认' : source === 'MENTOR_OBSERVATION' ? '导师观察' : source === 'MENTOR_FACTUAL_INPUT' || source === 'MENTOR_CONFIRMED' ? '导师事实输入' : source === 'ADMIN_CONFIRMED' ? '管理员确认' : source === 'STRUCTURED_INPUT' ? '结构化录入' : source === 'IMPORTED_HISTORY' || source === 'LEGACY_MIGRATION' ? '历史导入' : '客户明确表达' }

function CustomerDetail(props: CustomerDetailProps & { profileRefreshRevision: number; permissionRole: Staff['permissionRole'] }) {
  const { customer, database } = props
  const appointments = database.appointments.filter((item) => item.customerId === customer.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const sessions = database.sessions.filter((item) => item.customerId === customer.id).sort((a, b) => b.date.localeCompare(a.date))
  const enrollments = database.enrollments.filter((item) => item.customerId === customer.id && item.status !== 'CANCELLED')
  const courses = enrollments.map((item) => ({ enrollment: item, product: database.products.find((product) => product.id === item.productId) })).filter((item) => item.product)
  const latestProfileChanges = database.profileChanges.filter((item) => item.customerId === customer.id).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  const latestProfileChange = latestProfileChanges[0]
  const latestOperator = latestProfileChange?.operatorId ? database.staff.find((item) => item.id === latestProfileChange.operatorId) : undefined
  const [understandingByCustomerId, setUnderstandingByCustomerId] = useState<Record<string, CustomerScopedState<CustomerUnderstandingResponse>>>({})
  const [salesByCustomerId, setSalesByCustomerId] = useState<Record<string, CustomerScopedState<CustomerSalesUnderstandingResponse>>>({})
  const [profileByCustomerId, setProfileByCustomerId] = useState<Record<string, CustomerScopedState<CustomerProfileResponse>>>({})
  const [safetyState, setSafetyState] = useState(() => createCustomerScopedState<SafetyAssessmentResponse>(customer.id))
  const [understandingRefreshingCustomerId, setUnderstandingRefreshingCustomerId] = useState<string | null>(null)
  const [salesRefreshingCustomerId, setSalesRefreshingCustomerId] = useState<string | null>(null)
  const [understandingView, setUnderstandingView] = useState<'consultation' | 'sales'>('consultation')
  const [editingEnrollments, setEditingEnrollments] = useState(false)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const activeCustomerIdRef = useRef(customer.id)
  const understandingSequenceRef = useRef(0)
  const salesSequenceRef = useRef(0)
  const profileSequenceRef = useRef(0)
  if (activeCustomerIdRef.current !== customer.id) {
    activeCustomerIdRef.current = customer.id
    understandingSequenceRef.current += 1
    salesSequenceRef.current += 1
    profileSequenceRef.current += 1
  }
  const understandingState = understandingByCustomerId[customer.id]
  const salesState = salesByCustomerId[customer.id]
  const profileState = profileByCustomerId[customer.id]
  const understandingStateIsActive = Boolean(understandingState)
  const salesStateIsActive = Boolean(salesState)
  const safetyStateIsActive = isCustomerScopedStateFor(safetyState, customer.id)
  const understandingResponse = understandingState?.value || null
  const salesResponse = salesState?.value || null
  const safetyResponse = safetyStateIsActive ? safetyState.value : null
  const understandingError = understandingStateIsActive ? understandingState.error : ''
  const salesError = salesStateIsActive ? salesState.error : ''
  const understandingLoading = Boolean(understandingState?.loading)
  const salesLoading = Boolean(salesState?.loading)
  const profileResponse = profileState?.value || undefined
  const profileError = profileState?.error || ''
  const profileLoading = Boolean(profileState?.loading)
  const understandingRefreshing = understandingRefreshingCustomerId === customer.id
  const salesRefreshing = salesRefreshingCustomerId === customer.id
  useEffect(() => { const openProfileComposer = () => { const root = document.querySelector<HTMLElement>('.customer-detail-page.customer-detail-v2'); const moreDetails = root?.querySelector<HTMLDetailsElement>('.customer-more-details'); const evidenceDetails = moreDetails?.querySelector<HTMLDetailsElement>('.evidence-disclosure'); if (!root || !moreDetails || !evidenceDetails) return; moreDetails.open = true; evidenceDetails.open = true; requestAnimationFrame(() => root.querySelector<HTMLElement>('#profile-supplement')?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }; window.addEventListener('asva-open-source-composer', openProfileComposer); return () => window.removeEventListener('asva-open-source-composer', openProfileComposer) }, [customer.id])
  const loadUnderstanding = async () => {
    const requestCustomerId = customer.id
    const cacheKey = customerUnderstandingCacheKey(props.staffId, props.permissionRole, requestCustomerId)
    const current = understandingByCustomerId[requestCustomerId]
    const cached = props.resourceCache.get<CustomerUnderstandingResponse>(cacheKey)
    const cachedEntry = props.resourceCache.getEntry<CustomerUnderstandingResponse>(cacheKey)
    const cachedFresh = Boolean(cachedEntry?.data !== undefined && Date.now() - cachedEntry.updatedAt < DATABASE_TTL_MS)
    if (cached && cachedFresh) {
      setUnderstandingByCustomerId((state) => ({ ...state, [requestCustomerId]: createCustomerScopedState(requestCustomerId, cached) }))
      logAppPerformance('CUSTOMER_UNDERSTANDING_CACHE_HIT', { hit: true })
      return
    }
    const requestSequence = ++understandingSequenceRef.current
    const startedAt = performance.now()
    const previous = current?.value || cached || null
    setUnderstandingByCustomerId((state) => ({ ...state, [requestCustomerId]: createCustomerScopedState(requestCustomerId, previous, true) }))
    try {
      const result = await props.resourceCache.load(cacheKey, () => props.onGetUnderstanding(requestCustomerId), { ttlMs: DATABASE_TTL_MS })
      if (!canCommitCustomerResponse({ requestCustomerId, activeCustomerId: activeCustomerIdRef.current, requestSequence, activeSequence: understandingSequenceRef.current, responseCustomerId: result.customerId })) return
      setUnderstandingByCustomerId((current) => ({ ...current, [requestCustomerId]: { ...current[requestCustomerId], value: result, loading: false, error: '' } }))
      logAppPerformance('CUSTOMER_UNDERSTANDING_FETCH_MS', { duration_ms: Math.round(performance.now() - startedAt) })
    } catch (error) {
      if (activeCustomerIdRef.current !== requestCustomerId || understandingSequenceRef.current !== requestSequence) return
      setUnderstandingByCustomerId((current) => current[requestCustomerId] ? { ...current, [requestCustomerId]: { ...current[requestCustomerId], loading: false, error: error instanceof Error ? error.message : '读取客户理解失败' } } : current)
    } finally {
      if (activeCustomerIdRef.current !== requestCustomerId || understandingSequenceRef.current !== requestSequence) return
      setUnderstandingByCustomerId((current) => current[requestCustomerId] ? { ...current, [requestCustomerId]: { ...current[requestCustomerId], loading: false } } : current)
    }
  }
  const loadCustomerProfile = async (force = false) => {
    const requestCustomerId = customer.id
    const cacheKey = customerProfileCacheKey(props.staffId, props.permissionRole, requestCustomerId, customer.profileVersion ?? 0)
    const cachedProfile = props.resourceCache.get<CustomerProfileResponse>(cacheKey)
    const cachedProfileEntry = props.resourceCache.getEntry<CustomerProfileResponse>(cacheKey)
    const cachedProfileFresh = Boolean(cachedProfileEntry?.data !== undefined && Date.now() - cachedProfileEntry.updatedAt < DATABASE_TTL_MS)
    if (!force && profileByCustomerId[requestCustomerId]?.value && cachedProfileFresh) {
      logAppPerformance('CUSTOMER_PROFILE_CACHE_HIT', { hit: true })
      return
    }
    if (!force && cachedProfile && cachedProfileFresh && !profileByCustomerId[requestCustomerId]?.value) {
      setProfileByCustomerId((current) => ({ ...current, [requestCustomerId]: createCustomerScopedState(requestCustomerId, cachedProfile) }))
      logAppPerformance('CUSTOMER_PROFILE_CACHE_HIT', { hit: true })
      return
    }
    logAppPerformance('CUSTOMER_PROFILE_CACHE_HIT', { hit: Boolean(cachedProfile && cachedProfileFresh && !force) })
    const requestSequence = ++profileSequenceRef.current
    const previous = profileByCustomerId[requestCustomerId]?.value || cachedProfile
    setProfileByCustomerId((current) => ({ ...current, [requestCustomerId]: { ...createCustomerScopedState<CustomerProfileResponse>(requestCustomerId, previous ?? null, true), value: previous ?? null } }))
    const startedAt = performance.now()
    try {
      const result = await props.resourceCache.load(cacheKey, () => props.onLoadCustomerProfile(requestCustomerId), { ttlMs: DATABASE_TTL_MS, force })
      if (!canCommitCustomerResponse({ requestCustomerId, activeCustomerId: activeCustomerIdRef.current, requestSequence, activeSequence: profileSequenceRef.current, responseCustomerId: result.customerId })) return
      setProfileByCustomerId((current) => ({ ...current, [requestCustomerId]: { ...current[requestCustomerId], value: result, loading: false, error: '' } }))
      logAppPerformance('CUSTOMER_PROFILE_FETCH_MS', { duration_ms: Math.round(performance.now() - startedAt), from_cache: Boolean(cachedProfile && !force) })
    } catch (error) {
      if (activeCustomerIdRef.current !== requestCustomerId || profileSequenceRef.current !== requestSequence) return
      setProfileByCustomerId((current) => current[requestCustomerId] ? { ...current, [requestCustomerId]: { ...current[requestCustomerId], loading: false, error: error instanceof Error ? error.message : '读取客户档案失败' } } : current)
    } finally {
      if (activeCustomerIdRef.current !== requestCustomerId || profileSequenceRef.current !== requestSequence) return
      setProfileByCustomerId((current) => current[requestCustomerId] ? { ...current, [requestCustomerId]: { ...current[requestCustomerId], loading: false } } : current)
    }
  }
  const workspaceCacheKey = sourceWorkspaceCacheKey(props.staffId, props.permissionRole, customer.id)
  const cachedWorkspace = props.resourceCache.get<SourceWorkspace>(workspaceCacheKey)
  const cachedWorkspaceEntry = props.resourceCache.getEntry<SourceWorkspace>(workspaceCacheKey)
  const cachedWorkspaceFresh = Boolean(cachedWorkspaceEntry?.data !== undefined && Date.now() - cachedWorkspaceEntry.updatedAt < DATABASE_TTL_MS)
  const loadWorkspace = async (customerId: string, options: { refresh?: boolean } = {}) => {
    const cacheKey = sourceWorkspaceCacheKey(props.staffId, props.permissionRole, customerId)
    const cached = props.resourceCache.get<SourceWorkspace>(cacheKey)
    const startedAt = performance.now()
    const result = await props.resourceCache.load(cacheKey, () => props.onSourceWorkspace(customerId), { ttlMs: DATABASE_TTL_MS, force: Boolean(options.refresh) })
    logAppPerformance('SOURCE_WORKSPACE_FETCH_MS', { duration_ms: Math.round(performance.now() - startedAt), from_cache: Boolean(cached && !options.refresh) })
    return result
  }
  const setWorkspaceCache = (customerId: string, workspace: SourceWorkspace) => { props.resourceCache.set(sourceWorkspaceCacheKey(props.staffId, props.permissionRole, customerId), workspace) }
  const loadSalesUnderstanding = async () => {
    const requestCustomerId = customer.id
    const cacheKey = customerSalesUnderstandingCacheKey(props.staffId, props.permissionRole, requestCustomerId)
    const current = salesByCustomerId[requestCustomerId]
    const cached = props.resourceCache.get<CustomerSalesUnderstandingResponse>(cacheKey)
    const cachedEntry = props.resourceCache.getEntry<CustomerSalesUnderstandingResponse>(cacheKey)
    const cachedFresh = Boolean(cachedEntry?.data !== undefined && Date.now() - cachedEntry.updatedAt < DATABASE_TTL_MS)
    if (cached && cachedFresh) {
      setSalesByCustomerId((state) => ({ ...state, [requestCustomerId]: createCustomerScopedState(requestCustomerId, cached) }))
      logAppPerformance('CUSTOMER_SALES_UNDERSTANDING_CACHE_HIT', { hit: true })
      return
    }
    const requestSequence = ++salesSequenceRef.current
    const previous = current?.value || cached || null
    setSalesByCustomerId((state) => ({ ...state, [requestCustomerId]: createCustomerScopedState(requestCustomerId, previous, true) }))
    try {
      const result = await props.resourceCache.load(cacheKey, () => props.onGetSalesUnderstanding(requestCustomerId), { ttlMs: DATABASE_TTL_MS })
      if (!canCommitCustomerResponse({ requestCustomerId, activeCustomerId: activeCustomerIdRef.current, requestSequence, activeSequence: salesSequenceRef.current, responseCustomerId: result.customerId })) return
      setSalesByCustomerId((current) => ({ ...current, [requestCustomerId]: { ...current[requestCustomerId], value: result, loading: false, error: '' } }))
    } catch (error) {
      if (activeCustomerIdRef.current !== requestCustomerId || salesSequenceRef.current !== requestSequence) return
      setSalesByCustomerId((current) => current[requestCustomerId] ? { ...current, [requestCustomerId]: { ...current[requestCustomerId], loading: false, error: error instanceof Error ? error.message : '读取销售理解失败' } } : current)
    } finally {
      if (activeCustomerIdRef.current !== requestCustomerId || salesSequenceRef.current !== requestSequence) return
      setSalesByCustomerId((current) => current[requestCustomerId] ? { ...current, [requestCustomerId]: { ...current[requestCustomerId], loading: false } } : current)
    }
  }
  const refreshUnderstanding = async (force = false) => {
    const requestCustomerId = customer.id
    const cacheKey = customerUnderstandingCacheKey(props.staffId, props.permissionRole, requestCustomerId)
    const requestSequence = ++understandingSequenceRef.current
    setUnderstandingRefreshingCustomerId(requestCustomerId)
    try {
      const result = await props.onRefreshUnderstanding(requestCustomerId, force)
      props.resourceCache.set(cacheKey, result)
      if (!canCommitCustomerResponse({ requestCustomerId, activeCustomerId: activeCustomerIdRef.current, requestSequence, activeSequence: understandingSequenceRef.current, responseCustomerId: result.customerId })) return
      setUnderstandingByCustomerId((current) => ({ ...current, [requestCustomerId]: { ...(current[requestCustomerId] || createCustomerScopedState<CustomerUnderstandingResponse>(requestCustomerId)), value: result, loading: false, error: '' } }))
    } catch (error) {
      if (activeCustomerIdRef.current === requestCustomerId && understandingSequenceRef.current === requestSequence) setUnderstandingByCustomerId((current) => current[requestCustomerId] ? { ...current, [requestCustomerId]: { ...current[requestCustomerId], loading: false, error: error instanceof Error ? error.message : '重新理解失败' } } : current)
      throw error
    } finally {
      if (activeCustomerIdRef.current === requestCustomerId && understandingSequenceRef.current === requestSequence) setUnderstandingRefreshingCustomerId(null)
    }
  }
  const refreshSalesUnderstanding = async (force = false) => {
    const requestCustomerId = customer.id
    const cacheKey = customerSalesUnderstandingCacheKey(props.staffId, props.permissionRole, requestCustomerId)
    const requestSequence = ++salesSequenceRef.current
    setSalesRefreshingCustomerId(requestCustomerId)
    try {
      const result = await props.onRefreshSalesUnderstanding(requestCustomerId, force)
      props.resourceCache.set(cacheKey, result)
      if (!canCommitCustomerResponse({ requestCustomerId, activeCustomerId: activeCustomerIdRef.current, requestSequence, activeSequence: salesSequenceRef.current, responseCustomerId: result.customerId })) return
      setSalesByCustomerId((current) => ({ ...current, [requestCustomerId]: { ...(current[requestCustomerId] || createCustomerScopedState<CustomerSalesUnderstandingResponse>(requestCustomerId)), value: result, loading: false, error: '' } }))
    } finally {
      if (activeCustomerIdRef.current === requestCustomerId && salesSequenceRef.current === requestSequence) setSalesRefreshingCustomerId(null)
    }
  }
  const onSafetyResponse = useCallback((result: SafetyAssessmentResponse) => {
    if (result.customerId !== activeCustomerIdRef.current) return
    setSafetyState((current) => current.customerId === result.customerId ? { ...current, value: result, loading: false, error: '' } : current)
  }, [])
  const changeUnderstandingView = (next: 'consultation' | 'sales') => {
    setUnderstandingView(next)
    if (next === 'consultation') void loadUnderstanding()
    else void loadSalesUnderstanding()
  }
  useEffect(() => { void loadUnderstanding() }, [customer.id])
  const identityFacts = [customerProfileFact(customer, 'age') || (customer.profileFields?.birth_year ? `${customer.profileFields.birth_year}年生` : ''), customerProfileFact(customer, 'gender'), customerProfileFact(customer, 'city')].filter(Boolean)
  const relationOwner = customer.createdByName || database.staff.find((item) => item.id === customer.createdByStaffId)?.name || ''
  const referrer = customer.referrerName || customer.introducer || ''
  const courseNames = [...new Set(courses.map((item) => item.product?.name).filter((name): name is string => Boolean(name)))]
  const headerOverviewFacts = [...identityFacts, courseNames[0] || customer.intendedCourse || ''].filter(Boolean)
  const understandingProcessing = understandingResponse?.status === 'PROCESSING' || (!understandingResponse && customer.understandingStatus === 'PROCESSING')
  const understandingReadFailed = Boolean(understandingError) || understandingResponse?.status === 'FAILED'
  const currentUnderstanding = understandingResponse?.understanding || (understandingReadFailed ? customer.understanding : undefined)
  const safetySuggestion = safetyResponse?.assessment?.next_action || (safetyResponse?.context_summary.safety_data_sufficiency === 'INSUFFICIENT' ? '先确认客户当前的基本状态与安全，再决定后续服务方式。' : '')
  const serviceSuggestion = safetySuggestion || currentUnderstanding?.service_cautions?.[0]?.prefer || currentUnderstanding?.service_cautions?.[0]?.detail || currentUnderstanding?.next_conversation?.[0]?.suggested_entry || '先从客户当前最重要的一件事开始，保持确认多于解释。'
  const recentUpdate = latestProfileChange ? [friendlyDetailDate(latestProfileChange.updatedAt), latestOperator?.name].filter(Boolean).join(' · ') : ''
  const panelUnderstandingStatus = understandingResponse?.status || (understandingError ? 'FAILED' : customer.understandingStatus || 'STALE')
  const panelUnderstandingError = understandingError && !customer.understanding ? understandingError : ''
  const panelSalesStatus = salesResponse?.status || (salesError ? 'FAILED' : customer.salesUnderstandingStatus || 'STALE')
  return <article className="customer-detail-page customer-detail-v2">
    <header className="customer-detail-header">
      <div className="customer-detail-identity"><span className="customer-detail-avatar">{customer.initials}</span><div><div className="customer-detail-name-row"><h1>{customer.name}</h1><button className="primary-button small customer-profile-update-button" type="button" onClick={() => window.dispatchEvent(new Event('asva-open-source-composer'))}>更新客户档案</button></div>{headerOverviewFacts.length > 0 && <div className="customer-overview-facts">{headerOverviewFacts.map((fact) => <span key={fact}>{fact}</span>)}</div>}</div></div>
      <section className="customer-relationship-block"><div className="customer-relation-facts"><div><span>联系方式</span><strong>{customer.phone ? maskPhone(customer.phone) : customer.wechat ? `微信 ${customer.wechat}` : '—'}</strong>{customer.phone && customer.wechat && <small>微信 {customer.wechat}</small>}</div><div><span>介绍人</span><strong>{referrer || '—'}</strong></div><div><span>创建人</span><strong>{relationOwner || '—'}</strong></div><div><span>已报名课程</span><strong>{courseNames.length ? courseNames.join('、') : '—'}</strong></div></div></section>
      <section className="customer-service-block"><div className={`customer-service-facts ${sessions[0] ? '' : 'customer-service-facts-without-session'}`}>{sessions[0] && <div><span>最近服务</span><strong>{friendlyDetailDate(sessions[0].date).split(' ')[0] || '暂无'}</strong></div>}<div className="customer-service-suggestion"><span>当前建议</span><strong>{serviceSuggestion}</strong></div><div><span>最近更新</span><strong>{recentUpdate || '—'}</strong></div></div></section>
    </header>
    <CustomerUnderstandingOverview understanding={currentUnderstanding} source={understandingResponse?.meta.source} refs={understandingResponse?.evidence_refs || []} loading={understandingLoading} processing={understandingProcessing} error={understandingReadFailed} refreshing={understandingRefreshing} onRefresh={() => void refreshUnderstanding(true)} />
    <CustomerProfileRenderer key={`profile-${customer.id}`} customer={customer} profile={profileResponse} loading={profileLoading} error={profileError} onLoad={loadCustomerProfile} refreshKey={customer.profileVersion ?? 0} />
    <CustomerUnderstandingPanel key={`understanding-${customer.id}`} response={understandingResponse} fallback={customer.understanding} status={panelUnderstandingStatus} error={panelUnderstandingError} loading={understandingLoading} refreshing={understandingRefreshing} onRefresh={() => refreshUnderstanding(true)} customerId={customer.id} onGetSafety={props.onGetSafetyAssessment} onRefreshSafety={props.onRefreshSafetyAssessment} onSafetyResponse={onSafetyResponse} view={understandingView} onViewChange={changeUnderstandingView} salesResponse={salesResponse} salesFallback={customer.salesUnderstanding} salesStatus={panelSalesStatus} salesError={salesError} salesLoading={salesLoading} salesRefreshing={salesRefreshing} onSalesRefresh={() => refreshSalesUnderstanding(true)} courses={courses} canEditEnrollments={props.canSeeAll} onEditEnrollments={() => setEditingEnrollments(true)} />
    <details className="customer-more-details"><summary><span><strong>更多详细资料</strong><small>服务记录、变更历史和原始依据</small></span><b>按需展开</b></summary><div className="customer-more-details-body"><CustomerHistory appointments={appointments} sessions={sessions} database={database} /><ProfileChangeHistory changes={database.profileChanges.filter((item) => item.customerId === customer.id)} /><details className="record-disclosure evidence-disclosure" onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}><summary><span><strong>原始资料与查看依据</strong><small>用自然语言查看资料与依据</small></span><b>查看资料</b></summary><div className="record-disclosure-body">{evidenceOpen ? <EvidenceWorkspace key={customer.id} customer={customer} isAdmin={props.canSeeAll} cachedWorkspace={cachedWorkspace} cachedWorkspaceFresh={cachedWorkspaceFresh} onLoad={loadWorkspace} onWorkspaceChange={setWorkspaceCache} onSourceStatus={props.onSourceStatus} onExtractDocument={props.onExtractDocument} onCreate={props.onCreateSource} onProcess={props.onProcessSource} onResolveConflict={props.onResolveConflict} onOverrideServiceNecessity={props.onOverrideServiceNecessity} /> : <p className="detail-empty-line">展开后加载该客户的资料与查看依据。</p>}</div></details></div></details>
    {editingEnrollments && <EnrollmentEditor customer={customer} products={sortProductsForSelection(database.products.filter(activeProductForManualEntry))} enrollments={enrollments} onClose={() => setEditingEnrollments(false)} onSave={async (drafts) => { await props.onUpdateEnrollments(customer.id, drafts); setEditingEnrollments(false) }} />}
  </article>
}

function understandingStatusLabel(status: string) { return humanizeProcessingStatus(status) }
function CustomerUnderstandingOverview({ understanding, source, refs, loading, processing, error, refreshing, onRefresh }: { understanding?: CustomerUnderstandingV1; source?: string; refs: CustomerUnderstandingResponse['evidence_refs']; loading: boolean; processing: boolean; error: boolean; refreshing: boolean; onRefresh: () => void }) {
  const message = loading || processing ? '正在读取该客户的最新理解…' : '还没有形成一句话理解。'
  return <section className="customer-detail-section understanding-overview-section"><div className="understanding-overview"><div className="understanding-overview-heading"><div className="understanding-overview-label">一句话理解</div><button className="secondary-button small" type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? '理解中…' : '重新理解'}</button></div><div className="understanding-hero">{understanding ? <><p>{sanitizeUserVisibleText(understanding.one_line_understanding?.text || '当前资料不足，先从确认客户最近最在意的事情开始。')}</p>{source === 'STRUCTURED_FALLBACK' && <small className="understanding-read-warning">基于已录入基础资料，尚未形成最新 AI 分析。</small>}{error && <small className="understanding-read-warning">暂时无法获取最新内容，当前显示上一次整理结果。</small>}<UnderstandingEvidence ids={understanding.one_line_understanding?.evidence_ids} refs={refs} /></> : <p className="understanding-empty">{message}</p>}</div></div></section>
}
function safetyStatusLabel(response: SafetyAssessmentResponse | null) {
  if (!response?.assessment) return response?.status === 'PROCESSING' ? '正在确认安全边界' : '尚未形成服务安全判断'
  if (['R2', 'R3', 'R4'].includes(response.assessment.risk_level)) return '需要人工先确认，再决定服务方式'
  if (response.assessment.risk_level === 'UNKNOWN') return '当前信息不足，先补充安全相关信息'
  return '可以继续当前支持，并保持必要确认'
}
function CustomerSafetyPanel({ customerId, onGet, onRefresh, onResponse }: { customerId: string; onGet: (customerId: string) => Promise<SafetyAssessmentResponse>; onRefresh: (customerId: string, force?: boolean) => Promise<SafetyAssessmentResponse>; onResponse: (response: SafetyAssessmentResponse) => void }) {
  const [response, setResponse] = useState<SafetyAssessmentResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const requestSequenceRef = useRef(0)
  const load = async () => {
    const requestSequence = ++requestSequenceRef.current
    setLoading(true)
    try {
      const result = await onGet(customerId)
      if (requestSequence !== requestSequenceRef.current || result.customerId !== customerId) return
      setResponse(result)
      onResponse(result)
    } catch { /* the empty state remains retryable */ } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false)
    }
  }
  const refresh = async () => {
    const requestSequence = ++requestSequenceRef.current
    setRefreshing(true)
    try {
      const result = await onRefresh(customerId, true)
      if (requestSequence !== requestSequenceRef.current || result.customerId !== customerId) return
      setResponse(result)
      onResponse(result)
    } finally {
      if (requestSequence === requestSequenceRef.current) setRefreshing(false)
    }
  }
  const assessment = response?.assessment
  return <section className="customer-detail-section safety-panel"><div className="consultation-module-heading"><div><h3>服务安全边界</h3><p>先确认安全与稳定，再决定具体服务方式。</p></div></div><div className="safety-panel-content"><div className="safety-panel-actions"><span className="safety-status">{loading ? '正在确认当前服务建议…' : safetyStatusLabel(response)}</span><button className="secondary-button small" type="button" disabled={loading || refreshing} onClick={() => void (assessment ? refresh() : load())}>{loading || refreshing ? '确认中…' : assessment ? '重新确认' : '开始确认'}</button></div>{assessment ? <div className="safety-content"><p className="safety-next-action">下一步：{sanitizeUserVisibleText(assessment.next_action)}</p>{assessment.service_cautions.length > 0 && <div className="safety-cautions"><strong>服务提醒</strong>{assessment.service_cautions.map((item) => <span key={item}>{sanitizeUserVisibleText(item)}</span>)}</div>}{assessment.critical_unknowns.length > 0 && <div className="safety-unknowns"><strong>还需要确认</strong>{assessment.critical_unknowns.map((item) => <span key={item}>{sanitizeUserVisibleText(item)}</span>)}</div>}</div> : <p className="safety-empty">{response?.context_summary.safety_data_sufficiency === 'INSUFFICIENT' ? '当前资料还不足以判断安全边界，先从基本状态和当前安全开始确认。' : '需要时可以启动一次安全边界确认。'}</p>}</div></section>
}
function UnderstandingEvidence({ ids, refs }: { ids?: string[]; refs: CustomerUnderstandingResponse['evidence_refs'] }) {
  const items = (ids || []).map((id) => refs.find((item) => item.evidence_id === id)).filter(Boolean) as CustomerUnderstandingResponse['evidence_refs']
  const displayItems = dedupeEvidenceDisplay(items.map((item) => ({ id: item.evidence_id, sourceId: item.source_id, sourceTitle: item.source_title, typeLabel: humanizeEvidenceType(item.evidence_type), displayText: item.display_text, excerpt: item.excerpt })))
  if (!displayItems.length) return <small className="understanding-no-basis">当前没有可展开的直接依据</small>
  return <details className="understanding-evidence"><summary>查看依据</summary><div>{displayItems.map((item) => <article key={item.evidenceIds.join('|')} data-evidence-ids={item.evidenceIds.join(',')}><strong>{item.sourceTitle || '资料记录'}</strong><span className="understanding-evidence-type">{item.typeLabel}</span><span>{item.displayText}</span>{item.excerpt && <small>{item.excerpt}</small>}</article>)}</div></details>
}
function understandingItemTitle(item: UnderstandingInsight, variant: 'default' | 'tension' | 'conversation') {
  if (variant === 'tension') {
    const sides = [item.side_a, item.side_b].filter(Boolean)
    if (sides.length === 2) return sides.map(sanitizeUserVisibleText).join(' ↔ ')
  }
  if (variant === 'conversation' && item.focus) return sanitizeUserVisibleText(item.focus)
  return sanitizeUserVisibleText(item.text)
}
function UnderstandingInsightList({ title, items, refs, variant = 'default' }: { title: string; items: UnderstandingInsight[]; refs: CustomerUnderstandingResponse['evidence_refs']; variant?: 'default' | 'tension' | 'conversation' }) {
  if (!items.length) return null
  return <div className="understanding-block"><h3>{sanitizeUserVisibleText(title)}</h3><div className="understanding-list">{items.map((item, index) => { const detail = sanitizeUserVisibleText(variant === 'conversation' ? item.why_now || item.detail : item.detail); const fullDetail = detail; return <article className={`understanding-item understanding-type-${item.type.toLowerCase()} understanding-item-${variant}`} key={`${item.text}-${index}`}><div className="understanding-item-content"><strong>{understandingItemTitle(item, variant)}</strong>{variant === 'conversation' && detail && <span className="understanding-field-label">为什么现在</span>}{detail && <p className="understanding-summary">{detail}</p>}{fullDetail && fullDetail.length > 105 && <details className="understanding-more"><summary>展开更多</summary><p>{fullDetail}</p></details>}{variant === 'conversation' && item.suggested_entry && <div className="understanding-entry"><span className="understanding-field-label">建议开场</span><p>“{sanitizeUserVisibleText(item.suggested_entry)}”</p></div>}</div><span className="understanding-confidence">{item.confidence === 'HIGH' ? '把握较高' : item.confidence === 'MEDIUM' ? '把握中等' : '待确认'}</span><UnderstandingEvidence ids={item.evidence_ids} refs={refs} /></article> })}</div></div>
}
function ConsultationCard({ item, refs, kind = 'default' }: { item: UnderstandingInsight; refs: CustomerUnderstandingResponse['evidence_refs']; kind?: 'default' | 'entry' | 'question' }) {
  const title = sanitizeUserVisibleText(kind === 'entry' ? item.focus || item.title || item.text : kind === 'question' ? item.suggested_entry || item.title || item.text : item.title || item.text)
  const detail = sanitizeUserVisibleText(kind === 'entry' ? item.why_now || item.detail : item.detail || item.description)
  const fullText = detail || title
  const shouldCollapse = fullText.length > 150
  return <article className={`consultation-card consultation-card-${kind}`}><strong>{title}</strong>{detail && (shouldCollapse ? <details className="consultation-card-more"><summary>了解这件事</summary><p>{detail}</p></details> : <p>{detail}</p>)}{kind === 'entry' && item.suggested_entry && <div className="consultation-entry"><span>可以这样开始</span><p>“{sanitizeUserVisibleText(item.suggested_entry)}”</p></div>}<span className="understanding-confidence">{item.confidence === 'HIGH' ? '把握较高' : item.confidence === 'MEDIUM' ? '把握中等' : '待进一步确认'}</span><UnderstandingEvidence ids={item.evidence_ids} refs={refs} /></article>
}
function ConsultationModule({ title, hint, items, refs, kind = 'default', tone = 'core' }: { title: string; hint?: string; items: UnderstandingInsight[]; refs: CustomerUnderstandingResponse['evidence_refs']; kind?: 'default' | 'entry' | 'question'; tone?: 'core' | 'entry' | 'question' | 'caution' }) {
  if (!items.length) return null
  return <section className={`consultation-module consultation-module-${kind} consultation-module-tone-${tone}`}><div className="consultation-module-heading"><h3>{title}</h3>{hint && <span>{hint}</span>}</div><div className="consultation-module-content"><div className="consultation-card-list">{items.map((item, index) => <ConsultationCard item={item} refs={refs} kind={kind} key={`${item.text}-${index}`} />)}</div></div></section>
}
function salesStrategyLabel(strategy: string) { return humanizeStrategy(strategy) }
function salesTimingLabel(timing: string) { return humanizeTiming(timing) }
function commercialLevelLabel(level: string) { return humanizeLevel(level) }
function SalesInsightCard({ title, explanation, meta, evidenceIds, refs, detail }: { title: string; explanation?: string; meta?: string; evidenceIds?: string[]; refs: CustomerUnderstandingResponse['evidence_refs']; detail?: string }) {
  const full = detail || explanation || ''
  return <article className="sales-insight-card"><strong>{sanitizeUserVisibleText(title)}</strong>{explanation && <p className={full.length > 160 ? 'sales-collapsed-text' : ''}>{sanitizeUserVisibleText(explanation)}</p>}{full.length > 160 && <details className="sales-more"><summary>展开更多</summary><p>{sanitizeUserVisibleText(full)}</p></details>}{meta && <small>{sanitizeUserVisibleText(meta)}</small>}<UnderstandingEvidence ids={evidenceIds} refs={refs} /></article>
}
function SalesUnderstandingView({ customerId, response, fallback, status, error, loading, refreshing, onRefresh, refs, courses, canEditEnrollments, onEditEnrollments }: { customerId: string; response: CustomerSalesUnderstandingResponse | null; fallback?: CustomerSalesUnderstandingV1; status: string; error: string; loading: boolean; refreshing: boolean; onRefresh: () => void; refs: CustomerUnderstandingResponse['evidence_refs']; courses: Array<{ enrollment: Database['enrollments'][number]; product?: Product }>; canEditEnrollments: boolean; onEditEnrollments: () => void }) {
  const readFailed = Boolean(error) || status === 'FAILED'
  const safeResponse = response?.customerId === customerId ? response : null
  const rawSales = status === 'PROCESSING' ? null : safeResponse?.salesUnderstanding || (readFailed ? fallback : undefined)
  const sales = rawSales && {
    ...rawSales,
    summary: sanitizeUserVisibleText(rawSales.summary),
    follow_up_focus: rawSales.follow_up_focus.map(sanitizeUserVisibleText),
    do_not_do: rawSales.do_not_do.map(sanitizeUserVisibleText),
    pain_points: rawSales.pain_points.map((item) => ({ ...item, title: sanitizeUserVisibleText(item.title), explanation: sanitizeUserVisibleText(item.explanation), deeper_need_or_fear: sanitizeUserVisibleText(item.deeper_need_or_fear), severity: sanitizeUserVisibleText(item.severity), frequency: sanitizeUserVisibleText(item.frequency), urgency: sanitizeUserVisibleText(item.urgency) })),
    aspirations: rawSales.aspirations.map((item) => ({ ...item, title: sanitizeUserVisibleText(item.title), explanation: sanitizeUserVisibleText(item.explanation), gap: sanitizeUserVisibleText(item.gap), clarity: sanitizeUserVisibleText(item.clarity) })),
    willingness_to_pay: { ...rawSales.willingness_to_pay, explanation: sanitizeUserVisibleText(rawSales.willingness_to_pay.explanation), positive_signals: rawSales.willingness_to_pay.positive_signals.map(sanitizeUserVisibleText), unknowns: rawSales.willingness_to_pay.unknowns.map(sanitizeUserVisibleText) },
    ability_to_pay: { ...rawSales.ability_to_pay, explanation: sanitizeUserVisibleText(rawSales.ability_to_pay.explanation), known_financial_signals: rawSales.ability_to_pay.known_financial_signals.map(sanitizeUserVisibleText), unknowns: rawSales.ability_to_pay.unknowns.map(sanitizeUserVisibleText) },
  }
  if (readFailed && !sales) return <div className="sales-empty"><p>这位客户的销售视角暂时读取失败，可以稍后重试。</p><button className="primary-button small" type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? '重试中…' : '重试'}</button></div>
  if ((loading || status === 'PROCESSING') && !sales) return <p className="understanding-empty">正在读取该客户的销售分析…</p>
  if (!sales) return <div className="sales-empty"><p>还没有整理这个客户的 AI 档案。</p><button className="primary-button small" type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? '整理中…' : '开始整理销售视角'}</button><span>{understandingStatusLabel(status)}</span></div>
  const willingness = sales.willingness_to_pay
  const ability = sales.ability_to_pay
  return <div className="sales-workspace">{readFailed && <p className="understanding-read-warning">暂时无法获取最新内容，当前显示上一次整理结果。</p>}<section className="sales-advice-card"><div className="sales-advice-heading"><div><span className="sales-kicker">AI 销售建议 · 仅供参考</span><h3>{salesStrategyLabel(sales.strategy)}</h3></div><div className="sales-timing">销售时机：{salesTimingLabel(sales.sales_timing)}</div></div><p className="sales-summary">{sales.summary}</p><div className="sales-advice-columns"><div><strong>下一步关注</strong>{sales.follow_up_focus.map((item) => <span key={item}>• {item}</span>)}</div>{sales.do_not_do.length > 0 && <div><strong>暂不做</strong>{sales.do_not_do.map((item) => <span key={item}>• {item}</span>)}</div>}</div><small className="sales-basis-note">商业判断与客户痛苦程度分开看；把握不足时保留待确认。</small></section><div className="sales-grid sales-grid-two"><section className="sales-section"><h3>核心痛点</h3>{sales.pain_points.length ? sales.pain_points.map((item) => <SalesInsightCard key={item.title} title={item.title} explanation={item.explanation} detail={item.deeper_need_or_fear} meta={`严重度 ${item.severity} · 频率 ${item.frequency} · 紧迫度 ${item.urgency} · 把握 ${item.confidence === 'HIGH' ? '高' : item.confidence === 'MEDIUM' ? '中' : '低'}`} evidenceIds={item.evidence_ids} refs={refs} />) : <p className="sales-unknown">当前没有足够证据形成核心痛点判断。</p>}</section><section className="sales-section"><h3>核心痒点 / 渴望</h3>{sales.aspirations.length ? sales.aspirations.map((item) => <SalesInsightCard key={item.title} title={item.title} explanation={item.explanation} detail={item.gap} meta={`清晰度 ${item.clarity} · 把握 ${item.confidence === 'HIGH' ? '高' : item.confidence === 'MEDIUM' ? '中' : '低'}`} evidenceIds={item.evidence_ids} refs={refs} />) : <p className="sales-unknown">当前没有足够证据形成核心渴望判断。</p>}</section></div><div className="sales-grid sales-grid-two"><SalesCommercialCard title="付费意愿" value={commercialLevelLabel(willingness.level)} explanation={willingness.explanation} signals={willingness.positive_signals} unknowns={willingness.unknowns} evidenceIds={willingness.evidence_ids} refs={refs} /><SalesCommercialCard title="支付能力" value={commercialLevelLabel(ability.level)} explanation={ability.explanation} signals={ability.known_financial_signals} unknowns={ability.unknowns} evidenceIds={ability.evidence_ids} refs={refs} /></div><section className="sales-section sales-history"><div className="sales-history-heading"><div><h3>历史报名与服务</h3><p>报名和具体课程目录统一在销售视角查看。</p></div>{canEditEnrollments && <button className="secondary-button small" type="button" onClick={onEditEnrollments}>编辑报名</button>}</div><div className="overview-metrics sales-history-metrics"><DetailMetric label="已报名课程" value={`${courses.length} 门`} /></div><div className="sales-enrollment-directory"><strong>报名课程目录</strong>{courses.length ? <div className="enrollment-list">{courses.map(({ enrollment, product }) => <div className="enrollment-row" key={enrollment.id}><div><strong>{product?.name || enrollment.productId}</strong><small>{enrollment.status === '已完成' ? '已完成' : enrollment.status === '学习中' ? '进行中' : enrollment.status === 'CANCELLED' ? '已取消' : '已报名待确认'} · 报名 {detailDate(enrollment.enrolledAt || enrollment.date)}</small></div><span className={enrollment.paymentStatus === 'PAID' || enrollment.paid ? 'enrollment-paid' : 'enrollment-unrecorded'}>{enrollment.paymentStatus === 'PAID' || enrollment.paid ? '已付费' : enrollment.paymentStatus === 'UNPAID' ? '暂未付费' : '未记录'}</span></div>)}</div> : <p className="sales-unknown">暂无已报名课程。</p>}</div><p className="course-intent-note">课程意向：{courses.length ? '另见客户当前档案中的“意向课程”' : '暂无正式报名；意向课程仍只表示兴趣，不代表已报名。'}</p></section></div>
}
function SalesCommercialCard({ title, value, explanation, signals, unknowns, evidenceIds, refs }: { title: string; value: string; explanation: string; signals: string[]; unknowns: string[]; evidenceIds: string[]; refs: CustomerUnderstandingResponse['evidence_refs'] }) {
  return <section className="sales-section sales-commercial"><div className="sales-commercial-heading"><h3>{sanitizeUserVisibleText(title)}</h3><strong>{sanitizeUserVisibleText(value)}</strong></div><p>{sanitizeUserVisibleText(explanation || '当前证据不足，暂不做商业判断。')}</p>{signals.length > 0 && <div><span>已有信号</span>{signals.map((item) => <small key={item}>• {sanitizeUserVisibleText(item)}</small>)}</div>}{unknowns.length > 0 && <div><span>待确认</span>{unknowns.map((item) => <small key={item}>• {sanitizeUserVisibleText(item)}</small>)}</div>}<UnderstandingEvidence ids={evidenceIds} refs={refs} /></section>
}
function CustomerUnderstandingPanel({ response, fallback, status, error, loading, refreshing, onRefresh, customerId, onGetSafety, onRefreshSafety, onSafetyResponse, view, onViewChange, salesResponse, salesFallback, salesStatus, salesError, salesLoading, salesRefreshing, onSalesRefresh, courses, canEditEnrollments, onEditEnrollments }: { response: CustomerUnderstandingResponse | null; fallback?: CustomerUnderstandingV1; status: string; error: string; loading: boolean; refreshing: boolean; onRefresh: () => void; customerId: string; onGetSafety: (customerId: string) => Promise<SafetyAssessmentResponse>; onRefreshSafety: (customerId: string, force?: boolean) => Promise<SafetyAssessmentResponse>; onSafetyResponse: (response: SafetyAssessmentResponse) => void; view: 'consultation' | 'sales'; onViewChange: (view: 'consultation' | 'sales') => void; salesResponse: CustomerSalesUnderstandingResponse | null; salesFallback?: CustomerSalesUnderstandingV1; salesStatus: string; salesError: string; salesLoading: boolean; salesRefreshing: boolean; onSalesRefresh: () => void; courses: Array<{ enrollment: Database['enrollments'][number]; product?: Product }>; canEditEnrollments: boolean; onEditEnrollments: () => void }) {
  const understandingReadFailed = Boolean(error) || status === 'FAILED'
  const understanding = status === 'PROCESSING' ? undefined : response?.understanding || (understandingReadFailed ? fallback : undefined)
  const salesReadFailed = Boolean(salesError) || salesStatus === 'FAILED'
  const sales = salesReadFailed ? salesFallback : undefined
  const refs = response?.evidence_refs || []
  const safeSalesResponse = salesResponse?.customerId === customerId ? salesResponse : null
  const salesRefs = safeSalesResponse?.evidence_refs || refs
  const topIssues = understanding?.top_issues || []
  const strong = <T extends { confidence: string }>(items: T[]) => items.filter((item) => item.confidence !== 'LOW')
  const entryPoints = (understanding?.next_conversation || []).filter((item) => item.focus || item.suggested_entry || item.prompt).slice(0, 3)
  const questions = (understanding?.next_conversation || []).filter((item) => item.suggested_entry || item.prompt || item.text).slice(0, 4)
  const safety = <CustomerSafetyPanel customerId={customerId} onGet={onGetSafety} onRefresh={onRefreshSafety} onResponse={onSafetyResponse} />
  const consultationContent = error ? <div className="sales-empty"><p>这位客户的 AI 档案暂时读取失败，可以稍后重试。</p><button className="primary-button small" type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? '重试中…' : '重试'}</button></div> : (loading || status === 'PROCESSING') && !understanding ? <p className="understanding-empty">正在读取该客户的咨询档案…</p> : !understanding ? <div className="sales-empty"><p>还没有整理这个客户的 AI 档案。</p><button className="primary-button small" type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? '整理中…' : '开始整理'}</button><span>{understandingStatusLabel(status)}</span></div> : <><div className="consultation-grid"><ConsultationModule title="当前核心议题" hint="最多看三件事" items={strong(topIssues).slice(0, 3)} refs={refs} tone="core" /><ConsultationModule title="咨询切入点" hint="从具体处境开始" items={entryPoints} refs={refs} kind="entry" tone="entry" /><ConsultationModule title="下一步提问建议" hint="事实 → 感受 → 意义 → 模式" items={questions} refs={refs} kind="question" tone="question" />{safety}<ConsultationModule title="服务注意事项" hint="可直接转成行动" items={(understanding.service_cautions || []).slice(0, 4)} refs={refs} tone="caution" /></div><details className="understanding-depth"><summary><span><strong>更多理解</strong><small>人生阶段、资源、核心卡点、关键张力和待了解信息</small></span><b>按需展开</b></summary><div className="understanding-depth-grid"><UnderstandingInsightList title="当前人生阶段" items={understanding.current_life_phase ? [understanding.current_life_phase] : []} refs={refs} /><UnderstandingInsightList title="已有资源" items={strong(understanding.resources_and_strengths || []).slice(0, 3)} refs={refs} /><UnderstandingInsightList title="核心卡点" items={understanding.core_blocks || []} refs={refs} /><UnderstandingInsightList title="关键张力" items={understanding.key_tensions || []} refs={refs} variant="tension" /><UnderstandingInsightList title="待了解信息" items={(understanding.knowledge_gaps || []).map((item) => ({ ...item, text: item.text, detail: item.detail, confidence: 'LOW', type: 'SYNTHESIS' }))} refs={refs} /></div></details></>
  return <section className={`customer-detail-section understanding-panel ${view === 'sales' ? 'sales-view' : 'consultation-view'}`}><div className="customer-view-tabs" role="tablist" aria-label="客户理解视角"><button type="button" className={view === 'consultation' ? 'active' : ''} role="tab" aria-selected={view === 'consultation'} onClick={() => onViewChange('consultation')}>咨询视角</button><button type="button" className={view === 'sales' ? 'active' : ''} role="tab" aria-selected={view === 'sales'} onClick={() => onViewChange('sales')}>销售视角</button></div><div className="understanding-heading-actions"><span className={`understanding-status understanding-status-${(view === 'sales' ? salesStatus : status).toLowerCase()}`}>{understandingStatusLabel(view === 'sales' ? salesStatus : status)}</span><button className="secondary-button small" type="button" disabled={view === 'sales' ? salesRefreshing : refreshing} onClick={view === 'sales' ? onSalesRefresh : onRefresh}>{(view === 'sales' ? salesRefreshing : refreshing) ? '整理中…' : '重新整理'}</button></div>{view === 'sales' ? <SalesUnderstandingView customerId={customerId} response={safeSalesResponse} fallback={sales} status={salesStatus} error={salesError} loading={salesLoading} refreshing={salesRefreshing} onRefresh={onSalesRefresh} refs={salesRefs} courses={courses} canEditEnrollments={canEditEnrollments} onEditEnrollments={onEditEnrollments} /> : consultationContent}</section>
}

function DetailMetric({ label, value, note }: { label: string; value: string; note?: string }) { return <div className="detail-metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div> }
function SectionHeading({ title, meta, icon, action }: { title: string; meta?: string; icon?: string; action?: ReactNode }) { return <div className="customer-section-heading"><div><h2><span className="section-icon">{icon}</span>{title}</h2>{meta && <small>{meta}</small>}</div>{action}</div> }
function SummaryFact({ title, value, note, tone }: { title: string; value: string; note?: string; tone: string }) { return <div className={`summary-fact summary-fact-${tone}`}><span>{title}</span><strong>{value}</strong>{note && <small>{note}</small>}</div> }
function EnrollmentEditor({ customer, products, enrollments, onClose, onSave }: { customer: Customer; products: Product[]; enrollments: Database['enrollments']; onClose: () => void; onSave: (drafts: EnrollmentDraft[]) => Promise<void> }) {
  const [selected, setSelected] = useState<string[]>(() => enrollments.map((item) => item.productId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const toggle = (productId: string) => setSelected((current) => current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId])
  const save = async () => { setSaving(true); setError(''); try { await onSave(selected.map((productId) => ({ productId }))) } catch (saveError) { setError(saveError instanceof Error ? saveError.message : '保存报名失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><section className="modal-card compact-modal"><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">ENROLLMENT EDIT</div><h2>编辑已报名课程</h2><p className="modal-lede">{customer.name} · 移除课程会保留历史并标记为 CANCELLED。</p><div className="enrollment-editor-list">{products.map((product) => <label key={product.id} className="enrollment-editor-option"><input type="checkbox" checked={selected.includes(product.id)} onChange={() => toggle(product.id)} />{product.name}</label>)}{!products.length && <div className="inline-empty">暂无 ACTIVE 产品。</div>}</div>{error && <p className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button type="button" className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存报名'}</button></div></section></div>
}

function CustomerHistory({ appointments, sessions, database }: { appointments: Database['appointments']; sessions: Database['sessions']; database: Database }) { const events = [...appointments.map((item) => ({ id: item.id, date: item.createdAt, type: '预约', title: item.topic, body: item.description || item.expectation, mentorId: item.assignedMentorId })), ...sessions.map((item) => ({ id: item.id, date: item.date, type: '服务记录', title: item.topic, body: item.aiSummary || item.note, mentorId: item.mentorId }))].sort((a, b) => b.date.localeCompare(a.date)); return <section className="customer-detail-section"><SectionHeading title="历史记录" meta={`${events.length} 条`} icon="◷" action={<span className="history-filter">全部</span>} />{events.length ? <div className="history-timeline">{events.map((event) => { const mentor = database.staff.find((item) => item.id === event.mentorId); return <article className="history-event" key={event.id}><time>{detailDate(event.date)}</time><span className="history-dot" /><div><div className="history-event-title"><strong>{event.title}</strong></div><small>{event.type}{mentor ? ` · ${mentor.name}` : ''}</small><p>{event.body || '暂无详细记录。'}</p></div></article> })}</div> : <div className="detail-empty-line">还没有预约或服务记录。</div>}</section> }

function EvidenceWorkspace({ customer, isAdmin, cachedWorkspace, cachedWorkspaceFresh = true, onLoad, onWorkspaceChange, onSourceStatus, onExtractDocument, onCreate, onProcess, onResolveConflict, onOverrideServiceNecessity }: { customer: Customer; isAdmin: boolean; cachedWorkspace?: SourceWorkspace; cachedWorkspaceFresh?: boolean; onLoad: (customerId: string, options?: { refresh?: boolean }) => Promise<SourceWorkspace>; onWorkspaceChange?: (customerId: string, workspace: SourceWorkspace) => void; onSourceStatus: (customerId: string, operationId: string) => Promise<SourceSaveStatus>; onExtractDocument: (input: DocumentUploadInput) => Promise<DocumentExtractionResult>; onCreate: (input: SourceCreateInput) => Promise<SourceRecord>; onProcess: (sourceId: string, force?: boolean) => Promise<{ source: SourceRecord; evidenceItems: SourceWorkspace['evidenceItems']; proposals: SourceWorkspace['proposals']; conflicts: SourceWorkspace['conflicts'] }>; onResolveConflict: (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => Promise<void>; onOverrideServiceNecessity: (input: { entityType: 'source' | 'evidence'; id: string; serviceNecessity: 'LOW' | 'RELEVANT' | 'CRITICAL' }) => Promise<SourceWorkspace> }) {
  const emptyWorkspace: SourceWorkspace = { sources: [], evidenceItems: [], proposals: [], conflicts: [] }
  const [workspace, setWorkspace] = useState<SourceWorkspace>(() => cachedWorkspace || emptyWorkspace)
  const workspaceRef = useRef(cachedWorkspace || emptyWorkspace)
  const workspaceLoadedRef = useRef(Boolean(cachedWorkspace))
  const [workspaceLoaded, setWorkspaceLoaded] = useState(Boolean(cachedWorkspace))
  const [workspaceLoading, setWorkspaceLoading] = useState(!cachedWorkspace)
  const [workspaceRefreshing, setWorkspaceRefreshing] = useState(false)
  const [workspaceLoadError, setWorkspaceLoadError] = useState('')
  const [rawText, setRawText] = useState('')
  const [sourcePerspective, setSourcePerspective] = useState<'STAFF_REPORTED' | 'CUSTOMER_FIRST_PARTY'>('STAFF_REPORTED')
  const [attachedFile, setAttachedFile] = useState<File | null>(null)
  const [attachedDocument, setAttachedDocument] = useState<DocumentExtractionResult | null>(null)
  const [composerOpen, setComposerOpen] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<SourceSaveState>('IDLE')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [analysisSummary, setAnalysisSummary] = useState('')
  const [dialogueReview, setDialogueReview] = useState<DialogueAssessment | null>(null)
  const [dialogueSpeakerId, setDialogueSpeakerId] = useState('')
  const [dialogueConfirmed, setDialogueConfirmed] = useState(false)
  const [dialogueOwnership, setDialogueOwnership] = useState<'UNSET' | 'YES' | 'NO'>('UNSET')
  const saveStateRef = useRef<SourceSaveState>('IDLE')
  const pendingSaveRef = useRef<{ operationId: string; input: SourceCreateInput; startedAt: number } | null>(null)
  const pendingDialogueRef = useRef<{ input: SourceCreateInput; startedAt: number; assessment: DialogueAssessment } | null>(null)
  const processingRef = useRef(new Set<string>())
  const workspaceRequestSequenceRef = useRef(0)
  const setWorkspaceSnapshot = (next: SourceWorkspace) => {
    workspaceRef.current = next
    workspaceLoadedRef.current = true
    setWorkspaceLoaded(true)
    setWorkspace(next)
    onWorkspaceChange?.(customer.id, next)
  }
  const load = async ({ refresh = false }: { refresh?: boolean } = {}) => {
    if (!refresh && workspaceLoadedRef.current && cachedWorkspaceFresh) return workspaceRef.current
    const requestSequence = ++workspaceRequestSequenceRef.current
    const backgroundRefresh = refresh || workspaceLoadedRef.current
    if (backgroundRefresh) setWorkspaceRefreshing(true)
    else setWorkspaceLoading(true)
    try {
      const next = await onLoad(customer.id, { refresh })
      if (requestSequence !== workspaceRequestSequenceRef.current || next.sources.some((source) => source.customerId !== customer.id)) return null
      setWorkspaceSnapshot(next)
      setWorkspaceLoadError('')
      return next
    } catch (loadError) {
      if (requestSequence === workspaceRequestSequenceRef.current) {
        if (workspaceLoadedRef.current) setMessage('暂时无法更新相关依据。')
        else setWorkspaceLoadError('相关依据暂时加载失败')
      }
      return null
    } finally {
      if (requestSequence === workspaceRequestSequenceRef.current) {
        if (backgroundRefresh) setWorkspaceRefreshing(false)
        else setWorkspaceLoading(false)
      }
    }
  }
  useEffect(() => () => { processingRef.current.clear() }, [customer.id])
  useEffect(() => { const open = () => setComposerOpen(true); window.addEventListener('asva-open-source-composer', open); return () => window.removeEventListener('asva-open-source-composer', open) }, [])
  useEffect(() => {
    const shouldWarn = isSourceSavePending(saveState) || saveState === 'UNKNOWN'
    if (!shouldWarn) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '原始资料尚未确认保存，离开页面可能需要重新确认。' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [saveState])
  const attachDocument = async (file: File) => {
    if (file.size > MAX_DOCUMENT_SIZE_MB * 1024 * 1024) { setAttachedFile(null); setAttachedDocument(null); setError('文件较大，请压缩后再上传。'); return }
    setAttachedFile(file); setAttachedDocument(null); setError(''); setMessage('正在读取资料…')
    try { const base64 = await fileToBase64(file); const extracted = await onExtractDocument({ filename: file.name, mimeType: file.type, extension: `.${file.name.toLowerCase().split('.').pop() || ''}`, size: file.size, base64 }); setAttachedDocument(extracted); setMessage(`已读取 ${extracted.char_count.toLocaleString()} 字`) } catch (extractError) { setAttachedFile(null); setAttachedDocument(null); setMessage(''); setError(sourceFailureMessage(extractError, 'save')) }
  }
  const mergeProcessed = (processed: { source: SourceRecord; evidenceItems: SourceWorkspace['evidenceItems']; proposals: SourceWorkspace['proposals']; conflicts: SourceWorkspace['conflicts'] }) => {
    if (processed.source.customerId !== customer.id) return
    const current = workspaceRef.current
    const next = { sources: [processed.source, ...current.sources.filter((item) => item.id !== processed.source.id)], evidenceItems: [...current.evidenceItems.filter((item) => item.sourceId !== processed.source.id), ...processed.evidenceItems], proposals: [...current.proposals.filter((item) => item.sourceId !== processed.source.id), ...processed.proposals], conflicts: [...current.conflicts.filter((item) => !processed.conflicts.some((conflict) => conflict.id === item.id)), ...processed.conflicts] }
    setWorkspaceSnapshot(next)
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
        if (source.processingStatus === 'UPLOADED') {
          try { mergeProcessed(await onProcess(source.id)) } catch { if (!cancelled) setMessage('已保存，正在整理；稍后可重试。') } finally { processingRef.current.delete(source.id) }
        } else processingRef.current.delete(source.id)
      }
    }
    void reconcile()
    return () => { cancelled = true }
  }, [customer.id])
  const retrySource = async (sourceId: string) => {
    setSaving(true); setError('')
    try { mergeProcessed(await onProcess(sourceId, true)); setMessage('已重新识别并整理完成') } catch (processError) { await load({ refresh: true }); setMessage(sourceFailureMessage(processError)) } finally { setSaving(false) }
  }
  const updateSaveState = (event: Parameters<typeof transitionSourceSaveState>[1]) => {
    const next = transitionSourceSaveState(saveStateRef.current, event)
    saveStateRef.current = next
    setSaveState(next)
    return next
  }
  const confirmSourceSave = (source: SourceRecord, saveStartedAt: number) => {
    const nextState = updateSaveState('PERSISTED')
    if (!shouldStartSourceAi(nextState)) return
    pendingSaveRef.current = null
    setSaving(false)
    setRawText('')
    setAttachedFile(null)
    setAttachedDocument(null)
    setComposerOpen(false)
    setMessage(`已确认保存，正在整理 · ${Math.round(performance.now() - saveStartedAt)}ms`)
    setAnalysisSummary('')
    setDialogueReview(null)
    setDialogueSpeakerId('')
    setDialogueConfirmed(false)
    setDialogueOwnership('UNSET')
    void onProcess(source.id).then(mergeProcessed).then(() => setMessage('已确认保存并完成整理')).catch(async (processError) => { await load({ refresh: true }); setMessage(sourceFailureMessage(processError)) })
  }
  const recoverPendingSave = async (pending: { operationId: string; input: SourceCreateInput; startedAt: number }) => {
    updateSaveState('TIMEOUT')
    setMessage('保存响应超时，正在确认资料是否已经保存…')
    try {
      const status = await onSourceStatus(customer.id, pending.operationId)
      const persisted = status.status === 'PERSISTED' && status.source?.customerId === customer.id ? status.source : null
      if (persisted) { confirmSourceSave(persisted, pending.startedAt); return }
    } catch { /* keep UNKNOWN so the user can safely retry with the same operationId */ }
    updateSaveState('STATUS_UNKNOWN')
    setSaving(false)
    setMessage('保存结果暂未确认，原内容仍保留，可重新确认保存。')
  }
  const persistAfterDialogueConfirmation = async (input: SourceCreateInput, startedAt: number) => {
    pendingSaveRef.current = { operationId: input.operationId || '', input, startedAt }
    const source = await onCreate(input)
    confirmSourceSave(source, startedAt)
  }
  const rejectDialogue = () => {
    pendingDialogueRef.current = null
    setDialogueReview(null)
    setDialogueSpeakerId('')
    setDialogueConfirmed(false)
    setDialogueOwnership('UNSET')
    setMessage('已取消保存，资料仍保留，请修改后重试。')
  }
  useEffect(() => { if (dialogueOwnership === 'NO') rejectDialogue() }, [dialogueOwnership])
  const confirmDialogueAndSave = async () => {
    const pending = pendingDialogueRef.current
    const oneSpeaker = dialogueReview?.classification === 'ONE_SPEAKER'
    if (!pending || !dialogueReview || (oneSpeaker ? dialogueOwnership === 'UNSET' : (!dialogueConfirmed || !dialogueSpeakerId))) return
    setSaving(true); setError('')
    try {
      if (oneSpeaker && dialogueOwnership === 'NO') {
        rejectDialogue()
        setSaving(false)
        return
      }
      const confirmation = await requireDialogueGateHandlers().confirm({ analysisToken: dialogueReview.analysisToken, contentHash: dialogueReview.contentHash, targetCustomerId: customer.id, speakerId: oneSpeaker ? undefined : dialogueSpeakerId })
      pendingDialogueRef.current = null
      await persistAfterDialogueConfirmation({ ...pending.input, dialogueConfirmation: confirmation.dialogueConfirmation }, pending.startedAt)
    } catch (confirmError) {
      setSaving(false)
      setError(confirmError instanceof Error ? confirmError.message : '说话人确认失败')
    }
  }
  const save = async () => {
    if ((!rawText.trim() && !attachedFile) || saving || isSourceSavePending(saveStateRef.current)) return
    setSaving(true); setError(''); setMessage('')
    updateSaveState('START')
    const saveStartedAt = pendingSaveRef.current?.startedAt || performance.now()
    try {
      const document = attachedFile && attachedDocument ? { filename: attachedFile.name, mimeType: attachedFile.type, extension: `.${attachedFile.name.toLowerCase().split('.').pop() || ''}`, size: attachedFile.size, fileHash: attachedDocument.file_hash, charCount: attachedDocument.char_count, extractedText: attachedDocument.extracted_text } : undefined
      const input = pendingSaveRef.current?.input || { operationId: `source-${customer.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`, customerId: customer.id, sourceType: attachedFile ? 'FILE_UPLOAD' : 'TEXT_INPUT', rawText: attachedFile ? attachedDocument?.extracted_text || '' : rawText.trim(), sourcePerspective, notes: attachedFile ? rawText.trim() : undefined, document, dialogueConfirmation: '' }
      if (!pendingSaveRef.current) {
        if (attachedFile && attachedDocument) {
          const assessment = await requireDialogueGateHandlers().identify({ text: input.rawText, targetCustomerId: customer.id })
          if (assessment.classification !== 'NOT_DIALOGUE') {
            pendingDialogueRef.current = { input, startedAt: saveStartedAt, assessment }
            setDialogueReview(assessment)
            setDialogueSpeakerId('')
            setDialogueConfirmed(false)
          setDialogueOwnership('UNSET')
            setSaving(false)
            saveStateRef.current = 'IDLE'
            setSaveState('IDLE')
            setMessage('请先确认资料中的说话人是否为当前客户。')
            return
          }
          const confirmation = await requireDialogueGateHandlers().confirm({ analysisToken: assessment.analysisToken, contentHash: assessment.contentHash, targetCustomerId: customer.id })
          await persistAfterDialogueConfirmation({ ...input, dialogueConfirmation: confirmation.dialogueConfirmation }, saveStartedAt)
        } else {
          pendingSaveRef.current = { operationId: input.operationId || '', input, startedAt: saveStartedAt }
          const source = await onCreate(input)
          confirmSourceSave(source, saveStartedAt)
        }
      } else {
        const source = await onCreate(pendingSaveRef.current.input)
        confirmSourceSave(source, pendingSaveRef.current.startedAt)
      }
    } catch (saveError) {
      const code = (saveError as { code?: string; serverCode?: string })?.code || (saveError as { serverCode?: string })?.serverCode
      if (code === 'REQUEST_TIMEOUT' || code === 'NETWORK_UNREACHABLE' || code === 'CORS_ERROR') {
        const pending = pendingSaveRef.current
        if (pending) await recoverPendingSave(pending)
        else { updateSaveState('STATUS_UNKNOWN'); setSaving(false); setMessage('保存结果暂未确认，原内容仍保留，可重新确认保存。') }
      } else {
        updateSaveState('DEFINITE_FAILURE')
        pendingSaveRef.current = null
        setError(sourceFailureMessage(saveError, 'save'))
        setSaving(false)
      }
    }
  }
  const resolve = async (conflictId: string, resolution: 'USE_NEW' | 'KEEP_CURRENT' | 'KEEP_BOTH' | 'MARK_UNKNOWN') => { setSaving(true); try { await onResolveConflict(conflictId, resolution); await load({ refresh: true }) } catch (resolveError) { setError(resolveError instanceof Error ? resolveError.message : '冲突处理失败') } finally { setSaving(false) } }
  const overrideNecessity = async (evidenceId: string, serviceNecessity: 'LOW' | 'RELEVANT' | 'CRITICAL') => { setSaving(true); setError(''); try { setWorkspaceSnapshot(await onOverrideServiceNecessity({ entityType: 'evidence', id: evidenceId, serviceNecessity })); setMessage('服务必要性已更新') } catch (overrideError) { setError(overrideError instanceof Error ? overrideError.message : '服务必要性更新失败') } finally { setSaving(false) } }
  const grouped = (type: string) => workspace.evidenceItems.filter((item) => item.evidenceType === type)
  const fieldLabel = (field: string) => ({ birth_date: '出生日期', gender: '性别', phone: '手机号', wechat: '微信号', city: '居住城市', current_city: '居住城市', occupation: '当前职业', job_status: '工作状态', employment_status: '工作状态', relationship_status: '关系状态', marital_status: '婚姻状态', age: '年龄', sleep: '睡眠情况', sleep_status: '睡眠情况' } as Record<string, string>)[field] || '待确认资料'
  const dialogueNeedsRestructure = dialogueReview && ['OVER_TWO_SPEAKERS', 'UNCERTAIN'].includes(dialogueReview.classification)
  return <section className="customer-detail-section profile-supplement" id="profile-supplement" aria-busy={workspaceLoading} data-refreshing={workspaceRefreshing ? 'true' : undefined}>
    <SectionHeading title="档案记录" meta={`已记录 ${workspace.sources.length} 份 · 待确认 ${workspace.conflicts.filter((item) => item.status === 'OPEN').length} 项`} icon="＋" action={<button className="secondary-button small" type="button" onClick={() => setComposerOpen((open) => !open)}>{composerOpen ? '收起' : '＋ 补充档案'}</button>} />
    {workspaceLoading && <p className="understanding-empty evidence-workspace-loading">正在加载相关依据…</p>}
    {dialogueReview && <div className="dialogue-review" role="alert"><strong>保存前确认资料人物归属</strong><p>{dialogueReview.summary}</p>{dialogueReview.classification === 'ONE_SPEAKER' ? <><p>这段内容是否属于当前客户的档案信息？</p><div className="dialogue-ownership-options"><button type="button" className={dialogueOwnership === 'YES' ? 'selected' : 'secondary-button'} onClick={() => { setDialogueOwnership('YES'); setDialogueConfirmed(true); setDialogueSpeakerId(dialogueReview.speakers[0]?.id || '') }}>是，属于当前客户</button><button type="button" className={dialogueOwnership === 'NO' ? 'selected' : 'secondary-button'} onClick={() => setDialogueOwnership('NO')}>否，录入错误</button></div></> : dialogueNeedsRestructure ? <p>{dialogueReview.classification === 'OVER_TWO_SPEAKERS' ? '识别到超过两位实际说话人，请拆分资料后重新识别。' : '暂时无法可靠识别实际说话人，请标注说话人或整理文本后重新识别。'}</p> : <p>识别结果：2 位说话人。请选择哪位是当前客户：</p>}{dialogueReview.classification !== 'ONE_SPEAKER' && <div className="dialogue-speaker-options">{dialogueReview.speakers.map((speaker) => <label key={speaker.id}><input type="radio" name={`dialogue-speaker-${customer.id}`} value={speaker.id} checked={dialogueSpeakerId === speaker.id} onChange={() => setDialogueSpeakerId(speaker.id)} disabled={Boolean(dialogueNeedsRestructure)} />说话人 {speaker.id}：{speaker.excerpt || '暂无代表性原文'}（AI建议：{speaker.suggestedRole === 'CUSTOMER' ? '客户' : speaker.suggestedRole === 'MENTOR' ? '导师' : speaker.suggestedRole === 'OTHER' ? '其他参与者' : '未知'}）</label>)}</div>}{dialogueReview.classification === 'TWO_SPEAKERS' && <label className="dialogue-confirm-check"><input type="checkbox" checked={dialogueConfirmed} onChange={(event) => setDialogueConfirmed(event.target.checked)} />确认所选说话人为当前客户</label>}{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={() => { pendingDialogueRef.current = null; setDialogueReview(null); setDialogueSpeakerId(''); setDialogueConfirmed(false); setDialogueOwnership('UNSET'); setMessage('请修改资料后重新识别。') }}>返回修改</button><button type="button" className="primary-button" disabled={Boolean(dialogueNeedsRestructure) || (dialogueReview.classification === 'ONE_SPEAKER' ? dialogueOwnership !== 'YES' : !dialogueSpeakerId || !dialogueConfirmed) || saving} onClick={() => void confirmDialogueAndSave()}>{saving ? '确认中…' : dialogueReview.classification === 'ONE_SPEAKER' ? '确认归属并保存' : '确认人物并保存'}</button></div></div>}
    {workspaceLoadError && !workspaceLoading && !workspaceLoaded && <div className="evidence-load-error"><p>{workspaceLoadError}</p><button className="secondary-button small" type="button" onClick={() => void load()}>重试</button></div>}
    {composerOpen && <>
      <p className="supplement-note">写下补充说明，或上传一份资料；保存后系统会在后台读取并整理。</p>
      <textarea value={rawText} disabled={isSourceSavePending(saveState) || saveState === 'UNKNOWN' || Boolean(dialogueReview)} onChange={(event) => setRawText(event.target.value)} placeholder="可选：补充资料背景，例如：这是客户上周咨询后的整理资料。" />
      <small className="field-hint input-method-voice-hint">🎙 语音录入：点击输入框，使用手机键盘上的麦克风说话，即可转换成文字。</small>
      <label className="perspective-toggle"><input type="checkbox" disabled={isSourceSavePending(saveState) || saveState === 'UNKNOWN' || Boolean(dialogueReview)} checked={sourcePerspective === 'CUSTOMER_FIRST_PARTY'} onChange={(event) => setSourcePerspective(event.target.checked ? 'CUSTOMER_FIRST_PARTY' : 'STAFF_REPORTED')} /> 这是客户本人原话 / 原始资料</label>
      <div className="source-tools">
        <label className="secondary-button file-button">上传资料<input type="file" disabled={isSourceSavePending(saveState) || saveState === 'UNKNOWN' || Boolean(dialogueReview)} accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void attachDocument(file) }} /></label>
        <button className="primary-button" type="button" disabled={(!rawText.trim() && !(attachedFile && attachedDocument)) || saving || isSourceSavePending(saveState) || Boolean(attachedFile && !attachedDocument) || Boolean(dialogueReview)} onClick={() => void save()}>{saving ? '保存中…' : saveState === 'UNKNOWN' ? '重新确认保存' : saveState === 'FAILED' ? '重试保存' : '保存'}</button>
      </div>
      {attachedFile && <small className="status-note">📄 {attachedFile.name} · {attachedDocument ? `已读取 ${attachedDocument.char_count.toLocaleString()} 字` : '正在读取资料…'}</small>}
      {message && <small className="status-note">{message}</small>}
      {error && <p className="form-error">{error}</p>}
    </>}
    {workspace.sources.slice(0, 8).map((source) => {
      const file = sourceFileInfo(source.fileRef)
      const stale = isStaleProcessing(source)
      const presentation = sourceProcessingPresentation(source.processingStatus, source.processingError || '', stale)
      const resumable = shouldResumeSource(source) || source.processingStatus === 'FAILED'
      return <div className="source-file-status" key={source.id}>
        <span>{file ? `📄 ${file.original_filename}` : `✎ ${source.title || '文字资料'}`}</span>
        <small>{presentation.label}{presentation.message ? ` · ${presentation.message}` : ''}</small>
        {resumable && <button className="secondary-button small" type="button" disabled={saving} onClick={() => void retrySource(source.id)}>{source.processingStatus === 'FAILED' ? '重新整理' : '继续整理'}</button>}
      </div>
    })}
    {analysisSummary && <p className="analysis-summary">{analysisSummary}</p>}
    {workspace.conflicts.filter((item) => item.status === 'OPEN').map((conflict) => {
      const evidence = workspace.evidenceItems.find((item) => item.id === conflict.newEvidenceId)
      const source = workspace.sources.find((item) => item.id === evidence?.sourceId)
      return <div className="profile-draft-row conflict" key={conflict.id}>
        <strong>需要确认：{fieldLabel(conflict.fieldKey)}</strong>
        <span>当前：{displayProfileValue(conflict.currentValue as ProfileValue)}；资料中：{displayProfileValue(conflict.newValue as ProfileValue)}</span>
        <small>来源：{source?.title || '资料记录'} · 可展开“查看整理依据”回看原文依据。</small>
        <div className="review-actions">
          <button className="secondary-button small" type="button" disabled={saving} onClick={() => void resolve(conflict.id, 'KEEP_CURRENT')}>保持当前档案</button>
          <button className="secondary-button small" type="button" disabled={saving} onClick={() => void resolve(conflict.id, 'MARK_UNKNOWN')}>暂不处理</button>
          <button className="primary-button small" type="button" disabled={saving} onClick={() => void resolve(conflict.id, 'USE_NEW')}>覆盖到档案</button>
        </div>
      </div>
    })}
    <details className="advanced-evidence"><summary>查看整理依据</summary><div className="evidence-results"><EvidenceGroup title="明确信息" items={grouped('FACT')} isAdmin={isAdmin} saving={saving} onOverrideNecessity={overrideNecessity} /><EvidenceGroup title="客户表达" items={grouped('SELF_MEANING')} isAdmin={isAdmin} saving={saving} onOverrideNecessity={overrideNecessity} /><EvidenceGroup title="导师观察" items={grouped('OBSERVATION')} isAdmin={isAdmin} saving={saving} onOverrideNecessity={overrideNecessity} /><EvidenceGroup title="AI提示（仅供参考）" items={grouped('HYPOTHESIS')} weak isAdmin={isAdmin} saving={saving} onOverrideNecessity={overrideNecessity} /></div></details>
  </section>
}

function EvidenceGroup({ title, items, weak = false, isAdmin, saving, onOverrideNecessity }: { title: string; items: SourceWorkspace['evidenceItems']; weak?: boolean; isAdmin: boolean; saving: boolean; onOverrideNecessity: (evidenceId: string, serviceNecessity: 'LOW' | 'RELEVANT' | 'CRITICAL') => Promise<void> }) {
  const displayItems = dedupeEvidenceDisplay(items.map((item) => ({ id: item.id, sourceId: item.sourceId, displayText: item.displayText, excerpt: item.sourceExcerpt })))
  return <div className={`profile-section evidence-group ${weak ? 'evidence-group-weak' : ''}`}><h3>{sanitizeUserVisibleText(title)} <small>{items.length}</small></h3>{displayItems.length ? <div className="profile-update-list">{displayItems.map((item) => { const original = items.find((candidate) => candidate.id === item.evidenceIds[0]); if (!original) return null; const high = original.privacyLevel === 'HIGH_SENSITIVE'; const necessity = original.serviceNecessity === 'LOW' || original.serviceNecessity === 'CRITICAL' ? original.serviceNecessity : 'RELEVANT'; const displayText = item.displayText; const sourceExcerpt = item.excerpt; const showExcerpt = sourceExcerpt && sourceExcerpt.replace(/\s+/g, '') !== displayText.replace(/\s+/g, ''); return <div className="profile-update" key={item.evidenceIds.join('|')} data-evidence-ids={item.evidenceIds.join(',')}>{high && <strong>🔒 高度敏感资料</strong>}<strong>{displayText}</strong>{isAdmin || !high ? (showExcerpt && <span>{sourceExcerpt}</span>) : <><span>{sanitizeUserVisibleText(original.mentorServiceDetail || original.mentorSafeText || original.displayText)}</span>{original.necessaryExcerpt && <small>必要服务片段：{sanitizeUserVisibleText(original.necessaryExcerpt)}</small>}<small>请谨慎处理，必要时咨询专业督导老师。</small></>}{isAdmin && high && <label className="privacy-necessity-control">服务必要性<select value={necessity} disabled={saving} onChange={(event) => void onOverrideNecessity(original.id, event.target.value as 'LOW' | 'RELEVANT' | 'CRITICAL')}><option value="LOW">LOW · 非必要</option><option value="RELEVANT">RELEVANT · 相关</option><option value="CRITICAL">CRITICAL · 必要</option></select></label>}</div> })}</div> : <div className="profile-empty">暂无</div>}</div>
}

function ProfileSupplement({ customer, onGenerate, onConfirm }: { customer: Customer; onGenerate: (customerId: string, text: string) => Promise<ProfileDraft>; onConfirm: (customerId: string, updates: ProfileUpdate[]) => Promise<Customer> }) {
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const analyze = async () => { if (!text.trim() || loading) return; setLoading(true); try { setDraft(await onGenerate(customer.id, text.trim())) } finally { setLoading(false) } }
  const confirm = async () => { if (!draft?.updates.length || saving) return; setSaving(true); try { await onConfirm(customer.id, draft.updates); setDraft(null); setText('') } finally { setSaving(false) } }
  return <section className="customer-detail-section profile-supplement" id="profile-supplement"><SectionHeading title="补充客户档案" meta="文字补充，AI先整理建议" icon="＋" /><p className="supplement-note">先记录新的事实，AI 会拆成字段更新建议；冲突信息会在确认前单独标记。</p><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="例如：客户最近已经离职，开始考虑自由职业，平时恢复了瑜伽。" /><small className="field-hint input-method-voice-hint">🎙 语音录入：点击输入框，使用手机键盘上的麦克风说话，即可转换成文字。</small><div className="supplement-actions"><button className="primary-button" type="button" disabled={!text.trim() || loading} onClick={() => void analyze()}>{loading ? 'AI分析中…' : '文字补充'}</button></div>{draft && <div className="profile-draft"><strong>AI更新建议</strong>{draft.updates.length ? draft.updates.map((update) => <div className={`profile-draft-row ${update.conflict ? 'conflict' : ''}`} key={update.field}><span>{profileUpdateLabel(update)}</span><b>{update.conflict ? `${displayProfileValue(update.previousValue ?? null)} → ` : ''}{displayProfileValue(update.value)}</b><small>{sourceLabel(update.source)}{update.conflict ? ' · 与已有记录不同，确认后才覆盖' : ' · 待确认'}</small></div>) : <p>没有识别到新的档案信息，本次不写入。</p>}{draft.updates.length > 0 && <button className="primary-button" type="button" disabled={saving} onClick={() => void confirm()}>{saving ? '保存中…' : '确认更新档案'}</button>}</div>}</section>
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
  return <div className="modal-backdrop"><form className="modal-card form-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose}>×</button>{step === 'form' ? <><div className="eyebrow">FOLLOW-UP FEEDBACK</div><h2>补充跟进反馈</h2><p className="modal-lede">{customer.name} · 先把本次预约的信息补全。</p><label>本次主要聊了什么？<textarea value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="记录本次沟通的核心内容。" autoFocus /></label><label>本次跟进结果<div className="option-grid">{['暂无进一步需求', '需要继续关注', '有课程 / 服务意向', '已付费', '需要其他导师支持'].map((item) => <button type="button" key={item} className={result === item ? 'option-button selected' : 'option-button'} onClick={() => setResult(item)}>{item}</button>)}</div></label><label>当前核心需求<input value={coreNeed} onChange={(event) => setCoreNeed(event.target.value)} /></label><div className="form-two-col"><label>是否付费<select value={paid ? '是' : '否'} onChange={(event) => setPaid(event.target.value === '是')}><option>否</option><option>是</option></select></label><label>SABC<select value={grade} onChange={(event) => setGrade(event.target.value as CustomerGrade)}>{['S', 'A', 'B', 'C'].map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="form-two-col"><label>意向课程<select value={course} onChange={(event) => setCourse(event.target.value)}><option value="">尚未判断</option>{sortProductsForSelection(database.products).map((product) => <option key={product.id} value={product.name}>{product.name}</option>)}</select></label><label>备注<input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="可选" /></label></div><button className="primary-button full-width" type="submit" disabled={aiLoading || !topic.trim() || !coreNeed.trim()}>{aiLoading ? '正在整理…' : '生成 AI 整理'} <span>→</span></button></> : <><div className="eyebrow">CONFIRM FEEDBACK</div><h2>确认跟进信息</h2><p className="modal-lede">AI 只提供整理建议，保存前请由导师确认。</p><div className="review-block"><span>跟进后信息整理</span><p>{aiDraft?.summary}</p></div><div className="review-block"><span>当前客户状态</span><p>{aiDraft?.currentStatus}</p></div><div className="review-block"><span>下一步建议</span><p>{aiDraft?.nextStep}</p></div><div className="review-block"><span>将保存的信息</span><p>核心需求：{coreNeed}。付费：{paid ? '是' : '否'}。SABC：{grade}。意向课程：{course || '尚未判断'}。</p></div><div className="review-actions"><button type="button" className="secondary-button" onClick={() => setStep('form')}>返回修改</button><button type="button" className="primary-button" onClick={confirm}>确认并完成 <span>→</span></button></div></>}</form></div>
}


function activeProductForManualEntry(product: Product) { return product.active !== false && product.status === '在售' }

function ManualCustomerDialog({ database, onClose, onPreview, onExtractDocument, onCreate, onUpdate, onOpenCustomer }: { database: Database; onClose: () => void; onPreview: (input: ManualCustomerInput) => Promise<CustomerDraftPreview>; onExtractDocument: (input: DocumentUploadInput) => Promise<DocumentExtractionResult>; onCreate: (input: ManualCustomerInput, upload?: CustomerSourceUpload) => Promise<void>; onUpdate: (customerId: string, input: ManualCustomerInput, upload?: CustomerSourceUpload) => Promise<void>; onOpenCustomer: (customerId: string) => void }) {
  const products = sortProductsForSelection(database.products.filter(activeProductForManualEntry))
  const [step, setStep] = useState<'form' | 'duplicate' | 'dialogue'>('form')
  const [nickname, setNickname] = useState('')
  const [phone, setPhone] = useState('')
  const [wechat, setWechat] = useState('')
  const [contactErrors, setContactErrors] = useState<{ phone?: string; wechat?: string; contact?: string }>({})
  const [introducer, setIntroducer] = useState('')
  const [situation, setSituation] = useState('')
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [productMenuOpen, setProductMenuOpen] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [draft, setDraft] = useState<CustomerDraftPreview>({ duplicates: [], updates: [] })
  const [error, setError] = useState('')
  const [dialogueReview, setDialogueReview] = useState<DialogueAssessment | null>(null)
  const [dialogueSpeakerId, setDialogueSpeakerId] = useState('')
  const [dialogueConfirmed, setDialogueConfirmed] = useState(false)
  const [dialogueOwnership, setDialogueOwnership] = useState<'UNSET' | 'YES' | 'NO'>('UNSET')
  const [saving, setSaving] = useState(false)
  const [savePhase, setSavePhase] = useState<'SUBMITTING' | 'VERIFYING'>('SUBMITTING')
  const operationIdRef = useRef(`customer-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const sourceOperationIdRef = useRef(`source-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const [attachedFile, setAttachedFile] = useState<File | null>(null)
  const [attachedDocument, setAttachedDocument] = useState<DocumentExtractionResult | null>(null)
  const [documentLoading, setDocumentLoading] = useState(false)
  const pendingDialogueRef = useRef<{ input: ManualCustomerInput; upload: CustomerSourceUpload; targetCustomerId?: string; mode: 'create' | 'update' } | null>(null)
  useEffect(() => {
    const onSaveState = (event: Event) => {
      const detail = (event as CustomEvent<{ operationId?: string; status?: string }>).detail
      if (detail?.operationId !== operationIdRef.current) return
      if (detail.status === 'VERIFYING') setSavePhase('VERIFYING')
      if (detail.status === 'PROCESSING') setSavePhase('SUBMITTING')
    }
    window.addEventListener('asva-customer-save-state', onSaveState)
    return () => window.removeEventListener('asva-customer-save-state', onSaveState)
  }, [])
  const resetSourceOperationId = () => { sourceOperationIdRef.current = `source-${Date.now()}-${Math.random().toString(36).slice(2)}` }
  const input = (): ManualCustomerInput => {
    const enrollments: EnrollmentDraft[] = selectedProductIds.map((productId) => ({ productId }))
    return { operationId: operationIdRef.current, nickname, phone, wechat, introducer, situation, needsFollowup: false, mentorId: null, source: '管理员手动录入', caseSource: 'ADMIN_MANUAL', enrollments, confirmedNotSame: step === 'duplicate' && draft.identity?.result === 'POSSIBLE_MATCH' }
  }
  const toggleProduct = (productId: string) => setSelectedProductIds((ids) => ids.includes(productId) ? ids.filter((id) => id !== productId) : [...ids, productId])
  const visibleProducts = products.filter((product) => product.name.toLowerCase().includes(productQuery.trim().toLowerCase()))
  const validateContacts = (showRequired = true) => {
    const result = validateCustomerContacts({ phone, wechat }) as { ok: boolean; field: string; message: string }
    if (result.ok) { setContactErrors({}); return true }
    if (!showRequired && result.field === 'contact') { setContactErrors({}); return true }
    setContactErrors(result.field === 'phone' ? { phone: result.message } : result.field === 'wechat' ? { wechat: result.message } : { contact: result.message })
    return false
  }
  const attachDocument = async (file: File) => {
    const extension = `.${file.name.toLowerCase().split('.').pop() || ''}`
    if (!['.txt', '.md', '.markdown', '.docx'].includes(extension)) { setError('当前支持 TXT、Markdown 和 Word（.docx）文件。'); return }
    if (file.size > MAX_DOCUMENT_SIZE_MB * 1024 * 1024) { setError('文件较大，请压缩后再上传。'); return }
    resetSourceOperationId(); setAttachedFile(file); setAttachedDocument(null); setDocumentLoading(true); setError('')
    try {
      const extracted = await onExtractDocument({ filename: file.name, mimeType: file.type, extension, size: file.size, base64: await fileToBase64(file) })
      setAttachedDocument(extracted)
    } catch (extractError) { setAttachedFile(null); setAttachedDocument(null); setError(sourceFailureMessage(extractError, 'save')) } finally { setDocumentLoading(false) }
  }
  const removeDocument = () => { resetSourceOperationId(); setAttachedFile(null); setAttachedDocument(null); setDocumentLoading(false) }
  const uploadInput = (): CustomerSourceUpload | undefined => attachedFile && attachedDocument ? { operationId: sourceOperationIdRef.current, filename: attachedFile.name, mimeType: attachedFile.type, extension: `.${attachedFile.name.toLowerCase().split('.').pop() || ''}`, size: attachedDocument.size, fileHash: attachedDocument.file_hash, charCount: attachedDocument.char_count, extractedText: attachedDocument.extracted_text } : undefined
  const saveWithDialogueGate = async (payload: ManualCustomerInput, upload: CustomerSourceUpload | undefined, targetCustomerId: string | undefined, mode: 'create' | 'update') => {
    if (!upload) { if (mode === 'create') await onCreate(payload); else if (targetCustomerId) await onUpdate(targetCustomerId, payload); return }
    const assessment = await requireDialogueGateHandlers().identify({ text: upload.extractedText, targetCustomerId, customerOperationId: targetCustomerId ? undefined : payload.operationId })
    if (assessment.classification === 'NOT_DIALOGUE') {
      const confirmation = await requireDialogueGateHandlers().confirm({ analysisToken: assessment.analysisToken, contentHash: assessment.contentHash, targetCustomerId, customerOperationId: targetCustomerId ? undefined : payload.operationId })
      const confirmedUpload = { ...upload, dialogueConfirmation: confirmation.dialogueConfirmation }
      if (mode === 'create') await onCreate(payload, confirmedUpload); else if (targetCustomerId) await onUpdate(targetCustomerId, payload, confirmedUpload)
      return
    }
    pendingDialogueRef.current = { input: payload, upload, targetCustomerId, mode }
    setDialogueReview(assessment); setDialogueSpeakerId(''); setDialogueConfirmed(false); setDialogueOwnership('UNSET'); setStep('dialogue'); setSaving(false)
  }
  const rejectManualDialogue = () => {
    pendingDialogueRef.current = null
    setDialogueReview(null)
    setDialogueSpeakerId('')
    setDialogueConfirmed(false)
    setDialogueOwnership('UNSET')
    setStep('form')
    setError('已取消保存，资料仍保留，请修改后重试。')
  }
  useEffect(() => { if (dialogueOwnership === 'NO') rejectManualDialogue() }, [dialogueOwnership])
  const confirmManualDialogue = async () => {
    const pending = pendingDialogueRef.current
    const oneSpeaker = dialogueReview?.classification === 'ONE_SPEAKER'
    if (!pending || !dialogueReview || (oneSpeaker ? dialogueOwnership !== 'YES' : (!dialogueConfirmed || !dialogueSpeakerId))) return
    setSaving(true); setSavePhase('SUBMITTING'); setError('')
    try {
      if (oneSpeaker && dialogueOwnership === 'NO') {
        pendingDialogueRef.current = null
        setDialogueReview(null); setDialogueSpeakerId(''); setDialogueConfirmed(false); setDialogueOwnership('UNSET'); setStep('form'); setError('已取消保存，资料仍保留，请修改后重试。')
        return
      }
      const confirmation = await requireDialogueGateHandlers().confirm({ analysisToken: dialogueReview.analysisToken, contentHash: dialogueReview.contentHash, targetCustomerId: pending.targetCustomerId, customerOperationId: pending.targetCustomerId ? undefined : pending.input.operationId, speakerId: oneSpeaker ? undefined : dialogueSpeakerId })
      const upload = { ...pending.upload, dialogueConfirmation: confirmation.dialogueConfirmation }
      pendingDialogueRef.current = null
      if (pending.mode === 'create') await onCreate(pending.input, upload); else if (pending.targetCustomerId) await onUpdate(pending.targetCustomerId, pending.input, upload)
      setDialogueReview(null); setDialogueSpeakerId(''); setDialogueConfirmed(false); setDialogueOwnership('UNSET')
    } catch (confirmError) { setError(confirmError instanceof Error ? confirmError.message : '资料归属确认失败') } finally { setSaving(false) }
  }
  const preview = async (event: FormEvent) => { event.preventDefault(); if (!canStartCustomerSave(saving) || !validateContacts()) return; setError(''); setSaving(true); const payload = input(); try { const result = await onPreview(payload); setDraft({ duplicates: result.duplicates, identity: result.identity, updates: [] }); if (result.duplicates.length) setStep('duplicate'); else await saveWithDialogueGate(payload, uploadInput(), undefined, 'create') } catch (submitError) { setError(customerSaveFailureMessage(submitError)) } finally { setSaving(false) } }
  const submit = async (payload = input()) => { if (!canStartCustomerSave(saving) || !validateContacts()) return; setSaving(true); setSavePhase('SUBMITTING'); setError(''); try { await saveWithDialogueGate(payload, uploadInput(), undefined, 'create') } catch (submitError) { setError(customerSaveFailureMessage(submitError)) } finally { setSaving(false) } }
  const updateExisting = async () => { const match = draft.duplicates[0]; if (!match || !canStartCustomerSave(saving) || !validateContacts()) return; setSaving(true); setSavePhase('SUBMITTING'); setError(''); try { await saveWithDialogueGate(input(), uploadInput(), match.customer.id, 'update') } catch (submitError) { setError(customerSaveFailureMessage(submitError)) } finally { setSaving(false) } }
  const selectedProductNames = selectedProductIds.map((id) => products.find((product) => product.id === id)?.name).filter(Boolean)
  return <div className="modal-backdrop"><form className="modal-card form-modal manual-customer-modal" onSubmit={preview}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button>{step === 'form' ? <><div className="eyebrow">NEW CUSTOMER</div><h2>新增客户</h2><p className="modal-lede">先录入客户基础信息，课程报名详情可在客户详情页继续维护；新增客户不会自动创建预约。</p><label>客户昵称 *<input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="例如：阿布" autoFocus /></label><div className="form-two-col contact-row"><label>手机号<input value={phone} onChange={(event) => { setPhone(event.target.value); setContactErrors((current) => ({ ...current, phone: undefined, contact: undefined })) }} onBlur={() => validateContacts(false)} inputMode="numeric" />{contactErrors.phone && <span className="form-error">{contactErrors.phone}</span>}</label><label>微信号<input value={wechat} onChange={(event) => { setWechat(event.target.value); setContactErrors((current) => ({ ...current, wechat: undefined, contact: undefined })) }} onBlur={() => validateContacts(false)} />{contactErrors.wechat && <span className="form-error">{contactErrors.wechat}</span>}</label></div><p className="field-hint contact-hint">手机号和微信号至少填写一项，便于后续联系和客户去重。</p>{contactErrors.contact && <p className="form-error">{contactErrors.contact}</p>}<label>介绍人（选填）<input value={introducer} onChange={(event) => setIntroducer(event.target.value)} placeholder="例如：王老师" /></label><label>目前已报名课程<div className="multi-select"><button type="button" className="multi-select-trigger" aria-expanded={productMenuOpen} onClick={() => setProductMenuOpen((open) => !open)}>{selectedProductNames.length ? <span className="selected-tags">{selectedProductNames.map((name) => <span className="selected-tag" key={name}>{name}</span>)}</span> : <span className="multi-select-placeholder">请选择已报名课程</span>}<span className="multi-select-chevron">⌄</span></button>{productMenuOpen && <div className="multi-select-menu"><input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder="搜索课程名称" aria-label="搜索课程名称" autoFocus />{visibleProducts.length ? <div className="multi-select-options">{visibleProducts.map((product) => <label className="multi-select-option" key={product.id}><input type="checkbox" checked={selectedProductIds.includes(product.id)} onChange={() => toggleProduct(product.id)} /><span>{product.name}</span></label>)}</div> : <span className="inline-empty">没有找到匹配课程。</span>}</div>}</div>{!products.length && <span className="field-hint">暂无启用课程，请先在「ASVA 产品」中启用课程。</span>}</label><label>客户情况<textarea value={situation} onChange={(event) => setSituation(event.target.value)} placeholder="描述客户当前的困扰、目标或背景。" /><small className="field-hint input-method-voice-hint">🎙 语音录入：点击输入框，使用手机键盘上的麦克风说话，即可转换成文字。</small></label><div className="customer-document-upload"><label className="document-upload-button primary-button full-width customer-document-upload-button"><span aria-hidden="true">↑</span> 上传客户资料<input className="customer-document-upload-input" type="file" accept=".txt,.md,.markdown,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => { const file = event.target.files?.[0]; if (file) void attachDocument(file) }} disabled={saving || documentLoading} /></label>{attachedFile && <span className="field-hint">{attachedFile.name}</span>}</div>{documentLoading && <p className="ai-form-note">正在读取资料…</p>}{attachedFile && !documentLoading && <div className="source-file-status"><span>{attachedDocument ? `已读取 ${attachedDocument.char_count.toLocaleString()} 字` : '读取失败，请重新选择'}</span><button type="button" className="secondary-button small" onClick={removeDocument}>移除</button></div>}{error && <p className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="submit" disabled={saving || documentLoading}>{saving ? (savePhase === 'VERIFYING' ? '确认保存结果…' : '保存中…') : '保存'}</button></div></> : step === 'dialogue' ? <><div className="eyebrow">DIALOGUE SAFETY</div><h2>确认资料人物归属</h2><p className="modal-lede">AI 已识别这份资料可能包含对话。单人资料只需确认是否属于当前客户；多人资料仍需选择客户说话人。未确认前不会保存资料。</p><p>{dialogueReview?.summary}</p>{dialogueReview?.classification === 'ONE_SPEAKER' ? <><p>这段内容是否属于当前客户的档案信息？</p><div className="dialogue-ownership-options"><button type="button" className={`secondary-button ${dialogueOwnership === 'YES' ? 'selected' : ''}`} onClick={() => setDialogueOwnership('YES')}>是，属于当前客户</button><button type="button" className={`secondary-button ${dialogueOwnership === 'NO' ? 'selected' : ''}`} onClick={() => setDialogueOwnership('NO')}>否，录入错误</button></div></> : <><div className="dialogue-speaker-options">{dialogueReview?.speakers.map((speaker) => <label key={speaker.id}><input type="radio" name="manual-dialogue-speaker" value={speaker.id} checked={dialogueSpeakerId === speaker.id} onChange={() => setDialogueSpeakerId(speaker.id)} disabled={dialogueReview?.classification !== 'TWO_SPEAKERS'} />说话人 {speaker.id}：{speaker.excerpt || '暂无代表性原文'}（AI建议：{speaker.suggestedRole === 'CUSTOMER' ? '客户' : speaker.suggestedRole === 'MENTOR' ? '导师' : speaker.suggestedRole === 'OTHER' ? '其他参与者' : '未知'}）</label>)}</div>{dialogueReview?.classification === 'TWO_SPEAKERS' && <label className="dialogue-confirm-check"><input type="checkbox" checked={dialogueConfirmed} onChange={(event) => setDialogueConfirmed(event.target.checked)} />确认所选说话人为当前客户</label>}</>}{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={() => { pendingDialogueRef.current = null; setDialogueReview(null); setDialogueSpeakerId(''); setDialogueConfirmed(false); setDialogueOwnership('UNSET'); setStep('form') }}>返回修改</button><button type="button" className="primary-button" disabled={dialogueReview?.classification === 'ONE_SPEAKER' ? dialogueOwnership !== 'YES' : dialogueReview?.classification !== 'TWO_SPEAKERS' || !dialogueSpeakerId || !dialogueConfirmed || saving} onClick={() => void confirmManualDialogue()}>{saving ? '确认中…' : dialogueReview?.classification === 'ONE_SPEAKER' ? '确认归属并保存' : '确认人物并保存'}</button></div></> : <><div className="eyebrow">POSSIBLE DUPLICATE</div><h2>发现可能重复客户</h2><p className="modal-lede">已选课程：{selectedProductNames.join('、') || '无'}。同名只做可能重复提醒；手机号或微信号命中现有客户时必须打开原档案更新。</p>{draft.duplicates.map((match) => <div className="review-block" key={match.customer.id}><strong>{match.customer.name}</strong><span>{match.matchedBy === 'phone' ? '手机号相同' : match.matchedBy === 'wechat' ? '微信号相同' : match.matchedBy === 'nickname_exact' ? '昵称相同' : '昵称相近'} · {match.customer.need || '暂无当前困扰'}</span><div className="review-actions"><button type="button" className="secondary-button small" onClick={() => onOpenCustomer(match.customer.id)}>查看客户</button><button type="button" className="secondary-button small" onClick={updateExisting}>更新已有客户</button></div></div>)}{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={() => setStep('form')}>返回修改</button>{draft.identity?.result === 'POSSIBLE_MATCH' && <button type="button" className="primary-button" disabled={saving} onClick={() => submit(input())}>确认不是同一人并保存</button>}</div></>}</form></div>
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

function MePage({ staff, panel, onPanel, api, cache, dataReady, onLogout }: { staff: Staff; panel: MePanel; onPanel: (panel: MePanel) => void; api: WorkbenchApi; cache: ResourceCache; dataReady: boolean; onLogout: () => void }) {
  const isAdmin = staff.permissionRole === 'ADMIN'
  const effectivePanel = accountPanelFor(staff.permissionRole, panel) as MePanel
  const [accountStats, setAccountStats] = useState<BasicDashboard | null>(() => cache.get<BasicDashboard>(basicDashboardCacheKey(staff.id)) ?? null)
  const [accountStatsLoading, setAccountStatsLoading] = useState(() => !cache.get<BasicDashboard>(basicDashboardCacheKey(staff.id)))
  const [accountStatsError, setAccountStatsError] = useState('')
  const accountStatsStartedAt = useRef(performance.now())

  useEffect(() => {
    if (!dataReady) return undefined
    const cacheKey = basicDashboardCacheKey(staff.id)
    const cached = cache.get<BasicDashboard>(cacheKey)
    if (cached) {
      setAccountStats(cached)
      setAccountStatsLoading(false)
    } else {
      setAccountStatsLoading(true)
    }
    setAccountStatsError('')
    let cancelled = false
    cache.load(cacheKey, () => api.basicDashboard(staff.id), { ttlMs: DASHBOARD_TTL_MS }).then((next) => {
      if (cancelled) return
      writeSessionSnapshot(basicDashboardSnapshotKey(staff.id), next)
      setAccountStats(next)
      setAccountStatsLoading(false)
      console.info('[ASVA_PERF]', JSON.stringify({ metric: 'ME_CUSTOMER_COUNT_READY_MS', value_ms: Math.round(performance.now() - accountStatsStartedAt.current), from_cache: Boolean(cached) }))
    }).catch((error: Error) => {
      if (cancelled) return
      setAccountStatsError(error.message || '账号统计暂时无法更新')
      setAccountStatsLoading(false)
    })
    return () => { cancelled = true }
  }, [api, cache, dataReady, staff.id])

  useEffect(() => {
    console.info('[ASVA_PERF]', JSON.stringify({ metric: 'ME_SHELL_VISIBLE_MS', value_ms: Math.round(performance.now() - accountStatsStartedAt.current) }))
    console.info('[ASVA_PERF]', JSON.stringify({ metric: 'ME_ACCOUNT_VISIBLE_MS', value_ms: Math.round(performance.now() - accountStatsStartedAt.current) }))
  }, [])

  return <div className="me-page"><div className="profile-hero"><Avatar staff={staff} size="lg" /><div><div className="eyebrow">MY ACCOUNT</div><h1>{staff.name}</h1><p>{roleName(staff)}</p></div></div>{isAdmin && <div className="me-switcher"><button className={effectivePanel === 'account' ? 'active' : ''} onClick={() => onPanel('account')}>账号信息</button>{dataReady && <button className={effectivePanel === 'team' ? 'active' : ''} onClick={() => onPanel('team')}>导师管理</button>}</div>}{effectivePanel === 'account' && <AccountPanel staff={staff} accountStats={accountStats} accountStatsLoading={accountStatsLoading} accountStatsError={accountStatsError} api={api} />}{effectivePanel === 'team' && dataReady && <TeamPanel staffId={staff.id} api={api} cache={cache} />}<button className="logout-button" onClick={onLogout}>退出当前账号</button></div>
}

function AccountPanel({ staff, accountStats, accountStatsLoading, accountStatsError, api }: { staff: Staff; accountStats: BasicDashboard | null; accountStatsLoading: boolean; accountStatsError: string; api: WorkbenchApi }) {
  const [open, setOpen] = useState(false)
  const customerCount = staff.permissionRole === 'MENTOR' ? accountStats ? `${accountStats.customer_total} 位负责客户` : accountStatsLoading ? '正在读取…' : accountStatsError ? '暂时无法更新' : '暂无客户' : '全部客户'
  return <><section className="surface settings-card"><div className="settings-row"><span>显示身份</span><Badge tone="blue">{roleName(staff)}</Badge></div><div className="settings-row"><span>权限角色</span><strong>{staff.permissionRole}</strong></div><div className="settings-row"><span>可查看客户</span><strong>{customerCount}</strong></div><div className="settings-row"><span>数据权限</span><small>{staff.permissionRole === 'MENTOR' ? '仅当前导师负责的客户档案' : '全部客户与导师数据'}</small></div><div className="settings-row"><span>登录安全</span><button className="secondary-button small" type="button" onClick={() => setOpen(true)}>修改个人密码</button></div></section>{open && <SelfPasswordDialog api={api} onClose={() => setOpen(false)} />}</>
}

function maskPhone(phone: string) { return phone.length >= 7 ? phone.slice(0, 3) + '****' + phone.slice(-4) : phone }

function TeamPanel({ staffId, api, cache }: { staffId: string; api: WorkbenchApi; cache: ResourceCache }) {
  const cacheKey = mentorCacheKey(staffId)
  const [teams, setTeams] = useState<Awaited<ReturnType<WorkbenchApi['teamSnapshot']>> | null>(() => cache.get(cacheKey) ?? null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [formMentor, setFormMentor] = useState<Staff | 'create' | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>[number] | null>(null)
  const [resetTarget, setResetTarget] = useState<Staff | null>(null)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [temporaryCredential, setTemporaryCredential] = useState<TemporaryMentorCredential | null>(null)
  const loadingVisible = useDelayedLoading(!teams && !error)
  const teamStartedAt = useRef(performance.now())

  const reload = async (force = false) => {
    setError('')
    const cached = cache.get<Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>>(cacheKey)
    if (cached) setTeams(cached)
    else setTeams(null)
    try {
      const items = await cache.load(cacheKey, () => api.teamSnapshot(staffId), { ttlMs: MENTOR_TTL_MS, force })
      writeSessionSnapshot(mentorSnapshotKey(staffId), items.map((item) => ({ ...item, mentor: { ...item.mentor, phone: '' } })))
      setTeams(items)
      setSelectedId((current) => current && items.some((item) => item.mentor.id === current) ? current : items[0]?.mentor.id ?? null)
      console.info('[ASVA_PERF]', JSON.stringify({ metric: 'ME_TEAM_LIST_VISIBLE_MS', value_ms: Math.round(performance.now() - teamStartedAt.current), from_cache: Boolean(cached) }))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取导师列表失败')
    }
  }

  useEffect(() => { void reload() }, [api, cache, cacheKey, staffId])

  const selected = teams?.find((item) => item.mentor.id === selectedId)
  const applyTeams = (items: Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>) => {
    setTeams(items)
    setSelectedId((current) => current && items.some((item) => item.mentor.id === current) ? current : items[0]?.mentor.id ?? null)
  }
  const refreshAfterMutation = (preserve?: Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>[number]) => {
    void cache.refresh(cacheKey, () => api.teamSnapshot(staffId)).then((items) => {
      const next = reconcileMentorSnapshot(items, preserve)
      writeSessionSnapshot(mentorSnapshotKey(staffId), next.map((item) => ({ ...item, mentor: { ...item.mentor, phone: '' } })))
      cache.set(cacheKey, next)
      applyTeams(next)
    }).catch(() => {
      if (preserve) setError('列表后台更新暂时失败，已保留刚创建的导师。')
    })
  }
  const copyMentor = async (mentor: Staff, password?: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      const baseUrl = `${window.location.origin}${import.meta.env.BASE_URL}`
      await navigator.clipboard.writeText(buildMentorCopyText(mentor, baseUrl, password))
      if (password) setTemporaryCredential((current) => current?.mentor.id === mentor.id ? { ...current, password: undefined, copied: true } : current)
      setFeedback(password ? '登录信息已复制' : '账号信息已复制')
    } catch {
      setFeedback('复制失败，请手动复制')
    }
  }
  const save = async (input: { name: string; phone: string; initialPassword?: string }): Promise<MentorAccountResult> => {
    let result: MentorAccountResult
    if (formMentor === 'create') result = await api.createMentor(staffId, input)
    else if (formMentor) result = await api.updateMentor(staffId, formMentor.id, input)
    else throw new Error('导师表单已关闭')
    if (formMentor === 'create') {
      const mentor = publicMentorSummary(result)
      const optimistic = { mentor, customerCount: 0 }
      const next = insertMentorSnapshot(teams || [], result)
      cache.set(cacheKey, next)
      cache.invalidate(basicDashboardCacheKey(staffId))
      cache.invalidate(dashboardCacheKey(staffId))
      setTemporaryCredential({ mentor, password: result.initialPassword, copied: false })
      setFeedback('导师账号已创建')
      setFormMentor(null)
      applyTeams(next.length ? next : [optimistic])
      refreshAfterMutation(optimistic)
    } else {
      setFormMentor(null)
      cache.invalidate(cacheKey)
      refreshAfterMutation()
    }
    return result
  }
  const deactivate = async () => {
    if (!deactivateTarget) return
    await api.deactivateMentor(staffId, deactivateTarget.mentor.id)
    setDeactivateTarget(null)
    cache.invalidate(cacheKey)
    await reload(true)
  }

  if (!teams) return <div className="management-panel">{error ? <p>{error}</p> : loadingVisible ? <p>正在加载导师列表…</p> : null}</div>
  return <div className="management-panel">
    <SectionTitle title="导师管理" action={<button className="primary-button small" type="button" onClick={() => setFormMentor('create')}>新增导师</button>} />
    {feedback && <p className="panel-success">{feedback}</p>}
    {error && <p className="form-error">{error}</p>}
    <p className="panel-note">新增导师会生成一次性初始密码；首次登录后必须设置个人密码。</p>
    <div className="team-list">{teams.map((item) => <button type="button" key={item.mentor.id} className={'team-row ' + (selectedId === item.mentor.id ? 'selected' : '')} onClick={() => setSelectedId(item.mentor.id)}>
      <Avatar staff={item.mentor} size="sm" />
      <span><strong>{item.mentor.name}</strong><small>{maskPhone(item.mentor.phone)} · 负责客户 {item.customerCount}</small></span>
      <span className="team-counts"><Badge tone={item.mentor.status === 'ACTIVE' ? 'green' : 'neutral'}>{item.mentor.status === 'ACTIVE' ? '在职' : '已停用'}</Badge><b>{item.customerCount}</b><small>负责客户</small></span>
    </button>)}</div>
    {selected && <section className="mentor-detail">
      <div className="mentor-detail-heading"><div><h3>{selected.mentor.name}</h3><p>{selected.mentor.phone} · {staffStatusLabel(selected.mentor.status)}</p></div><Badge tone={selected.mentor.status === 'ACTIVE' ? 'green' : 'neutral'}>{staffStatusLabel(selected.mentor.status)}</Badge></div>
      <p>负责客户 {selected.customerCount}</p>
      {(selected.customerPreviews || []).map((customer) => <div className="mini-customer" key={customer.id}><span>{customer.initials}</span><strong>{customer.name}</strong><small>{customer.need}</small></div>)}
      {selected.mentor.status === 'ACTIVE' ? <div className="mentor-actions"><button className="secondary-button small" type="button" onClick={() => void copyMentor(selected.mentor)}>复制账号</button>{temporaryCredential?.mentor.id === selected.mentor.id && temporaryCredential.password ? <button className="primary-button small" type="button" onClick={() => void copyMentor(selected.mentor, temporaryCredential.password)}>复制登录信息</button> : temporaryCredential?.mentor.id === selected.mentor.id && temporaryCredential.copied ? <span className="copy-success">已复制</span> : null}<button className="secondary-button small" type="button" onClick={() => setFormMentor(selected.mentor)}>编辑账号</button><button className="secondary-button small" type="button" onClick={() => setResetTarget(selected.mentor)}>重置密码</button><button className="secondary-button small danger-button" type="button" onClick={() => setDeactivateTarget(selected)}>停用账号</button></div> : <small className="mentor-readonly">该账号已停用，保留用于历史记录。</small>}
    </section>}
    {formMentor && <MentorFormDialog mentor={formMentor === 'create' ? undefined : formMentor} api={api} actorId={staffId} onClose={() => setFormMentor(null)} onSubmit={save} />}
    {resetTarget && <PasswordResetDialog staff={resetTarget} api={api} actorId={staffId} onClose={() => setResetTarget(null)} onComplete={(password) => { setTemporaryCredential({ mentor: resetTarget, password, copied: false }); setResetTarget(null); setFeedback('密码已重置，可复制新的登录信息。') }} />}
    {deactivateTarget && <MentorDeactivateDialog snapshot={deactivateTarget} onClose={() => setDeactivateTarget(null)} onConfirm={deactivate} />}
  </div>
}

function PasswordResetDialog({ staff, api, actorId, onClose, onComplete }: { staff: Staff; api: WorkbenchApi; actorId: string; onClose: () => void; onComplete: (initialPassword: string) => void }) {
  const [initialPassword, setInitialPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(''); try { const result = await api.resetPassword(actorId, staff.id); setInitialPassword(result.initialPassword || ''); onComplete(result.initialPassword || '') } catch (resetError) { setError(resetError instanceof Error ? resetError.message : '重置密码失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><form className="modal-card compact-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">RESET PASSWORD</div><h2>重置{staff.name}的密码</h2><p className="modal-lede">系统会生成新的随机临时密码；旧 Session 会立即失效，重置成功后可在导师卡片中复制新的登录信息。</p>{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving && <ButtonSpinner />}{saving ? '重置中…' : '生成并重置'}</button></div></form></div>
}

function SelfPasswordDialog({ api, onClose }: { api: WorkbenchApi; onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [newPasswordError, setNewPasswordError] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const nextError = validatePasswordInput(newPassword)
    const nextConfirmError = !confirm ? '请再次输入新密码' : getConfirmPasswordError(newPassword, confirm)
    setNewPasswordError(nextError)
    setConfirmError(nextConfirmError)
    setError('')
    if (nextError || nextConfirmError) return
    setSaving(true)
    try { await api.changePassword(currentPassword, newPassword); onClose() } catch (changeError) {
      const message = passwordErrorMessage(changeError)
      if ((changeError as { code?: string })?.code === 'PASSWORD_INVALID') setError(message)
      else setNewPasswordError(message)
    } finally { setSaving(false) }
  }
  return <div className="modal-backdrop"><form className="modal-card compact-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">CHANGE PASSWORD</div><h2>修改密码</h2><p className="modal-lede">{PASSWORD_POLICY_HINT}</p><label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); setError('') }} /></label><label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => { setNewPassword(event.target.value); setNewPasswordError(''); setConfirmError(getConfirmPasswordError(event.target.value, confirm)) }} />{newPasswordError && <span className="form-error">{newPasswordError}</span>}</label><label>确认新密码<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => { setConfirm(event.target.value); setConfirmError(getConfirmPasswordError(newPassword, event.target.value)); setError('') }} />{confirmError && <span className="form-error">{confirmError}</span>}</label>{error && <p className="form-error">{error}</p>}<div className="review-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving && <ButtonSpinner />}{saving ? '保存中…' : '保存新密码'}</button></div></form></div>
}

function MentorFormDialog({ mentor, api, actorId, onClose, onSubmit }: { mentor?: Staff; api: WorkbenchApi; actorId: string; onClose: () => void; onSubmit: (input: { name: string; phone: string; initialPassword?: string }) => Promise<MentorAccountResult> }) {
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
  return <div className="modal-backdrop"><form className="modal-card compact-modal form-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">MENTOR ACCOUNT</div><h2>{mentor ? '编辑导师' : '新增导师'}</h2><p className="modal-lede">只需填写昵称和手机号。系统会生成一次性初始密码，账号创建成功后可立即复制。</p><label>导师昵称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：王老师" autoFocus /></label><label>手机号<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" placeholder="11 位手机号" /></label>{error && <p className="form-error">{error}</p>}<button className="primary-button full-width" type="submit" disabled={saving || !name.trim() || !phone.trim()} aria-busy={saving}>{saving && <ButtonSpinner />}{saving ? '保存中…' : '保存账号'} <span>→</span></button></form></div>
}

function MentorDeactivateDialog({ snapshot, onClose, onConfirm }: { snapshot: Awaited<ReturnType<WorkbenchApi['teamSnapshot']>>[number]; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const confirm = async () => { setSaving(true); setError(''); try { await onConfirm() } catch (confirmError) { setError(confirmError instanceof Error ? confirmError.message : '停用失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><section className="modal-card compact-modal"><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button><div className="eyebrow">DEACTIVATE ACCOUNT</div><h2>停用{snapshot.mentor.name}？</h2><p className="modal-lede">停用后关闭账号，历史客户记录保留。</p>{error && <p className="form-error">{error}</p>}<div className="review-actions"><button className="secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" type="button" disabled={saving} aria-busy={saving} onClick={confirm}>{saving && <ButtonSpinner />}{saving ? '停用中…' : '确认停用'}</button></div></section></div>
}

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
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!situation.trim() && !profileText.trim()) return
    setAiLoading(true)
    try {
      const input = { topic: situation.trim() || profileText.trim(), result, coreNeed: customer.need, paid: customer.paid, grade: customer.grade, intendedCourse: customer.intendedCourse, notes: situation.trim(), expectation: customer.helpExpectation }
      const [summary, profile] = await Promise.all([onGenerateSummary(input), profileText.trim() ? onGenerateProfile(customer.id, profileText.trim()) : Promise.resolve({ updates: [] })])
      setAiDraft(summary)
      setProfileDraft(profile)
      setStep('review')
    } finally { setAiLoading(false) }
  }
  const finish = async (updates: ProfileUpdate[]) => { if (saving) return; setSaving(true); setSaveError(''); try { await onSubmit({ appointmentId: appointment.id, topic: situation.trim() || profileText.trim() || '本次沟通', result, coreNeed: customer.need, paid: customer.paid, grade: customer.grade, intendedCourse: customer.intendedCourse, notes: situation.trim(), profileText: profileText.trim(), profileUpdates: updates, aiSummary: aiDraft?.summary, aiStatus: aiDraft?.currentStatus, aiNextStep: aiDraft?.nextStep }) } catch (saveErrorValue) { setSaveError(saveErrorValue instanceof Error ? saveErrorValue.message : '保存服务记录失败') } finally { setSaving(false) } }
  return <div className="modal-backdrop"><form className="modal-card form-modal" onSubmit={submit}><button type="button" className="modal-close" onClick={onClose} disabled={saving}>×</button>{step === 'form' ? <><div className="eyebrow">SERVICE RECORD</div><h2>记录本次沟通</h2><p className="modal-lede">{customer.name} · 用几句话记录事实，AI 帮你整理。</p><label>本次主要聊了什么？<textarea value={situation} onChange={(event) => setSituation(event.target.value)} placeholder="例如：客户说最近工作压力变大，想先把每天的节奏稳住。" autoFocus /></label><label>说说这个客户现在的情况<textarea value={profileText} onChange={(event) => setProfileText(event.target.value)} placeholder="例如：36 岁，住在杭州，从事设计，已婚，有一个女儿，喜欢瑜伽和旅行。" /><small className="field-hint input-method-voice-hint">🎙 语音录入：点击输入框，使用手机键盘上的麦克风说话，即可转换成文字。</small></label><label>本次结果<div className="option-grid">{['继续跟进', '暂时结束', '有课程 / 服务意向', '需要转介'].map((item) => <button type="button" key={item} className={result === item ? 'option-button selected' : 'option-button'} disabled={aiLoading || saving} onClick={() => setResult(item)}>{item}</button>)}</div></label><button className="primary-button full-width" type="submit" disabled={aiLoading || saving || (!situation.trim() && !profileText.trim())} aria-busy={aiLoading}>{aiLoading && <ButtonSpinner />}{aiLoading ? '正在整理…' : '生成 AI 整理'} <span>→</span></button></> : <><div className="eyebrow">CONFIRM RECORD</div><h2>确认本次整理</h2><p className="modal-lede">AI 只提供整理建议；画像更新在你确认后才会写入客户档案。</p>{saveError && <p className="form-error">{saveError}</p>}<div className="review-block"><span>本次总结</span><p>{aiDraft?.summary}</p></div><div className="review-block"><span>当前客户状态</span><p>{aiDraft?.currentStatus}</p></div><div className="review-block"><span>下一步跟进建议</span><p>{aiDraft?.nextStep}</p></div><div className="review-block"><span>本次发现 · {profileDraft.updates.length} 项</span>{profileDraft.updates.length ? <div className="profile-update-list">{profileDraft.updates.map((update) => <div className={`profile-update ${update.conflict ? 'conflict' : ''}`} key={update.field}><strong>{profileUpdateLabel(update)}</strong><span>{update.conflict ? `${displayProfileValue(update.previousValue ?? null)} → ` : ''}{displayProfileValue(update.value)}</span><small>{profileSourceLabel(update.source || 'MENTOR_OBSERVATION')} · {update.conflict ? '与已有记录不同，请确认' : '待确认'}</small></div>)}</div> : <p>没有识别到新的画像信息，本次只保存服务记录。</p>}</div><div className="review-actions"><button type="button" className="secondary-button" onClick={() => setStep('form')} disabled={saving}>返回修改</button><button type="button" className="secondary-button" onClick={() => void finish([])} disabled={saving}>{saving && <ButtonSpinner />}忽略画像更新</button><button type="button" className="primary-button" onClick={() => void finish(profileDraft.updates)} disabled={saving} aria-busy={saving}>{saving && <ButtonSpinner />}{saving ? '保存中…' : '全部确认并完成'} <span>→</span></button></div></>}</form></div>
}

function ProfileChangeHistory({ changes }: { changes: Database['profileChanges'] }) { const sorted = [...changes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); return <section className="customer-detail-section profile-change-history"><details className="record-disclosure"><summary><span><strong>档案变更历史</strong><small>{sorted.length ? `${sorted.length} 条人工与资料变更记录` : '还没有档案变更记录'}</small></span><b>查看历史</b></summary><div className="record-disclosure-body">{sorted.length ? <div className="history-timeline">{sorted.map((change) => <article className="history-event" key={change.id}><time>{detailDate(change.updatedAt)}</time><span className="history-dot" /><div><div className="history-event-title"><strong>{change.fieldName || change.field}</strong></div><small>{sourceLabel(change.source)} · {change.confirmed ? '已确认' : '待确认'}</small><p>{displayProfileValue(change.newValue) || '已清空'}</p></div></article>)}</div> : <div className="detail-empty-line">还没有档案变更记录。</div>}</div></details></section> }

export default function App() { return <HashRouter><WorkbenchApp /></HashRouter> }
