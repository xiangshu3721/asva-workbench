import fs from 'node:fs'
import path from 'node:path'

const rootDir = path.resolve(process.env.ASVA_CONFIG_DIR || process.cwd())

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

loadEnvFile(path.join(rootDir, '.env'))
loadEnvFile(path.join(rootDir, '.env.local'))

const value = (key, fallback = '') => process.env[key]?.trim() || fallback
const normalizeAppEnv = (raw) => {
  if (raw === 'production') return 'production'
  if (raw === 'staging') return 'staging'
  if (raw === 'mock') return 'mock'
  if (raw === 'development' || raw === 'local') return 'development'
  return 'invalid'
}
const legacyEnvironment = value('ASVA_ENVIRONMENT', value('NODE_ENV', 'development'))
const appEnv = normalizeAppEnv(value('APP_ENV', legacyEnvironment))
const isStaging = appEnv === 'staging'
const productionWriteProtection = value('PRODUCTION_WRITE_PROTECTION', 'OFF')
const productionTableIds = new Set(['tblUrXu4ivBGJ7zV', 'tblFKkM7fPTqi8Zx', 'tblFGmyJi3RJQ7bM', 'tblojNfk4bVM5KxH', 'tblLG2SFwYpKgiMQ', 'tblTH3OmBuzUsBVu'])
const stagingRequiredTableKeys = ['customers', 'staff', 'profileChanges', 'sourceRecords', 'evidenceItems', 'profileUpdateProposals', 'evidenceConflicts']
const automaticProfileArchivingMode = value('FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE', 'off').toLowerCase()
const automaticProfileArchivingEnabledAt = value('AUTOMATIC_PROFILE_ARCHIVING_ENABLED_AT')
const automaticProfileCanaryCustomerIds = new Set((value('AUTOMATIC_PROFILE_CANARY_CUSTOMER_IDS') || '')
  .split(/[\s,]+/)
  .map((id) => id.trim())
  .filter(Boolean))
const frontendOrigin = value('ASVA_FRONTEND_ORIGIN', 'https://xiangshu3721.github.io')
const corsAllowedOrigins = (value('CORS_ALLOWED_ORIGINS') || [frontendOrigin, 'https://xiangshu3721.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173'].join(','))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

