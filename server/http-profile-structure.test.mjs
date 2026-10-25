import { once } from 'node:events'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { materializeCustomerProfile } from '../shared/profile-materialization.mjs'

process.env.APP_ENV = 'mock'
process.env.ASVA_ENVIRONMENT = 'mock'
process.env.DATA_MODE = 'mock'
process.env.HOST = '127.0.0.1'
process.env.PORT = '0'
process.env.ASVA_FRONTEND_ORIGIN = 'https://xiangshu3721.github.io'
process.env.FEISHU_SOURCE_RECORDS_TABLE_ID ||= 'tbl-http-structure-source'
process.env.FEISHU_EVIDENCE_ITEMS_TABLE_ID ||= 'tbl-http-structure-evidence'
process.env.FEISHU_PROFILE_UPDATE_PROPOSALS_TABLE_ID ||= 'tbl-http-structure-proposal'
process.env.FEISHU_EVIDENCE_CONFLICTS_TABLE_ID ||= 'tbl-http-structure-conflict'

const state = vi.hoisted(() => ({ repository: null }))

function simpleHash(value) {
  let hash = 2166136261
  for (const character of String(value)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

class SyntheticRepository {
  constructor() {
    this.customer = {
      id: 'CUS-STRUCTURE-HTTP',
      name: '合成客户A',
      mentorId: 'MENTOR-STRUCTURE',
      profileFields: {},
      profileFieldMeta: {},
      notes: '29岁，女性，在杭州工作。最近经常和男朋友吵架，感觉很累，睡眠一般，不确定这段关系是否应该继续。想做自己感兴趣的事业。',
    }
    this.sources = []
    this.evidenceItems = []
    this.proposals = []
    this.conflicts = []
    state.repository = this
  }

  assertAccess(actorId, customerId = this.customer.id) {
    if (actorId !== 'MENTOR-STRUCTURE' || customerId !== this.customer.id) throw Object.assign(new Error('客户不存在或无权访问'), { code: 'CUSTOMER_NOT_FOUND', status: 404 })
  }

  staff(staffId) { return { id: staffId, name: '合成导师', permissionRole: 'MENTOR', status: 'ACTIVE', loginEnabled: true } }

  materialization() {
    return materializeCustomerProfile({ customer: this.customer, evidenceItems: this.evidenceItems })
  }

  sourceWorkspace(actorId, customerId) {
    this.assertAccess(actorId, customerId)
    return { sources: this.sources.map((source) => ({ ...source, rawText: undefined })), evidenceItems: this.evidenceItems, proposals: this.proposals, conflicts: this.conflicts, profileMaterialization: this.materialization() }
  }

  customerProfile(actorId, customerId) {
    this.assertAccess(actorId, customerId)
    return { customerId, profileFields: this.customer.profileFields, profileFieldMeta: this.customer.profileFieldMeta, profileMaterialization: this.materialization() }
  }

  createSource(actorId, input) {
    this.assertAccess(actorId, input.customerId)
    const contentHash = input.contentHash || simpleHash(input.rawText)
    const existing = this.sources.find((source) => source.customerId === input.customerId && source.contentHash === contentHash)
    if (existing) return existing
    const source = { id: `SRC-STRUCTURE-${this.sources.length + 1}`, sourceId: `SRC-STRUCTURE-${this.sources.length + 1}`, customerId: input.customerId, sourceType: input.sourceType, rawText: input.rawText, contentHash, processingStatus: 'UPLOADED', processingVersion: 1, lastBatchId: '' }
    this.sources.push(source)
    return source
  }

  sourceDetail(actorId, sourceId) {
    const source = this.sources.find((item) => item.id === sourceId)
    if (!source) throw new Error('资料不存在')
    this.assertAccess(actorId, source.customerId)
    return { source: { ...source, rawText: undefined }, evidenceItems: this.evidenceItems.filter((item) => item.sourceId === sourceId), proposals: this.proposals.filter((item) => item.sourceId === sourceId), conflicts: this.conflicts.filter((item) => item.sourceId === sourceId), profileMaterialization: this.materialization() }
  }

  processSource(actorId, sourceId) {
    const source = this.sources.find((item) => item.id === sourceId)
    if (!source) throw new Error('资料不存在')
    this.assertAccess(actorId, source.customerId)
    if (this.evidenceItems.some((item) => item.sourceId === sourceId)) return this.sourceDetail(actorId, sourceId)
    const batchId = `EXT-STRUCTURE-${sourceId}`
    const candidates = [
      ['age', 29, '年龄：29岁', '29岁'],
      ['gender', '女', '性别：女', '女性'],
      ['city', '杭州', '现居地：杭州', '在杭州工作'],
      ['relationship_status', '恋爱中', '亲密关系状态：恋爱中', '和男朋友吵架'],
      ['relationship_conflicts', '经常与伴侣争吵', '关系困扰：经常与伴侣争吵', '最近经常和男朋友吵架'],
      ['emotion_expression', '感觉很累', '情绪感受：感觉很累', '感觉很累'],
      ['sleep', '一般', '睡眠情况：一般', '睡眠一般'],
      ['current_core_issue', '不确定这段关系是否应该继续', '当前困扰：不确定这段关系是否应该继续', '不确定这段关系是否应该继续'],
      ['career_goal', '想做自己感兴趣的事业', '事业目标：想做自己感兴趣的事业', '想做自己感兴趣的事业'],
    ]
    for (const [index, [fieldKey, value, displayText, sourceExcerpt]] of candidates.entries()) {
      const evidence = { id: `EVD-STRUCTURE-${index + 1}`, sourceId, customerId: this.customer.id, fieldKey, standardValue: value, displayText, sourceExcerpt, evidenceType: 'FACT', semanticKind: ['relationship_status', 'relationship_conflicts'].includes(fieldKey) ? 'RELATIONSHIP' : fieldKey === 'career_goal' ? 'GOAL' : 'PROFILE_FIELD', contentSource: 'STAFF_TRANSCRIBED_CUSTOMER', informationNature: fieldKey === 'emotion_expression' || fieldKey === 'current_core_issue' ? 'PERSONAL_STATEMENT' : 'OBJECTIVE_RECORD', verificationStatus: 'SOURCE_SUPPORTED', reviewStatus: 'PENDING_REVIEW', extractionBatchId: batchId, confidence: 0.92, occurredAt: null }
      this.evidenceItems.push(evidence)
      this.proposals.push({ id: `PROP-STRUCTURE-${index + 1}`, customerId: this.customer.id, sourceId, evidenceId: evidence.id, fieldKey, proposedValue: value, reviewStatus: 'PENDING_REVIEW' })
    }
    source.processingStatus = 'COMPLETED'
    source.lastBatchId = batchId
    return this.sourceDetail(actorId, sourceId)
  }

  reviewProposal(actorId, proposalId, decision) {
    const proposal = this.proposals.find((item) => item.id === proposalId)
    if (!proposal) throw new Error('建议不存在')
    this.assertAccess(actorId, proposal.customerId)
    const evidence = this.evidenceItems.find((item) => item.id === proposal.evidenceId)
    if (decision === 'CONFIRM') {
      this.customer.profileFields[proposal.fieldKey] = proposal.proposedValue
      this.customer.profileFieldMeta[proposal.fieldKey] = { source: 'MENTOR_CONFIRMED', confirmed: true }
      evidence.reviewStatus = 'CONFIRMED'
      proposal.reviewStatus = 'CONFIRMED'
    }
    return this.sourceWorkspace(actorId, proposal.customerId)
  }
}

vi.mock('./repository.mjs', () => ({ FeishuRepository: SyntheticRepository }))

const { server } = await import('./index.mjs?http-profile-structure-test')
if (!server.listening) await once(server, 'listening')
const address = server.address()
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
const headers = { Origin: 'https://xiangshu3721.github.io', 'X-Staff-Id': 'MENTOR-STRUCTURE', 'Content-Type': 'application/json' }

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  const payload = await response.json()
  return { response, payload }
}

afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('isolated real HTTP structured profile pipeline', () => {
  it('persists deterministic AI evidence, exposes provisional items, confirms one item, and survives refresh', async () => {
    const customerId = 'CUS-STRUCTURE-HTTP'
    const rawText = state.repository.customer.notes
    const workspaceBefore = await request(`/api/customers/${customerId}/sources`)
    expect(workspaceBefore.response.status).toBe(200)
    expect(workspaceBefore.payload.sources).toHaveLength(0)

    const created = await request('/api/sources', { method: 'POST', body: JSON.stringify({ customerId, sourceType: 'TEXT_INPUT', rawText, operationId: 'profile-notes-structure-1', sourcePerspective: 'STAFF_REPORTED', dialogueConfirmation: '' }) })
    expect(created.response.status).toBe(201)
    const processed = await request(`/api/sources/${created.payload.id}/process`, { method: 'POST', body: JSON.stringify({}) })
    expect(processed.response.status).toBe(200)
    expect(processed.payload.evidenceItems).toHaveLength(9)
    expect(processed.payload.evidenceItems.every((item) => item.reviewStatus === 'PENDING_REVIEW')).toBe(true)

    const pendingProfile = await request(`/api/customers/${customerId}/profile`)
    expect(pendingProfile.response.status).toBe(200)
    expect(pendingProfile.payload.profileMaterialization.provisionalItems).toHaveLength(9)
    expect(pendingProfile.payload.profileMaterialization.provisionalItems[0].basis[0].excerpt).toBe('29岁')
    expect(pendingProfile.payload.profileMaterialization.provisionalItems.some((item) => item.sectionTitle === '家庭与关系')).toBe(true)

    const repeatedSource = await request('/api/sources', { method: 'POST', body: JSON.stringify({ customerId, sourceType: 'TEXT_INPUT', rawText, operationId: 'profile-notes-structure-1-retry', sourcePerspective: 'STAFF_REPORTED', dialogueConfirmation: '' }) })
    const repeatedProcess = await request(`/api/sources/${repeatedSource.payload.id}/process`, { method: 'POST', body: JSON.stringify({}) })
    expect(repeatedSource.payload.id).toBe(created.payload.id)
    expect(repeatedProcess.payload.evidenceItems).toHaveLength(9)
    expect(state.repository.sources).toHaveLength(1)
    expect(state.repository.evidenceItems).toHaveLength(9)

    const confirmed = await request('/api/profile-proposals/PROP-STRUCTURE-1/review', { method: 'POST', body: JSON.stringify({ decision: 'CONFIRM' }) })
    expect(confirmed.response.status).toBe(200)
    expect(confirmed.payload.profileMaterialization.sections.flatMap((section) => section.items).find((item) => item.label === '年龄')).toMatchObject({ text: '29', statusLabel: '人工已确认' })

    const refreshed = await request(`/api/customers/${customerId}/profile`)
    expect(refreshed.response.status).toBe(200)
    expect(refreshed.payload.profileMaterialization.provisionalItems).toHaveLength(8)
    expect(refreshed.payload.profileMaterialization.sections.flatMap((section) => section.items).some((item) => item.label === '年龄' && item.text === '29')).toBe(true)
  })
})
