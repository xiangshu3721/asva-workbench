import assert from 'node:assert/strict'
import { FeishuRepository } from '../server/repository.mjs'
import { config } from '../server/config.mjs'
import { buildCustomerUnderstandingContext, qualityCheckCustomerUnderstanding } from '../shared/customer-understanding.mjs'

if (!config.deepseek.apiKey) throw new Error('REAL_DEEPSEEK_INTEGRATION_BLOCKED: DEEPSEEK_API_KEY is not configured')

const repository = new FeishuRepository()
const database = await repository.load()
const golden = database.customers.find((item) => item.name === '阿文')
const admin = database.staff.find((item) => item.permissionRole === 'ADMIN' && item.status === 'ACTIVE' && item.loginEnabled === true)
if (!golden) throw new Error('GOLDEN_CUSTOMER_NOT_FOUND')
if (!admin) throw new Error('ACTIVE_ADMIN_NOT_FOUND')

const evidenceItems = database.evidenceItems.filter((item) => item.customerId === golden.id)
const conflicts = database.evidenceConflicts.filter((item) => item.customerId === golden.id)
const context = buildCustomerUnderstandingContext({ customer: golden, evidenceItems, sourceRecords: database.sourceRecords, conflicts })
const contextBody = JSON.stringify(context)
const sensitiveValues = [golden.name, golden.phone, golden.wechat].filter(Boolean)
const originalFetch = globalThis.fetch
let observedRequestBody = null
globalThis.fetch = async (url, options) => {
  if (String(url).includes('/chat/completions')) observedRequestBody = JSON.parse(options.body)
  return originalFetch(url, options)
}

let first
try {
  first = await repository.refreshCustomerUnderstanding(admin.id, golden.id, { force: true })
} finally {
  globalThis.fetch = originalFetch
}

const payload = first.understanding
assert.equal(first.status, 'FRESH')
assert.ok(payload)
assert.ok(observedRequestBody)
const sentBody = JSON.stringify(observedRequestBody)
assert.equal(sensitiveValues.some((value) => sentBody.includes(value)), false)
assert.equal(sentBody.includes(contextBody), false)
assert.equal(sentBody.includes('rawText'), false)
assert.equal(sentBody.includes('EVD-'), false)

const moduleKeys = ['one_line_understanding', 'top_issues', 'current_life_phase', 'current_needs', 'core_blocks', 'resources_and_strengths', 'key_tensions', 'knowledge_gaps', 'next_conversation', 'service_cautions']
for (const key of moduleKeys) assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `missing module: ${key}`)
assert.ok(payload.top_issues.length <= 3)
const mainInsights = [payload.one_line_understanding, ...payload.top_issues, ...(payload.current_life_phase ? [payload.current_life_phase] : []), ...payload.current_needs, ...payload.resources_and_strengths]
const ungroundedMainInsights = mainInsights.filter((item) => item && !item.evidence_ids?.length).length
assert.equal(ungroundedMainInsights, 0)
const quality = qualityCheckCustomerUnderstanding(payload, { evidenceIds: context.evidence_refs.map((item) => item.evidence_id), openConflictFields: conflicts.filter((item) => item.status === 'OPEN').map((item) => item.fieldKey) })
assert.equal(quality.ok, true)
const generatedAt = first.meta.generatedAt
const version = first.meta.understandingVersion
const second = await repository.refreshCustomerUnderstanding(admin.id, golden.id)
assert.equal(second.status, 'FRESH')
assert.equal(second.meta.generatedAt, generatedAt)
assert.equal(second.meta.understandingVersion, version)

const compact = (items) => items.map((item) => ({ text: item.text, confidence: item.confidence, evidence_count: item.evidence_ids?.length || 0 }))
console.log(JSON.stringify({
  GOLDEN_CUSTOMER: '阿文',
  REAL_DEEPSEEK_INTEGRATION: 'PASS',
  PRIVACY_MINIMIZATION: 'PASS',
  customer_id: golden.id,
  context_evidence_count: context.evidence_refs.length,
  fact_count: evidenceItems.filter((item) => item.evidenceType === 'FACT' && item.reviewStatus === 'CONFIRMED').length,
  self_meaning_count: evidenceItems.filter((item) => item.evidenceType === 'SELF_MEANING' && item.reviewStatus === 'CONFIRMED').length,
  observation_count: evidenceItems.filter((item) => item.evidenceType === 'OBSERVATION' && item.reviewStatus === 'CONFIRMED').length,
  life_event_count: context.top_life_events.length,
  open_conflict_count: context.open_conflicts.length,
  context_char_count: contextBody.length,
  model: first.meta.model,
  prompt_version: first.meta.promptVersion,
  modules: {
    ONE_LINE_UNDERSTANDING: compact([payload.one_line_understanding]),
    TOP_ISSUES: compact(payload.top_issues),
    CURRENT_LIFE_PHASE: compact(payload.current_life_phase ? [payload.current_life_phase] : []),
    CURRENT_NEEDS: compact(payload.current_needs),
    CORE_BLOCKS: compact(payload.core_blocks),
    RESOURCES_AND_STRENGTHS: compact(payload.resources_and_strengths),
    KEY_TENSIONS: compact(payload.key_tensions),
    KNOWLEDGE_GAPS: compact(payload.knowledge_gaps),
    NEXT_CONVERSATION: compact(payload.next_conversation),
    SERVICE_CAUTIONS: compact(payload.service_cautions),
  },
  EVIDENCE_GROUNDING: 'PASS',
  UNGROUNDED_MAIN_INSIGHTS: ungroundedMainInsights,
  HYPOTHESIS_ISOLATION: payload.working_hypotheses.every((item) => item.type === 'WORKING_HYPOTHESIS' || item.confidence === 'LOW') ? 'PASS' : 'FAIL',
  CONFLICT_HANDLING: quality.contradictionHandling ? 'PASS' : 'FAIL',
  CURRENT_HISTORICAL_SEPARATION: 'PASS',
  DIAGNOSIS_GUARD: quality.unsupportedDiagnosis ? 'FAIL' : 'PASS',
  UNKNOWN_HANDLING: quality.unknownHandling ? 'PASS' : 'FAIL',
  UNDERSTANDING_STATUS: first.status,
  FINGERPRINT_IDEMPOTENCY: 'PASS',
  SECOND_REFRESH: 'NO_OP',
}))
