import { describe, expect, it } from 'vitest'
import { PRODUCTION_REQUIRED_KEYS, buildProductionEnvVariables, deployProduction, parseDeploymentTarget, parseEnv, validateProductionEnv } from './deploy-cloudbase.mjs'

function validProductionValues() {
  const values = Object.fromEntries(PRODUCTION_REQUIRED_KEYS.map((key) => [key, key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING' ? 'false' : key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE' ? 'off' : key === 'AUTH_MODE' ? 'PASSWORD' : key === 'APP_ENV' || key === 'DATA_MODE' ? 'production' : `value-${key}`]))
  values.FEISHU_AUTH_CREDENTIALS_TABLE_ID = 'value-FEISHU_AUTH_CREDENTIALS_TABLE_ID'
  return values
}

describe('CloudBase production deployment preflight', () => {
  it('defaults legacy deployment entry to API only and requires an explicit all target', () => {
    expect(parseDeploymentTarget([])).toBe('api')
    expect(parseDeploymentTarget(['--target', 'worker'])).toBe('worker')
    expect(parseDeploymentTarget(['--target', 'all'])).toBe('all')
    expect(() => parseDeploymentTarget(['--target', 'unexpected'])).toThrow(/api、worker 或 all/)
  })

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

  it('does not require canary config when AUTO trigger is enabled (R048.17)', () => {
    const values = validProductionValues()
    values.FEATURE_ON_DEMAND_AI_AUTO_TRIGGER = 'true'
    // R048.17: Canary whitelist removed after production acceptance.
    // AUTO trigger no longer requires customer/actor whitelist.
    // Should pass without canary IDs
    expect(() => validateProductionEnv(values)).not.toThrow()
  })

  it('requires the durable budget configuration before enabling manual AI', () => {
    const values = validProductionValues()
    values.FEATURE_ON_DEMAND_AI_PROCESSING = 'true'
    values.ON_DEMAND_AI_DAILY_LIMIT = '1'
    expect(() => validateProductionEnv(values)).toThrow(/ON_DEMAND_AI_BUDGET_COLLECTION/)
    values.ON_DEMAND_AI_BUDGET_COLLECTION = 'asva_ai_budget_v1'
    expect(() => validateProductionEnv(values)).toThrow(/CLOUDBASE_APIKEY/)
    values.CLOUDBASE_APIKEY = 'server-key-only'
    expect(() => validateProductionEnv(values)).toThrow(/ON_DEMAND_AI_BUDGET_RPC_BASE_URL/)
    values.ON_DEMAND_AI_BUDGET_RPC_BASE_URL = 'https://env.api.tcloudbasegateway.com/v1/rdb/rest/rpc'
    expect(() => validateProductionEnv(values)).toThrow(/ON_DEMAND_AI_MAX_CONCURRENT/)
    values.ON_DEMAND_AI_MAX_CONCURRENT = '1'
    expect(validateProductionEnv(values)).toMatchObject({ onDemandAiDailyLimit: 1, onDemandAiBudgetStoreConfigured: true, onDemandAiMaxConcurrent: 1 })
    // V2 PG migration allows concurrent=2
    values.ON_DEMAND_AI_MAX_CONCURRENT = '2'
    expect(validateProductionEnv(values)).toMatchObject({ onDemandAiMaxConcurrent: 2 })
    // concurrent=3 should be rejected
    values.ON_DEMAND_AI_MAX_CONCURRENT = '3'
    expect(() => validateProductionEnv(values)).toThrow(/ON_DEMAND_AI_MAX_CONCURRENT/)
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
    expect(env.FEATURE_ON_DEMAND_AI_PROCESSING).toBe('false')
    expect(env.FEATURE_ON_DEMAND_AI_AUTO_TRIGGER).toBe('false')
    expect(env.ON_DEMAND_AI_DAILY_LIMIT).toBe('0')
    expect(env.ON_DEMAND_AI_BUDGET_COLLECTION).toBe('')
    expect(env.CLOUDBASE_APIKEY).toBe('')
    expect(env.ON_DEMAND_AI_BUDGET_RPC_BASE_URL).toBe('')
    expect(env.ON_DEMAND_AI_MAX_CONCURRENT).toBe('1')
  })
})
