// The authorizing round of a landing step (execution-landing-result-identity
// D1, D2): the merge or fast-forward effect records the round whose pass (or
// carry) authorized it, and that round, confirmed against the execution, the
// change, and the landed head, is the only thing that names the result Kawai
// accepts. A commit never selects a result: there is no commit search and no
// fallback, and the round's outcome is not re-checked (the merge cannot be
// undone).
import type { RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'

/** What landed, as the landing effect recorded it: the head and the authorizing round's id. */
export interface LandedStep { head: string; roundId: string | null }

export type AuthorizingRefusal = 'no-round' | 'round-missing' | 'round-mismatch' | 'commit-mismatch'
export type Authorizing = { ok: true; round: RoundRow } | { ok: false; reason: AuthorizingRefusal }

/** The landing step's authorizing round, or why it cannot be confirmed (checked in this order). */
export function authorizingRound(store: Pick<ExecutionStore, 'round'>, executionId: string, change: string, landed: LandedStep): Authorizing {
  if (landed.roundId === null) return { ok: false, reason: 'no-round' }
  const round = store.round(landed.roundId)
  if (round === null) return { ok: false, reason: 'round-missing' }
  if (round.executionId !== executionId || round.change !== change) return { ok: false, reason: 'round-mismatch' }
  if (round.commitSha !== landed.head) return { ok: false, reason: 'commit-mismatch' }
  return { ok: true, round }
}
