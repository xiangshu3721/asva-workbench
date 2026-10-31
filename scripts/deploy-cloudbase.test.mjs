import { describe, expect, it } from 'vitest'
import { PRODUCTION_REQUIRED_KEYS, buildProductionEnvVariables, buildAiArchiveEnvVariables, buildAiArchiveCloudbaserc, buildApiCloudbaserc, productionDeployOrder, deployProduction, parseEnv, validateProductionEnv } from './deploy-cloudbase.mjs'

function validProductionValues() {
  const values = Object.fromEntries(PRODUCTION_REQUIRED_KEYS.map((key) => [key, key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING' ? 'false' : key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE' ? 'off' : key === 'AUTH_MODE' ? 'PASSWORD' : key === 'APP_ENV' || key === 'DATA_MODE' ? 'production' : `value-${key}`]))
  values.FEISHU_AUTH_CREDENTIALS_TABLE_ID = 'value-FEISHU_AUTH_CREDENTIALS_TABLE_ID'
  return values
}

describe('CloudBase production deployment preflight', () => {
  it('requires an explicit deployment env file before any CloudBase command can run', async () => {
    const previous = process.env.ASVA_DEPLOY_ENV_FILE
    delete process.env.ASVA_DEPLOY_ENV_FILE
    await expect(deployProduction()).rejects.toThrow(/ASVA_DEPLOY_ENV_FILE/)
    if (previous === undefined) delete process.env.ASVA_DEPLOY_ENV_FILE
    else process.env.ASVA_DEPLOY_ENV_FILE = previous
  })

  it('parses explicit env files without exposing values in the validation summary', () => {
    const values = parseEnv('APP_ENV=production\nDATA_MODE=production\nFEATURE_AUTOMATIC_PROFILE_ARCHIVING=false\nDEEPSEEK_API_KEY=super-secret\n')
    expect(values.DEEPSEEK_API_KEY).toBe('super-secret')
    const summary = validateProductionEnv({ ...validProductionValues(), ...values }, '/private/tmp/production.env')
    expect(JSON.stringify(summary)).not.toContain('super-secret')
    expect(summary.automaticProfileArchiving).toBe('false')
  })

  it('rejects missing table IDs instead of falling back to production defaults', () => {
    const values = validProductionValues()
    delete values.FEISHU_CUSTOMERS_TABLE_ID
    expect(() => validateProductionEnv(values)).toThrow(/FEISHU_CUSTOMERS_TABLE_ID/)
  })

  it('rejects an enabled automatic archiving flag during production deployment', () => {
    const values = validProductionValues()
    values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
    expect(() => validateProductionEnv(values)).toThrow(/FEATURE_AUTOMATIC_PROFILE_ARCHIVING/)
  })

  it('requires an explicit non-empty allowlist for production Canary mode', () => {
    const values = validProductionValues()
    values.ASVA_DEPLOY_MODE = 'canary'
    values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
    values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'canary'
    values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY = 'true'
    expect(() => validateProductionEnv(values)).toThrow(/AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS/)
    values.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS = 'CUS-SYNTH-1,CUS-SYNTH-2'
    expect(validateProductionEnv(values)).toMatchObject({ deployMode: 'canary', automaticProfileCanaryCustomerCount: 2 })
  })

  it('requires a post-enable timestamp and rejects Canary settings in formal production mode', () => {
    const values = validProductionValues()
    values.ASVA_DEPLOY_MODE = 'production'
    values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
    values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'production'
    expect(() => validateProductionEnv(values)).toThrow(/AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT/)
    values.AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT = '2026-10-26T15:00:00.000Z'
    expect(validateProductionEnv(values)).toMatchObject({ deployMode: 'production', automaticProfileArchivingMode: 'production' })
    values.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS = 'CUS-SYNTH-1'
    expect(() => validateProductionEnv(values)).toThrow(/Canary 配置/)
  })

  it('passes every explicit table ID through and forces automatic archiving off', () => {
    const values = validProductionValues()
    values.FEISHU_ENROLLMENTS_TABLE_ID = 'tbl-enrollments-explicit'
    const env = buildProductionEnvVariables(values, { releaseCounter: 48, releasePatch: 7, gitCommit: 'candidate', gitBranch: 'feature/smart-profile-v1', buildTime: 'now' })
    expect(env.FEISHU_CUSTOMERS_TABLE_ID).toBe(values.FEISHU_CUSTOMERS_TABLE_ID)
    expect(env.FEISHU_PROFILE_CHANGES_TABLE_ID).toBe(values.FEISHU_PROFILE_CHANGES_TABLE_ID)
    expect(env.FEISHU_ENROLLMENTS_TABLE_ID).toBe('tbl-enrollments-explicit')
    expect(env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING).toBe('false')
    expect(env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE).toBe('off')
    expect(env.AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT).toBe('')
    expect(env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY).toBe('false')
    expect(env.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS).toBe('')
  })
})

