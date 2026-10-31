import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envId = 'root-journey-prod-d4d7pzd0a8f805'
const functionName = 'asva-api'
const servicePath = 'asva-api'
const aiArchiveFunctionName = 'asva-ai-archive'
const aiArchiveFunctionDir = path.join(root, 'cloudbase/functions/asva-ai-archive')
const serviceUrl = 'https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api'
const functionDir = path.join(root, 'cloudbase/functions/asva-api')

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
  const requiredKeys = [...PRODUCTION_REQUIRED_KEYS, ...(values.AUTH_MODE === 'PASSWORD' ? ['FEISHU_AUTH_CREDENTIALS_TABLE_ID'] : ['ASVA_ADMIN_LOGIN_CODE'])]
  const missing = requiredKeys.filter((key) => !values[key])
  if (missing.length) throw new Error(`生产部署配置缺少必填变量：${missing.join(', ')}`)
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
    requiredKeyCount: requiredKeys.length,
    configuredTableKeys: Object.keys(values).filter((key) => key.startsWith('FEISHU_') && key.endsWith('_TABLE_ID')).sort(),
  }
}

export function buildProductionEnvVariables(values, buildMetadata) {
  const table = (key) => values[key] || ''
  return {
    DEEPSEEK_API_KEY: values.DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL: values.DEEPSEEK_MODEL || 'deepseek-chat',
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
    ASVA_AI_ARCHIVE_FUNCTION_NAME: values.ASVA_AI_ARCHIVE_FUNCTION_NAME || 'asva-ai-archive',
    ASVA_AI_ARCHIVE_INVOKE_MODE: values.ASVA_AI_ARCHIVE_INVOKE_MODE || 'event',
    CLOUDBASE_ENV_ID: values.CLOUDBASE_ENV_ID || values.TCB_ENV_ID || 'root-journey-prod-d4d7pzd0a8f805',
    ...(values.ASVA_AI_ARCHIVE_INVOKE_SECRET ? { ASVA_AI_ARCHIVE_INVOKE_SECRET: values.ASVA_AI_ARCHIVE_INVOKE_SECRET } : {}),
    ...(values.TENCENTCLOUD_SECRETID ? { TENCENTCLOUD_SECRETID: values.TENCENTCLOUD_SECRETID } : {}),
    ...(values.TENCENTCLOUD_SECRETKEY ? { TENCENTCLOUD_SECRETKEY: values.TENCENTCLOUD_SECRETKEY } : {}),
    ...(values.CLOUDBASE_SECRET_ID ? { CLOUDBASE_SECRET_ID: values.CLOUDBASE_SECRET_ID } : {}),
    ...(values.CLOUDBASE_SECRET_KEY ? { CLOUDBASE_SECRET_KEY: values.CLOUDBASE_SECRET_KEY } : {}),
    ...(values.CLOUDBASE_APIKEY ? { CLOUDBASE_APIKEY: values.CLOUDBASE_APIKEY } : {}),
  }
}

