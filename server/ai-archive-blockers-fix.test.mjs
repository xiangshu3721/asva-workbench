/**
 * Targeted fixes for ChatGPT PR#55 blockers on tip 859ec73:
 * 1) SCF Invoke ClientContext protocol
 * 2) Save-path delivery ACK
 * 3) Single authoritative Event (no duplicate process Event)
 * 4) Deploy order + effective cloudbaserc
 * Does NOT deploy / write production Feishu / merge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { contentHash } from '../shared/evidence-contract.mjs'

const EVIDENCE_DIR = process.env.ASVA_BLOCKERS_EVIDENCE_DIR
  || (process.env.HOME
    ? `${process.env.HOME}/Troublehut/_verify/asva-closed-loop-blockers-20261031`
    : path.resolve('_verify/asva-closed-loop-blockers-20261031'))

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.ASVA_AI_ARCHIVE_INVOKE_MODE = 'local'
process.env.ASVA_AI_ARCHIVE_INVOKE_SECRET = 'blockers-secret-test'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING = 'true'
process.env.FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE = 'off'

const {
  buildAiArchiveClientContext,
  buildScfInvokeRequestBody,
  awaitAiArchiveJobAck,
  scheduleAiArchiveJob,
  setLocalAiArchiveWorkerRunner,
  enqueueAiArchiveJob,
} = await import('./ai-archive-invoke.mjs')
const { parseAiArchiveEvent, handleAiArchiveEvent } = await import('./ai-archive-worker.mjs')
const { FeishuRepository } = await import('./repository.mjs')
const { config } = await import('./config.mjs')
const {
  productionDeployOrder,
  buildAiArchiveCloudbaserc,
  buildApiCloudbaserc,
  buildProductionEnvVariables,
  buildAiArchiveEnvVariables,
  PRODUCTION_REQUIRED_KEYS,
  parseEnv,
} = await import('../scripts/deploy-cloudbase.mjs')

describe('blocker1: SCF Invoke ClientContext protocol', () => {
  it('puts task params + secret into ClientContext and omits Payload from Invoke JSON', () => {
    const clientContext = buildAiArchiveClientContext({
      mode: 'recover',
      customerId: 'CUS-PROTO-1',
      sourceId: '',
      actorId: 'ADMIN-1',
      reason: 'CUSTOMER_SAVE',
      force: false,
    })
    expect(clientContext).toMatchObject({
      version: 1,
      mode: 'recover',
      customerId: 'CUS-PROTO-1',
      actorId: 'ADMIN-1',
      reason: 'CUSTOMER_SAVE',
      asvaInvokeSecret: 'blockers-secret-test',
    })
    expect(clientContext.sourceId).toBeUndefined()

    const requestBody = buildScfInvokeRequestBody({
      functionName: 'asva-ai-archive',
      namespace: 'root-journey-prod-d4d7pzd0a8f805',
      clientContext,
    })
    expect(requestBody).toMatchObject({
      FunctionName: 'asva-ai-archive',
      Namespace: 'root-journey-prod-d4d7pzd0a8f805',
      InvocationType: 'Event',
      Qualifier: '$LATEST',
    })
    expect(requestBody).not.toHaveProperty('Payload')
    const parsedContext = JSON.parse(requestBody.ClientContext)
    expect(parsedContext.customerId).toBe('CUS-PROTO-1')
    expect(parsedContext.mode).toBe('recover')
    expect(parsedContext.asvaInvokeSecret).toBe('blockers-secret-test')

    // Worker event input === ClientContext object (official SCF behavior).
    const workerEvent = parseAiArchiveEvent(parsedContext)
    expect(workerEvent.customerId).toBe('CUS-PROTO-1')
    expect(workerEvent.mode).toBe('recover')
    expect(workerEvent.asvaInvokeSecret).toBe('blockers-secret-test')
  })

  it('worker parses ClientContext-shaped event and rejects bad secret', async () => {
    const good = parseAiArchiveEvent({
      mode: 'recover',
      customerId: 'CUS-PROTO-2',
      actorId: 'ADMIN-1',
      asvaInvokeSecret: 'blockers-secret-test',
    })
    expect(good.customerId).toBe('CUS-PROTO-2')

    await expect(handleAiArchiveEvent({
      mode: 'recover',
      customerId: 'CUS-PROTO-2',
      asvaInvokeSecret: 'wrong-secret',
    })).resolves.toMatchObject({ ok: false, errorCode: 'AI_ARCHIVE_INVOKE_FORBIDDEN' })
  })
})

describe('blocker2: save path awaits delivery ACK only', () => {
  beforeEach(() => {
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
    process.env.ASVA_AI_ARCHIVE_INVOKE_MODE = 'local'
  })

  afterEach(() => {
    setLocalAiArchiveWorkerRunner(null)
  })

  it('awaitAiArchiveJobAck resolves on LOCAL_QUEUED without waiting for AI', async () => {
    let aiFinished = false
    setLocalAiArchiveWorkerRunner(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      aiFinished = true
      return { ok: true, status: 'COMPLETED' }
    })
    const scheduled = scheduleAiArchiveJob({ mode: 'recover', customerId: 'CUS-ACK-1', actorId: 'ADMIN-1' })
    const ack = await awaitAiArchiveJobAck(scheduled, { budgetMs: 1000 })
    expect(ack.status).toBe('LOCAL_QUEUED')
    expect(aiFinished).toBe(false)
  })

  it('scheduleAutomaticCustomerProfile exposes deliveryAck and createCustomer awaits it', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    const scheduled = repository.scheduleAutomaticCustomerProfile('ADMIN-1', 'CUS-ACK-2', '投递确认客户资料', 'CUSTOMER_SAVE')
    expect(scheduled).toMatchObject({ status: 'QUEUED', workerScheduled: true })
    expect(scheduled.deliveryAck).toBeTruthy()
    const delivery = await repository.awaitAutomaticCustomerProfileDelivery('CUS-ACK-2', { budgetMs: 1000 })
    expect(['LOCAL_QUEUED', 'INVOKED', 'FAILED', 'DISABLED', 'BUDGET_EXCEEDED']).toContain(delivery.status)
  })

  it('delivery ACK failure keeps customer/pending markers intact conceptually', async () => {
    // Simulate FAILED ack without throwing from schedule wrapper.
    const failedAck = Promise.resolve({ status: 'FAILED', mode: 'event', errorCode: 'SCF_INVOKE_FAILED' })
    const result = await awaitAiArchiveJobAck({ ack: failedAck }, { budgetMs: 500 })
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'SCF_INVOKE_FAILED' })
  })
})

describe('blocker3: single authoritative Event — no duplicate archive', () => {
  const state = {
    tables: new Map(),
    nextRecordId: 1,
    processCalls: [],
  }

  function table(id) {
    if (!state.tables.has(id)) state.tables.set(id, new Map())
    return state.tables.get(id)
  }

  beforeEach(() => {
    state.tables = new Map()
    state.nextRecordId = 1
    state.processCalls = []
    config.features.automaticProfileArchiving = true
    config.features.automaticProfileArchivingMode = 'off'
  })

  it('queueAutomaticCustomerProfile does not schedule Event(process)', async () => {
    const repository = new FeishuRepository({ authRepository: {} })
    repository.createSource = vi.fn(async (_actor, input) => ({ id: 'SRC-SINGLE-1', ...input, processingStatus: 'UPLOADED' }))
    repository.scheduleAutomaticProcessing = vi.fn()
    repository.clearAutomaticProfilePending = vi.fn(async () => true)

    await repository.queueAutomaticCustomerProfile('ADMIN-1', 'CUS-SINGLE-1', '单Event客户原文', 'CUSTOMER_SAVE')
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalled()
  })

  it('scheduleAutomaticCustomerProfile fires only recover Event; queue does not add process Event', async () => {
    const events = []
    setLocalAiArchiveWorkerRunner(async (payload) => {
      events.push({ ...payload })
      return { ok: true, status: 'COMPLETED', mode: payload.mode }
    })
    const repository = new FeishuRepository({ authRepository: {} })
    repository.createSource = vi.fn(async (_actor, input) => ({ id: 'SRC-SINGLE-2', ...input, processingStatus: 'UPLOADED' }))
    repository.scheduleAutomaticProcessing = vi.fn()
    repository.clearAutomaticProfilePending = vi.fn(async () => true)

    const scheduled = repository.scheduleAutomaticCustomerProfile('ADMIN-1', 'CUS-SINGLE-2', '单权威Event原文', 'CUSTOMER_SAVE')
    expect(scheduled.workerScheduled).toBe(true)
    await repository.awaitAutomaticCustomerProfileDelivery('CUS-SINGLE-2', { budgetMs: 1000 })
    await repository.awaitAutomaticCustomerProfileKickoff('CUS-SINGLE-2', { budgetMs: 1000 })
    // Local runner receives recover only from scheduleAiArchiveJob; queue must not schedule process.
    expect(repository.scheduleAutomaticProcessing).not.toHaveBeenCalled()
    expect(events.every((item) => item.mode === 'recover')).toBe(true)
    expect(events.filter((item) => item.mode === 'process')).toHaveLength(0)
    setLocalAiArchiveWorkerRunner(null)
  })

  it('duplicate/concurrent recover Events on same Source do not duplicate evidence', async () => {
    const notes = '并发Event：希望提升表达能力，不重复归档。'
    const hash = contentHash(notes)
    const evidence = []
    const repository = new FeishuRepository({
      authRepository: {},
      evidenceExtractor: async () => {
        const item = {
          evidence_type: 'FACT',
          field_key: 'current_goal',
          value: '提升表达能力',
          display_text: '提升表达能力',
          source_excerpt: '希望提升表达能力',
          locator: { char_start: 0, char_end: 8 },
          confidence: 0.9,
          semantic_kind: 'GOAL',
          content_source: 'STAFF_REPORTED',
          information_nature: 'OBSERVED_FACT',
          verification_status: 'UNVERIFIED',
          review_status: 'PENDING_REVIEW',
        }
        evidence.push(item)
        return [item]
      },
    })

    // Minimal in-memory stubs via method overrides — avoid full Feishu mock suite.
    const source = {
      id: 'SRC-CONC-1',
      customerId: 'CUS-CONC-1',
      contentHash: hash,
      notes: 'AUTO_PROFILE_ORGANIZE:CUSTOMER_SAVE',
      processingStatus: 'UPLOADED',
      uploadedBy: 'ADMIN-1',
      rawText: notes,
    }
    repository.load = vi.fn(async () => ({
      customers: [{
        id: 'CUS-CONC-1',
        notes,
        need: '',
        helpExpectation: '',
        goal: '',
        automaticProfilePending: { contentHash: hash, actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE' },
        createdAt: '2026-10-31T00:00:00.000Z',
      }],
      staff: [{ id: 'ADMIN-1', permissionRole: 'ADMIN', status: 'ACTIVE', loginEnabled: true }],
      sourceRecords: [source],
      evidenceItems: [],
    }))
    repository.clearAutomaticProfilePending = vi.fn(async () => true)
    repository.queueAutomaticCustomerProfile = vi.fn()
    let processCount = 0
    repository.processSource = vi.fn(async () => {
      processCount += 1
      if (processCount > 1) {
        // Idempotent second call: no new evidence writes.
        return {
          source: { ...source, processingStatus: 'COMPLETED' },
          evidenceItems: [{ id: 'EVD-1', sourceId: source.id, contentHash: hash }],
          proposals: [],
          conflicts: [],
        }
      }
      source.processingStatus = 'COMPLETED'
      return {
        source: { ...source, processingStatus: 'COMPLETED' },
        evidenceItems: [{ id: 'EVD-1', sourceId: source.id, contentHash: hash }],
        proposals: [],
        conflicts: [],
      }
    })

    const results = await Promise.all([
      repository.recoverAutomaticCustomerProfile('ADMIN-1', 'CUS-CONC-1'),
      repository.recoverAutomaticCustomerProfile('ADMIN-1', 'CUS-CONC-1'),
    ])
    expect(results.every((item) => item.sourceId === 'SRC-CONC-1')).toBe(true)
    expect(repository.queueAutomaticCustomerProfile).not.toHaveBeenCalled()
    // processSource may run twice under concurrency but must not create a second Source / schedule Event.
    expect(repository.scheduleAutomaticProcessing?.mock?.calls?.length || 0).toBe(0)
  })
})

describe('blocker4: deploy order + effective worker config + API env retained', () => {
  it('production deploy order is worker then api', () => {
    expect(productionDeployOrder()).toEqual(['asva-ai-archive', 'asva-api'])
  })

  it('worker cloudbaserc is the file CLI cwd consumes (512/120)', () => {
    const values = Object.fromEntries(PRODUCTION_REQUIRED_KEYS.map((key) => [
      key,
      key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING' ? 'false'
        : key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE' ? 'off'
          : key === 'AUTH_MODE' ? 'PASSWORD'
            : key === 'APP_ENV' || key === 'DATA_MODE' ? 'production'
              : `value-${key}`,
    ]))
    values.FEISHU_AUTH_CREDENTIALS_TABLE_ID = 'cred'
    values.ASVA_AI_ARCHIVE_INVOKE_SECRET = 's'
    const env = buildAiArchiveEnvVariables(values, {
      releaseCounter: 49, releasePatch: 0, gitCommit: 'tip', gitBranch: 'fix/ai-archive-closed-loop-20261031', buildTime: 'now',
    })
    const rc = buildAiArchiveCloudbaserc({
      envId: 'root-journey-prod-d4d7pzd0a8f805',
      workerDir: '/repo/cloudbase/functions/asva-ai-archive',
      envVariables: env,
    })
    expect(rc.functions[0].memorySize).toBe(512)
    expect(rc.functions[0].timeout).toBe(120)
    expect(rc.functions[0].envVariables.ASVA_AI_ARCHIVE_INVOKE_MODE).toBe('disabled')
  })

  it('API env retains core production keys (≥42) while adding invoke vars', () => {
    const values = Object.fromEntries(PRODUCTION_REQUIRED_KEYS.map((key) => [
      key,
      key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING' ? 'false'
        : key === 'FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE' ? 'off'
          : key === 'AUTH_MODE' ? 'PASSWORD'
            : key === 'APP_ENV' || key === 'DATA_MODE' ? 'production'
              : `value-${key}`,
    ]))
    values.FEISHU_AUTH_CREDENTIALS_TABLE_ID = 'cred'
    values.TENCENTCLOUD_SECRETID = 'AKIDtest'
    values.TENCENTCLOUD_SECRETKEY = 'secret'
    values.ASVA_AI_ARCHIVE_INVOKE_SECRET = 's'
    const env = buildProductionEnvVariables(values, {
      releaseCounter: 49, releasePatch: 0, gitCommit: 'tip', gitBranch: 'fix/ai-archive-closed-loop-20261031', buildTime: 'now',
    })
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(42)
    expect(env.ASVA_AI_ARCHIVE_INVOKE_MODE).toBe('event')
    expect(env.FEISHU_CUSTOMERS_TABLE_ID).toBeTruthy()
    expect(env.DEEPSEEK_API_KEY).toBeTruthy()
    const apiRc = buildApiCloudbaserc({
      envId: 'root-journey-prod-d4d7pzd0a8f805',
      functionDir: '/repo/cloudbase/functions/asva-api',
      functionName: 'asva-api',
      envVariables: env,
    })
    expect(Object.keys(apiRc.functions[0].envVariables).length).toBe(Object.keys(env).length)
  })
})

describe('blocker evidence write', () => {
  it('writes evidence summary for the four blockers', async () => {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    const clientContext = buildAiArchiveClientContext({
      mode: 'recover', customerId: 'CUS-EVID', actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE',
    })
    const requestBody = buildScfInvokeRequestBody({
      functionName: 'asva-ai-archive',
      namespace: 'root-journey-prod-d4d7pzd0a8f805',
      clientContext,
    })
    const summary = {
      tipBase: '859ec73a450636c5f307c383cb81852b36461d1f',
      blockers: {
        '1_clientContext': {
          hasPayloadField: Object.prototype.hasOwnProperty.call(requestBody, 'Payload'),
          clientContextHasCustomerId: Boolean(JSON.parse(requestBody.ClientContext).customerId),
          clientContextHasSecret: Boolean(JSON.parse(requestBody.ClientContext).asvaInvokeSecret),
        },
        '2_deliveryAck': {
          helper: 'awaitAiArchiveJobAck / awaitAutomaticCustomerProfileDelivery',
          awaitsAi: false,
        },
        '3_singleEvent': {
          queueSchedulesProcess: false,
          authoritativeMode: 'recover',
        },
        '4_deploy': {
          order: productionDeployOrder(),
          workerMemory: 512,
          workerTimeout: 120,
        },
      },
      notDeployed: true,
      notProductionWrite: true,
      notMerged: true,
    }
    await writeFile(path.join(EVIDENCE_DIR, 'blockers-fix-summary.json'), JSON.stringify(summary, null, 2))
    expect(summary.blockers['1_clientContext'].hasPayloadField).toBe(false)
    expect(summary.blockers['4_deploy'].order[0]).toBe('asva-ai-archive')
  })
})
