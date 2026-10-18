import { describe, expect, it } from 'vitest'
import { sourceProcessingPresentation } from './source-processing-state.mjs'

describe('R043 customer persistence and source-state presentation', () => {
  it('distinguishes a stale processing source from an active processing source', () => {
    expect(sourceProcessingPresentation('PROCESSING', '', false)).toMatchObject({ label: '已保存 · 正在整理', canRetry: true })
    expect(sourceProcessingPresentation('PROCESSING', '', true)).toMatchObject({ label: '已保存 · 整理超时', canRetry: true })
  })
})
