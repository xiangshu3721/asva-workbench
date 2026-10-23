import { describe, expect, it } from 'vitest'
import { config, isCorsOriginAllowed } from './config.mjs'
import { responseHeaders } from './cors.mjs'

describe('development CORS origin policy', () => {
  it('allows any localhost port during development', () => {
    expect(isCorsOriginAllowed('http://127.0.0.1:5175', 'development')).toBe(true)
    expect(isCorsOriginAllowed('http://localhost:8789', 'development')).toBe(true)
  })

  it('does not allow arbitrary public origins', () => {
    expect(isCorsOriginAllowed('https://attacker.example')).toBe(false)
    expect(isCorsOriginAllowed('https://xiangshu3721.github.io/asva-workbench/')).toBe(false)
  })

  it('returns the approved origin and the complete mutation preflight contract', () => {
    const headers = responseHeaders({ headers: { origin: 'https://xiangshu3721.github.io' } }, 'req-cors-1')
    expect(headers['Access-Control-Allow-Origin']).toBe('https://xiangshu3721.github.io')
    expect(headers['Access-Control-Allow-Headers']).toContain('X-ASVA-Response-Mode')
    expect(headers['Access-Control-Allow-Headers']).toContain('X-Idempotency-Key')
    expect(headers['Access-Control-Allow-Methods']).toContain('POST')
    expect(headers['Access-Control-Allow-Methods']).toContain('PATCH')
    expect(headers['Access-Control-Allow-Methods']).toContain('PUT')
    expect(headers['Access-Control-Allow-Methods']).toContain('OPTIONS')
    expect(headers['Access-Control-Expose-Headers']).toBe('X-Request-Id')
  })

  it('does not grant CORS access to an unauthorized origin', () => {
    const headers = responseHeaders({ headers: { origin: 'https://attacker.example' } }, 'req-cors-2')
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
  })
})
