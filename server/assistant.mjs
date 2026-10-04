import { createQueryUnderstanding } from './deepseek.mjs'
import { BUSINESS_GLOSSARY, DIMENSION_REGISTRY, ENTITY_REGISTRY, METRIC_REGISTRY, RELATIONSHIP_GRAPH, SCHEMA_REGISTRY, DateResolver, EntityResolver, QueryCompiler, QueryPlanner, executeSemanticQuery } from '../shared/semantic-engine.mjs'

function semanticQuestion(question, understanding) {
  if (!understanding) return question
  const pieces = [question]
  if (understanding.time_range_label) pieces.push(understanding.time_range_label)
  if (understanding.operation === 'GROUP_AGGREGATE' && understanding.dimensions[0]) pieces.push(`按${DIMENSION_REGISTRY[understanding.dimensions[0]]?.aliases?.[0] || understanding.dimensions[0]}分`)
  if (understanding.operation === 'RANK' && understanding.dimensions[0]) pieces.push(DIMENSION_REGISTRY[understanding.dimensions[0]]?.aliases?.[0] || understanding.dimensions[0])
  if (understanding.operation === 'RANK') pieces.push('排名')
  if (understanding.operation === 'TREND') pieces.push('趋势')
  if (understanding.operation === 'COMPARE') pieces.push('对比')
  if (understanding.metrics[0]) pieces.push(METRIC_REGISTRY[understanding.metrics[0]]?.aliases?.[0] || understanding.metrics[0])
  if (understanding.filters.some((item) => item.field === 'payment_status' && item.value === 'PAID')) pieces.push('只看付费')
  return pieces.join(' ')
}

export async function queryAssistant(database, question, context = {}, actorId = 'server-admin') {
  let understanding = null
  try { understanding = await createQueryUnderstanding(question) } catch { understanding = null }
  return executeSemanticQuery(database, semanticQuestion(question, understanding), { ...context, semantic_hint: understanding || undefined }, actorId)
}

export { BUSINESS_GLOSSARY, DIMENSION_REGISTRY, ENTITY_REGISTRY, METRIC_REGISTRY, RELATIONSHIP_GRAPH, SCHEMA_REGISTRY, DateResolver, EntityResolver, QueryCompiler, QueryPlanner }
