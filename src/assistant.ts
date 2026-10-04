import type { AssistantQueryContext, AssistantQueryResult } from './clientApi'
// The browser and HTTP server intentionally use the same semantic engine.
// @ts-expect-error The shared .mjs module is bundled by Vite and executed by Node on the server.
import { executeSemanticQuery } from '../shared/semantic-engine.mjs'
import type { Database } from './domain'

// @ts-ignore Shared JS exports are intentionally treated as runtime-only in the browser build.
export { BUSINESS_GLOSSARY, DIMENSION_REGISTRY, ENTITY_REGISTRY, METRIC_REGISTRY, RELATIONSHIP_GRAPH, SCHEMA_REGISTRY, DateResolver, EntityResolver, QueryCompiler, QueryPlanner } from '../shared/semantic-engine.mjs'

export function queryLocalAssistant(database: Database, question: string, context: AssistantQueryContext = {}, actorId = 'local-admin'): AssistantQueryResult {
  return executeSemanticQuery(database, question, context, actorId) as AssistantQueryResult
}
