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
  const canaryEnabled = values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY === 'true'
  const canaryCustomerIds = String(values.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS || '').split(/[\s,]+/).map((id) => id.trim()).filter(Boolean)
  if (!['normal', 'canary'].includes(deployMode)) throw new Error('ASVA_DEPLOY_MODE 必须是 normal 或 canary')
  if (deployMode === 'normal') {
    if (values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING !== 'false') throw new Error('FEATURE_AUTOMATIC_PROFILE_ARCHIVING 必须显式设置为 false')
    if (canaryEnabled || canaryCustomerIds.length) throw new Error('normal 部署不得携带自动归档 Canary 配置')
  } else {
    if (values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING !== 'true') throw new Error('canary 部署必须显式设置 FEATURE_AUTOMATIC_PROFILE_ARCHIVING=true')
    if (!canaryEnabled) throw new Error('canary 部署必须显式设置 FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY=true')
    if (!canaryCustomerIds.length) throw new Error('canary 部署必须配置 AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS')
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
    await writeFile(path.join(tempDir, 'cloudbaserc.json'), JSON.stringify({
      envId,
      functionRoot: functionDir,
      functions: [{
        name: functionName,
        type: 'HTTP',
        handler: 'index.main',
        runtime: 'Nodejs20.19',
        timeout: 60,
        memorySize: 256,
        envVariables,
      }],
    }, null, 2))

    const tcb = process.env.TCB_BIN || 'tcb'
    const functionsOutput = await runCapture(tcb, ['fn', 'list', '--env-id', envId, '--json'], root)
    const functionsJsonStart = functionsOutput.indexOf('{')
    const functions = functionsJsonStart >= 0 ? JSON.parse(functionsOutput.slice(functionsJsonStart)) : { data: [] }
    const hasExistingTarget = (functions.data || []).some((item) => item.name === functionName)
    const functionArgs = ['fn', 'deploy', functionName, '--dir', functionDir, '--httpFn', '--runtime', 'Nodejs20.19', '--install-dependency', 'false', '--yes']
    if (hasExistingTarget) functionArgs.push('--force')
    functionArgs.push('--json')
    await run(tcb, functionArgs, tempDir)

    const servicesOutput = await runCapture(tcb, ['service', 'list', '--env-id', envId, '--json'], root)
    const servicesJsonStart = servicesOutput.indexOf('{')
    const services = servicesJsonStart >= 0 ? JSON.parse(servicesOutput.slice(servicesJsonStart)) : { data: [] }
    const hasService = (services.data || []).some((item) => item.path === `/${servicePath}` && item.name === functionName)
    if (!hasService) await run(tcb, ['service', 'create', '--env-id', envId, '--service-path', servicePath, '--function', functionName, '--json'], root)
    console.log(`ASVA CloudBase API base: ${serviceUrl}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await deployProduction()
}
