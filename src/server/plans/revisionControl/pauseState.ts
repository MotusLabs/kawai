// The pause target's derived state (revision-control design D8): the pure
// `pauseTargetState(target, facts)`. Paused is a recorded fact (`paused_at`)
// and decided is a recorded decision (or the execution's finish read as
// `cancelled`); everything else is Pausing, with every cause that applies,
// in D8's order. Nothing here writes: the executor's tick records Paused in
// its own guarded transaction when the work is on `origin` and the holder is
// ready (D8's recording rule), and `workOnOrigin` is exported so that tick
// and the cause derivation read the same rule. A restart re-derives Pausing
// from stored rows plus the holder's live facts; nothing about a pause lives
// only in memory (R18).
import type { CheckpointKind, PausingCause, PauseDecision, PauseStage, PauseTargetState } from '../../../shared/planRevisionControl'

/** The push effect's settled state, as the effect store reads it. */
export type PushEffectState = 'pending' | 'running' | 'done' | 'failed' | 'unknown' | 'cancelled'

/** The target's stored facts (the `plan_pause_targets` row, narrowed). */
export interface PauseTargetRecord {
  stage: PauseStage
  /** The claimant at request time; null when the instruction was withdrawn. */
  holderSession: string | null
  withdrawn: boolean
  pausedAt: string | null
  decision: PauseDecision | null
  /** The newest checkpoint's kind, or null when none is recorded. */
  checkpointKind: CheckpointKind | null
  /** That checkpoint's `push-checkpoint` effect; null without a commit checkpoint. */
  pushEffectState: PushEffectState | null
}

/** The runtime facts around the target, read by the caller. */
export interface PauseTargetFacts {
  /** The execution finished: an undecided target's decision reads `cancelled` (D8). */
  executionFinished: boolean
  /** The pause mail is delivered (a withdrawn target has none). */
  messageDelivered: boolean
  /** A `spawning` instruction whose spawn has not claimed yet (D6). */
  spawnUnclaimed: boolean
  /** A pending approval or question (R11: it stays unresolved). */
  pendingRequest: boolean
  /** A turn or background work is running. */
  busy: boolean
  /** The holder is parked or its profile is cooling (D6). */
  providerLimit: { profile: string | null; resetAt: string | null } | null
  /** The holder session's state: live, archived, or killed. */
  holder: 'live' | 'archived' | 'killed'
  /** `MemberRelease.readiness` for a live holder: ready, or its reasons. */
  readiness: { ready: boolean; reasons: string[] }
  /** The pause deadline has passed. */
  deadlinePassed: boolean
}

/**
 * Whether the target's work is on `origin` (D8's recording rule): a review,
 * or a newest checkpoint of kind `result`, or a `commit` whose push effect
 * is done. Everything else — including a killed holder's unpushed commit —
 * is not.
 */
export function workOnOrigin(target: PauseTargetRecord): boolean {
  if (target.stage === 'review') return true
  if (target.checkpointKind === 'result') return true
  return target.checkpointKind === 'commit' && target.pushEffectState === 'done'
}

/**
 * The target's state. Decided wins over Paused (D13's `plan-checkpoint-decision`
 * clears on a decision), Paused only from `paused_at`, and Pausing carries its
 * causes: `awaiting-delivery`, `starting`, `request`, `busy`, `provider-limit`,
 * `no-checkpoint`, `checkpoint-pushing`, `checkpoint-push-failed`,
 * `holder-killed`, then member release's readiness reasons. A withdrawn
 * target carries no causes — nothing is owed to it — until the executor
 * records Paused, which it does at once (D6). A killed holder is a cause
 * only while nothing of its work reached `origin`; once its checkpoint is
 * there it counts as ready.
 */
export function pauseTargetState(target: PauseTargetRecord, facts: PauseTargetFacts): PauseTargetState {
  if (target.decision !== null) return { state: 'decided', decision: target.decision }
  if (facts.executionFinished) return { state: 'decided', decision: 'cancelled' }
  if (target.pausedAt !== null) return { state: 'paused' }
  // A withdrawn target (its instruction was unclaimed and superseded) waits
  // for nothing and for nobody; the executor records Paused immediately.
  if (target.withdrawn || target.holderSession === null) return { state: 'pausing', causes: [], ownerRequired: false }

  const causes: PausingCause[] = []
  if (!facts.messageDelivered) causes.push({ kind: 'awaiting-delivery' })
  if (facts.spawnUnclaimed) causes.push({ kind: 'starting' })
  if (facts.pendingRequest) causes.push({ kind: 'request' })
  if (facts.busy) causes.push({ kind: 'busy' })
  if (facts.providerLimit) {
    causes.push({ kind: 'provider-limit', profile: facts.providerLimit.profile, resetAt: facts.providerLimit.resetAt })
  }
  const onOrigin = workOnOrigin(target)
  if (target.stage === 'attempt' && !onOrigin) {
    if (target.checkpointKind === null) causes.push({ kind: 'no-checkpoint' })
    else if (target.checkpointKind === 'commit') {
      // `unknown` is not settled (the startup inspection decides it) and a
      // cancelled push never re-runs; the holder's way out of either is
      // recording again, so both read as a failed push.
      if (target.pushEffectState === 'failed' || target.pushEffectState === 'cancelled' || target.pushEffectState === 'unknown') {
        causes.push({ kind: 'checkpoint-push-failed' })
      } else {
        causes.push({ kind: 'checkpoint-pushing' })
      }
    }
    // A `notes` checkpoint on an attempt target cannot arise through the
    // tool (D7 allows notes for a review only); it adds no cause here.
  }
  if (facts.holder === 'killed' && !onOrigin) causes.push({ kind: 'holder-killed' })
  if (!facts.readiness.ready) {
    for (const reason of facts.readiness.reasons) causes.push({ kind: 'readiness', reason })
  }

  const ownerRequired =
    causes.some(cause => cause.kind === 'holder-killed' || cause.kind === 'checkpoint-push-failed') ||
    (facts.deadlinePassed && causes.length > 0)
  return { state: 'pausing', causes, ownerRequired }
}
