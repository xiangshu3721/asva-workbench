import { describe, expect, it } from 'vitest'
import { isSourceSavePending, shouldPreserveSourceInput, shouldStartSourceAi, transitionSourceSaveState } from './save-reliability'

describe('source save reliability state machine', () => {
  it('distinguishes SAVING, VERIFYING, UNKNOWN, CONFIRMED and FAILED', () => {
    expect(transitionSourceSaveState('IDLE', 'START')).toBe('SAVING')
    expect(transitionSourceSaveState('SAVING', 'TIMEOUT')).toBe('VERIFYING')
    expect(transitionSourceSaveState('VERIFYING', 'STATUS_UNKNOWN')).toBe('UNKNOWN')
    expect(transitionSourceSaveState('UNKNOWN', 'START')).toBe('SAVING')
    expect(transitionSourceSaveState('SAVING', 'DEFINITE_FAILURE')).toBe('FAILED')
    expect(transitionSourceSaveState('SAVING', 'PERSISTED')).toBe('CONFIRMED')
    expect(transitionSourceSaveState('CONFIRMED', 'RESET')).toBe('IDLE')
  })

  it('keeps input and blocks AI until the source is confirmed', () => {
    for (const state of ['SAVING', 'VERIFYING', 'UNKNOWN', 'FAILED'] as const) {
      expect(shouldPreserveSourceInput(state)).toBe(true)
      expect(shouldStartSourceAi(state)).toBe(false)
    }
    expect(shouldPreserveSourceInput('CONFIRMED')).toBe(false)
    expect(shouldStartSourceAi('CONFIRMED')).toBe(true)
  })

  it('blocks duplicate clicks only while a request is in flight', () => {
    expect(isSourceSavePending('SAVING')).toBe(true)
    expect(isSourceSavePending('VERIFYING')).toBe(true)
    expect(isSourceSavePending('UNKNOWN')).toBe(false)
    expect(isSourceSavePending('FAILED')).toBe(false)
  })
})
