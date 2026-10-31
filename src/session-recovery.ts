import { ApiError } from './clientApi'

export function isExplicitSessionInvalid(error: unknown) {
  const value = error as { code?: string; serverCode?: string; httpStatus?: number }
  return error instanceof ApiError
    ? error.httpStatus === 401 || error.serverCode === 'AUTH_INVALID' || error.serverCode === 'AUTH_REQUIRED'
    : value?.httpStatus === 401 || value?.code === 'HTTP_401' || value?.serverCode === 'AUTH_INVALID' || value?.serverCode === 'AUTH_REQUIRED'
}

export function sessionRetryMessage(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return message ? `登录状态暂时无法确认：${message}。有效登录凭据已保留，请重试。` : '登录状态暂时无法确认。有效登录凭据已保留，请重试。'
}
