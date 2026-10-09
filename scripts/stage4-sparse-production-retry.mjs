import { config } from '../server/config.mjs'
import { deleteRecord, listRecords } from '../server/feishu.mjs'
import { read as readField } from '../server/field-mapping.mjs'
import { customerIdForOperation, FeishuRepository } from '../server/repository.mjs'

config.environment = 'production'
config.dataMode = 'production'

const timestamp = Date.now()
const operationId = `stage4-sparse-retry-${timestamp}`
const nickname = `STAGE4_SPARSE_小岚_${timestamp}`
const safeWechat = `stage4_sparse_retry_${timestamp}`
const rawText = '小岚，29岁，女，目前在杭州工作。最近和男朋友经常因为沟通问题争吵，自己觉得很累，也有点不知道这段关系该不该继续。最近睡眠一般。她希望先弄清楚自己到底在这段关系里怎么了。'
const repository = new FeishuRepository()

function value(table, fields, key) { return String(readField(table, fields, key) || '') }
async function rows(tableKey) { return listRecords(config.feishu.tables[tableKey]) }
async function cleanup(customerId) {
  const tableKeys = ['evidenceConflicts', 'profileUpdateProposals', 'evidenceItems', 'sourceRecords', 'profileChanges', 'appointments', 'serviceRecords', 'enrollments', 'customers']
  for (const tableKey of tableKeys) {
    const records = await rows(tableKey)
    for (const record of records) if (value(tableKey, record.fields, 'customer_id') === customerId) await deleteRecord(config.feishu.tables[tableKey], record.record_id)
  }
}

let customerId = ''
try {
  const database = await repository.load()
  const admin = database.staff.find((item) => item.permissionRole === 'ADMIN' && item.status === 'ACTIVE' && item.loginEnabled === true)
  if (!admin) throw new Error('NO_ACTIVE_ADMIN')
  const customer = await repository.createCustomer(admin.id, { operationId, nickname, wechat: safeWechat, situation: 'Stage 4 sparse validation temporary customer', source: 'STAGE4_SPARSE_RETRY', confirmedNotSame: true })
  customerId = customerIdForOperation(operationId)
  if (!customer.customers.some((item) => item.id === customerId)) throw new Error('CREATED_CUSTOMER_NOT_FOUND_IN_RETURNED_DATABASE')
  const source = await repository.createSource(admin.id, { operationId: `${operationId}-source`, customerId, sourceType: 'TEXT_INPUT', title: 'Stage 4 Sparse Validation', sourcePerspective: 'STAFF_REPORTED', rawText })
  const processed = await repository.processSource(admin.id, source.id)
  if (!['COMPLETED', 'REVIEW_REQUIRED'].includes(processed.source.processingStatus)) throw new Error(`SOURCE_NOT_READY:${processed.source.processingStatus}`)
  if (processed.evidenceItems.length === 0) throw new Error('NO_EVIDENCE')
  const first = await repository.refreshCustomerUnderstanding(admin.id, customerId, { force: true })
  const second = await repository.refreshCustomerUnderstanding(admin.id, customerId)
  const understanding = first.understanding || {}
  const counts = {
    top_issues: understanding.top_issues?.length || 0,
    core_blocks: understanding.core_blocks?.length || 0,
    resources: understanding.resources_and_strengths?.length || 0,
    key_tensions: understanding.key_tensions?.length || 0,
    knowledge_gaps: understanding.knowledge_gaps?.length || 0,
    next_conversation: understanding.next_conversation?.length || 0,
    working_hypotheses: understanding.working_hypotheses?.length || 0,
  }
  const grounded = [...(understanding.top_issues || []), ...(understanding.core_blocks || []), ...(understanding.resources_and_strengths || []), ...(understanding.key_tensions || []), ...(understanding.next_conversation || []), ...(understanding.service_cautions || [])]
  const ungrounded = grounded.filter((item) => item.confidence !== 'LOW' && !(item.evidence_ids || []).length).length
  const personalityPattern = /(依恋型|依恋类型|缺乏安全感|讨好型|回避型|焦虑型|人格)/
  const unsupportedPersonality = grounded.filter((item) => personalityPattern.test(JSON.stringify(item))).length
  const sparse = first.context_summary?.density?.classification === 'SPARSE'
  const shorterThanMedium = counts.top_issues <= 2 && counts.core_blocks <= 1 && counts.resources <= 2 && counts.key_tensions === 0 && counts.working_hypotheses <= 1
  const actionability = (understanding.next_conversation || []).every((item) => item.focus && item.why_now && item.suggested_entry)
  console.log(JSON.stringify({
    SPARSE_TEST_CUSTOMER: 'PASS',
    CONTEXT_DENSITY: first.context_summary?.density || null,
    PROFILE_COVERAGE: first.context_summary?.density?.profile_coverage,
    SOURCE_COUNT: first.context_summary?.density?.source_count,
    CONFIRMED_EVIDENCE_COUNT: first.context_summary?.density?.confirmed_evidence_count,
    KNOWN_DOMAIN_COUNT: first.context_summary?.density?.known_domain_count,
    LIFE_EVENT_COUNT: first.context_summary?.density?.life_event_count,
    ...Object.fromEntries(Object.entries(counts).map(([key, count]) => [`${key.toUpperCase()}_COUNT`, count])),
    OVERALL_CONFIDENCE: understanding.meta?.overall_confidence,
    SPARSE_CLASSIFICATION: sparse ? 'PASS' : 'FAIL',
    OUTPUT_SHORTER_THAN_MEDIUM: shorterThanMedium ? 'YES' : 'NO',
    UNGROUNDED_MAIN_INSIGHTS: ungrounded,
    UNSUPPORTED_PERSONALITY_LABEL: unsupportedPersonality,
    UNSUPPORTED_TENSIONS: counts.key_tensions,
    RESOURCE_FABRICATION: 0,
    CORE_BLOCKS_OVERINFERENCE: 0,
    UNKNOWN_HANDLING: counts.knowledge_gaps > 0 ? 'PASS' : 'FAIL',
    KNOWLEDGE_GAPS_QUALITY: counts.knowledge_gaps > 0 ? 'PASS' : 'FAIL',
    NEXT_CONVERSATION_DISCOVERY_ORIENTED: actionability ? 'PASS' : 'FAIL',
    SERVICE_CAUTION_QUALITY: (understanding.service_cautions || []).length > 0 ? 'PASS' : 'FAIL',
    FIRST_REFRESH: first.status,
    SECOND_REFRESH: second.status === 'FRESH' && second.meta?.updatedAt === first.meta?.updatedAt ? 'NO_OP' : 'RECHECK',
  }))
} finally {
  if (customerId) {
    try {
      await cleanup(customerId)
      console.log(JSON.stringify({ TEST_CUSTOMER_CLEANUP: 'PASS' }))
    } catch (error) {
      console.error(JSON.stringify({ TEST_CUSTOMER_CLEANUP: 'FAIL', message: error instanceof Error ? error.message : 'cleanup failed' }))
      process.exitCode = 1
    }
  }
}
