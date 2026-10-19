export type SourceSaveState = 'IDLE' | 'SAVING' | 'VERIFYING' | 'CONFIRMED' | 'UNKNOWN' | 'FAILED'

export type SourceSaveEvent =
  | 'START'
  | 'PERSISTED'
  | 'TIMEOUT'
  | 'STATUS_CONFIRMED'
  | 'STATUS_UNKNOWN'
  | 'DEFINITE_FAILURE'
  | 'RESET'

export function transitionSourceSaveState(state: SourceSaveState, event: SourceSaveEvent): SourceSaveState {
  if (event === 'RESET') return 'IDLE'
  if (event === 'START') return state === 'SAVING' || state === 'VERIFYING' ? state : 'SAVING'
  if (event === 'PERSISTED' || event === 'STATUS_CONFIRMED') return 'CONFIRMED'
  if (event === 'TIMEOUT') return 'VERIFYING'
  if (event === 'STATUS_UNKNOWN') return 'UNKNOWN'
  if (event === 'DEFINITE_FAILURE') return 'FAILED'
  return state
}

export function shouldPreserveSourceInput(state: SourceSaveState) {
  return state !== 'CONFIRMED'
}

export function shouldStartSourceAi(state: SourceSaveState) {
  return state === 'CONFIRMED'
}

export function isSourceSavePending(state: SourceSaveState) {
  return state === 'SAVING' || state === 'VERIFYING'
}
