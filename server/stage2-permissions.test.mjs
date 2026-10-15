import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSource = fs.readFileSync(path.join(process.cwd(), 'server/index.mjs'), 'utf8')

describe('Stage 2 document permissions', () => {
  it('allows an authenticated mentor to extract an uploaded document', () => {
    expect(indexSource).toMatch(/url\.pathname === '\/api\/documents\/extract'[\s\S]*repository\.extractDocument\(await guard\(request\)/)
    expect(indexSource).not.toMatch(/url\.pathname === '\/api\/documents\/extract'[\s\S]*repository\.extractDocument\(await guardAdmin\(request\)/)
  })
})
