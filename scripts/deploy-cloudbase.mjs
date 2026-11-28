import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envId = 'root-journey-prod-d4d7pzd0a8f805'
const functionName = 'asva-api'
const servicePath = 'asva-api'
const serviceUrl = 'https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api'
const functionDir = path.join(root, 'cloudbase/functions/asva-api')
const workerName = 'asva-ai-archive'
const workerDir = path.join(root, 'cloudbase/functions/asva-ai-archive')
const workerTriggerName = 'asva-auto-archive-every-minute'
const workerCron = '0 */1 * * * * *'
// Production telemetry showed the Worker using roughly 570–619MB. Keep the
// current 1024MB allocation until a dedicated benchmark supports a change.
export const WORKER_MEMORY_MB = 1024

export function parseEnv(text) {
  const values = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const key = line.slice(0, equals).trim()
    const rawValue = line.slice(equals + 1).trim()
    values[key] = rawValue.replace(/^("|')(.*)\1$/, '$2')
  }
  return values
}

export const PRODUCTION_REQUIRED_KEYS = [
  'APP_ENV',
  'DATA_MODE',
  'AUTH_MODE',
  'FEATURE_AUTOMATIC_PROFILE_ARCHIVING',
  'FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE',
  'DEEPSEEK_API_KEY',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_APP_TOKEN',
  'ASVA_AUTH_SECRET',
  'FEISHU_APPOINTMENTS_TABLE_ID',
  'FEISHU_CUSTOMERS_TABLE_ID',
  'FEISHU_SERVICE_RECORDS_TABLE_ID',
  'FEISHU_STAFF_TABLE_ID',
  'FEISHU_PRODUCTS_TABLE_ID',
  'FEISHU_PROFILE_CHANGES_TABLE_ID',
  'FEISHU_SOURCE_RECORDS_TABLE_ID',
  'FEISHU_EVIDENCE_ITEMS_TABLE_ID',
  'FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID',
  'FEISHU_EVIDENCE_CONFLICTS_TABLE_ID',
]

export function validateProductionEnv(values, envPath = '') {
  if (values.APP_ENV !== 'production' || values.DATA_MODE !== 'production') {
    throw new Error('CloudBase Production 部署必须使用 APP_ENV=production 与 DATA_MODE=production 的显式配置文件')
  }
  if (!['ADMIN_CODE', 'PASSWORD'].includes(values.AUTH_MODE)) throw new Error('AUTH_MODE 必须明确设置为 ADMIN_CODE 或 PASSWORD')
  const deployMode = values.ASVA_DEPLOY_MODE || 'normal'
  const automaticProfileMode = String(values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE || '').toLowerCase()
  const automaticProfileEnabledAt = String(values.AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT || '').trim()
  const canaryEnabled = values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY === 'true'
  const canaryCustomerIds = String(values.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS || '').split(/[\s,]+/).map((id) => id.trim()).filter(Boolean)
  if (!['normal', 'canary', 'production'].includes(deployMode)) throw new Error('ASVA_DEPLOY_MODE 必须是 normal、canary 或 production')
  if (deployMode === 'normal') {
    if (values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING !== 'false') throw new Error('FEATURE_AUTOMATIC_PROFILE_ARCHIVING 必须显式设置为 false')
    if (automaticProfileMode !== 'off' || automaticProfileEnabledAt || canaryEnabled || canaryCustomerIds.length) throw new Error('normal 部署不得携带自动归档运行配置')
  } else if (deployMode === 'canary') {
    if (values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING !== 'true') throw new Error('canary 部署必须显式设置 FEATURE_AUTOMATIC_PROFILE_ARCHIVING=true')
    if (automaticProfileMode !== 'canary') throw new Error('canary 部署必须显式设置 FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE=canary')
    if (!canaryEnabled) throw new Error('canary 部署必须显式设置 FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY=true')
    if (!canaryCustomerIds.length) throw new Error('canary 部署必须配置 AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS')
    if (automaticProfileEnabledAt) throw new Error('canary 部署不得设置 AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT')
  } else {
    if (values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING !== 'true') throw new Error('production 自动归档部署必须显式设置 FEATURE_AUTOMATIC_PROFILE_ARCHIVING=true')
    if (automaticProfileMode !== 'production') throw new Error('production 自动归档部署必须显式设置 FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE=production')
    if (!automaticProfileEnabledAt || Number.isNaN(Date.parse(automaticProfileEnabledAt))) throw new Error('production 自动归档部署必须设置有效的 AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT')
    if (canaryEnabled || canaryCustomerIds.length) throw new Error('production 自动归档部署不得携带 Canary 配置')
  }
  if (values.FEATURE_ON_DEMAND_AI_AUTO_TRIGGER === 'true') {
    // R048.17: Canary whitelist removed after production acceptance.
    // All authenticated staff who upload sources can trigger AUTO.
    // PG reservation ensures idempotency and budget protection.
  }
  if (values.FEATURE_ON_DEMAND_AI_PROCESSING === 'true') {
    const dailyLimit = Number(values.ON_DEMAND_AI_DAILY_LIMIT)
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100) throw new Error('手动按需 AI 必须设置 1 到 100 的 ON_DEMAND_AI_DAILY_LIMIT')
    if (!String(values.ON_DEMAND_AI_BUDGET_COLLECTION || '').trim()) throw new Error('手动按需 AI 必须显式设置 ON_DEMAND_AI_BUDGET_COLLECTION')
    if (!String(values.CLOUDBASE_APIKEY || '').trim()) throw new Error('手动按需 AI 必须显式设置 CLOUDBASE_APIKEY')
    if (!String(values.ON_DEMAND_AI_BUDGET_RPC_BASE_URL || '').trim()) throw new Error('手动按需 AI 必须显式设置 ON_DEMAND_AI_BUDGET_RPC_BASE_URL')
    const maxConcurrent = Number(values.ON_DEMAND_AI_MAX_CONCURRENT)
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) throw new Error('ON_DEMAND_AI_MAX_CONCURRENT 必须设置为 1（V1 PG）或 2（V2 PG 迁移后）')
  }
  const requiredKeys = [...PRODUCTION_REQUIRED_KEYS, ...(values.AUTH_MODE === 'PASSWORD' ? ['FEISHU_AUTH_CREDENTIALS_TABLE_ID'] : ['ASVA_ADMIN_LOGIN_CODE'])]
  const missing = requiredKeys.filter((key) => !values[key])
  if (missing.length) throw new Error(`生产部署配置缺少必填变量：${missing.join(', ')}`)
  if (values.ON_DEMAND_AI_TEST_SCOPE_ENABLED === 'true') {
    const testAdmins = String(values.ON_DEMAND_AI_TEST_ADMIN_ACTOR_IDS || '').split(/[\s,]+/).map((id) => id.trim()).filter(Boolean)
    const testSources = String(values.ON_DEMAND_AI_TEST_SOURCE_IDS || '').split(/[\s,]+/).map((id) => id.trim()).filter(Boolean)
    if (!testAdmins.length || !testSources.length) throw new Error('按需 AI 测试范围启用时必须同时配置 ADMIN 与 Source 白名单')
  }
  return {
    envPath,
    appEnv: values.APP_ENV,
    dataMode: values.DATA_MODE,
    authMode: values.AUTH_MODE,
    deployMode,
    automaticProfileArchiving: values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING,
    automaticProfileArchivingMode: automaticProfileMode,
    automaticProfileArchivingEnabledAt: automaticProfileEnabledAt || '',
    automaticProfileArchivingCanary: canaryEnabled,
    automaticProfileCanaryCustomerCount: canaryCustomerIds.length,
    onDemandAiProcessing: values.FEATURE_ON_DEMAND_AI_PROCESSING === 'true',
    onDemandAiDailyLimit: Math.max(0, Number(values.ON_DEMAND_AI_DAILY_LIMIT || 0) || 0),
    onDemandAiBudgetStoreConfigured: Boolean(String(values.ON_DEMAND_AI_BUDGET_COLLECTION || '').trim()),
    onDemandAiBudgetRpcConfigured: Boolean(String(values.ON_DEMAND_AI_BUDGET_RPC_BASE_URL || '').trim()),
    onDemandAiMaxConcurrent: Math.min(2, Math.max(1, Number(values.ON_DEMAND_AI_MAX_CONCURRENT || 1) || 1)),
    requiredKeyCount: requiredKeys.length,
    configuredTableKeys: Object.keys(values).filter((key) => key.startsWith('FEISHU_') && key.endsWith('_TABLE_ID')).sort(),
  }
}

