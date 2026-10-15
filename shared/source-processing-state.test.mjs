import { describe, expect, it } from 'vitest'
import { aiFailureMessage, persistenceFailureMessage, sourceProcessingPresentation } from './source-processing-state.mjs'

describe('save and AI organize state separation', () => {
  it('SAVE_SUCCESS_AI_SUCCESS', () => {
    expect(sourceProcessingPresentation('COMPLETED')).toMatchObject({ label: '已保存 · 整理完成', canRetry: false })
  })

  it('SAVE_SUCCESS_AI_FAIL', () => {
    expect(sourceProcessingPresentation('FAILED', 'DEEPSEEK_UNAVAILABLE')).toMatchObject({ label: '已保存 · 整理暂时失败', message: '资料已保存，智能整理暂时失败。', canRetry: true })
  })

  it('SAVE_SUCCESS_AI_FAIL_PERSISTENCE_REMAINS_SUCCESS', () => {
    const presentation = sourceProcessingPresentation('FAILED', 'DEEPSEEK_TIMEOUT')
    expect(presentation.label).toContain('已保存')
    expect(presentation.message).toContain('资料已保存')
  })

  it('AI_FAIL_RAW_ENUM_NOT_VISIBLE', () => {
    const text = aiFailureMessage({ code: 'DEEPSEEK_UNAVAILABLE' })
    expect(text).not.toContain('DEEPSEEK_UNAVAILABLE')
    expect(text).toBe('资料已保存，智能整理暂时失败。')
  })

  it('SAVE_FAIL_AI_NOT_TRIGGERED', () => {
    expect(persistenceFailureMessage({ code: 'FEISHU_TIMEOUT' })).toBe('保存暂时失败，内容还在，请稍后再试。')
  })
})
