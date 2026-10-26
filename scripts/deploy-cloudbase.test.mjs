import { describe, expect, it } from 'vitest'
import { PRODUCTION_REQUIRED_KEYS, buildProductionEnvVariables, deployProduction, parseEnv, validateProductionEnv } from './deploy-cloudbase.mjs'

function validProductionValues() {
  const values = Object.fromEntries(PRODUCTION_REQUIRED_KEYS.map((key) => [key, key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING' ? 'false' : key === 'AUTH_MODE' ? 'PASSWORD' : key === 'APP_ENV' || key === 'DATA_MODE' ? 'production' : `value-${key}`]))
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

  it('passes every explicit table ID through and forces automatic archiving off', () => {
    const values = validProductionValues()
    values.FEISHU_ENROLLMENTS_TABLE_ID = 'tbl-enrollments-explicit'
    const env = buildProductionEnvVariables(values, { releaseCounter: 48, releasePatch: 7, gitCommit: 'candidate', gitBranch: 'feature/smart-profile-v1', buildTime: 'now' })
    expect(env.FEISHU_CUSTOMERS_TABLE_ID).toBe(values.FEISHU_CUSTOMERS_TABLE_ID)
    expect(env.FEISHU_PROFILE_CHANGES_TABLE_ID).toBe(values.FEISHU_PROFILE_CHANGES_TABLE_ID)
    expect(env.FEISHU_ENROLLMENTS_TABLE_ID).toBe('tbl-enrollments-explicit')
    expect(env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING).toBe('false')
  })
})
