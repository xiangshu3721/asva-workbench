import { appendFile } from 'node:fs/promises'

const STS_ENDPOINT = 'https://sts.tencentcloudapi.com/'
const STS_VERSION = '2018-08-13'

function required(name, value = process.env[name]) {
  if (!value) throw new Error(`Missing required ${name}`)
  return value
}

export function buildRoleSessionName({ repository = process.env.GITHUB_REPOSITORY, runId = process.env.GITHUB_RUN_ID }) {
  const source = `asva-${repository || 'github'}-${runId || 'run'}`.replace(/[^A-Za-z0-9+=,.@_-]/g, '-')
  return source.slice(0, 64)
}

export function buildStsRequest({ providerId, roleArn, webIdentityToken, region, roleSessionName, durationSeconds = 1800 }) {
  const timestamp = Math.floor(Date.now() / 1000)
  return {
    url: STS_ENDPOINT,
    options: {
      method: 'POST',
      headers: {
        Authorization: 'SKIP',
        'Content-Type': 'application/json; charset=utf-8',
        Host: 'sts.tencentcloudapi.com',
        'X-TC-Action': 'AssumeRoleWithWebIdentity',
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': STS_VERSION,
        'X-TC-Region': region,
      },
      body: JSON.stringify({
        ProviderId: providerId,
        RoleArn: roleArn,
        RoleSessionName: roleSessionName,
        WebIdentityToken: webIdentityToken,
        DurationSeconds: durationSeconds,
      }),
    },
  }
}

export async function requestGitHubIdToken({ audience, fetchImpl = fetch, requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }) {
  required('ACTIONS_ID_TOKEN_REQUEST_URL', requestUrl)
  required('ACTIONS_ID_TOKEN_REQUEST_TOKEN', requestToken)
  const url = new URL(requestUrl)
  url.searchParams.set('audience', audience)
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${requestToken}` } })
  if (!response.ok) throw new Error(`GitHub OIDC token request failed with HTTP ${response.status}`)
  const payload = await response.json()
  if (!payload.value) throw new Error('GitHub OIDC response did not contain a token')
  return payload.value
}

export async function assumeTencentRole({ audience, providerId, roleArn, region, fetchImpl = fetch }) {
  const token = await requestGitHubIdToken({ audience, fetchImpl })
  const request = buildStsRequest({
    providerId,
    roleArn,
    webIdentityToken: token,
    region,
    roleSessionName: buildRoleSessionName({}),
  })
  const response = await fetchImpl(request.url, request.options)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.Response?.Error) {
    const code = payload.Response?.Error?.Code || `HTTP ${response.status}`
    throw new Error(`Tencent STS role assumption failed: ${code}`)
  }
  const credentials = payload.Response?.Credentials
  if (!credentials?.TmpSecretId || !credentials?.TmpSecretKey || !credentials?.Token) {
    throw new Error('Tencent STS response did not contain temporary credentials')
  }
  return credentials
}

async function exportTemporaryCredentials(credentials, envPath = process.env.GITHUB_ENV) {
  required('GITHUB_ENV', envPath)
  for (const value of [credentials.TmpSecretId, credentials.TmpSecretKey, credentials.Token]) {
    process.stdout.write(`::add-mask::${value}\n`)
  }
  await appendFile(envPath, [
    `TCB_SECRET_ID=${credentials.TmpSecretId}`,
    `TCB_SECRET_KEY=${credentials.TmpSecretKey}`,
    `TCB_TOKEN=${credentials.Token}`,
    '',
  ].join('\n'))
}

export async function run() {
  const audience = process.env.TENCENT_CLOUD_OIDC_AUDIENCE || 'sts.tencentcloudapi.com'
  const credentials = await assumeTencentRole({
    audience,
    providerId: required('TENCENT_CLOUD_OIDC_PROVIDER_ID'),
    roleArn: required('TENCENT_CLOUD_ROLE_ARN'),
    region: process.env.TENCENT_CLOUD_REGION || 'ap-shanghai',
  })
  await exportTemporaryCredentials(credentials)
  console.log(JSON.stringify({ ok: true, credentialType: 'oidc-sts', durationSeconds: 1800 }))
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) await run()
