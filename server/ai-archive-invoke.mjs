/**
 * Async AI archive worker invoke.
 * Production: SCF Invoke InvocationType=Event (detaches from asva-api HTTP lifecycle).
 * Local/mock: runs the worker handler in-process (test double for Event invoke).
 * Never expose credentials to the frontend; only asva-api / worker use this module.
 */
import crypto from 'node:crypto'
import https from 'node:https'
import { config } from './config.mjs'

export const AI_ARCHIVE_FUNCTION_DEFAULT = 'asva-ai-archive'

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim()
}

export function aiArchiveInvokeMode() {
  const forced = env('ASVA_AI_ARCHIVE_INVOKE_MODE').toLowerCase()
  if (forced === 'event' || forced === 'local' || forced === 'disabled') return forced
  if (config.appEnv === 'mock' || config.appEnv === 'development') return 'local'
  if (env('TENCENTCLOUD_SECRETID') || env('CLOUDBASE_SECRET_ID') || env('CLOUDBASE_APIKEY')) return 'event'
  return 'local'
}

export function aiArchiveFunctionName() {
  return env('ASVA_AI_ARCHIVE_FUNCTION_NAME', AI_ARCHIVE_FUNCTION_DEFAULT)
}

export function aiArchiveEnvId() {
  return env('CLOUDBASE_ENV_ID', env('TCB_ENV_ID', 'root-journey-prod-d4d7pzd0a8f805'))
}

function credentials() {
  const secretId = env('TENCENTCLOUD_SECRETID', env('CLOUDBASE_SECRET_ID'))
  const secretKey = env('TENCENTCLOUD_SECRETKEY', env('CLOUDBASE_SECRET_KEY'))
  const apiKey = env('CLOUDBASE_APIKEY')
  return { secretId, secretKey, apiKey }
}

function sha256Hex(payload) {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}

function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest()
}

