import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import packageJson from '../package.json' with { type: 'json' }

const release = JSON.parse(fs.readFileSync('release.json', 'utf8'))
const run = (args) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim() } catch { return 'UNKNOWN' } }
const releaseCounter = Number(release.releaseCounter || 0)
const releasePatch = Number(release.releasePatch || 0)
const releaseName = `R${String(releaseCounter).padStart(3, '0')}${releasePatch > 0 ? `.${releasePatch}` : ''}`
const metadata = {
  appVersion: packageJson.version,
  releaseCounter,
  releasePatch,
  release: releaseName,
  gitCommit: run(['rev-parse', 'HEAD']),
  gitBranch: run(['branch', '--show-current']),
  buildTime: new Date().toISOString(),
  appEnv: process.env.VITE_APP_ENV || process.env.APP_ENV || process.env.ASVA_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
  environment: process.env.VITE_APP_ENV || process.env.APP_ENV || process.env.ASVA_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
}
fs.writeFileSync('build-meta.json', `${JSON.stringify(metadata, null, 2)}\n`)
fs.mkdirSync('public', { recursive: true })
fs.writeFileSync('public/build-meta.json', `${JSON.stringify(metadata, null, 2)}\n`)
fs.mkdirSync('cloudbase/functions/asva-api', { recursive: true })
fs.writeFileSync('cloudbase/functions/asva-api/build-meta.json', `${JSON.stringify(metadata, null, 2)}\n`)
console.log(`${metadata.release} build metadata written (${metadata.gitCommit})`)
