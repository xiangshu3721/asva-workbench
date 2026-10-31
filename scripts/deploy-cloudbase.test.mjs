import { describe, expect, it } from 'vitest'
import { PRODUCTION_REQUIRED_KEYS, buildProductionEnvVariables, buildAiArchiveEnvVariables, deployProduction, parseEnv, validateProductionEnv } from './deploy-cloudbase.mjs'

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
