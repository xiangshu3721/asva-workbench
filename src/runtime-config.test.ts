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

  it('rejects unknown environments', () => {
    expect(resolveRuntimeConfig({ VITE_APP_ENV: 'demo', VITE_API_BASE_URL: 'http://127.0.0.1:8788' }).appEnv).toBe('invalid')
  })
})
