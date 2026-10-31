import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('manual customer create submit path', () => {
  it('submits the normal create form directly without a preview request', () => {
    expect(appSource).toContain("await saveWithDialogueGate(payload, uploadInput(), undefined, 'create')")
    expect(appSource).not.toContain('onPreview={previewManualCustomer}')
    expect(appSource).not.toContain('await onPreview(payload)')
  })
})