export function buildAiArchiveEnvVariables(values, buildMetadata) {
  const apiEnv = buildProductionEnvVariables(values, buildMetadata)
  return {
    ...apiEnv,
    // Worker is Event-triggered; keep invoke mode local-disabled inside worker itself.
    ASVA_AI_ARCHIVE_INVOKE_MODE: 'disabled',
    HOST: '0.0.0.0',
    PORT: '9001',
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

export async function deployProduction() {
  if (!process.env.ASVA_DEPLOY_ENV_FILE) throw new Error('生产部署必须显式设置 ASVA_DEPLOY_ENV_FILE，禁止回退到仓库默认配置')
  const envPath = path.resolve(process.env.ASVA_DEPLOY_ENV_FILE)
  const values = parseEnv(await readFile(envPath, 'utf8'))
  const buildMetadata = JSON.parse(await readFile(path.join(root, 'build-meta.json'), 'utf8'))
  const summary = validateProductionEnv(values, envPath)
  const envVariables = buildProductionEnvVariables(values, buildMetadata)
  if (process.argv.includes('--preflight')) {
    console.log(JSON.stringify({ ok: true, preflight: summary, release: `R${String(buildMetadata.releaseCounter).padStart(3, '0')}${buildMetadata.releasePatch > 0 ? `.${buildMetadata.releasePatch}` : ''}`, gitCommit: buildMetadata.gitCommit }))
    return
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'asva-cloudbase-'))
  try {
    const tcb = process.env.TCB_BIN || 'tcb'

    // Deploy worker FIRST so Event invoke from the new API tip has a ready target.
    let workerConfirm = null
    if (!process.argv.includes('--skip-ai-archive-worker')) {
      workerConfirm = await deployAiArchiveWorker({
        tcb,
        envId,
        envVariables: buildAiArchiveEnvVariables(values, buildMetadata),
        tempDir,
      })
    } else {
      console.log('Skipped asva-ai-archive worker deploy (--skip-ai-archive-worker)')
    }

    // Then API: rewrite cloudbaserc.json for HTTP asva-api (cwd=tempDir consumes this file).
    const apiRc = buildApiCloudbaserc({ envId, functionDir, functionName, envVariables })
    await writeFile(path.join(tempDir, 'cloudbaserc.json'), JSON.stringify(apiRc, null, 2))

    const functionsOutput = await runCapture(tcb, ['fn', 'list', '--env-id', envId, '--json'], root)
    const functionsJsonStart = functionsOutput.indexOf('{')
    const functions = functionsJsonStart >= 0 ? JSON.parse(functionsOutput.slice(functionsJsonStart)) : { data: [] }
    const hasExistingTarget = (functions.data || []).some((item) => item.name === functionName)
    const functionArgs = ['fn', 'deploy', functionName, '--dir', functionDir, '--httpFn', '--runtime', 'Nodejs20.19', '--install-dependency', 'false', '--yes', '--config', path.join(tempDir, 'cloudbaserc.json')]
    if (hasExistingTarget) functionArgs.push('--force')
    functionArgs.push('--json')
    await run(tcb, functionArgs, tempDir)

    const servicesOutput = await runCapture(tcb, ['service', 'list', '--env-id', envId, '--json'], root)
    const servicesJsonStart = servicesOutput.indexOf('{')
    const services = servicesJsonStart >= 0 ? JSON.parse(servicesOutput.slice(servicesJsonStart)) : { data: [] }
    const hasService = (services.data || []).some((item) => item.path === `/${servicePath}` && item.name === functionName)
    if (!hasService) await run(tcb, ['service', 'create', '--env-id', envId, '--service-path', servicePath, '--function', functionName, '--json'], root)
    console.log(`ASVA CloudBase API base: ${serviceUrl}`)
    if (workerConfirm) {
      console.log(`ASVA AI archive worker confirmed: memory=${workerConfirm.memorySize} timeout=${workerConfirm.timeout} envKeys=${workerConfirm.envKeyCount}`)
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * Deploy the Event worker used for AI archive closed loop.
 * First release checklist (manual; this script does not grant IAM):
 * 1) npm run build:cloudbase:ai-archive
 * 2) Deploy worker + asva-api with ASVA_DEPLOY_ENV_FILE
 * 3) Ensure asva-api runtime has TENCENTCLOUD_SECRETID/KEY (or CLOUDBASE_*) with SCF Invoke permission on asva-ai-archive
 * 4) Set ASVA_AI_ARCHIVE_INVOKE_MODE=event and matching ASVA_AI_ARCHIVE_INVOKE_SECRET on both functions
 * 5) Do NOT enable provisioned concurrency
 * Memory default 512 to match live asva-api strategy. Timeout 120s for AI+Feishu budget.
 */
export function buildApiCloudbaserc({ envId: targetEnvId, functionDir: apiDir, functionName: apiName, envVariables }) {
  return {
    envId: targetEnvId,
    functionRoot: apiDir,
    functions: [{
      name: apiName,
      type: 'HTTP',
      handler: 'index.main',
      runtime: 'Nodejs20.19',
      timeout: 60,
      memorySize: 512,
      envVariables,
    }],
  }
}

export function buildAiArchiveCloudbaserc({ envId: targetEnvId, workerDir, envVariables }) {
  return {
    envId: targetEnvId,
    functionRoot: path.dirname(workerDir),
    functions: [{
      name: aiArchiveFunctionName,
      // Event / ordinary function (not HTTP)
      handler: 'index.main',
      runtime: 'Nodejs20.19',
      timeout: 120,
      memorySize: 512,
      envVariables,
    }],
  }
}

/** Deploy order for production: worker then api. */
export function productionDeployOrder({ skipWorker = false } = {}) {
  return skipWorker ? ['asva-api'] : ['asva-ai-archive', 'asva-api']
}