function tc3Sign({ secretId, secretKey, service, host, action, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const hashedRequestPayload = sha256Hex(payload)
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`
  const signedHeaders = 'content-type;host'
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedRequestPayload].join('\n')
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const secretDate = hmacSha256(`TC3${secretKey}`, date)
  const secretService = hmacSha256(secretDate, service)
  const secretSigning = hmacSha256(secretService, 'tc3_request')
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

function httpsJsonRequest({ hostname, path = '/', headers, body, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname,
      path,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { raw += chunk })
      response.on('end', () => {
        let parsed = null
        try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = { raw } }
        if ((response.statusCode || 500) >= 400) {
          reject(Object.assign(new Error(`HTTP_${response.statusCode}`), { statusCode: response.statusCode, body: parsed }))
          return
        }
        resolve({ statusCode: response.statusCode, body: parsed })
      })
    })
    request.on('timeout', () => request.destroy(Object.assign(new Error('INVOKE_TIMEOUT'), { code: 'INVOKE_TIMEOUT' })))
    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

/** SCF Invoke with InvocationType=Event — returns as soon as the event is accepted. */
export async function invokeScfEvent({ functionName, namespace, payload, qualifier = '$LATEST' }) {
  const { secretId, secretKey } = credentials()
  if (!secretId || !secretKey) {
    throw Object.assign(new Error('缺少腾讯云密钥，无法异步 Invoke AI 归档 worker'), { code: 'AI_ARCHIVE_INVOKE_CREDENTIALS_MISSING' })
  }
  const host = 'scf.tencentcloudapi.com'
  const service = 'scf'
  const action = 'Invoke'
  const timestamp = Math.floor(Date.now() / 1000)
  const clientContext = JSON.stringify({
    asvaInvokeSecret: env('ASVA_AI_ARCHIVE_INVOKE_SECRET'),
    asvaInvokeAt: new Date().toISOString(),
  })
  const requestPayload = JSON.stringify({
    FunctionName: functionName,
    Namespace: namespace,
    Qualifier: qualifier,
    InvocationType: 'Event',
    ClientContext: clientContext.slice(0, 3500),
    Payload: JSON.stringify(payload),
  })
  const authorization = tc3Sign({ secretId, secretKey, service, host, action, payload: requestPayload, timestamp })
  const response = await httpsJsonRequest({
    hostname: host,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': '2018-04-16',
      'X-TC-Region': env('TENCENTCLOUD_REGION', 'ap-shanghai'),
    },
    body: requestPayload,
    timeoutMs: Number(env('ASVA_AI_ARCHIVE_INVOKE_TIMEOUT_MS', '5000')) || 5000,
  })
  const error = response.body?.Response?.Error
  if (error) {
    throw Object.assign(new Error(error.Message || error.Code || 'SCF_INVOKE_FAILED'), {
      code: error.Code || 'SCF_INVOKE_FAILED',
      requestId: response.body?.Response?.RequestId,
    })
  }
  return {
    status: 'INVOKED',
    mode: 'event',
    requestId: response.body?.Response?.RequestId || '',
    result: response.body?.Response?.Result || null,
  }
}

let localWorkerRunner = null

/** Test/prod seam: inject a local runner (defaults to dynamic import of worker handler). */
export function setLocalAiArchiveWorkerRunner(runner) {
  localWorkerRunner = runner
}

async function defaultLocalRunner(payload) {
  const mod = await import('./ai-archive-worker.mjs')
  return mod.handleAiArchiveEvent(payload)
}

/**
 * Fire-and-forget enqueue for AI archive work.
 * @returns {{ status: 'INVOKED'|'LOCAL_QUEUED'|'DISABLED'|'FAILED', mode: string, requestId?: string, errorCode?: string }}
 */
export async function enqueueAiArchiveJob(input = {}) {
  const customerId = String(input.customerId || '').trim()
  const sourceId = String(input.sourceId || '').trim()
  if (!customerId && !sourceId) {
    return { status: 'FAILED', mode: aiArchiveInvokeMode(), errorCode: 'AI_ARCHIVE_JOB_TARGET_REQUIRED' }
  }
  const payload = {
    version: 1,
    mode: input.mode === 'process' ? 'process' : 'recover',
    customerId,
    sourceId: sourceId || undefined,
    actorId: String(input.actorId || '').trim() || undefined,
    reason: String(input.reason || 'AUTO').trim() || 'AUTO',
    force: input.force === true,
    enqueuedAt: new Date().toISOString(),
  }
  const mode = aiArchiveInvokeMode()
  if (mode === 'disabled') return { status: 'DISABLED', mode }

  if (mode === 'event') {
    try {
      const invoked = await invokeScfEvent({
        functionName: aiArchiveFunctionName(),
        namespace: aiArchiveEnvId(),
        payload,
      })
      return { status: 'INVOKED', mode: 'event', requestId: invoked.requestId }
    } catch (error) {
      return {
        status: 'FAILED',
        mode: 'event',
        errorCode: error?.code || 'AI_ARCHIVE_INVOKE_FAILED',
        message: error?.message || 'invoke failed',
      }
    }
  }

  // local / development: schedule worker handler off the current stack
  const runner = localWorkerRunner || defaultLocalRunner
  const job = {
    status: 'LOCAL_QUEUED',
    mode: 'local',
    promise: Promise.resolve().then(() => runner(payload)),
  }
  // Detach: callers must not await the AI work on the save path.
  void job.promise.catch((error) => {
    console.error('[ASVA_AI_ARCHIVE_LOCAL]', JSON.stringify({
      customerId: payload.customerId,
      sourceId: payload.sourceId,
      error: error?.code || error?.message || 'LOCAL_WORKER_FAILED',
    }))
  })
  return job
}

/** Best-effort non-throwing wrapper used by repository schedule paths. */
export function scheduleAiArchiveJob(input = {}) {
  let resolveAck
  const ack = new Promise((resolve) => { resolveAck = resolve })
  void enqueueAiArchiveJob(input)
    .then((result) => resolveAck(result))
    .catch((error) => resolveAck({
      status: 'FAILED',
      mode: aiArchiveInvokeMode(),
      errorCode: error?.code || 'AI_ARCHIVE_SCHEDULE_FAILED',
    }))
  return { status: 'QUEUED', ack }
}