describe('AI archive worker deploy helpers', () => {
  it('builds worker env with invoke disabled inside the worker itself', () => {
    const values = validProductionValues()
    values.ASVA_AI_ARCHIVE_INVOKE_SECRET = 'secret-for-test'
    values.TENCENTCLOUD_SECRETID = 'AKIDtest'
    values.TENCENTCLOUD_SECRETKEY = 'secret'
    const env = buildAiArchiveEnvVariables(values, { releaseCounter: 49, releasePatch: 0, gitCommit: 'tip', gitBranch: 'fix/ai-archive-closed-loop-20261031', buildTime: 'now' })
    expect(env.ASVA_AI_ARCHIVE_FUNCTION_NAME).toBe('asva-ai-archive')
    expect(env.ASVA_AI_ARCHIVE_INVOKE_MODE).toBe('disabled')
    expect(env.ASVA_AI_ARCHIVE_INVOKE_SECRET).toBe('secret-for-test')
    expect(JSON.stringify(env)).not.toContain('super-secret')
  })
})

describe('AI archive deploy order and effective config', () => {
  it('deploys worker before api', () => {
    expect(productionDeployOrder()).toEqual(['asva-ai-archive', 'asva-api'])
    expect(productionDeployOrder({ skipWorker: true })).toEqual(['asva-api'])
  })

  it('builds worker cloudbaserc with 512MB/120s for CLI cwd consumption', () => {
    const values = validProductionValues()
    values.ASVA_AI_ARCHIVE_INVOKE_SECRET = 'secret-for-test'
    const env = buildAiArchiveEnvVariables(values, { releaseCounter: 49, releasePatch: 0, gitCommit: 'tip', gitBranch: 'fix/ai-archive-closed-loop-20261031', buildTime: 'now' })
    const rc = buildAiArchiveCloudbaserc({
      envId: 'root-journey-prod-d4d7pzd0a8f805',
      workerDir: '/tmp/cloudbase/functions/asva-ai-archive',
      envVariables: env,
    })
    expect(rc.functions[0]).toMatchObject({
      name: 'asva-ai-archive',
      timeout: 120,
      memorySize: 512,
      handler: 'index.main',
      runtime: 'Nodejs20.19',
    })
    expect(rc.functions[0].type).toBeUndefined()
    expect(rc.functions[0].envVariables.ASVA_AI_ARCHIVE_INVOKE_MODE).toBe('disabled')
  })

  it('preserves full API env set when building api cloudbaserc', () => {
    const values = validProductionValues()
    values.ASVA_AI_ARCHIVE_INVOKE_SECRET = 'secret-for-test'
    values.TENCENTCLOUD_SECRETID = 'AKIDtest'
    values.TENCENTCLOUD_SECRETKEY = 'secret'
    values.FEISHU_ENROLLMENTS_TABLE_ID = 'tbl-enroll'
    const env = buildProductionEnvVariables(values, { releaseCounter: 49, releasePatch: 0, gitCommit: 'tip', gitBranch: 'fix/ai-archive-closed-loop-20261031', buildTime: 'now' })
    const rc = buildApiCloudbaserc({
      envId: 'root-journey-prod-d4d7pzd0a8f805',
      functionDir: '/tmp/cloudbase/functions/asva-api',
      functionName: 'asva-api',
      envVariables: env,
    })
    expect(rc.functions[0].type).toBe('HTTP')
    expect(rc.functions[0].memorySize).toBe(512)
    expect(rc.functions[0].timeout).toBe(60)
    // Original production keys remain present (additive AI-archive vars allowed).
    for (const key of [
      'DEEPSEEK_API_KEY', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_APP_TOKEN',
      'FEISHU_CUSTOMERS_TABLE_ID', 'FEISHU_SOURCE_RECORDS_TABLE_ID', 'FEISHU_EVIDENCE_ITEMS_TABLE_ID',
      'ASVA_AUTH_SECRET', 'AUTH_MODE', 'APP_ENV', 'DATA_MODE',
      'FEATURE_AUTOMATIC_PROFILE_ARCHIVING', 'ASVA_GIT_COMMIT',
    ]) {
      expect(env[key]).toBeTruthy()
    }
    expect(env.ASVA_AI_ARCHIVE_INVOKE_MODE).toBe('event')
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(42)
  })

  it('deploy script source deploys worker before api and writes cloudbaserc.json', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./deploy-cloudbase.mjs', import.meta.url), 'utf8')
    const workerIdx = source.indexOf('await deployAiArchiveWorker(')
    const apiWriteIdx = source.indexOf("buildApiCloudbaserc(")
    const apiDeployIdx = source.indexOf("'fn', 'deploy', functionName")
    expect(workerIdx).toBeGreaterThan(0)
    expect(apiWriteIdx).toBeGreaterThan(workerIdx)
    expect(apiDeployIdx).toBeGreaterThan(apiWriteIdx)
    expect(source).toMatch(/writeFile\(path\.join\(tempDir, 'cloudbaserc\.json'\)/)
    expect(source).toMatch(/--config-file', rcPath|--config-file', path\.join\(tempDir, 'cloudbaserc\.json'\)/)
  })
})