export async function deployAiArchiveWorker({ tcb, envId: targetEnvId, envVariables, tempDir }) {
  const workerDir = aiArchiveFunctionDir
  const workerRc = buildAiArchiveCloudbaserc({ envId: targetEnvId, workerDir, envVariables })
  // CLI cwd=tempDir reads cloudbaserc.json; also keep a named copy for operators.
  const rcPath = path.join(tempDir, 'cloudbaserc.json')
  await writeFile(rcPath, JSON.stringify(workerRc, null, 2))
  await writeFile(path.join(tempDir, 'cloudbaserc.ai-archive.json'), JSON.stringify(workerRc, null, 2))
  const functionsOutput = await runCapture(tcb, ['fn', 'list', '--env-id', targetEnvId, '--json'], root)
  const functionsJsonStart = functionsOutput.indexOf('{')
  const functions = functionsJsonStart >= 0 ? JSON.parse(functionsOutput.slice(functionsJsonStart)) : { data: [] }
  const hasExistingTarget = (functions.data || []).some((item) => item.name === aiArchiveFunctionName)
  // Ordinary Event function: do not pass --httpFn; pass --config so settings apply.
  const functionArgs = [
    'fn', 'deploy', aiArchiveFunctionName,
    '--dir', workerDir,
    '--runtime', 'Nodejs20.19',
    '--install-dependency', 'false',
    '--yes',
    '--config', rcPath,
  ]
  if (hasExistingTarget) functionArgs.push('--force')
  functionArgs.push('--json')
  await run(tcb, functionArgs, tempDir)

  // Read back to confirm memory/timeout/env actually applied.
  let confirmed = {
    memorySize: workerRc.functions[0].memorySize,
    timeout: workerRc.functions[0].timeout,
    envKeyCount: Object.keys(envVariables || {}).length,
    readBack: false,
  }
  try {
    const detailOutput = await runCapture(tcb, ['fn', 'detail', aiArchiveFunctionName, '--env-id', targetEnvId, '--json'], root)
    const detailStart = detailOutput.indexOf('{')
    const detail = detailStart >= 0 ? JSON.parse(detailOutput.slice(detailStart)) : null
    const data = detail?.data || detail || {}
    confirmed = {
      memorySize: Number(data.MemorySize || data.memorySize || confirmed.memorySize),
      timeout: Number(data.Timeout || data.timeout || confirmed.timeout),
      envKeyCount: Object.keys(data.EnvVariables || data.envVariables || envVariables || {}).length || confirmed.envKeyCount,
      readBack: true,
      name: data.Name || data.name || aiArchiveFunctionName,
    }
    if (confirmed.memorySize !== 512 || confirmed.timeout !== 120) {
      throw new Error(`asva-ai-archive 配置读回不符: memory=${confirmed.memorySize} timeout=${confirmed.timeout}（期望 512/120）`)
    }
  } catch (error) {
    if (String(error?.message || '').includes('配置读回不符')) throw error
    console.warn(`ASVA AI archive worker detail read-back skipped: ${error?.message || error}`)
  }
  console.log(`ASVA AI archive worker deployed: ${aiArchiveFunctionName} (Event, memory=${confirmed.memorySize}, timeout=${confirmed.timeout}, envKeys=${confirmed.envKeyCount}, readBack=${confirmed.readBack}). Tip: deploy by tip SHA; do not merge dirty PR#54.`)
  return confirmed
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--worker-only')) {
    if (!process.env.ASVA_DEPLOY_ENV_FILE) throw new Error('生产部署必须显式设置 ASVA_DEPLOY_ENV_FILE，禁止回退到仓库默认配置')
    const envPath = path.resolve(process.env.ASVA_DEPLOY_ENV_FILE)
    const values = parseEnv(await readFile(envPath, 'utf8'))
    const buildMetadata = JSON.parse(await readFile(path.join(root, 'build-meta.json'), 'utf8'))
    validateProductionEnv(values, envPath)
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'asva-cloudbase-worker-'))
    try {
      await deployAiArchiveWorker({
        tcb: process.env.TCB_BIN || 'tcb',
        envId,
        envVariables: buildAiArchiveEnvVariables(values, buildMetadata),
        tempDir,
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  } else {
    await deployProduction()
  }
}
