import { createHash } from 'node:crypto'
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
    codeAddress: ['-e', envId, 'api', 'scf', 'GetFunctionAddress', '--api-version', '2018-04-16', '--body', JSON.stringify({ FunctionName: functionName, Namespace: envId, Qualifier: '$LATEST' }), '--json'],
    download: [...prefix, 'code', 'download', functionName, path.join(backupDir, 'code'), '--json'],
    update: candidateDir ? [...prefix, 'code', 'update', functionName, '--dir', candidateDir, '--deployMode', 'cos', '--json'] : null,
  }
}

export function parseJsonOutput(output, label) {
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
  if (name !== API_FUNCTION_NAME) throw new Error('CloudBase detail did not identify asva-api')
  return {
    functionName: name,
    runtime: record?.Runtime || record?.runtime || '',
    timeout: record?.Timeout || record?.timeout || '',
  }
}

export function codeAddressSnapshot(address) {
  const record = address?.Response || address?.response || address?.data || address
  const codeSha256 = record?.CodeSha256 || record?.codeSha256
  if (!codeSha256 || typeof codeSha256 !== 'string') throw new Error('CloudBase code address did not include a code hash')
  return { remoteCodeSha256: codeSha256 }
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

async function fileManifest(rootDir, relative = '') {
  const directory = path.join(rootDir, relative)
  const entries = await readdir(directory, { withFileTypes: true })
  const manifest = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryRelative = path.join(relative, entry.name)
    const fullPath = path.join(rootDir, entryRelative)
    if (entry.isDirectory()) manifest.push(...await fileManifest(rootDir, entryRelative))
    else if (entry.isFile()) {
      const content = await readFile(fullPath)
      manifest.push({ path: entryRelative.split(path.sep).join('/'), size: content.length, sha256: createHash('sha256').update(content).digest('hex') })
    } else throw new Error(`Rollback bundle contains a non-regular file: ${entryRelative}`)
  }
  return manifest
}

export async function deployableBundleFingerprint(bundleDir) {
  const entry = path.join(bundleDir, 'index.js')
  if (!(await stat(entry)).isFile()) throw new Error('Deployable function bundle is missing index.js')
  const files = await fileManifest(bundleDir)
  if (!files.length) throw new Error('Deployable function bundle is empty')
  return {
    entry: 'index.js',
    fileCount: files.length,
    contentSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  }
}

function assertSameBundle(expected, actual, label) {
  if (!expected || expected.contentSha256 !== actual.contentSha256 || expected.fileCount !== actual.fileCount || expected.entry !== actual.entry) {
    throw new Error(`${label} bundle no longer matches its verified baseline`)
  }
}

export async function checkHealth(fetchImpl = fetch) {
  const response = await fetchImpl(API_HEALTH_URL, { signal: AbortSignal.timeout(20_000) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok !== true) throw new Error(`API health check failed with HTTP ${response.status}`)
  return {
    httpStatus: response.status,
    ok: true,
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
  const detail = functionSnapshot(parseJsonOutput(await runner(plan.detail), 'CloudBase function detail'))
  const codeAddress = codeAddressSnapshot(parseJsonOutput(await runner(plan.codeAddress), 'CloudBase function code address'))
  return { ...detail, ...codeAddress }
}

async function downloadRollbackBundle(plan, runner) {
  const output = parseJsonOutput(await runner(plan.download), 'CloudBase function code download')
  const expectedPath = plan.download.at(-2)
  if (output.message !== 'Code downloaded' || path.resolve(output.path || '') !== path.resolve(expectedPath) || output.version !== '$LATEST') {
    throw new Error('CloudBase function code download did not confirm the expected latest rollback bundle')
  }
  return deployableBundleFingerprint(expectedPath)
}

async function updateCode(plan, runner, label) {
  const output = parseJsonOutput(await runner(plan.update), label)
  if (output.message !== 'Code updated') throw new Error(`${label} did not confirm code update`)
}

export async function preflight({ args = process.argv.slice(3), runner = runTcb, fetchImpl = fetch } = {}) {
  const { envId, backupDir } = options(args)
  const plan = apiOnlyCommandPlan({ envId, backupDir })
  await mkdir(backupDir, { recursive: true })
  const before = await readDetail(plan, runner)
  const rollbackBundle = await downloadRollbackBundle(plan, runner)
  const health = await checkHealth(fetchImpl)
  const baseline = { schemaVersion: 2, environmentId: envId, api: before, rollbackBundle, health }
  await writeFile(path.join(backupDir, 'baseline.json'), JSON.stringify(baseline, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ok: true, operation: 'preflight', baseline }))
  return baseline
}

async function loadBaseline(backupDir) {
  const source = await readFile(path.join(backupDir, 'baseline.json'), 'utf8')
  const baseline = JSON.parse(source)
  assertApiOnlyTarget({ envId: baseline.environmentId, functionName: baseline.api?.functionName })
  if (!baseline.api?.remoteCodeSha256) throw new Error('Rollback baseline did not include an API code hash')
  assertSameBundle(baseline.rollbackBundle, await deployableBundleFingerprint(path.join(backupDir, 'code')), 'Rollback')
  return baseline
}

async function ensureCandidate(candidateDir) {
  if (!candidateDir) throw new Error('Missing --candidate-dir')
  return deployableBundleFingerprint(candidateDir)
}

async function rollback({ envId, backupDir, runner }) {
  const plan = apiOnlyCommandPlan({ envId, backupDir, candidateDir: path.join(backupDir, 'code') })
  await updateCode(plan, runner, 'CloudBase rollback')
  return readDetail(plan, runner)
}

export async function deploy({ args = process.argv.slice(3), runner = runTcb, fetchImpl = fetch } = {}) {
  const { envId, backupDir, candidateDir } = options(args)
  const baseline = await loadBaseline(backupDir)
  const candidateBundle = await ensureCandidate(candidateDir)
  const plan = apiOnlyCommandPlan({ envId, backupDir, candidateDir })
  const current = await readDetail(plan, runner)
  if (current.remoteCodeSha256 !== baseline.api.remoteCodeSha256) throw new Error('API code changed after the rollback baseline was captured; refusing deployment')
  let updateStarted = false
  try {
    updateStarted = true
    await updateCode(plan, runner, 'CloudBase API deployment')
    const after = await readDetail(plan, runner)
    const health = await checkHealth(fetchImpl)
    const result = { ok: true, operation: 'deploy', before: baseline.api, after, candidateBundle, health }
    console.log(JSON.stringify(result))
    return result
  } catch (error) {
    if (!updateStarted) throw error
    try {
      const afterRollback = await rollback({ envId, backupDir, runner })
      if (afterRollback.remoteCodeSha256 !== baseline.api.remoteCodeSha256) throw new Error('rollback code hash does not match the verified baseline')
      const health = await checkHealth(fetchImpl)
      throw new Error(`API deployment failed and rollback completed (rollback hash: ${afterRollback.remoteCodeSha256}, health: ${health.ok}): ${error.message}`)
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