describe('temporary STS session token forwarding', () => {
  it('maps temporary STS TENCENTCLOUD_* into CLOUDBASE_* (SCF forbids TENCENTCLOUD_ prefix)', () => {
    const values = Object.fromEntries(PRODUCTION_REQUIRED_KEYS.map((key) => [key, key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING' ? 'true' : key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE' ? 'canary' : key === 'AUTH_MODE' ? 'PASSWORD' : key === 'APP_ENV' || key === 'DATA_MODE' ? 'production' : `value-${key}`]))
    values.ASVA_DEPLOY_MODE = 'canary'
    values.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY = 'true'
    values.AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS = 'CUS-SYNTH-1'
    values.FEISHU_AUTH_CREDENTIALS_TABLE_ID = 'tbl-auth'
    values.TENCENTCLOUD_SECRETID = 'AKIDtmp'
    values.TENCENTCLOUD_SECRETKEY = 'tmpSecret'
    values.TENCENTCLOUD_SESSIONTOKEN = 'tmpToken'
    values.ASVA_AI_ARCHIVE_INVOKE_SECRET = 'invoke-secret'
    const env = buildProductionEnvVariables(values, { releaseCounter: 1, releasePatch: 0, gitCommit: 'abc', gitBranch: 'main', buildTime: 't' })
    // SCF forbids TENCENTCLOUD_* env keys; deploy maps STS into CLOUDBASE_* aliases.
    expect(env.TENCENTCLOUD_SESSIONTOKEN).toBeUndefined()
    expect(env.TENCENTCLOUD_SECRETID).toBeUndefined()
    expect(env.CLOUDBASE_SESSIONTOKEN).toBe('tmpToken')
    expect(env.CLOUDBASE_SECRET_ID).toBe('AKIDtmp')
    expect(env.CLOUDBASE_SECRET_KEY).toBe('tmpSecret')
  })
})

