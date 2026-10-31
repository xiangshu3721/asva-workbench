import { describe, expect, it } from 'vitest'
import { ApiError } from './clientApi'
import { isExplicitSessionInvalid, sessionRetryMessage } from './session-recovery'

describe('session recovery classification', () => {
  it('clears credentials only for an explicit 401 authentication failure', () => {
    expect(isExplicitSessionInvalid(new ApiError({ code: 'HTTP_401', serverCode: 'AUTH_INVALID', httpStatus: 401, message: '登录信息验证失败' }))).toBe(true)
    expect(isExplicitSessionInvalid({ code: 'HTTP_401' })).toBe(true)
  })

  it('keeps credentials for temporary network and upstream failures', () => {
    expect(isExplicitSessionInvalid(new ApiError({ code: 'REQUEST_TIMEOUT', message: '请求超时' }))).toBe(false)
    expect(isExplicitSessionInvalid(new ApiError({ code: 'HTTP_502', httpStatus: 502, message: '飞书暂时不可用' }))).toBe(false)
    expect(isExplicitSessionInvalid(new ApiError({ code: 'HTTP_503', httpStatus: 503, message: '服务暂时不可用' }))).toBe(false)
    expect(sessionRetryMessage(new Error('飞书暂时不可用'))).toContain('有效登录凭据已保留')
  })
})
