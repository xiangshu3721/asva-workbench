import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config.mjs', () => ({ config: { appEnv: 'test', deepseek: { apiKey: 'synthetic-test-key', model: 'legacy-model', evidenceModel: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' } } }))

const { classifyDeepSeekResponse, createEvidenceCandidates, EVIDENCE_EXTRACT_TIMEOUT_MS, EVIDENCE_EXTRACT_MAX_ATTEMPTS } = await import('./deepseek.mjs')

describe('DeepSeek processing diagnostics', () => {
  it('keeps Evidence extraction within the CloudBase request budget', () => {
    expect(EVIDENCE_EXTRACT_TIMEOUT_MS).toBe(25_000)
    expect(EVIDENCE_EXTRACT_MAX_ATTEMPTS).toBe(1)
    expect(EVIDENCE_EXTRACT_TIMEOUT_MS * EVIDENCE_EXTRACT_MAX_ATTEMPTS).toBeLessThan(60_000)
  })

  it('classifies timeout and provider throttling separately', () => {
    expect(classifyDeepSeekResponse({ aborted: true })).toBe('DEEPSEEK_TIMEOUT')
    expect(classifyDeepSeekResponse({ status: 429 })).toBe('DEEPSEEK_RATE_LIMIT')
    expect(classifyDeepSeekResponse({ status: 503 })).toBe('DEEPSEEK_UNAVAILABLE')
    expect(classifyDeepSeekResponse({ status: 430, providerError: { type: 'SERVER', message: 'Service is too busy' } })).toBe('DEEPSEEK_UPSTREAM_OVERLOADED')
    expect(classifyDeepSeekResponse({ status: 400, providerError: { code: 'service_unavailable_error' } })).toBe('DEEPSEEK_UPSTREAM_OVERLOADED')
  })

  it('preserves only non-sensitive provider diagnostics for an overloaded upstream', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ request_id: 'req-synthetic-430', error: { type: 'SERVER', code: 'service_unavailable_error', message: 'Service is too busy' } }), { status: 430, headers: { 'content-type': 'application/json', 'retry-after': '7' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createEvidenceCandidates({ text: '合成资料。', sourceRole: 'STAFF_REPORTED', sourcePerspective: 'STAFF_REPORTED' })).rejects.toMatchObject({
      code: 'DEEPSEEK_UPSTREAM_OVERLOADED',
      httpStatus: 430,
      providerType: 'SERVER',
      providerCode: 'service_unavailable_error',
      providerRequestId: 'req-synthetic-430',
      retryAfter: '7',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
    expect(promptInput.writable_customer_fields.find((item) => item.key === 'current_core_issue').boundary).toContain('不是客户想达到的结果')
    expect(promptInput.writable_customer_fields.find((item) => item.key === 'current_goal').boundary).toContain('不是当前困扰')
    expect(promptInput.writable_customer_fields.find((item) => item.key === 'current_expectation').boundary).toContain('从导师或服务中获得')
    expect(promptInput.writable_customer_fields.find((item) => item.key === 'support_system').boundary).toContain('不要重复同一条原文')
    expect(body.messages.find((message) => message.role === 'system').content).toContain('工作地点没有独立物理字段时field_key留空')
  })

  it('clears a model-misclassified work location before evidence normalization', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [
      { evidence_type: 'FACT', semantic_kind: 'PROFILE_FIELD', field_key: 'city', value: '杭州', display_text: '所在城市：杭州', source_excerpt: '在杭州工作', confidence: .9 },
      { evidence_type: 'HYPOTHESIS', semantic_kind: 'GOAL', field_key: 'career_goal', value: '心理咨询', display_text: '考虑转向心理咨询', source_excerpt: '考虑转向心理咨询相关方向', confidence: .6 },
    ] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createEvidenceCandidates({ text: '我在杭州工作，考虑转向心理咨询相关方向。', sourceRole: 'STAFF_REPORTED', sourcePerspective: 'STAFF_REPORTED' })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ field_key: '', semantic_kind: 'EVENT', source_excerpt: '在杭州工作' }),
      expect.objectContaining({ field_key: 'career_goal', evidence_type: 'HYPOTHESIS' }),
    ]))
  })

  it('removes an exact family-support duplicate from the broader support field', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [
      { evidence_type: 'FACT', semantic_kind: 'RELATIONSHIP', field_key: 'support_system', value: '父母支持我', display_text: '支持系统：父母支持我', source_excerpt: '父母支持我', confidence: .8 },
      { evidence_type: 'FACT', semantic_kind: 'RELATIONSHIP', field_key: 'family_support_level', value: '父母支持我', display_text: '家庭支持：父母支持我', source_excerpt: '父母支持我', confidence: .8 },
    ] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createEvidenceCandidates({ text: '父母支持我。', sourceRole: 'STAFF_REPORTED', sourcePerspective: 'STAFF_REPORTED' })).resolves.toEqual([
      expect.objectContaining({ field_key: 'family_support_level' }),
    ])
  })

  it('fails closed on truncated evidence output without burning extra DeepSeek attempts', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"items":[' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createEvidenceCandidates({ text: '合成资料。', sourceRole: 'STAFF_REPORTED', sourcePerspective: 'STAFF_REPORTED' })).rejects.toMatchObject({ code: 'DEEPSEEK_OUTPUT_TRUNCATED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

afterEach(() => vi.unstubAllGlobals())