export function buildProductionEnvVariables(values, buildMetadata) {
  const table = (key) => values[key] || ''
  return {
    DEEPSEEK_API_KEY: values.DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL: values.DEEPSEEK_MODEL || 'deepseek-flash',
    DEEPSEEK_EVIDENCE_MODEL: values.DEEPSEEK_EVIDENCE_MODEL || 'deepseek-flash',
    DEEPSEEK_BASE_URL: values.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    FEISHU_APP_ID: values.FEISHU_APP_ID,
    FEISHU_APP_SECRET: values.FEISHU_APP_SECRET,
    FEISHU_APP_TOKEN: values.FEISHU_APP_TOKEN,
    FEISHU_BASE_URL: values.FEISHU_BASE_URL || 'https://open.feishu.cn',
    FEISHU_APPOINTMENTS_TABLE_ID: table('FEISHU_APPOINTMENTS_TABLE_ID'),
    FEISHU_CUSTOMERS_TABLE_ID: table('FEISHU_CUSTOMERS_TABLE_ID'),
    FEISHU_SERVICE_RECORDS_TABLE_ID: table('FEISHU_SERVICE_RECORDS_TABLE_ID'),
    FEISHU_STAFF_TABLE_ID: table('FEISHU_STAFF_TABLE_ID'),
    FEISHU_PRODUCTS_TABLE_ID: table('FEISHU_PRODUCTS_TABLE_ID'),
    FEISHU_ENROLLMENTS_TABLE_ID: table('FEISHU_ENROLLMENTS_TABLE_ID'),
    FEISHU_PROFILE_CHANGES_TABLE_ID: table('FEISHU_PROFILE_CHANGES_TABLE_ID'),
    FEISHU_SOURCE_RECORDS_TABLE_ID: table('FEISHU_SOURCE_RECORDS_TABLE_ID'),
    FEISHU_EVIDENCE_ITEMS_TABLE_ID: table('FEISHU_EVIDENCE_ITEMS_TABLE_ID'),
    FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID: table('FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID'),
    FEISHU_EVIDENCE_CONFLICTS_TABLE_ID: table('FEISHU_EVIDENCE_CONFLICTS_TABLE_ID'),
    ASVA_AUTH_SECRET: values.ASVA_AUTH_SECRET,
    ...(values.AUTH_MODE === 'ADMIN_CODE' ? { ASVA_ADMIN_LOGIN_CODE: values.ASVA_ADMIN_LOGIN_CODE } : {}),
    FEISHU_AUTH_CREDENTIALS_TABLE_ID: table('FEISHU_AUTH_CREDENTIALS_TABLE_ID'),
    AUTH_MODE: values.AUTH_MODE,
    APP_ENV: 'production',
    ASVA_ENVIRONMENT: 'production',
    DATA_MODE: 'production',
    ALLOW_DEV_OTP: 'false',
    FEATURE_EXTERNAL_APPOINTMENT: 'false',
    FEATURE_AUTOMATIC_PROFILE_ARCHIVING: values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING,
    FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE: values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE,
    AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT: values.AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT || '',
    FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY: values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY || 'false',
    AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS: values.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS || '',
    // Always make the new one-shot endpoint fail closed on a normal deploy.
    // Enabling it requires an explicit reviewed production configuration change.
    FEATURE_ON_DEMAND_AI_PROCESSING: values.FEATURE_ON_DEMAND_AI_PROCESSING || 'false',
    FEATURE_ON_DEMAND_AI_AUTO_TRIGGER: values.FEATURE_ON_DEMAND_AI_AUTO_TRIGGER || 'false',
    ON_DEMAND_AI_AUTO_TRIGGER_CUSTOMER_IDS: values.ON_DEMAND_AI_AUTO_TRIGGER_CUSTOMER_IDS || '',
    ON_DEMAND_AI_AUTO_TRIGGER_ACTOR_IDS: values.ON_DEMAND_AI_AUTO_TRIGGER_ACTOR_IDS || '',
    ON_DEMAND_AI_MAX_CHARS: values.ON_DEMAND_AI_MAX_CHARS || '4000',
    ON_DEMAND_AI_MAX_TOKENS: values.ON_DEMAND_AI_MAX_TOKENS || '2048',
    ON_DEMAND_AI_TIMEOUT_MS: values.ON_DEMAND_AI_TIMEOUT_MS || '45000',
    ON_DEMAND_AI_DAILY_LIMIT: values.ON_DEMAND_AI_DAILY_LIMIT || '0',
    ON_DEMAND_AI_BUDGET_COLLECTION: values.ON_DEMAND_AI_BUDGET_COLLECTION || '',
    CLOUDBASE_APIKEY: values.CLOUDBASE_APIKEY || '',
    ON_DEMAND_AI_BUDGET_RPC_BASE_URL: values.ON_DEMAND_AI_BUDGET_RPC_BASE_URL || '',
    ON_DEMAND_AI_BUDGET_RPC_FUNCTION: values.ON_DEMAND_AI_BUDGET_RPC_FUNCTION || 'asva_ai_budget_guard',
    ON_DEMAND_AI_MAX_CONCURRENT: values.ON_DEMAND_AI_MAX_CONCURRENT || '1',
    ON_DEMAND_AI_TEST_SCOPE_ENABLED: values.ON_DEMAND_AI_TEST_SCOPE_ENABLED || 'false',
    ON_DEMAND_AI_TEST_ADMIN_ACTOR_IDS: values.ON_DEMAND_AI_TEST_ADMIN_ACTOR_IDS || '',
    ON_DEMAND_AI_TEST_SOURCE_IDS: values.ON_DEMAND_AI_TEST_SOURCE_IDS || '',
    ASVA_DEPLOY_MODE: values.ASVA_DEPLOY_MODE || 'normal',
    ASVA_FRONTEND_ORIGIN: values.ASVA_FRONTEND_ORIGIN || 'https://xiangshu3721.github.io',
    CORS_ALLOWED_ORIGINS: values.CORS_ALLOWED_ORIGINS || 'https://xiangshu3721.github.io,http://localhost:5173,http://127.0.0.1:5173',
    ASVA_RELEASE_COUNTER: String(buildMetadata.releaseCounter),
    ASVA_RELEASE_PATCH: String(buildMetadata.releasePatch || 0),
    ASVA_GIT_COMMIT: buildMetadata.gitCommit,
    ASVA_GIT_BRANCH: buildMetadata.gitBranch,
    ASVA_BUILD_TIME: buildMetadata.buildTime,
    HOST: '0.0.0.0',
    PORT: '9000',
  }
}

