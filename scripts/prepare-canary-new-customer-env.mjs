#!/usr/bin/env node
/**
 * Prepare ASVA_DEPLOY_ENV_FILE for synthetic NEW-CUSTOMER canary (no deploy).
 * - Starts from existing production.env (preserves live keys / same Feishu data source)
 * - Forces canary allowlist to precomputed synth customer only:
 *     operationId ASVA-SYNTH-NEW-CUSTOMER-ARCHIVE-20261031
 *     customerId  CUS-a61e57990749ae442014  (= customerIdForOperation)
 * - Does NOT create the customer in production; needs separate write authorization
 * - Ensures ASVA_AI_ARCHIVE_INVOKE_SECRET (generate if missing)
 * - Injects temporary STS as CLOUDBASE_SECRET_ID/KEY/SESSIONTOKEN
 *
 * Usage:
 *   node scripts/prepare-canary-new-customer-env.mjs
 *   ASVA_CANARY_ENV_OUT=/path/to/out.env node scripts/prepare-canary-new-customer-env.mjs
 */
import { mkdir, readFile, writeFile, access, chmod } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseEnv, validateProductionEnv, buildProductionEnvVariables, buildAiArchiveEnvVariables } from './deploy-cloudbase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultBase = path.join(root, 'stage0-backup/prod-R048.9-c913ae5/config/production.env')
const defaultSecureDir = path.join(path.dirname(root), '_verify/asva-new-customer-archive-fix-20261031/secure')
const synthOperationId = 'ASVA-SYNTH-NEW-CUSTOMER-ARCHIVE-20261031'
const synthCustomerId = 'CUS-a61e57990749ae442014' // customerIdForOperation(synthOperationId)

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output.slice(-2000)}`)))
  })
}

function toEnvFile(values) {
  return Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('\n') + '\n'
}

async function exists(filePath) {
  try { await access(filePath, fsConstants.R_OK); return true } catch { return false }
}

async function loadOrCreateInvokeSecret(secureDir) {
  const secretPath = path.join(secureDir, 'ASVA_AI_ARCHIVE_INVOKE_SECRET')
  if (await exists(secretPath)) {
    const existing = (await readFile(secretPath, 'utf8')).trim()
    if (existing) return { secret: existing, generated: false, path: secretPath }
  }
  const secret = crypto.randomBytes(32).toString('base64url')
  await mkdir(secureDir, { recursive: true, mode: 0o700 })
  await writeFile(secretPath, secret + '\n', { mode: 0o600 })
  await chmod(secretPath, 0o600)
  return { secret, generated: true, path: secretPath }
}

async function loadCloudBaseApiKey(secureDir) {
  const candidates = [
    path.join(secureDir, 'CLOUDBASE_APIKEY.asva-scf-invoke-20261031'),
    path.join(secureDir, 'CLOUDBASE_APIKEY'),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      const value = (await readFile(candidate, 'utf8')).trim()
      if (value) return { present: true, path: candidate, value }
    }
  }
  return { present: false, path: '', value: '' }
}

async function fetchTemporarySts() {
  const tcb = process.env.TCB_BIN || 'tcb'
  const output = await runCapture(tcb, ['secrets', 'get', '--json'])
  const jsonStart = output.indexOf('{')
  if (jsonStart < 0) throw new Error('tcb secrets get returned no JSON')
  const parsed = JSON.parse(output.slice(jsonStart))
  const data = parsed.data || parsed
  if (!data.secretId || !data.secretKey || !data.token) {
    throw new Error('tcb secrets get missing secretId/secretKey/token')
  }
  return {
    secretId: data.secretId,
    secretKey: data.secretKey,
    token: data.token,
    expiredAt: data.expiredAt || '',
    isTemporary: data.isTemporary !== false,
    envId: data.envId || 'root-journey-prod-d4d7pzd0a8f805',
  }
}

async function main() {
  const basePath = path.resolve(process.env.ASVA_CANARY_ENV_BASE || defaultBase)
  const secureDir = path.resolve(process.env.ASVA_CANARY_SECURE_DIR || defaultSecureDir)
  const outPath = path.resolve(process.env.ASVA_CANARY_ENV_OUT || path.join(secureDir, 'ASVA_DEPLOY_ENV_FILE.canary-new-customer.env'))
  await mkdir(path.dirname(outPath), { recursive: true, mode: 0o700 })
  await mkdir(secureDir, { recursive: true, mode: 0o700 })

  const baseValues = parseEnv(await readFile(basePath, 'utf8'))
  const invoke = await loadOrCreateInvokeSecret(secureDir)
  const apiKey = await loadCloudBaseApiKey(secureDir)
  const sts = await fetchTemporarySts()

  const values = {
    ...baseValues,
    FEATURE_AUTOMATIC_PROFILE_ARCHIVING: 'true',
    FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE: 'canary',
    FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY: 'true',
    AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS: synthCustomerId,
    AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT: '',
    ASVA_DEPLOY_MODE: 'canary',
    ASVA_AI_ARCHIVE_FUNCTION_NAME: 'asva-ai-archive',
    ASVA_AI_ARCHIVE_INVOKE_MODE: 'event',
    ASVA_AI_ARCHIVE_INVOKE_SECRET: invoke.secret,
    CLOUDBASE_ENV_ID: 'root-journey-prod-d4d7pzd0a8f805',
    // SCF rejects TENCENTCLOUD_* env keys; store STS under CLOUDBASE_* aliases (credentials() reads these).
    CLOUDBASE_SECRET_ID: sts.secretId,
    CLOUDBASE_SECRET_KEY: sts.secretKey,
    CLOUDBASE_SESSIONTOKEN: sts.token,
  }
  if (apiKey.present) values.CLOUDBASE_APIKEY = apiKey.value

  const summary = validateProductionEnv(values, outPath)
  // Identity fields are overwritten at deploy from build-meta; keep placeholders from base.
  await writeFile(outPath, toEnvFile(values), { mode: 0o600 })
  await chmod(outPath, 0o600)

  // Meta without secrets
  const meta = {
    generatedAtAsiaShanghai: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' CST',
    outPath,
    basePath,
    validate: summary,
    invokeSecret: { generated: invoke.generated, path: invoke.path, present: true },
    cloudbaseApiKey: { present: apiKey.present, path: apiKey.path || null },
    sts: {
      isTemporary: sts.isTemporary,
      expiredAt: sts.expiredAt,
      envId: sts.envId,
      secretIdPresent: true,
      secretKeyPresent: true,
      sessionTokenPresent: true,
      note: 'Temporary STS for canary window only; replace with long-term CAM SecretId/Key (empty SESSIONTOKEN) for durable production.',
    },
    canary: {
      ASVA_DEPLOY_MODE: 'canary',
      FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE: 'canary',
      AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS: synthCustomerId,
      synthOperationId,
      note: 'allowlist is synth new-customer only; no production create in this script',
    },
    plannedApiEnvKeyCount: Object.keys(buildProductionEnvVariables(values, {
      releaseCounter: 48, releasePatch: 11, gitCommit: 'pending', gitBranch: 'pending', buildTime: 'pending',
    })).length,
    plannedWorkerEnvKeyCount: Object.keys(buildAiArchiveEnvVariables(values, {
      releaseCounter: 48, releasePatch: 11, gitCommit: 'pending', gitBranch: 'pending', buildTime: 'pending',
    })).length,
  }
  const metaPath = outPath + '.meta.json'
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, outPath, metaPath, stsExpiredAt: sts.expiredAt, invokeSecretGenerated: invoke.generated, cloudbaseApiKeyPresent: apiKey.present, canaryCustomerId: synthCustomerId, synthOperationId }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
