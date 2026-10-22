import { describe, expect, it } from 'vitest'
import {
  createDialogueAnalysisToken,
  finalizeDialogueConfirmation,
  normalizeDialogueAssessment,
  parseDialogueContext,
  serializeDialogueContext,
  verifyDialogueConfirmation,
} from './dialogue-gate.mjs'

const secret = 'synthetic-dialogue-gate-secret'
const hash = 'hash-synthetic-dialogue'

function analysis(classification, speakers = []) {
  return createDialogueAnalysisToken({
    contentHash: hash,
    targetCustomerId: 'CUS-SYNTH-A',
    assessment: normalizeDialogueAssessment({ classification, speakers }, 'synthetic'),
    secret,
    now: 1_000,
  })
}

describe('R047 dialogue attribution gate', () => {
  it('does not infer speaker count from people merely mentioned in one speaker text', () => {
    const result = normalizeDialogueAssessment({
      classification: 'ONE_SPEAKER',
      speakers: [{ id: 'A', excerpt: '我和爸爸、妈妈、丈夫都聊过这件事。', suggested_role: 'UNKNOWN' }],
    }, '我和爸爸、妈妈、丈夫都聊过这件事。')

    expect(result.classification).toBe('ONE_SPEAKER')
    expect(result.speakers).toHaveLength(1)
  })

  it('fails closed when the model does not provide a reliable classification', () => {
    const result = normalizeDialogueAssessment({ classification: 'CUSTOMER_DIRECT', speakers: [] }, 'synthetic')

    expect(result.classification).toBe('UNCERTAIN')
    expect(result.requiresHumanConfirmation).toBe(true)
  })

  it('requires explicit confirmation for one and two speakers', () => {
    const one = finalizeDialogueConfirmation({
      analysisToken: analysis('ONE_SPEAKER', [{ id: 'A', excerpt: '客户内容', suggested_role: 'CUSTOMER' }]),
      contentHash: hash,
      targetCustomerId: 'CUS-SYNTH-A',
      speakerId: 'A',
      secret,
      now: 2_000,
    })
    const two = finalizeDialogueConfirmation({
      analysisToken: analysis('TWO_SPEAKERS', [{ id: 'A' }, { id: 'B' }]),
      contentHash: hash,
      targetCustomerId: 'CUS-SYNTH-A',
      speakerId: 'B',
      secret,
      now: 2_000,
    })

    expect(one.currentCustomerSpeakerId).toBe('A')
    expect(two.currentCustomerSpeakerId).toBe('B')
    expect(verifyDialogueConfirmation({ token: one.dialogueConfirmation, contentHash: hash, targetCustomerId: 'CUS-SYNTH-A', secret, now: 2_001 }).kind).toBe('DIALOGUE_CONFIRMATION')
  })

  it('lets the one-speaker ownership confirmation use the only detected speaker', () => {
    const one = finalizeDialogueConfirmation({
      analysisToken: analysis('ONE_SPEAKER', [{ id: 'A', excerpt: '单人资料', suggested_role: 'UNKNOWN' }]),
      contentHash: hash,
      targetCustomerId: 'CUS-SYNTH-A',
      secret,
      now: 2_000,
    })

    expect(one.currentCustomerSpeakerId).toBe('A')
  })

  it('rejects over-two-speaker and uncertain material before persistence', () => {
    expect(() => finalizeDialogueConfirmation({ analysisToken: analysis('OVER_TWO_SPEAKERS', [{ id: 'A' }, { id: 'B' }, { id: 'C' }]), contentHash: hash, targetCustomerId: 'CUS-SYNTH-A', secret, now: 2_000 })).toThrowError(/超过两位/)
    expect(() => finalizeDialogueConfirmation({ analysisToken: analysis('UNCERTAIN'), contentHash: hash, targetCustomerId: 'CUS-SYNTH-A', secret, now: 2_000 })).toThrowError(/无法确认/)
  })

  it('binds confirmation to the exact text, target customer, and operation context', () => {
    const token = analysis('NOT_DIALOGUE')

    expect(() => finalizeDialogueConfirmation({ analysisToken: token, contentHash: 'different-hash', targetCustomerId: 'CUS-SYNTH-A', secret, now: 2_000 })).toThrowError(/资料、客户或操作已变化/)
    expect(() => finalizeDialogueConfirmation({ analysisToken: token, contentHash: hash, targetCustomerId: 'CUS-SYNTH-B', secret, now: 2_000 })).toThrowError(/资料、客户或操作已变化/)
  })

  it('round-trips the internal attribution context without exposing it in notes', () => {
    const context = { classification: 'TWO_SPEAKERS', currentCustomerSpeakerId: 'A', targetCustomerId: 'CUS-SYNTH-A', customerOperationId: '' }
    const serialized = serializeDialogueContext(context)
    expect(parseDialogueContext(`operator note\n${serialized}`)).toEqual(context)
  })
})
