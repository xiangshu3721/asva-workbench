import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.mjs', () => ({ config: { appEnv: 'test', deepseek: { apiKey: 'synthetic-test-key', model: 'legacy-model', evidenceModel: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' } } }))

const { classifyDeepSeekResponse, createEvidenceCandidates } = await import('./deepseek.mjs')

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

  it('uses an evidence-only JSON contract without changing the general model settings', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [{ field_key: 'age', value: 29, source_excerpt: '29岁' }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createEvidenceCandidates({ text: '合成客户29岁。', sourceRole: 'STAFF_REPORTED', sourcePerspective: 'STAFF_REPORTED' })).resolves.toHaveLength(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('deepseek-flash')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.max_tokens).toBe(4096)
    expect(body.stream).toBe(false)
    const promptInput = JSON.parse(body.messages.find((message) => message.role === 'user').content)
    expect(promptInput.writable_customer_fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'sleep', meaning: '睡眠情况' }),
      expect.objectContaining({ key: 'relationship_conflicts', meaning: '关系冲突' }),
      expect.objectContaining({ key: 'career_goal', meaning: '职业目标' }),
    ]))
    expect(promptInput.writable_customer_fields.find((item) => item.key === 'city').boundary).toContain('工作地点不得填入')
  })

  it('fails closed on truncated evidence output without burning extra DeepSeek attempts', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"items":[' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createEvidenceCandidates({ text: '合成资料。', sourceRole: 'STAFF_REPORTED', sourcePerspective: 'STAFF_REPORTED' })).rejects.toMatchObject({ code: 'DEEPSEEK_OUTPUT_TRUNCATED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

afterEach(() => vi.unstubAllGlobals())
