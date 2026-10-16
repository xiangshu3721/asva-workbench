import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const key = line.slice(0, equals).trim()
    const value = line.slice(equals + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvFile(path.join(root, '.env'))
loadEnvFile(path.join(root, '.env.local'))

const appEnv = process.env.VITE_APP_ENV?.trim() || 'development'
const validAppEnv = new Set(['development', 'staging', 'production', 'mock'])
const apiBase = process.env.VITE_API_BASE_URL?.trim().replace(/\/$/, '') || ''
const frontendMeta = [path.join(root, 'public/build-meta.json'), path.join(root, 'build-meta.json')]
  .map((filePath) => { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null } })
  .find(Boolean) || {}

let backend = null
let backendReachable = false
if (apiBase) {
  try {
    const response = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(5000) })
    backend = await response.json().catch(() => null)
    backendReachable = response.ok && Boolean(backend?.ok)
  } catch {
    backendReachable = false
  }
}

const versionCompatible = Number.isFinite(Number(frontendMeta.releaseCounter)) && Number.isFinite(Number(backend?.releaseCounter))
  ? Number(frontendMeta.releaseCounter) === Number(backend.releaseCounter)
  : null

console.log(`Frontend Environment: ${appEnv}`)
console.log(`Frontend Release: ${frontendMeta.release || 'UNKNOWN'}`)
console.log(`API Base: ${apiBase || 'UNSET'}`)
console.log(`Backend Reachable: ${backendReachable ? 'YES' : 'NO'}`)
console.log(`Backend Environment: ${backend?.appEnv || backend?.environment || 'UNKNOWN'}`)
console.log(`Backend Release: ${backend?.release || 'UNKNOWN'}`)
console.log(`Version Compatible: ${versionCompatible === null ? 'UNKNOWN' : versionCompatible ? 'YES' : 'NO'}`)
console.log(`Auth Mode: ${backend?.authMode || 'UNKNOWN'}`)
console.log(`Data Mode: ${backend?.dataMode || 'UNKNOWN'}`)

const expectedDataMode = appEnv === 'mock' ? 'mock' : appEnv === 'staging' ? 'staging' : 'production'
const healthyConfiguration = !validAppEnv.has(appEnv) ? false : appEnv === 'mock'
  ? !apiBase
  : Boolean(apiBase) && backendReachable && backend?.appEnv === appEnv && backend?.dataMode === expectedDataMode && (appEnv !== 'staging' || backend?.productionWriteProtection === 'ON') && versionCompatible !== false
if (!healthyConfiguration) process.exitCode = 1
