import { isCorsOriginAllowed } from './config.mjs'

export const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, X-Staff-Id, X-Operation-Id, X-Idempotency-Key, X-ASVA-Response-Mode'
export const CORS_ALLOWED_METHODS = 'GET, POST, PATCH, PUT, OPTIONS'

export function responseHeaders(request, requestId) {
  const requestedOrigin = request.headers.origin
  const origin = requestedOrigin && isCorsOriginAllowed(requestedOrigin) ? requestedOrigin : ''
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS,
    'Access-Control-Expose-Headers': 'X-Request-Id',
    'X-Request-Id': requestId,
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  }
}