// Deploying the Worker must never make it runnable by accident.  The caller
// must deliberately opt in on the command line and in the reviewed deployment
// environment.  Timer restoration has an additional, auditable approval value.
export function workerRestorePolicy(values, args = process.argv.slice(2)) {
  const enableWorker = args.includes('--enable-archive-worker')
  const restoreTimer = args.includes('--restore-worker-timer')
  const deployMode = values.ASVA_DEPLOY_MODE || 'normal'
  const workerRuntimeEnabled = enableWorker
    && values.AUTOMATIC_ARCHIVE_WORKER_ENABLED === 'true'
    && values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING === 'true'
    && deployMode === 'production'

  if (restoreTimer && !enableWorker) {
    throw new Error('--restore-worker-timer 必须同时提供 --enable-archive-worker')
  }
  if (enableWorker && !workerRuntimeEnabled) {
    throw new Error('启用自动归档 Worker 需要 production 模式、功能开关和 AUTOMATIC_ARCHIVE_WORKER_ENABLED=true')
  }
  if (restoreTimer && values.ASVA_WORKER_TIMER_RESTORE_APPROVED !== 'true') {
    throw new Error('恢复自动归档定时器需要 ASVA_WORKER_TIMER_RESTORE_APPROVED=true 的单独批准')
  }

  return {
    workerRuntimeEnabled,
    restoreTimer: restoreTimer && workerRuntimeEnabled,
  }
}

