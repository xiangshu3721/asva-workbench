import crypto from 'node:crypto'
import { config } from './config.mjs'

export class AuthError extends Error {
  code = 'AUTH_INVALID'
  status = 401
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function sign(value) { return crypto.createHmac('sha256', config.authSecret).update(value).digest('base64url') }

export const ACCESS_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000
export const PASSWORD_CHANGE_TOKEN_TTL_MS = 15 * 60 * 1000

export function issueSession(staffId, authVersion = 0, authMode = config.authMode, purpose = 'SESSION') {
  if (!config.authSecret) throw Object.assign(new Error('生产认证密钥未配置'), { code: 'AUTH_NOT_CONFIGURED', status: 503 })
  const iat = Date.now()
  const ttl = purpose === 'PASSWORD_CHANGE' ? PASSWORD_CHANGE_TOKEN_TTL_MS : ACCESS_TOKEN_TTL_MS
  const payload = encode({ sub: staffId, auth_version: Number(authVersion) || 0, amr: authMode, purpose, iat, exp: iat + ttl })
  return `${payload}.${sign(payload)}`
}

export function verifySession(token) {
  if (!config.authSecret || !token) throw new AuthError('登录状态无效或已过期')
  const [payload, signature] = token.split('.')
  const expected = sign(payload || '')
  if (!payload || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new AuthError('登录状态无效或已过期')
  let claims
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw new AuthError('登录状态无效或已过期') }
  if (!claims.sub || Number(claims.exp) < Date.now()) throw new AuthError('登录状态无效或已过期')
  return claims
}

export function bearerToken(request) {
  const header = request.headers.authorization
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
}
