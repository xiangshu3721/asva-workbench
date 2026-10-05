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

export const config = {
  port: Number(value('PORT', '8788')),
  host: value('HOST', '127.0.0.1'),
  authSecret: value('ASVA_AUTH_SECRET'),
  deepseek: {
    apiKey: value('DEEPSEEK_API_KEY'),
    model: value('DEEPSEEK_MODEL', 'deepseek-chat'),
    baseUrl: value('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/$/, ''),
  },
  feishu: {
    appId: value('FEISHU_APP_ID', 'cli_aaff6cb53db89bd3'),
    appSecret: value('FEISHU_APP_SECRET'),
    baseToken: value('FEISHU_APP_TOKEN'),
    baseUrl: value('FEISHU_BASE_URL', 'https://open.feishu.cn').replace(/\/$/, ''),
    tables: {
      appointments: value('FEISHU_APPOINTMENTS_TABLE_ID', 'tblUrXu4ivBGJ7zV'),
      customers: value('FEISHU_CUSTOMERS_TABLE_ID', 'tblFKkM7fPTqi8Zx'),
      serviceRecords: value('FEISHU_SERVICE_RECORDS_TABLE_ID', 'tblFGmyJi3RJQ7bM'),
      staff: value('FEISHU_STAFF_TABLE_ID', 'tblojNfk4bVM5KxH'),
      products: value('FEISHU_PRODUCTS_TABLE_ID', 'tblLG2SFwYpKgiMQ'),
      enrollments: value('FEISHU_ENROLLMENTS_TABLE_ID'),
      profileChanges: value('FEISHU_PROFILE_CHANGES_TABLE_ID', 'tblTH3OmBuzUsBVu'),
    },
  },
}

export function configurationStatus() {
  return {
    deepseekConfigured: Boolean(config.deepseek.apiKey),
    feishuConfigured: Boolean(config.feishu.appId && config.feishu.appSecret && config.feishu.baseToken),
    authConfigured: Boolean(config.authSecret),
  }
}
