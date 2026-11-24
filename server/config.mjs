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
const onDemandAiMaxChars = Math.min(4000, Math.max(1, Number(value('ON_DEMAND_AI_MAX_CHARS', '4000')) || 4000))
// The raw Source limit does not include the field catalogue, safety rules or
// current profile snapshot that are appended to the model prompt.
const onDemandAiMaxPromptChars = Math.min(16_000, Math.max(4_000, Number(value('ON_DEMAND_AI_MAX_PROMPT_CHARS', '16000')) || 16_000))
const onDemandAiTimeoutMs = Math.min(45_000, Math.max(1_000, Number(value('ON_DEMAND_AI_TIMEOUT_MS', '45000')) || 45_000))
const onDemandAiMaxTokens = Math.min(2048, Math.max(256, Number(value('ON_DEMAND_AI_MAX_TOKENS', '2048')) || 2048))
// V1 has one shared hard budget for MANUAL and AUTO. Keep the application
// fail-closed on zero, and never let an environment edit raise this ceiling.
const onDemandAiDailyLimit = Math.min(100, Math.max(0, Number(value('ON_DEMAND_AI_DAILY_LIMIT', '0')) || 0))
const onDemandAiMaxConcurrent = Math.min(2, Math.max(1, Number(value('ON_DEMAND_AI_MAX_CONCURRENT', '1')) || 1))
const onDemandAiBudgetCollection = value('ON_DEMAND_AI_BUDGET_COLLECTION')
const onDemandAiBudgetApiKey = value('CLOUDBASE_APIKEY')
const onDemandAiBudgetRpcBaseUrl = value('ON_DEMAND_AI_BUDGET_RPC_BASE_URL')
const onDemandAiBudgetRpcFunction = value('ON_DEMAND_AI_BUDGET_RPC_FUNCTION', 'asva_ai_budget_guard')
const idSet = (raw) => new Set(String(raw || '').split(/[\s,]+/).map((id) => id.trim()).filter(Boolean))
// Temporary acceptance isolation. When enabled, the manual endpoint only
// accepts an exact ADMIN actor and an exact Source id, both evaluated on the
// server before any budget reservation or model call. Missing lists fail
// closed instead of opening the endpoint to every mentor.
const onDemandAiTestScopeEnabled = value('ON_DEMAND_AI_TEST_SCOPE_ENABLED', 'false') === 'true'
const onDemandAiTestAdminActorIds = idSet(value('ON_DEMAND_AI_TEST_ADMIN_ACTOR_IDS'))
const onDemandAiTestSourceIds = idSet(value('ON_DEMAND_AI_TEST_SOURCE_IDS'))
// Automatic processing is intentionally limited to an explicit, intersecting
// mentor/customer canary. An empty either side means no automatic request may
// reach the model, even if its feature flag was accidentally enabled.
const onDemandAiAutoTriggerCustomerIds = idSet(value('ON_DEMAND_AI_AUTO_TRIGGER_CUSTOMER_IDS'))
const onDemandAiAutoTriggerActorIds = idSet(value('ON_DEMAND_AI_AUTO_TRIGGER_ACTOR_IDS'))
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
  features: {
    externalAppointment: value('FEATURE_EXTERNAL_APPOINTMENT', 'false') === 'true',
    automaticProfileArchiving: value('FEATURE_AUTOMATIC_PROFILE_ARCHIVING', 'false') === 'true',
    automaticProfileArchivingMode,
    automaticProfileArchivingEnabledAt,
    automaticProfileArchivingCanary: value('FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY', 'false') === 'true',
    automaticProfileCanaryCustomerIds,
    // This is intentionally independent from the retired automatic archive
    // switch. It gates only an explicit, single-source HTTP request.
    onDemandAiProcessing: value('FEATURE_ON_DEMAND_AI_PROCESSING', 'false') === 'true',
    // Auto-triggering is deliberately a second, fail-closed switch. It must
    // stay false until the durable transaction guard has passed a controlled
    // production run. Both canary sets below must also match.
    onDemandAiAutoTrigger: value('FEATURE_ON_DEMAND_AI_AUTO_TRIGGER', 'false') === 'true',
    onDemandAiAutoTriggerCustomerIds,
    onDemandAiAutoTriggerActorIds,
    onDemandAiMaxChars,
    onDemandAiMaxPromptChars,
    onDemandAiTimeoutMs,
    onDemandAiMaxTokens,
    onDemandAiDailyLimit,
    // A missing RPC table, endpoint or server API key is deliberately not
    // given a default. The API must fail closed until the dedicated
    // PostgreSQL table and function are provisioned and read back by review.
    onDemandAiBudgetCollection,
    onDemandAiBudgetApiKey,
    onDemandAiBudgetRpcBaseUrl,
    onDemandAiBudgetRpcFunction,
    onDemandAiMaxConcurrent,
    onDemandAiTestScopeEnabled,
    onDemandAiTestAdminActorIds,
    onDemandAiTestSourceIds,
  },
  deepseek: {
    apiKey: value('DEEPSEEK_API_KEY'),
    model: value('DEEPSEEK_MODEL', 'deepseek-flash'),
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
      assessmentBindings: value('FEISHU_ASSESSMENT_BINDINGS_TABLE_ID'),
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
