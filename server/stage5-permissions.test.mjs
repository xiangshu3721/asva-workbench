import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')

describe('Stage 5 route permissions', () => {
  it('keeps safety assessment reads behind authenticated access', () => {
    expect(source).toMatch(/safetyCustomer && request\.method === 'GET'.*await guard\(request\)/)
  })

  it('keeps safety refresh behind admin access', () => {
    expect(source).toMatch(/safetyCustomer && request\.method === 'POST'.*safety-assessment\/refresh.*await guardAdmin\(request\)/)
  })

  it('keeps mentor management reads behind admin access', () => {
    expect(source).toMatch(/url\.pathname === '\/api\/staff\/mentors'[\s\S]*repository\.teamSnapshot\(await guardAdmin\(request\)/)
  })
})
