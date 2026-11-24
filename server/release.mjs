import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import packageJson from '../package.json' with { type: 'json' }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

function git(command) {
  try { return execFileSync('git', command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return 'UNKNOWN' }
}

const root = path.resolve(process.env.ASVA_APP_ROOT || process.cwd())
const release = readJson(path.join(root, 'release.json'))
const built = readJson(path.join(root, 'build-meta.json'))
const counter = Number(process.env.ASVA_RELEASE_COUNTER || built.releaseCounter || release.releaseCounter || 0)
const patch = Number(process.env.ASVA_RELEASE_PATCH ?? built.releasePatch ?? release.releasePatch ?? 0)
const appEnv = process.env.APP_ENV || process.env.ASVA_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'production' : 'development')
const releaseName = `R${String(counter).padStart(3, '0')}${patch > 0 ? `.${patch}` : ''}`

export const releaseMetadata = {
  appVersion: packageJson.version,
  releaseCounter: counter,
  releasePatch: patch,
  release: releaseName,
  gitCommit: process.env.ASVA_GIT_COMMIT || built.gitCommit || git(['rev-parse', 'HEAD']),
  gitBranch: process.env.ASVA_GIT_BRANCH || built.gitBranch || git(['branch', '--show-current']),
  buildTime: process.env.ASVA_BUILD_TIME || built.buildTime || null,
  appEnv,
  environment: process.env.ASVA_ENVIRONMENT || appEnv,
}

export function featureFlags() {
  return {
    externalAppointment: process.env.FEATURE_EXTERNAL_APPOINTMENT === 'true',
    onDemandAiProcessing: process.env.FEATURE_ON_DEMAND_AI_PROCESSING === 'true',
    onDemandAiAutoTrigger: process.env.FEATURE_ON_DEMAND_AI_AUTO_TRIGGER === 'true',
    onDemandAiDailyLimit: Math.min(100, Math.max(0, Number(process.env.ON_DEMAND_AI_DAILY_LIMIT || 0) || 0)),
    onDemandAiMaxConcurrent: Math.min(2, Math.max(1, Number(process.env.ON_DEMAND_AI_MAX_CONCURRENT || 1) || 1)),
    onDemandAiBudgetStoreConfigured: Boolean(String(process.env.ON_DEMAND_AI_BUDGET_COLLECTION || '').trim() && String(process.env.ON_DEMAND_AI_BUDGET_RPC_BASE_URL || '').trim() && String(process.env.CLOUDBASE_APIKEY || '').trim()),
    // Expose only the boolean. Whitelist identifiers stay server-side.
    onDemandAiTestScopeEnabled: process.env.ON_DEMAND_AI_TEST_SCOPE_ENABLED === 'true',
    // Do not expose customer or mentor identifiers through public health.
    // R048.17: Canary whitelist removed — AUTO is available to all authorized mentors.
  }
}
