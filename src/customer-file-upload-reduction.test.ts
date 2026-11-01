import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('V2 customer material entry points', () => {
  it('keeps the customer flows text-only while preserving history and source processing', () => {
    expect(appSource).toContain('const source = await onCreate(input)')
    expect(appSource).toContain("sourceType: 'TEXT_INPUT'")
    expect(appSource).toContain('原始资料与查看依据')
    expect(appSource).toContain('查看整理依据')
    expect(appSource).not.toContain('type="file"')
    expect(appSource).not.toContain('onExtractDocument')
    expect(appSource).not.toContain('FILE_UPLOAD')
    expect(appSource).not.toContain('identifyDialogue')
    expect(appSource).not.toContain('confirmDialogue')
  })
})
