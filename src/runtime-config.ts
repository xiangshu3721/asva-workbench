export type AppEnvironment = 'development' | 'production' | 'mock'

const APP_ENVIRONMENTS: AppEnvironment[] = ['development', 'production', 'mock']

export interface RuntimeConfig {
  appEnv: AppEnvironment | 'invalid'
  apiBaseUrl: string
  dataMode: 'production' | 'mock'
  apiConfigured: boolean
  configurationError: string | null
}

export function resolveRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const rawAppEnv = env.VITE_APP_ENV?.trim() || 'development'
  const appEnv = APP_ENVIRONMENTS.includes(rawAppEnv as AppEnvironment) ? rawAppEnv as AppEnvironment : 'invalid'
  const apiBaseUrl = env.VITE_API_BASE_URL?.trim().replace(/\/$/, '') || ''
  const apiConfigured = Boolean(apiBaseUrl)
  const configurationError = appEnv === 'invalid'
    ? `VITE_APP_ENV 必须是 development、production 或 mock，当前为 ${rawAppEnv}`
    : appEnv !== 'mock' && !apiConfigured
      ? '未配置 VITE_API_BASE_URL。development 和 production 必须连接真实 HTTP API；如需本地演示，请明确设置 VITE_APP_ENV=mock。'
      : null
  return { appEnv, apiBaseUrl, dataMode: appEnv === 'mock' ? 'mock' : 'production', apiConfigured, configurationError }
}

export const runtimeConfig = resolveRuntimeConfig({
  VITE_APP_ENV: import.meta.env.VITE_APP_ENV,
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
})