export const config = {
  port: Number(value('PORT', '8788')),
  host: value('HOST', '127.0.0.1'),
  authSecret: value('ASVA_AUTH_SECRET'),
  adminLoginCode: value('ASVA_ADMIN_LOGIN_CODE'),
  authMode: value('AUTH_MODE', 'ADMIN_CODE'),
  appEnv,
  environment: legacyEnvironment,
  dataMode: value('DATA_MODE', appEnv === 'mock' ? 'mock' : appEnv === 'staging' ? 'staging' : 'production'),
  productionWriteProtection,
  allowDevOtp: value('ALLOW_DEV_OTP', 'false') === 'true',
  maxDocumentSizeMb: Number(value('MAX_DOCUMENT_SIZE_MB', '20')) || 20,
  frontendOrigin,
  corsAllowedOrigins,
  aiArchive: {
    functionName: value('ASVA_AI_ARCHIVE_FUNCTION_NAME', 'asva-ai-archive'),
    invokeMode: value('ASVA_AI_ARCHIVE_INVOKE_MODE', ''),
    envId: value('CLOUDBASE_ENV_ID', value('TCB_ENV_ID', 'root-journey-prod-d4d7pzd0a8f805')),
  },
  features: {
    externalAppointment: value('FEATURE_EXTERNAL_APPOINTMENT', 'false') === 'true',
    automaticProfileArchiving: value('FEATURE_AUTOMATIC_PROFILE_ARCHIVING', 'false') === 'true',
    automaticProfileArchivingMode,
    automaticProfileArchivingEnabledAt,
    automaticProfileArchivingCanary: value('FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY', 'false') === 'true',
    automaticProfileCanaryCustomerIds,
  },
  deepseek: {
    apiKey: value('DEEPSEEK_API_KEY'),
    model: value('DEEPSEEK_MODEL', 'deepseek-chat'),
    evidenceModel: value('DEEPSEEK_EVIDENCE_MODEL', 'deepseek-flash'),
    baseUrl: value('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/$/, ''),
  },
  feishu: {
    appId: value('FEISHU_APP_ID', isStaging ? '' : 'cli_aaff6cb53db89bd3'),
    appSecret: value('FEISHU_APP_SECRET'),
    baseToken: value('FEISHU_APP_TOKEN'),
    baseUrl: value('FEISHU_BASE_URL', 'https://open.feishu.cn').replace(/\/$/, ''),
    tables: {
      appointments: value('FEISHU_APPOINTMENTS_TABLE_ID', isStaging ? '' : 'tblUrXu4ivBGJ7zV'),
      customers: value('FEISHU_CUSTOMERS_TABLE_ID', isStaging ? '' : 'tblFKkM7fPTqi8Zx'),
      serviceRecords: value('FEISHU_SERVICE_RECORDS_TABLE_ID', isStaging ? '' : 'tblFGmyJi3RJQ7bM'),
      staff: value('FEISHU_STAFF_TABLE_ID', isStaging ? '' : 'tblojNfk4bVM5KxH'),
      products: value('FEISHU_PRODUCTS_TABLE_ID', isStaging ? '' : 'tblLG2SFwYpKgiMQ'),
      enrollments: value('FEISHU_ENROLLMENTS_TABLE_ID'),
      profileChanges: value('FEISHU_PROFILE_CHANGES_TABLE_ID', isStaging ? '' : 'tblTH3OmBuzUsBVu'),
      authCredentials: value('FEISHU_AUTH_CREDENTIALS_TABLE_ID'),
      sourceRecords: value('FEISHU_SOURCE_RECORDS_TABLE_ID'),
      evidenceItems: value('FEISHU_EVIDENCE_ITEMS_TABLE_ID'),
      profileUpdateProposals: value('FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID'),
      evidenceConflicts: value('FEISHU_EVIDENCE_CONFLICTS_TABLE_ID'),
      safetyAssessments: value('FEISHU_SAFETY_ASSESSMENTS_TABLE_ID'),
    },
  },
}

if (config.appEnv === 'production') {
  if (!['off', 'canary', 'production'].includes(config.features.automaticProfileArchivingMode)) throw new Error('PRODUCTION_AUTOMATIC_PROFILE_MODE_INVALID')
  if (!config.features.automaticProfileArchiving) {
    if (config.features.automaticProfileArchivingMode !== 'off' || config.features.automaticProfileArchivingCanary || config.features.automaticProfileCanaryCustomerIds.size || config.features.automaticProfileArchivingEnabledAt) throw new Error('PRODUCTION_AUTOMATIC_PROFILE_DISABLED_CONFIG_INVALID')
  } else if (config.features.automaticProfileArchivingMode === 'canary') {
    if (!config.features.automaticProfileArchivingCanary) throw new Error('PRODUCTION_AUTOMATIC_PROFILE_CANARY_REQUIRED')
    if (!config.features.automaticProfileCanaryCustomerIds.size) throw new Error('PRODUCTION_AUTOMATIC_PROFILE_CANARY_ALLOWLIST_REQUIRED')
    if (config.features.automaticProfileArchivingEnabledAt) throw new Error('PRODUCTION_AUTOMATIC_PROFILE_CANARY_ENABLE_TIME_FORBIDDEN')
  } else if (config.features.automaticProfileArchivingMode === 'production') {
    if (!config.features.automaticProfileArchivingEnabledAt || Number.isNaN(Date.parse(config.features.automaticProfileArchivingEnabledAt))) throw new Error('PRODUCTION_AUTOMATIC_PROFILE_ENABLE_TIME_REQUIRED')
    if (config.features.automaticProfileArchivingCanary || config.features.automaticProfileCanaryCustomerIds.size) throw new Error('PRODUCTION_AUTOMATIC_PROFILE_FORMAL_MODE_CANARY_CONFIG_FORBIDDEN')
  } else {
    throw new Error('PRODUCTION_AUTOMATIC_PROFILE_MODE_REQUIRED')
  }
}

if (config.appEnv === 'staging') {
  if (config.dataMode !== 'staging') throw new Error('STAGING_DATA_MODE_REQUIRED')
  if (config.productionWriteProtection !== 'ON') throw new Error('STAGING_PRODUCTION_WRITE_PROTECTION_REQUIRED')
  const missingRequired = stagingRequiredTableKeys.filter((key) => !config.feishu.tables[key])
  if (!config.feishu.appId || !config.feishu.appSecret || !config.feishu.baseToken) throw new Error('STAGING_FEISHU_CREDENTIALS_REQUIRED')
  if (missingRequired.length) throw new Error(`STAGING_REQUIRED_TABLES_MISSING:${missingRequired.join(',')}`)
  const configuredProductionTable = Object.values(config.feishu.tables).some((tableId) => tableId && productionTableIds.has(tableId))
  if (configuredProductionTable) throw new Error('STAGING_PRODUCTION_TABLE_ID_FORBIDDEN')
}

export function isCorsOriginAllowed(origin, appEnv = config.appEnv) {
  if (!origin || corsAllowedOrigins.includes(origin)) return Boolean(origin)
  if (appEnv !== 'development') return false
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

export function configurationStatus() {
  return {
    deepseekConfigured: Boolean(config.deepseek.apiKey),
    feishuConfigured: Boolean(config.feishu.appId && config.feishu.appSecret && config.feishu.baseToken),
    authConfigured: Boolean(config.authSecret),
    adminAuthConfigured: config.authMode === 'ADMIN_CODE' && Boolean(config.adminLoginCode),
    authCredentialStoreConfigured: Boolean(config.feishu.tables.authCredentials),
    authMode: config.authMode,
    appEnv: config.appEnv,
    environment: config.environment,
    dataMode: config.dataMode,
    productionWriteProtection: config.productionWriteProtection,
    featureFlags: config.features,
  }
}
