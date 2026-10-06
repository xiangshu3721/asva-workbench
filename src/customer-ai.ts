import type { Database } from './domain'

// @ts-expect-error The shared .mjs module is bundled by Vite and executed by Node on the server.
import { briefText, buildCustomerAiContext, generateBrief, generateCoreSummary } from '../shared/customer-ai.mjs'

export type AiConfidence = 'LOW' | 'MEDIUM' | 'HIGH'
export type AiRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNASSESSED'

export interface AiCoreSummary {
  overview: string
  core_issues: string[]
  priority_topics: string[]
  current_goals: string[]
  resources: string[]
  service_focus: string
  risk: { level: AiRiskLevel; reason: string }
  confidence: AiConfidence
  missing_key_information: string[]
}

export interface AiBrief {
  confirmed: string[]
  to_confirm: string[]
  entry_points: string[]
  suggested_questions: string[]
  interaction_guidance: { tone: string; pace: string; avoid: string[]; care_cues: string[] }
  lede: string
}

export interface CustomerAiContext {
  now: string
  customer: Record<string, unknown>
  currentCase: Record<string, unknown> | null
  recentSessions: Array<Record<string, unknown>>
  recentChanges: Array<Record<string, unknown>>
  enrollments: Array<Record<string, unknown>>
}

export function assembleCustomerContext(database: Database, customerId: string, now?: string): CustomerAiContext {
  return buildCustomerAiContext(database, customerId, now) as CustomerAiContext
}

export function createLocalCoreSummary(context: CustomerAiContext): AiCoreSummary {
  return generateCoreSummary(context) as AiCoreSummary
}

export function createLocalBrief(context: CustomerAiContext, summary?: AiCoreSummary): AiBrief {
  return generateBrief(context, summary) as AiBrief
}

export function briefToText(brief: AiBrief): string {
  return briefText(brief) as string
}

