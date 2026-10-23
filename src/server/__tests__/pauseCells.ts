// The shared cell table (revision-control 4.4, lead ruling L5): one verdict
// per state × kind × newest-row-status cell of the pause-target axes, shared
// by every resolution's completeness test — Continue, Adapt, and Restart
// later — so the reachable-vs-unreachable reading is stated once and can
// never disagree between grids again (the class behind Continue's B3 and
// Adapt's B1). The U-claims are the design table's, each stated once with
// the production line its reason rests on. A resolution's completeness test
// maps only the reachable cells to its rows; the unreachable ones carry a
// U-id from PAUSE_U_CLAIMS.
import type { AttemptKind } from '../../shared/planExecution'

/** The states a pause target presents, in the resolve's check order. */
export const PAUSE_STATES = [
  'decided',
  'withdrawn',
  'pausing',
  'paused·gone',
  'paused (attempt stage)',
  'paused (review target)',
  'paused (review target, handoff superseded)',
  'paused (update target: gating, update row out)',
  'paused (update target, answered after the pause)',
] as const
export type PauseCellState = (typeof PAUSE_STATES)[number]

/** The newest attempt row's axes. `—` is the no-row cell (kind null with it). */
export const PAUSE_KINDS = ['implement', 'fix', 'update'] as const
export const PAUSE_ROW_STATUSES = ['—', 'owed', 'out', 'answered (plain)', 'answered·rev↗'] as const
export type PauseRowStatus = (typeof PAUSE_ROW_STATUSES)[number]

/** The design table's row-shape U-claims, stated once (L5), with the production line each reason rests on. */
export const PAUSE_U_CLAIMS = {
  U1: 'an `update` newest row `owed` (any stage), and an `update` row `out` on an attempt-stage (implementing) change — an owed update row reads noActiveWork (O3/H7: agentHeldStage returns null for an owed newest row, planExecution.ts:153), so a pause never names one; and an update row is `out` only in `gating` with no step and no passed round (H″ O1: planExecution.ts:160) — that gating cell is the update attempt target (C17/A13r/R21r), never an attempt-stage one',
  U2: 'an absent, owed, or out newest row on a review target — a standing review implies the reviewed round exists with its result recorded, so the newest row is answered (plain or rev↗)',
  U3: 'a row reading two statuses at once — attemptStatus\'s branches are exclusive (attemptStatus.ts:28–39): a round recording the row wins, so an answered row reads neither owed nor out',
  U7: 'an `update` newest row `answered` (plain or rev↗) outside the update target — the pause is never CREATED naming one (agentHeldStage reads `attempt` for an update row only while it is `out` on a `gating` change, planExecution.ts:160; an answered update row reads no active work at placement); on an attempt-stage change an update row is unreachable in every later status too — owed and `out` by U1, answered because no update row is minted under the pause\'s hold (failedUpdate returns before its mints, executionLanding.ts:220)',
} as const
export type PauseUId = keyof typeof PAUSE_U_CLAIMS

export type PauseCellVerdict =
  | { unreachable: false; via: string }
  | { unreachable: true; uId: PauseUId }

export interface PauseCell {
  state: PauseCellState
  kind: AttemptKind | null
  /** `*` on the state-level cells: the state answers before the row is read. */
  status: PauseRowStatus | '*'
  verdict: PauseCellVerdict
}

const ANSWERED = ['answered (plain)', 'answered·rev↗'] as const

/**
 * The verdict for one cell, first match in the resolve's own check order:
 * the state rows answer before the stage branch, then the stage's row shape.
 * The per-state axis shapes follow the design table's own columns — the
 * state-level rows carry `*` over kind and status, a review target's kind
 * axis collapses to answered(*), and the update-target states' kind axis is
 * the update kind their state names.
 */
export function pauseCell(state: PauseCellState, kind: AttemptKind | null, status: PauseRowStatus | '*'): PauseCellVerdict {
  if (state === 'decided') return { unreachable: false, via: 'the state-level refusal names the standing decision (I1)' }
  if (state === 'withdrawn') return { unreachable: false, via: 'withdrawn is checked before the state (C9/A8r)' }
  if (state === 'pausing') return { unreachable: false, via: 'still pausing refuses before the stage branch (C10/A9r)' }
  if (state === 'paused·gone') return { unreachable: false, via: 'the gone holder is refused or accepted by choice (C11/A11r)' }
  if (state === 'paused (review target)' || state === 'paused (review target, handoff superseded)') {
    if (status !== 'answered (plain)' && status !== 'answered·rev↗') return { unreachable: true, uId: 'U2' }
    return { unreachable: false, via: 'a review target\'s kind axis collapses to answered(*) — the newest row is the reviewed round\'s' }
  }
  if (state === 'paused (attempt stage)') {
    if (kind === null) return { unreachable: false, via: 'the pause names the stage with no newest row (C2/A2r)' }
    if (kind === 'update') return { unreachable: true, uId: status === 'owed' || status === 'out' ? 'U1' : 'U7' }
    // G4's caveat: an owed row is reachable only minted after the pause's
    // creation — a round failing CI under the gate leaves applyFix's row owed.
    return { unreachable: false, via: kind === 'fix' && status === 'owed' ? 'G4: minted owed after the pause\'s creation' : 'the pause names the row' }
  }
  // The update-target states: the newest row is their update row.
  if (status === 'owed') return { unreachable: true, uId: 'U1' }
  if (status === 'out') {
    return state === 'paused (update target: gating, update row out)'
      ? { unreachable: false, via: 'the update target at placement (C17/A13r/R21r)' }
      : { unreachable: true, uId: 'U3' } // an answered row is not also out (attemptStatus's exclusive branches)
  }
  return state === 'paused (update target, answered after the pause)'
    ? { unreachable: false, via: 'the holder\'s result recorded the round under the hold (L4): C18/C19/A14r' }
    : { unreachable: true, uId: 'U7' } // the pause is never CREATED naming an answered update row
}

/** The shared expansion: every state's own axis shape, each cell exactly once. */
export function pauseCells(): PauseCell[] {
  const cells: PauseCell[] = []
  for (const state of PAUSE_STATES) {
    if (state === 'decided' || state === 'withdrawn' || state === 'pausing' || state === 'paused·gone') {
      cells.push({ state, kind: null, status: '*', verdict: pauseCell(state, null, '*') })
    } else if (state === 'paused (review target)' || state === 'paused (review target, handoff superseded)') {
      for (const status of PAUSE_ROW_STATUSES) {
        cells.push({ state, kind: null, status, verdict: pauseCell(state, null, status) })
      }
    } else if (state === 'paused (attempt stage)') {
      cells.push({ state, kind: null, status: '—', verdict: pauseCell(state, null, '—') })
      for (const kind of PAUSE_KINDS) {
        for (const status of ['owed', 'out', ...ANSWERED] as const) {
          cells.push({ state, kind, status, verdict: pauseCell(state, kind, status) })
        }
      }
    } else {
      for (const status of ['owed', 'out', ...ANSWERED] as const) {
        cells.push({ state, kind: 'update', status, verdict: pauseCell(state, 'update', status) })
      }
    }
  }
  return cells
}
