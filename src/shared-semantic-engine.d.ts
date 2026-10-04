declare module '../shared/semantic-engine.mjs' {
  export const BUSINESS_GLOSSARY: any
  export const DIMENSION_REGISTRY: any
  export const METRIC_REGISTRY: any
  export const RELATIONSHIP_GRAPH: any
  export const SCHEMA_REGISTRY: any
  export const DateResolver: any
  export const EntityResolver: any
  export const QueryCompiler: any
  export const QueryPlanner: any
  export function executeSemanticQuery(database: any, question: string, context?: any, actorId?: string): any
}
