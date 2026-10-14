import { describe, expect, it } from 'vitest'
import { config, isCorsOriginAllowed } from './config.mjs'

describe('development CORS origin policy', () => {
  it('allows any localhost port during development', () => {
    expect(isCorsOriginAllowed('http://127.0.0.1:5175', 'development')).toBe(true)
    expect(isCorsOriginAllowed('http://localhost:8789', 'development')).toBe(true)
  })

  it('does not allow arbitrary public origins', () => {
    expect(isCorsOriginAllowed('https://attacker.example')).toBe(false)
  })
})
