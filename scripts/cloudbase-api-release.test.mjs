import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { API_FUNCTION_NAME, PRODUCTION_ENV_ID, apiOnlyCommandPlan, assertApiOnlyTarget, checkHealth, deploy, functionSnapshot, preflight } from './cloudbase-api-release.mjs'

const detail = (codeSha256) => JSON.stringify({ FunctionName: 'asva-api', Runtime: 'Nodejs20.19', Timeout: 60, CodeSha256: codeSha256 })
const codeAddress = (codeSha256) => JSON.stringify({ Response: { CodeSha256: codeSha256 } })
const healthy = () => new Response(JSON.stringify({ ok: true, release: 'R048.11' }), { status: 200 })
const unhealthy = () => new Response(JSON.stringify({ ok: false }), { status: 503 })
const workflowSource = readFileSync(new URL('../.github/workflows/cloudbase-api-release.yml', import.meta.url), 'utf8')
const releaseGuide = readFileSync(new URL('../docs/CLOUDBASE_API_RELEASE.md', import.meta.url), 'utf8')

function simulatedRunner({ state, failCandidateUpdate = false, failRollbackUpdate = false, wrappedCodeResponses = false }) {
  const codeResponse = (value) => JSON.stringify(wrappedCodeResponses ? { data: value } : value)
  return async (args) => {
    const command = args.join(' ')
    if (command.includes(' fn detail ')) return detail(state.remoteHash)
    if (command.includes(' api scf GetFunctionAddress ')) return codeAddress(state.remoteHash)
    if (command.includes(' fn code download ')) {
      const destination = args.at(-2)
      await mkdir(destination, { recursive: true })
      await writeFile(path.join(destination, 'index.js'), 'exports.main = () => ({ ok: true })\n')
      return codeResponse({ message: 'Code downloaded', path: destination, version: '$LATEST' })
    }
    if (command.includes(' fn code update ')) {
      const directory = args[args.indexOf('--dir') + 1]
      if (directory.endsWith('/code')) {
        if (failRollbackUpdate) throw new Error('rollback transport interrupted')
        state.remoteHash = state.baselineHash
      } else {
        state.remoteHash = state.candidateHash
        if (failCandidateUpdate) throw new Error('deployment transport interrupted')
      }
      return codeResponse({ message: 'Code updated' })
    }
    throw new Error(`Unexpected command: ${command}`)
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asva-api-release-test-'))
  const backup = path.join(root, 'backup')
  const candidate = path.join(root, 'candidate')
  await mkdir(candidate, { recursive: true })
  await writeFile(path.join(candidate, 'index.js'), 'exports.main = () => ({ candidate: true })\n')
  const state = { baselineHash: 'baseline-sha', candidateHash: 'candidate-sha', remoteHash: 'baseline-sha' }
  const args = ['--backup-dir', backup, '--candidate-dir', candidate, '--env-id', PRODUCTION_ENV_ID]
  return { root, backup, candidate, state, args, dispose: () => rm(root, { recursive: true, force: true }) }
}

describe('CloudBase API-only release plan', () => {
  it('allows only the fixed production asva-api target', () => {
    expect(assertApiOnlyTarget({ envId: PRODUCTION_ENV_ID, functionName: API_FUNCTION_NAME })).toEqual({ envId: PRODUCTION_ENV_ID, functionName: API_FUNCTION_NAME })
    expect(() => assertApiOnlyTarget({ envId: 'staging', functionName: API_FUNCTION_NAME })).toThrow(/unexpected CloudBase environment/)
    expect(() => assertApiOnlyTarget({ envId: PRODUCTION_ENV_ID, functionName: 'asva-ai-archive' })).toThrow(/non-API/)
  })

  it('uses code-only API commands and never addresses the worker, trigger, route, or configuration APIs', () => {
    const commands = apiOnlyCommandPlan({ backupDir: '/tmp/asva-baseline', candidateDir: '/tmp/asva-candidate' })
    const text = JSON.stringify(commands)
    expect(text).toContain('asva-api')
    expect(text).toContain('code","update')
    expect(text).toContain('GetFunctionAddress')
    expect(text).not.toMatch(/asva-ai-archive|trigger|service|config|envVariables/)
  })

  it('uses GetFunction detail for identity and a separate code-address response for the remote code hash', () => {
    expect(functionSnapshot({ FunctionName: 'asva-api', Runtime: 'Nodejs20.19', Timeout: 60 })).toMatchObject({ functionName: 'asva-api', runtime: 'Nodejs20.19' })
    expect(() => functionSnapshot({ FunctionName: 'asva-ai-archive' })).toThrow(/asva-api/)
  })

  it('accepts the actual health contract of ok: true and rejects status-only success', async () => {
    await expect(checkHealth(async () => healthy())).resolves.toMatchObject({ ok: true, httpStatus: 200 })
    await expect(checkHealth(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))).rejects.toThrow(/health check failed/)
  })

  it('keeps GitHub Environment protection, its API Key secret, and the fixed API target aligned', () => {
    expect(workflowSource).toContain("if: github.ref == 'refs/heads/master'")
    expect(workflowSource).toContain('environment: cloudbase-production')
    expect(workflowSource).toContain('TCB_CLOUDBASE_API_KEY: ${{ secrets.CLOUDBASE_API_KEY }}')
    expect(workflowSource).toContain('tcb login --cloudbase-api-key "$TCB_CLOUDBASE_API_KEY" -e "$TCB_ENV_ID"')
    expect(workflowSource).not.toMatch(/id-token|OIDC|STS|TENCENT_CLOUD_ROLE_ARN/)
    expect(releaseGuide).toContain('`CLOUDBASE_API_KEY`')
    expect(releaseGuide).toContain('tcb login --cloudbase-api-key <key> -e <envId>')
  })

  it('verifies an extracted rollback bundle with a content manifest and restores it after a failed health check', async () => {
    const test = await fixture()
    try {
      const runner = simulatedRunner({ state: test.state })
      const baseline = await preflight({ args: test.args, runner, fetchImpl: async () => healthy() })
      expect(baseline.api.remoteCodeSha256).toBe('baseline-sha')
      expect(baseline.rollbackBundle).toMatchObject({ entry: 'index.js', fileCount: 1 })
      let healthCalls = 0
      const fetchImpl = async () => (++healthCalls === 1 ? unhealthy() : healthy())
      await expect(deploy({ args: test.args, runner, fetchImpl })).rejects.toThrow(/rollback completed/)
      expect(test.state.remoteHash).toBe('baseline-sha')
    } finally { await test.dispose() }
  })

  it('accepts the actual CloudBase CLI {data:{message,path,version}} download envelope during read-only verify', async () => {
    const test = await fixture()
    try {
      const runner = simulatedRunner({ state: test.state, wrappedCodeResponses: true })
      const baseline = await preflight({ args: test.args, runner, fetchImpl: async () => healthy() })
      expect(baseline.api.remoteCodeSha256).toBe('baseline-sha')
      expect(baseline.rollbackBundle).toMatchObject({ entry: 'index.js', fileCount: 1 })
      expect(baseline.health).toMatchObject({ ok: true, httpStatus: 200 })
      expect(test.state.remoteHash).toBe('baseline-sha')
    } finally { await test.dispose() }
  })

  it('accepts nested update confirmations for deploy and rollback without changing the existing failure safeguards', async () => {
    const test = await fixture()
    try {
      const runner = simulatedRunner({ state: test.state, wrappedCodeResponses: true })
      await preflight({ args: test.args, runner, fetchImpl: async () => healthy() })
      let healthCalls = 0
      const fetchImpl = async () => (++healthCalls === 1 ? unhealthy() : healthy())
      await expect(deploy({ args: test.args, runner, fetchImpl })).rejects.toThrow(/rollback completed/)
      expect(test.state.remoteHash).toBe('baseline-sha')
    } finally { await test.dispose() }
  })

  it('reports an unknown state when the rollback command cannot be confirmed and never logs deployment success', async () => {
    const test = await fixture()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await preflight({ args: test.args, runner: simulatedRunner({ state: test.state }), fetchImpl: async () => healthy() })
      await expect(deploy({ args: test.args, runner: simulatedRunner({ state: test.state, failCandidateUpdate: true, failRollbackUpdate: true }), fetchImpl: async () => healthy() })).rejects.toThrow(/rollback outcome is unknown/)
      expect(log.mock.calls.map((call) => call.join(' ')).some((line) => line.includes('"operation":"deploy"'))).toBe(false)
    } finally {
      log.mockRestore()
      await test.dispose()
    }
  })

  it('refuses a rollback bundle whose extracted files changed after the baseline was recorded', async () => {
    const test = await fixture()
    try {
      const runner = simulatedRunner({ state: test.state })
      await preflight({ args: test.args, runner, fetchImpl: async () => healthy() })
      await writeFile(path.join(test.backup, 'code', 'index.js'), 'tampered')
      await expect(deploy({ args: test.args, runner, fetchImpl: async () => healthy() })).rejects.toThrow(/Rollback bundle no longer matches/)
    } finally { await test.dispose() }
  })
})
