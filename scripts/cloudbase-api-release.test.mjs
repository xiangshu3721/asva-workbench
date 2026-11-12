import { describe, expect, it } from 'vitest'
import { API_FUNCTION_NAME, PRODUCTION_ENV_ID, apiOnlyCommandPlan, assertApiOnlyTarget, functionSnapshot } from './cloudbase-api-release.mjs'

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
    expect(text).not.toMatch(/asva-ai-archive|trigger|service|config|envVariables/)
  })

  it('requires a name and code hash in the rollback baseline detail', () => {
    expect(functionSnapshot({ data: { Name: 'asva-api', CodeSha256: 'baseline-sha', Runtime: 'Nodejs20.19', Timeout: 60 } })).toMatchObject({ functionName: 'asva-api', codeSha256: 'baseline-sha' })
    expect(() => functionSnapshot({ data: { Name: 'asva-ai-archive', CodeSha256: 'sha' } })).toThrow(/asva-api/)
    expect(() => functionSnapshot({ data: { Name: 'asva-api' } })).toThrow(/code hash/)
  })
})
