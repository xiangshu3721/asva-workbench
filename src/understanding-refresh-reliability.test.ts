import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_DEFAULT_TIMEOUT_MS, CLIENT_UNDERSTANDING_REFRESH_TIMEOUT_MS, createHttpApi } from './clientApi'
import { readFileSync } from 'node:fs'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('consultation refresh client reliability', () => {
  it('uses a bounded refresh budget below the CloudBase function ceiling', async () => {
    expect(CLIENT_UNDERSTANDING_REFRESH_TIMEOUT_MS).toBe(50_000)
    expect(CLIENT_UNDERSTANDING_REFRESH_TIMEOUT_MS).toBeGreaterThan(CLIENT_DEFAULT_TIMEOUT_MS)
    expect(CLIENT_UNDERSTANDING_REFRESH_TIMEOUT_MS).toBeLessThan(60_000)
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    vi.stubGlobal('fetch', fetchMock)

    const pending = expect(createHttpApi('http://127.0.0.1:8788').refreshCustomerUnderstanding('STAFF-1', 'CUS-1', true)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(CLIENT_UNDERSTANDING_REFRESH_TIMEOUT_MS)
    await pending
  })

  it('keeps the floating assistant removed and automatically refreshes stale current-rule understanding at most once per data/version key', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('<GlobalAIAssistant ')
    expect(source).toContain('autoUnderstandingRefreshAttemptsRef.current.has(attemptKey)')
    expect(source).toContain('autoUnderstandingRefreshAttemptsRef.current.add(attemptKey)')
    expect(source).toContain("response.status !== 'STALE' || response.meta.promptVersion !== CUSTOMER_UNDERSTANDING_PROMPT_VERSION")
    expect(source).toContain('cached?.meta.promptVersion === CUSTOMER_UNDERSTANDING_PROMPT_VERSION')
    expect(source).toContain('response.context_summary?.has_meaningful_input !== true')
    expect(source).toContain('props.onRefreshUnderstanding(requestCustomerId, false)')
  })

  it('keeps a previous response visible and labels read versus refresh failures accurately', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(source).toContain("error: `读取咨询理解失败：${error instanceof Error ? error.message : '请求未完成'}`")
    expect(source).toContain("error: `重新整理失败：${error instanceof Error ? error.message : '请求未完成'}`")
    expect(source).toContain('const storedUnderstanding = response?.understanding || (understandingReadFailed ? fallback : undefined)')
    expect(source).toContain('const useRecordedDirection = localDirections.length > 0 && !hasVisibleStoredIssue')
    expect(source).toContain('const visibleIssues = useRecordedDirection ? localDirections : (understanding?.top_issues || [])')
    expect(source).toContain('const entryPoints = (useRecordedDirection ?')
    expect(source).toContain('重新整理未完成，当前保留上一次可用结果。')
    expect(source).toContain('AI 重新整理未完成，当前显示基于已录入资料的待确认结果。')
  })
})
