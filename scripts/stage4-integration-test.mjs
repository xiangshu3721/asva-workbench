import assert from 'node:assert/strict'
import { buildCustomerUnderstandingContext, createLocalCustomerUnderstanding, qualityCheckCustomerUnderstanding, understandingInputFingerprint } from '../shared/customer-understanding.mjs'

const customer = { id: `STAGE4_IT_${Date.now()}`, profileVersion: 1, need: '希望稳定工作节奏', helpExpectation: '找到可执行的一步', profileFields: { city: '杭州', current_goal: '稳定工作节奏' } }
const evidenceItems = [
  { id: 'IT-EVD-1', sourceId: 'IT-SRC-1', customerId: customer.id, evidenceType: 'FACT', semanticKind: 'GOAL', fieldKey: 'current_goal', standardValue: '稳定工作节奏', displayText: '当前希望稳定工作节奏', sourceExcerpt: '我想先把工作节奏稳定下来', confidence: 0.95, reviewStatus: 'CONFIRMED' },
  { id: 'IT-EVD-2', sourceId: 'IT-SRC-1', customerId: customer.id, evidenceType: 'SELF_MEANING', semanticKind: 'NEED', fieldKey: 'current_expectation', standardValue: '可执行的一步', displayText: '希望找到可执行的一步', sourceExcerpt: '我希望这次能找到下一步', confidence: 0.9, reviewStatus: 'CONFIRMED' },
  { id: 'IT-EVD-HYP', sourceId: 'IT-SRC-1', customerId: customer.id, evidenceType: 'HYPOTHESIS', semanticKind: 'OTHER', fieldKey: '', standardValue: '', displayText: '可能存在未确认的解释', sourceExcerpt: '仅为假设', confidence: 0.4, reviewStatus: 'CONFIRMED' },
]
const context = buildCustomerUnderstandingContext({ customer, evidenceItems })
assert.equal(context.current_snapshot.phone, undefined)
assert.equal(context.working_hypotheses.length, 1)
const result = createLocalCustomerUnderstanding(context)
const quality = qualityCheckCustomerUnderstanding(result, { evidenceIds: context.evidence_refs.map((item) => item.evidence_id) })
assert.equal(quality.ok, true)
assert.equal(understandingInputFingerprint({ customer, evidenceItems }), context.input_fingerprint)
console.log(JSON.stringify({ STAGE4_IT: 'PASS', context_evidence_count: context.evidence_refs.length, quality: 'PASS', production_write: 'NO' }))
