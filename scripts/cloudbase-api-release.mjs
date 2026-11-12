import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PRODUCTION_ENV_ID = 'root-journey-prod-d4d7pzd0a8f805'
export const API_FUNCTION_NAME = 'asva-api'
export const API_HEALTH_URL = 'https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api/api/health'

function valueAfter(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? '' : args[index + 1] || ''
}

export function assertApiOnlyTarget({ envId, functionName }) {
  if (envId !== PRODUCTION_ENV_ID) throw new Error(`Refusing unexpected CloudBase environment: ${envId || '(empty)'}`)
  if (functionName !== API_FUNCTION_NAME) throw new Error(`Refusing non-API CloudBase function: ${functionName || '(empty)'}`)
  return { envId, functionName }
}

export function apiOnlyCommandPlan({ envId = PRODUCTION_ENV_ID, functionName = API_FUNCTION_NAME, backupDir, candidateDir }) {
  assertApiOnlyTarget({ envId, functionName })
  const prefix = ['-e', envId, 'fn']
  return {
    detail: [...prefix, 'detail', functionName, '--json'],
    download: [...prefix, 'code', 'download', functionName, path.join(backupDir, 'code'), '--json'],
    update: candidateDir ? [...prefix, 'code', 'update', functionName, '--dir', candidateDir, '--deployMode', 'cos', '--json'] : null,
  }
}

function parseJsonOutput(output, label) {
  const trimmed = String(output || '').trim()
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart < 0) throw new Error(`${label} did not return JSON`)
  try {
    return JSON.parse(trimmed.slice(jsonStart))
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }
}

function functionRecord(detail) {
  return detail?.data || detail?.Data || detail?.Response || detail
}

export function functionSnapshot(detail) {
  const record = functionRecord(detail)
  const name = record?.Name || record?.name || record?.FunctionName || record?.functionName
  const codeSha256 = record?.CodeSha256 || record?.codeSha256 || record?.CodeSha || record?.codeSha
  if (name !== API_FUNCTION_NAME) throw new Error('CloudBase detail did not identify asva-api')
  if (!codeSha256) throw new Error('CloudBase detail did not include an API code hash')
  return {
    functionName: name,
    codeSha256,
    runtime: record?.Runtime || record?.runtime || '',
    timeout: record?.Timeout || record?.timeout || '',
  }
}

function runTcb(args, { tcbBin = process.env.TCB_BIN || 'tcb', cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tcbBin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`CloudBase CLI failed (${code})`)))
  })
}

async function directoryHasContent(target) {
  const entries = await readdir(target)
  return entries.length > 0
}

async function checkHealth(fetchImpl = fetch) {
  const response = await fetchImpl(API_HEALTH_URL, { signal: AbortSignal.timeout(20_000) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.status !== 'ok') throw new Error(`API health check failed with HTTP ${response.status}`)
  return {
    httpStatus: response.status,
    status: payload.status,
    release: payload.release || '',
    gitCommit: payload.gitCommit || '',
    version: payload.version || '',
  }
}

function options(args) {
  const envId = valueAfter(args, '--env-id') || PRODUCTION_ENV_ID
  const backupDir = valueAfter(args, '--backup-dir')
  const candidateDir = valueAfter(args, '--candidate-dir')
  if (!backupDir) throw new Error('Missing --backup-dir')
  return { envId, backupDir: path.resolve(backupDir), candidateDir: candidateDir ? path.resolve(candidateDir) : '' }
}

async function readDetail(plan, runner = runTcb) {
  return functionSnapshot(parseJsonOutput(await runner(plan.detail), 'CloudBase function detail'))
}

export async function preflight({ args = process.argv.slice(3), runner = runTcb, fetchImpl = fetch } = {}) {
  const { envId, backupDir } = options(args)
  const plan = apiOnlyCommandPlan({ envId, backupDir })
  await mkdir(backupDir, { recursive: true })
  const before = await readDetail(plan, runner)
  await runner(plan.download)
  if (!await directoryHasContent(path.join(backupDir, 'code'))) throw new Error('CloudBase rollback code download was empty')
  const health = await checkHealth(fetchImpl)
  const baseline = { schemaVersion: 1, environmentId: envId, api: before, health }
  await writeFile(path.join(backupDir, 'baseline.json'), JSON.stringify(baseline, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ok: true, operation: 'preflight', baseline }))
  return baseline
}

async function loadBaseline(backupDir) {
  const source = await readFile(path.join(backupDir, 'baseline.json'), 'utf8')
  const baseline = JSON.parse(source)
  assertApiOnlyTarget({ envId: baseline.environmentId, functionName: baseline.api?.functionName })
  if (!baseline.api?.codeSha256) throw new Error('Rollback baseline did not include an API code hash')
  if (!await directoryHasContent(path.join(backupDir, 'code'))) throw new Error('Rollback baseline code is missing')
  return baseline
}

async function ensureCandidate(candidateDir) {
  if (!candidateDir) throw new Error('Missing --candidate-dir')
  const entry = path.join(candidateDir, 'index.js')
  if (!(await stat(entry)).isFile()) throw new Error('Candidate API bundle is missing index.js')
}

async function rollback({ envId, backupDir, runner }) {
  const plan = apiOnlyCommandPlan({ envId, backupDir, candidateDir: path.join(backupDir, 'code') })
  await runner(plan.update)
  return readDetail(plan, runner)
}

export async function deploy({ args = process.argv.slice(3), runner = runTcb, fetchImpl = fetch } = {}) {
  const { envId, backupDir, candidateDir } = options(args)
  const baseline = await loadBaseline(backupDir)
  await ensureCandidate(candidateDir)
  const plan = apiOnlyCommandPlan({ envId, backupDir, candidateDir })
  const current = await readDetail(plan, runner)
  if (current.codeSha256 !== baseline.api.codeSha256) throw new Error('API code changed after the rollback baseline was captured; refusing deployment')
  let updateStarted = false
  try {
    updateStarted = true
    await runner(plan.update)
    const after = await readDetail(plan, runner)
    const health = await checkHealth(fetchImpl)
    const result = { ok: true, operation: 'deploy', before: baseline.api, after, health }
    console.log(JSON.stringify(result))
    return result
  } catch (error) {
    if (!updateStarted) throw error
    try {
      const afterRollback = await rollback({ envId, backupDir, runner })
      const health = await checkHealth(fetchImpl)
      throw new Error(`API deployment failed and rollback completed (rollback hash: ${afterRollback.codeSha256}, health: ${health.status}): ${error.message}`)
    } catch (rollbackError) {
      if (String(rollbackError.message).startsWith('API deployment failed and rollback completed')) throw rollbackError
      throw new Error(`API deployment failed; rollback outcome is unknown: ${rollbackError.message}`)
    }
  }
}

async function main() {
  const [command] = process.argv.slice(2)
  if (command === 'preflight') return preflight()
  if (command === 'deploy') return deploy()
  throw new Error('Usage: node scripts/cloudbase-api-release.mjs <preflight|deploy> --backup-dir <path> [--candidate-dir <path>] [--env-id <id>]')
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
