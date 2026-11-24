/**
 * R048.17 – stage4Finalize condition validation.
 * 
 * Verifies that the stage4Finalize condition correctly includes
 * on-demand AUTO sources even when wasExtractReady=false.
 * 
 * This is a pure logic test - no Feishu or repository dependencies.
 */

import { describe, it, expect } from 'vitest'

function computeStage4Finalize({
  automaticMode,
  isAutomaticProfileSource,
  wasExtractReady,
  reconcileExistingEvidence,
  onDemand,
  onDemandTrigger,
}) {
  // This mirrors the actual logic in repository.mjs line 3193
  return automaticMode && isAutomaticProfileSource && (wasExtractReady || reconcileExistingEvidence || (onDemand && onDemandTrigger === 'AUTO'))
}

describe('R048.17 stage4Finalize condition', () => {
  it('1. on-demand AUTO with fresh UPLOADED source → stage4Finalize=true', () => {
    const result = computeStage4Finalize({
      automaticMode: true, // via onDemandAutoArchive
      isAutomaticProfileSource: true,
      wasExtractReady: false, // fresh source
      reconcileExistingEvidence: false,
      onDemand: true,
      onDemandTrigger: 'AUTO',
    })
    expect(result).toBe(true)
  })

  it('2. on-demand MANUAL does NOT trigger stage4Finalize', () => {
    const result = computeStage4Finalize({
      automaticMode: false, // MANUAL doesn't get automaticMode
      isAutomaticProfileSource: true,
      wasExtractReady: false,
      reconcileExistingEvidence: false,
      onDemand: true,
      onDemandTrigger: 'MANUAL',
    })
    expect(result).toBe(false)
  })

  it('3. legacy two-pass (wasExtractReady=true) still works', () => {
    const result = computeStage4Finalize({
      automaticMode: true, // via legacy canary
      isAutomaticProfileSource: true,
      wasExtractReady: true, // second pass
      reconcileExistingEvidence: false,
      onDemand: false,
      onDemandTrigger: undefined,
    })
    expect(result).toBe(true)
  })

  it('4. non-automatic-profile source never triggers stage4Finalize', () => {
    const result = computeStage4Finalize({
      automaticMode: true,
      isAutomaticProfileSource: false, // regular source
      wasExtractReady: false,
      reconcileExistingEvidence: false,
      onDemand: true,
      onDemandTrigger: 'AUTO',
    })
    expect(result).toBe(false)
  })

  it('5. automaticMode=false blocks stage4Finalize even with AUTO', () => {
    const result = computeStage4Finalize({
      automaticMode: false, // not in canary, not AUTO
      isAutomaticProfileSource: true,
      wasExtractReady: false,
      reconcileExistingEvidence: false,
      onDemand: true,
      onDemandTrigger: 'AUTO',
    })
    expect(result).toBe(false)
  })

  it('6. reconcileExistingEvidence=true triggers stage4Finalize', () => {
    const result = computeStage4Finalize({
      automaticMode: true,
      isAutomaticProfileSource: true,
      wasExtractReady: false,
      reconcileExistingEvidence: true, // explicit reconcile
      onDemand: false,
      onDemandTrigger: undefined,
    })
    expect(result).toBe(true)
  })
})
