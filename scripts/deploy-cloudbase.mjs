import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envId = 'root-journey-prod-d4d7pzd0a8f805'
const functionName = 'asva-api'
const servicePath = 'asva-api'
const serviceUrl = 'https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api'
const functionDir = path.join(root, 'cloudbase/functions/asva-api')

function parseEnv(text) {
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

const envPath = path.join(root, '.env.local')
const values = parseEnv(await readFile(envPath, 'utf8'))
const buildMetadata = JSON.parse(await readFile(path.join(root, 'build-meta.json'), 'utf8'))
const authMode = values.AUTH_MODE || 'ADMIN_CODE'
const requiredKeys = ['DEEPSEEK_API_KEY', 'FEISHU_APP_SECRET', 'FEISHU_APP_TOKEN', 'ASVA_AUTH_SECRET', ...(authMode === 'PASSWORD' ? ['FEISHU_AUTH_CREDENTIALS_TABLE_ID'] : ['ASVA_ADMIN_LOGIN_CODE'])]
const missing = requiredKeys.filter((key) => !values[key])
if (missing.length) throw new Error(`.env.local 缺少 ASVA CloudBase 生产变量：${missing.join(', ')}`)

const envVariables = {
  DEEPSEEK_API_KEY: values.DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: values.DEEPSEEK_MODEL || 'deepseek-chat',
  DEEPSEEK_BASE_URL: values.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  FEISHU_APP_ID: values.FEISHU_APP_ID || 'cli_aaff6cb53db89bd3',
  FEISHU_APP_SECRET: values.FEISHU_APP_SECRET,
  FEISHU_APP_TOKEN: values.FEISHU_APP_TOKEN,
  FEISHU_BASE_URL: values.FEISHU_BASE_URL || 'https://open.feishu.cn',
  FEISHU_APPOINTMENTS_TABLE_ID: values.FEISHU_APPOINTMENTS_TABLE_ID || 'tblUrXu4ivBGJ7zV',
  FEISHU_CUSTOMERS_TABLE_ID: values.FEISHU_CUSTOMERS_TABLE_ID || 'tblFKkM7fPTqi8Zx',
  FEISHU_SERVICE_RECORDS_TABLE_ID: values.FEISHU_SERVICE_RECORDS_TABLE_ID || 'tblFGmyJi3RJQ7bM',
  FEISHU_STAFF_TABLE_ID: values.FEISHU_STAFF_TABLE_ID || 'tblojNfk4bVM5KxH',
  FEISHU_PRODUCTS_TABLE_ID: values.FEISHU_PRODUCTS_TABLE_ID || 'tblLG2SFwYpKgiMQ',
  FEISHU_ENROLLMENTS_TABLE_ID: values.FEISHU_ENROLLMENTS_TABLE_ID || '',
  FEISHU_PROFILE_CHANGES_TABLE_ID: values.FEISHU_PROFILE_CHANGES_TABLE_ID || 'tblTH3OmBuzUsBVu',
  FEISHU_SOURCE_RECORDS_TABLE_ID: values.FEISHU_SOURCE_RECORDS_TABLE_ID || '',
  FEISHU_EVIDENCE_ITEMS_TABLE_ID: values.FEISHU_EVIDENCE_ITEMS_TABLE_ID || '',
  FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID: values.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID || '',
  FEISHU_EVIDENCE_CONFLICTS_TABLE_ID: values.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID || '',
  ASVA_AUTH_SECRET: values.ASVA_AUTH_SECRET || '',
  ...(authMode === 'ADMIN_CODE' ? { ASVA_ADMIN_LOGIN_CODE: values.ASVA_ADMIN_LOGIN_CODE || '' } : {}),
  FEISHU_AUTH_CREDENTIALS_TABLE_ID: values.FEISHU_AUTH_CREDENTIALS_TABLE_ID || '',
  AUTH_MODE: authMode,
  ASVA_ENVIRONMENT: 'production',
  DATA_MODE: 'production',
  ALLOW_DEV_OTP: 'false',
  FEATURE_EXTERNAL_APPOINTMENT: 'false',
  ASVA_FRONTEND_ORIGIN: values.ASVA_FRONTEND_ORIGIN || 'https://xiangshu3721.github.io',
  ASVA_RELEASE_COUNTER: String(buildMetadata.releaseCounter),
  ASVA_GIT_COMMIT: buildMetadata.gitCommit,
  ASVA_GIT_BRANCH: buildMetadata.gitBranch,
  ASVA_BUILD_TIME: buildMetadata.buildTime,
  HOST: '0.0.0.0',
  PORT: '9000',
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
