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
const environment = process.env.ASVA_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'production' : 'local')

export const releaseMetadata = {
  appVersion: packageJson.version,
  releaseCounter: counter,
  release: `R${String(counter).padStart(3, '0')}`,
  gitCommit: process.env.ASVA_GIT_COMMIT || built.gitCommit || git(['rev-parse', 'HEAD']),
  gitBranch: process.env.ASVA_GIT_BRANCH || built.gitBranch || git(['branch', '--show-current']),
  buildTime: process.env.ASVA_BUILD_TIME || built.buildTime || null,
  environment,
}

export function featureFlags() {
  return { externalAppointment: process.env.FEATURE_EXTERNAL_APPOINTMENT === 'true' }
}
