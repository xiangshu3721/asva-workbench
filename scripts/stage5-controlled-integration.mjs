import { config } from '../server/config.mjs'
import { createSafetySignalCandidates } from '../server/deepseek.mjs'
import { buildCustomerSafetyContext, buildSafetyAssessment } from '../server/safety.mjs'
import { SAFETY_FIXTURES } from '../shared/safety-fixtures.mjs'

if (!config.deepseek.apiKey) {
  console.log(JSON.stringify({ ok: false, code: 'DEEPSEEK_UNAVAILABLE', production_customer_call: false }))
  process.exitCode = 1
}

const highRiskTypes = new Set(['SELF_HARM_IDEATION', 'SUICIDAL_INTENT_OR_PLAN', 'RECENT_SELF_HARM_BEHAVIOR', 'HARM_TO_OTHERS_IDEATION', 'BASIC_SELF_CARE_FAILURE', 'REALITY_TESTING_CONCERN'])
const requestedFixture = process.env.STAGE5_FIXTURE_ID || ''
const fixtureIds = new Set(['NEGATED', 'THIRD_PARTY', 'HISTORICAL', 'R2_PASSIVE_DEATH_WISH', 'R3_CURRENT_SELF_HARM', 'R4_IMMINENT', 'SPARSE_UNKNOWN'])
const selectedFixtures = SAFETY_FIXTURES.filter((item) => fixtureIds.has(item.id) && (!requestedFixture || item.id === requestedFixture))
const result = { ok: true, production_customer_call: false, fixtures: [], guards: { negation_error: 0, third_party_attribution_error: 0, historical_as_current_error: 0, hard_rule_miss: 0, conflict_auto_resolved: 0, ungrounded_safety_signal: 0, unsupported_diagnosis: 0 }, json: { initial_valid: true, repair_used: false, final_valid: true } }

for (const fixture of selectedFixtures) {
  const customerId = `CONTROLLED-${fixture.id}`
  const evidenceId = `CONTROLLED-EVD-${fixture.id}`
  const context = buildCustomerSafetyContext({
    customer: { id: customerId, profileVersion: 1, name: 'CONTROLLED_FIXTURE', profileFields: {} },
    evidenceItems: [{ id: evidenceId, customerId, sourceId: `CONTROLLED-SRC-${fixture.id}`, evidenceType: 'FACT', semanticKind: 'CURRENT_STATE', fieldKey: 'current_core_issue', displayText: fixture.text, sourceExcerpt: fixture.text, confidence: 1, reviewStatus: 'CONFIRMED', sourcePerspective: 'CUSTOMER_FIRST_PARTY' }],
    sourceRecords: [{ id: `CONTROLLED-SRC-${fixture.id}`, customerId, title: 'Controlled fixture' }],
    conflicts: [],
  })
  try {
    const candidates = await createSafetySignalCandidates({ context })
    const built = buildSafetyAssessment({ context, candidates })
    const assessment = built.assessment
    result.json.initial_valid &&= candidates.initial_json_valid === true
    result.json.repair_used ||= candidates.repair_used === true
    result.json.final_valid &&= candidates.final_json_valid === true
    result.guards.ungrounded_safety_signal += built.quality.quality.ungroundedSafetySignal
    result.guards.unsupported_diagnosis += built.quality.quality.unsupportedDiagnosis
    if (fixture.id === 'NEGATED' && assessment.safety_signals.some((item) => item.subject_scope === 'SELF' && item.polarity === 'PRESENT' && highRiskTypes.has(item.signal_type))) result.guards.negation_error += 1
    if (fixture.id === 'THIRD_PARTY' && assessment.safety_signals.some((item) => item.subject_scope === 'SELF' && item.polarity === 'PRESENT' && highRiskTypes.has(item.signal_type))) result.guards.third_party_attribution_error += 1
    if (fixture.id === 'HISTORICAL' && ['R3', 'R4'].includes(assessment.risk_level)) result.guards.historical_as_current_error += 1
    const hardRuleMiss = fixture.id === 'R4_IMMINENT'
      ? assessment.risk_level !== 'R4' || assessment.service_gate !== 'SAFETY_FIRST' || assessment.commercial_block !== 'HARD_BLOCK'
      : fixture.id === 'R3_CURRENT_SELF_HARM'
        ? !['R3', 'R4'].includes(assessment.risk_level) || assessment.commercial_block !== 'HARD_BLOCK'
        : fixture.id === 'R2_PASSIVE_DEATH_WISH'
          ? assessment.risk_level !== 'R2' || !['STABILIZE_FIRST', 'ONE_TO_ONE'].includes(assessment.service_gate) || assessment.commercial_block === 'NONE'
          : fixture.id === 'SPARSE_UNKNOWN'
            ? assessment.risk_level !== 'UNKNOWN' || assessment.service_gate === 'COURSE_READY'
            : false
    if (hardRuleMiss) result.guards.hard_rule_miss += 1
    result.fixtures.push({ id: fixture.id, risk_level: assessment.risk_level, service_gate: assessment.service_gate, commercial_block: assessment.commercial_block, signal_count: assessment.safety_signals.length, signals: assessment.safety_signals.map((item) => ({ signal_type: item.signal_type, subject_scope: item.subject_scope, polarity: item.polarity, explicitness: item.explicitness, recency: item.recency, has_plan_language: /(计划|意图|手段|工具|正在|立即|今晚|今天)/.test(`${item.details} ${item.current_status}`) })), initial_json_valid: candidates.initial_json_valid, repair_used: candidates.repair_used, final_json_valid: candidates.final_json_valid })
  } catch (error) {
    result.ok = false
    result.fixtures.push({ id: fixture.id, error_code: error?.code || 'CONTROLLED_INTEGRATION_FAILED', diagnostic: error?.code === 'SAFETY_JSON_INVALID' ? { parsed_keys: error.parsedKeys || [], signal_count: error.signalCount, signal_shapes: error.signalShapes || [], critical_unknowns_type: error.criticalUnknownsType, context_summary_type: error.contextSummaryType, repair_used: error.repairUsed === true } : undefined })
    result.json.initial_valid = false
    result.json.final_valid = false
  }
}

result.ok = result.ok && Object.values(result.guards).every((value) => value === 0) && result.json.final_valid
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