export function buildWorkerEnvVariables(values, buildMetadata, policy = workerRestorePolicy(values, [])) {
  return {
    ...buildProductionEnvVariables(values, buildMetadata),
    // Explicitly write false during every ordinary Worker deployment instead
    // of relying on an old cloud-side value surviving a configuration update.
    AUTOMATIC_ARCHIVE_WORKER_ENABLED: policy.workerRuntimeEnabled ? 'true' : 'false',
  }
}

function run(command, args, cwd, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: environment })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)))
  })
}

function runCapture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited with code ${code}: ${output.slice(-4000)}`)))
  })
}

export function parseDeploymentTarget(args = process.argv.slice(2)) {
  const index = args.indexOf('--target')
  const target = index < 0 ? 'api' : args[index + 1]
  if (!['api', 'worker', 'all'].includes(target)) throw new Error('部署目标必须是 api、worker 或 all')
  return target
}

export async function deployProduction({ target = parseDeploymentTarget(), args = process.argv.slice(2) } = {}) {
  if (!['api', 'worker', 'all'].includes(target)) throw new Error('部署目标必须是 api、worker 或 all')
  if (!process.env.ASVA_DEPLOY_ENV_FILE) throw new Error('生产部署必须显式设置 ASVA_DEPLOY_ENV_FILE，禁止回退到仓库默认配置')
  const envPath = path.resolve(process.env.ASVA_DEPLOY_ENV_FILE)
  const values = parseEnv(await readFile(envPath, 'utf8'))
  const buildMetadata = JSON.parse(await readFile(path.join(root, 'build-meta.json'), 'utf8'))
  const summary = validateProductionEnv(values, envPath)
  const envVariables = buildProductionEnvVariables(values, buildMetadata)
  const workerPolicy = workerRestorePolicy(values, args)
  const workerEnvVariables = buildWorkerEnvVariables(values, buildMetadata, workerPolicy)
  if (process.argv.includes('--preflight')) {
    console.log(JSON.stringify({ ok: true, preflight: summary, worker: workerPolicy, release: `R${String(buildMetadata.releaseCounter).padStart(3, '0')}${buildMetadata.releasePatch > 0 ? `.${buildMetadata.releasePatch}` : ''}`, gitCommit: buildMetadata.gitCommit }))
    return
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'asva-cloudbase-'))
  try {
    const deployApi = target === 'api' || target === 'all'
    const deployWorker = target === 'worker' || target === 'all'
    const functionConfig = []
    if (deployApi) functionConfig.push({
      name: functionName,
      handler: 'index.main',
      runtime: 'Nodejs20.19',
      // P0-20261122: first acceptance run completed all business writes at 59.7s
      // but was killed by the 60s SCF timeout before PG complete ran. HTTP
      // functions support 1-7200s. 120s gives the on-demand path headroom for
      // model call + evidence writes + proposal writes + PG completion.
      timeout: 120,
      memorySize: 256,
      envVariables,
    })
    if (deployWorker) functionConfig.push({
      name: workerName,
      handler: 'index.main',
      runtime: 'Nodejs20.19',
      timeout: 60,
      memorySize: WORKER_MEMORY_MB,
      envVariables: workerEnvVariables,
    })
    await writeFile(path.join(tempDir, 'cloudbaserc.json'), JSON.stringify({
      envId,
      functionRoot: functionDir,
      functions: functionConfig,
    }, null, 2))

    const tcb = process.env.TCB_BIN || 'tcb'
    const functionsOutput = await runCapture(tcb, ['fn', 'list', '--env-id', envId, '--json'], root)
    const functionsJsonStart = functionsOutput.indexOf('{')
    const functionsRaw = functionsJsonStart >= 0 ? JSON.parse(functionsOutput.slice(functionsJsonStart)) : { data: [] }
    // tcb fn list may return data as an array or as { Functions: [...] }
    const functionsList = Array.isArray(functionsRaw.data) ? functionsRaw.data : (functionsRaw.data?.Functions || functionsRaw.data?.functions || [])
    if (deployApi) {
      const hasExistingTarget = functionsList.some((item) => item.name === functionName || item.FunctionName === functionName)
      const functionArgs = ['fn', 'deploy', functionName, '--dir', functionDir, '--httpFn', '--runtime', 'Nodejs20.19', '--install-dependency', 'false', '--yes']
      if (hasExistingTarget) functionArgs.push('--force')
      functionArgs.push('--json')
      await run(tcb, functionArgs, tempDir)

      const servicesOutput = await runCapture(tcb, ['service', 'list', '--env-id', envId, '--json'], root)
      const servicesJsonStart = servicesOutput.indexOf('{')
      const services = servicesJsonStart >= 0 ? JSON.parse(servicesOutput.slice(servicesJsonStart)) : { data: [] }
      const hasService = (services.data || []).some((item) => item.path === `/${servicePath}` && item.name === functionName)
      if (!hasService) await run(tcb, ['service', 'create', '--env-id', envId, '--service-path', servicePath, '--function', functionName, '--json'], tempDir)
      console.log(`ASVA CloudBase API base: ${serviceUrl}`)
    }

    if (deployWorker) {
      const hasExistingWorker = functionsList.some((item) => item.name === workerName || item.FunctionName === workerName)
      const workerArgs = ['fn', 'deploy', workerName, '--dir', workerDir, '--runtime', 'Nodejs20.19', '--install-dependency', 'false', '--yes']
      if (hasExistingWorker) workerArgs.push('--force')
      workerArgs.push('--json')
      await run(tcb, workerArgs, tempDir)
      if (workerPolicy.restoreTimer) {
        const workerDetailOutput = await runCapture(tcb, ['fn', 'detail', workerName, '--env-id', envId, '--json'], root)
        const workerDetailJsonStart = workerDetailOutput.indexOf('{')
        const workerDetail = workerDetailJsonStart >= 0 ? JSON.parse(workerDetailOutput.slice(workerDetailJsonStart)) : { data: {} }
        const workerTriggers = workerDetail.data?.Triggers || []
        const hasWorkerTrigger = workerTriggers.some((trigger) => trigger.TriggerName === workerTriggerName || trigger.triggerName === workerTriggerName || trigger.Name === workerTriggerName || trigger.name === workerTriggerName)
        if (!hasWorkerTrigger) await run(tcb, ['fn', 'trigger', 'create', workerName, '--trigger-name', workerTriggerName, '--cron', workerCron, '--json'], tempDir)
      } else {
        console.info('[ASVA_AUTO_ARCHIVE_DEPLOY]', JSON.stringify({ worker: workerName, timer: 'UNCHANGED', reason: 'RESTORE_NOT_EXPLICITLY_AUTHORIZED' }))
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await deployProduction({ target: parseDeploymentTarget() })
}
