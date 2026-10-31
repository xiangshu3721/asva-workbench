/**
 * ASVA-ARCHIVE-001 diagnostic only:
 * - Locate SRC-b6d499… relative to CUS-db3032
 * - Non-force finalize re-entry (timeout-resume / idempotency)
 * Constraints: no force, no deploy, canary allowlist = this synth id only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'evidence')
const ROOT = '/Users/xiangshu/Troublehut/asva-workbench'
const PROD_ENV = path.join(ROOT, 'stage0-backup/prod-R048.9-c913ae5/config/production.env')
const LOCAL_ENV = path.join(ROOT, '.env.local')
const ACTOR = 'staff-admin-owner-001'
const CUSTOMER_ID = 'CUS-db3032dea6f71877dc42'
const HARD_TIMEOUT_MS = 120_000

function loadEnvFile(filePath, into = process.env) {
  if (!fs.existsSync(filePath)) return
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (into[key] === undefined) into[key] = value
  }
}
function shanghaiNow() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).replace(' ', 'T')
}
function unwrap(v) {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' && 'text' in x ? x.text : x)).join('')
  return v == null ? '' : String(v)
}

loadEnvFile(PROD_ENV)
loadEnvFile(LOCAL_ENV)
process.env.APP_ENV = 'production'
process.env.ASVA_ENVIRONMENT = 'production'
process.env.DATA_MODE = 'production'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'canary'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY = 'true'
process.env.ASVA_DEPLOY_MODE = 'canary'
process.env.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS = CUSTOMER_ID
delete process.env.AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT

const deepseekLog = []
const originalLog = console.log
console.log = (...args) => {
  const line = args.map(String).join(' ')
  if (line.includes('[ASVA_DEEPSEEK]') || line.includes('[ASVA_AUDIT]') || line.includes('[ASVA_FEISHU_WRITE]')) {
    deepseekLog.push(line.slice(0, 500))
  }
  originalLog(...args)
}

const report = {
  generatedAtAsiaShanghai: shanghaiNow(),
  customerId: CUSTOMER_ID,
  forceUsed: false,
  deployed: false,
}

try {
  const { FeishuRepository } = await import(path.join(ROOT, 'server/repository.mjs'))
  const repository = new FeishuRepository()

  const beforeDb = await repository.withCustomerScope(CUSTOMER_ID, 'HTTP_AUTO_ARCHIVE', () => repository.load({ force: true }))
  const beforeSources = (beforeDb.sourceRecords || []).filter((s) => s.customerId === CUSTOMER_ID).map((s) => ({
    id: s.id,
    processingStatus: s.processingStatus,
    processingError: s.processingError || null,
    contentHash: s.contentHash || null,
    notesPrefix: String(s.notes || '').split('\n')[0].slice(0, 80),
    lastBatchId: s.lastBatchId || null,
    sourceType: s.sourceType,
  }))
  const beforeEvidence = (beforeDb.evidenceItems || []).filter((e) => e.customerId === CUSTOMER_ID || beforeSources.some((s) => s.id === e.sourceId))
  const beforeProposals = (beforeDb.profileUpdateProposals || []).filter((p) => p.customerId === CUSTOMER_ID || beforeSources.some((s) => s.id === p.sourceId))
  const customer = (beforeDb.customers || []).find((c) => c.id === CUSTOMER_ID)
  report.before = {
    sourceCount: beforeSources.length,
    sources: beforeSources,
    evidenceCount: beforeEvidence.length,
    proposalCount: beforeProposals.length,
    automaticProfilePending: customer?.automaticProfilePending || null,
    physical: {
      current_core_issue: unwrap(customer?.profileFields?.current_core_issue || customer?.need).slice(0, 80),
      current_goal: unwrap(customer?.profileFields?.current_goal || customer?.goal).slice(0, 80),
      current_expectation: unwrap(customer?.profileFields?.current_expectation || customer?.helpExpectation).slice(0, 80),
    },
    metaLabels: Object.fromEntries(Object.entries(customer?.profileFieldMeta || {})
      .filter(([k]) => ['current_core_issue','current_goal','current_expectation','career_goal','secondary_issues'].includes(k))
      .map(([k,v]) => [k, { confirmed: v?.confirmed, verificationLabel: v?.verificationLabel, sourceRecordId: v?.sourceRecordId }])),
  }

  const second = beforeSources.find((s) => s.id.startsWith('SRC-b6d499'))
  report.secondSourceLocate = second || beforeSources.find((s) => s.processingStatus === 'FAILED') || null

  const started = Date.now()
  let finalizeResult = null
  let finalizeError = null
  try {
    finalizeResult = await Promise.race([
      repository.runCustomerAutoArchive(ACTOR, CUSTOMER_ID, { force: false, stage: 'finalize', finalize: true }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('FINALIZE_RESUME_TIMEOUT'), { code: 'FINALIZE_RESUME_TIMEOUT' })), HARD_TIMEOUT_MS)),
    ])
  } catch (error) {
    finalizeError = { code: error?.code, message: error?.message }
  }
  report.resume = {
    durationMs: Date.now() - started,
    resultStatus: finalizeResult?.status || null,
    phase: finalizeResult?.phase || null,
    sourceId: finalizeResult?.sourceId || null,
    reused: finalizeResult?.reused ?? null,
    evidenceCount: finalizeResult?.evidenceCount ?? null,
    proposalCount: finalizeResult?.proposalCount ?? null,
    error: finalizeError,
    errorCode: finalizeResult?.errorCode || null,
  }

  const afterDb = await repository.withCustomerScope(CUSTOMER_ID, 'HTTP_AUTO_ARCHIVE', () => repository.load({ force: true }))
  const afterSources = (afterDb.sourceRecords || []).filter((s) => s.customerId === CUSTOMER_ID).map((s) => ({
    id: s.id,
    processingStatus: s.processingStatus,
    processingError: s.processingError || null,
    contentHash: s.contentHash || null,
    notesPrefix: String(s.notes || '').split('\n')[0].slice(0, 80),
    lastBatchId: s.lastBatchId || null,
  }))
  const afterEvidence = (afterDb.evidenceItems || []).filter((e) => e.customerId === CUSTOMER_ID || afterSources.some((s) => s.id === e.sourceId))
  const afterProposals = (afterDb.profileUpdateProposals || []).filter((p) => p.customerId === CUSTOMER_ID || afterSources.some((s) => s.id === p.sourceId))
  report.after = {
    sourceCount: afterSources.length,
    sources: afterSources,
    evidenceCount: afterEvidence.length,
    proposalCount: afterProposals.length,
  }
  report.deltas = {
    sourceDelta: afterSources.length - beforeSources.length,
    evidenceDelta: afterEvidence.length - beforeEvidence.length,
    proposalDelta: afterProposals.length - beforeProposals.length,
    newSourceIds: afterSources.map((s) => s.id).filter((id) => !beforeSources.some((b) => b.id === id)),
  }
  const modelLines = deepseekLog.filter((l) => l.includes('[ASVA_DEEPSEEK]'))
  report.modelCallsDuringResume = modelLines.length
  report.modelCallSnippets = modelLines.map((l) => {
    const m = l.match(/\{.*\}/)
    if (!m) return l.slice(0, 200)
    try {
      const o = JSON.parse(m[0])
      return { operation: o.operation, model: o.model, duration_ms: o.duration_ms, http_status: o.http_status }
    } catch { return l.slice(0, 200) }
  })
  report.auditSnippets = deepseekLog.filter((l) => l.includes('[ASVA_AUDIT]')).slice(-10).map((l) => l.slice(0, 300))
  report.okIdempotent = report.deltas.sourceDelta === 0 && report.deltas.evidenceDelta === 0 && report.deltas.proposalDelta === 0 && report.modelCallsDuringResume === 0 && ['COMPLETED','REVIEW_REQUIRED','ALREADY_DONE'].includes(report.resume.resultStatus || report.resume.phase)

  fs.writeFileSync(path.join(OUT, 'timeout-resume-test.json'), JSON.stringify(report, null, 2) + '\n')
  originalLog(JSON.stringify({ ok: true, resume: report.resume, deltas: report.deltas, modelCalls: report.modelCallsDuringResume, second: report.secondSourceLocate }, null, 2))
  process.exit(0)
} catch (error) {
  report.error = { code: error?.code, message: error?.message, stack: String(error?.stack || '').split('\n').slice(0, 8) }
  fs.writeFileSync(path.join(OUT, 'timeout-resume-test.json'), JSON.stringify(report, null, 2) + '\n')
  console.error(error)
  process.exit(1)
}
