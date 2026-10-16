import { describe, expect, it } from 'vitest'
import { resolveRuntimeConfig } from './runtime-config'

describe('runtime environment contract', () => {
  it('defaults to real development mode and never silently selects demo', () => {
    const config = resolveRuntimeConfig({})
    expect(config.appEnv).toBe('development')
    expect(config.dataMode).toBe('production')
    expect(config.configurationError).toContain('VITE_API_BASE_URL')
  })

  it('requires mock to be explicit', () => {
    const config = resolveRuntimeConfig({ VITE_APP_ENV: 'mock' })
    expect(config.appEnv).toBe('mock')
    expect(config.dataMode).toBe('mock')
    expect(config.configurationError).toBeNull()
  })

  it('accepts a configured development real API', () => {
    const config = resolveRuntimeConfig({ VITE_APP_ENV: 'development', VITE_API_BASE_URL: 'http://127.0.0.1:8788/' })
    expect(config.apiBaseUrl).toBe('http://127.0.0.1:8788')
    expect(config.configurationError).toBeNull()
  })

  it('accepts an isolated staging API and rejects the production API', () => {
    expect(resolveRuntimeConfig({ VITE_APP_ENV: 'staging', VITE_API_BASE_URL: 'https://staging.example.test/asva-api' })).toMatchObject({ appEnv: 'staging', dataMode: 'staging', configurationError: null })
    expect(resolveRuntimeConfig({ VITE_APP_ENV: 'staging', VITE_API_BASE_URL: 'https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api' }).configurationError).toContain('Staging 禁止连接 Production API')
  })

  it('rejects unknown environments', () => {
    expect(resolveRuntimeConfig({ VITE_APP_ENV: 'demo', VITE_API_BASE_URL: 'http://127.0.0.1:8788' }).appEnv).toBe('invalid')
  })
})
