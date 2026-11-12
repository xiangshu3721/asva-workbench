import { describe, expect, it } from 'vitest'
import { buildRoleSessionName, buildStsRequest } from './github-oidc-tencent-sts.mjs'

describe('GitHub OIDC Tencent STS exchange', () => {
  it('creates a bounded safe STS session name', () => {
    const session = buildRoleSessionName({ repository: 'xiangshu3721/asva-workbench', runId: '12345' })
    expect(session).toBe('asva-xiangshu3721-asva-workbench-12345')
    expect(session).toMatch(/^[A-Za-z0-9+=,.@_-]{1,64}$/)
  })

  it('uses the unsigned OIDC STS exchange and keeps the web token in the request body only', () => {
    const request = buildStsRequest({ providerId: 'github-asva-production', roleArn: 'qcs::cam::uin/123:roleName/asva-api-deployer', webIdentityToken: 'oidc-token', region: 'ap-shanghai', roleSessionName: 'asva-test' })
    expect(request.options.headers.Authorization).toBe('SKIP')
    expect(request.options.headers['X-TC-Action']).toBe('AssumeRoleWithWebIdentity')
    expect(request.options.body).toContain('oidc-token')
  })
})
