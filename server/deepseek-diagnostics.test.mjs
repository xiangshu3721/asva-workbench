import { describe, expect, it } from 'vitest'
import { classifyDeepSeekResponse } from './deepseek.mjs'

describe('DeepSeek processing diagnostics', () => {
  it('classifies timeout and provider throttling separately', () => {
    expect(classifyDeepSeekResponse({ aborted: true })).toBe('DEEPSEEK_TIMEOUT')
    expect(classifyDeepSeekResponse({ status: 429 })).toBe('DEEPSEEK_RATE_LIMIT')
    expect(classifyDeepSeekResponse({ status: 503 })).toBe('DEEPSEEK_UNAVAILABLE')
  })

  it('classifies successful HTTP responses with invalid content', () => {
    expect(classifyDeepSeekResponse({ invalidJson: true })).toBe('DEEPSEEK_INVALID_RESPONSE')
    expect(classifyDeepSeekResponse({ emptyContent: true })).toBe('DEEPSEEK_INVALID_RESPONSE')
  })
})
