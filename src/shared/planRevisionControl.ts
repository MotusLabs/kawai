// Revision control (revision-control design D1, D2): the record, gate, and
// view types shared by the server's `src/server/plans/revisionControl/`
// modules and, later, the plan protocol and view. The records mirror the D2
// tables — holds (`plan_holds`, `plan_hold_changes`), pauses and their
// targets (`plan_pauses`, `plan_pause_targets`), checkpoints
// (`plan_checkpoints`), and an execution's revision history
// (`plan_execution_revisions`, `plan_execution_publication_changes`). The
// pure gates live server-side: `holdGate` (D5), `pauseTargetState` (D8),
// `revisionDelta` (D10); their input and result types are here.

// --- Holds (D2, D4) ---

export type HoldScope = 'plan' | 'changes'

/** What a hold cites: a strategy impact review (`reconsider`) or a decision card. */
export type HoldCites = { kind: 'impact-review' | 'decision-card'; id: string }

/** A `plan_holds` row; the changes of scope `changes` ride `plan_hold_changes`. */
export interface PlanHold {
  id: string
  teamId: string
  planId: string
  scope: HoldScope
  rationale: string
  /** Review deadline; extended in place, the history in `plan_events`. */
  deadline: string
  cites: HoldCites | null
  createdAt: string
  commandId: string
  releasedAt: string | null
  releaseReason: string | null
  releaseCommandId: string | null
  /** Scope `changes` only: the change names still held (their rows unreleased). */
  changes: string[]
}

/** A hold as the gate (D5) reads it: active holds only. */
export interface ActiveHold {
  id: string
  scope: HoldScope
  /** Scope `changes` only: the change names still held. */
  changes: readonly string[]
}

// --- Pauses and targets (D2, D6, D8) ---

export type PauseStage = 'attempt' | 'review'

export type PauseDecision = 'continue' | 'adapt' | 'restart' | 'cancelled'

/** A `plan_pauses` row. */
export interface PlanPause {
  id: string
  teamId: string
  planId: string
  executionId: string
  holdId: string
  deadline: string
  note: string | null
  createdAt: string
  commandId: string
  closedAt: string | null
}

/** A `plan_pause_targets` row: one held change of the pause. */
export interface PlanPauseTarget {
  pauseId: string
  change: string
  stage: PauseStage
  attemptId: string | null
  assignmentId: string
  /** The claimant at request time; null when the instruction was withdrawn. */
  holderSession: string | null
  /** The pause mail. */
  messageId: string | null
  /** The instruction was unclaimed and Kawai superseded it (D6). */
  withdrawn: boolean
  /** Recorded Paused; never derived (D8). */
  pausedAt: string | null
  checkpointId: string | null
  decision: PauseDecision | null
  decisionDetail: Record<string, unknown> | null
  decidedAt: string | null
  decisionCommandId: string | null
}

// --- Checkpoints (D2, D7) ---

export type CheckpointKind = 'commit' | 'result' | 'notes'

/** A `plan_checkpoints` row: the durable checkpoint of one paused target. */
export interface PlanCheckpoint {
  id: string
  executionId: string
  change: string
  pauseId: string
  attemptId: string | null
  sessionId: string
  kind: CheckpointKind
  commitSha: string | null
  /** The attempt's baseline commit. */
  baselineCommit: string | null
  /** The attempt manifest's hash. */
  manifestHash: string | null
  /** Kind `result`: the round's result that counts as the checkpoint. */
  resultId: string | null
  summary: string
  unfinished: string | null
  errorsTests: string | null
  nextSteps: string
  /** The `push-checkpoint` effect; set only for kind `commit`. */
  effectId: string | null
  /** The checkpoint this one supersedes; the earlier row stays readable. */
  supersededBy: string | null
  createdAt: string
}

// --- Execution revisions and publications (D2, D10, D11) ---

/** A `plan_execution_revisions` row; seq 1 is the revision Start recorded. */
export interface ExecutionRevisionRecord {
  executionId: string
  seq: number
  revision: number
  contentHash: string
  reportId: string
  inputHash: string
  rationale: string | null
  commandId: string | null
  payload: Record<string, unknown> | null
  appliedAt: string
}

export type DeltaClass = 'unchanged' | 'changed' | 'added' | 'removed' | 'metadata'

/** A `plan_execution_publication_changes` row: one change's Apply outcome. */
export interface PublicationChange {
  executionId: string
  seq: number
  change: string
  class: DeltaClass
  /** continue | adapt | restart | none (changed, no task yet); null elsewhere. */
  choice: string | null
  /** The changed C1 fields, for class `changed` and `metadata`. */
  fields: string[]
  /** The task Adapt published its revision of. */
  taskId: string | null
  taskRevision: number | null
}

// --- The revision delta (D10) ---

/**
 * One change's classification against the execution's revision. `metadata`
 * is a landed change whose only differences are `dependsOn` or `fixes`;
 * Apply updates them and offers no choice.
 */
export interface DeltaChange {
  change: string
  class: DeltaClass
  /** The compared C1 fields that differ; empty unless changed or metadata. */
  fields: string[]
  /**
   * Class `changed` only: `'needed'` when the change has a task (provisioned),
   * `'none'` while it is still waiting, unprovisioned.
   */
  choice: 'needed' | 'none' | null
}

export type DeltaFindingKind = 'landing-changed' | 'plan-rules-changed' | 'landed-changed' | 'lead-changed'

/** An execution-wide delta finding; every kind but `lead-changed` refuses (D11). */
export interface DeltaFinding {
  kind: DeltaFindingKind
  detail: string
  /** The named changes, for `landed-changed`. */
  changes: string[]
}

export interface RevisionDelta {
  /** Every change of either revision, in the target's content order, removed changes last. */
  changes: DeltaChange[]
  findings: DeltaFinding[]
}

// --- The hold gate (D5) ---

/** The gate's closure for one change: why it may not advance, or null. */
export interface HoldClosure {
  /** Every active hold covering the change, sorted. */
  holdIds: string[]
  /** `plan` when a whole-plan hold covers it, else `changes`. */
  scope: HoldScope
  /** The open pause target's pause, when the pause also closes the gate. */
  pauseId: string | null
}

// --- Pausing, Paused, decided (D8) ---

/**
 * A Pausing target's causes, in D8's order. `holder-killed`,
 * `checkpoint-push-failed`, and any cause still standing at the pause
 * deadline cannot clear without the owner.
 */
export type PausingCause =
  | { kind: 'awaiting-delivery' }
  | { kind: 'starting' }
  | { kind: 'request' }
  | { kind: 'busy' }
  | { kind: 'provider-limit'; profile: string | null; resetAt: string | null }
  | { kind: 'no-checkpoint' }
  | { kind: 'checkpoint-pushing' }
  | { kind: 'checkpoint-push-failed' }
  | { kind: 'holder-killed' }
  | { kind: 'readiness'; reason: string }

export type PauseTargetState =
  | { state: 'paused' }
  /** A recorded decision, or the execution's finish read as `cancelled`. */
  | { state: 'decided'; decision: PauseDecision }
  | { state: 'pausing'; causes: PausingCause[]; ownerRequired: boolean }

// --- Views (D14, D15): what `team-plan-detail` and `plan_get` carry ---

export interface HoldView {
  id: string
  scope: HoldScope
  rationale: string
  deadline: string
  cites: HoldCites | null
  createdAt: string
  releasedAt: string | null
  releaseReason: string | null
  changes: string[]
}

export interface CheckpointView {
  id: string
  kind: CheckpointKind
  commitSha: string | null
  summary: string
  nextSteps: string
  createdAt: string
  supersededBy: string | null
}

export interface PauseTargetView {
  change: string
  stage: PauseStage
  holderSession: string | null
  withdrawn: boolean
  state: PauseTargetState
  pausedAt: string | null
  /** The newest checkpoint, superseded ones behind it. */
  checkpoint: CheckpointView | null
  decision: PauseDecision | null
  decidedAt: string | null
}

export interface PauseView {
  id: string
  holdId: string
  deadline: string
  note: string | null
  createdAt: string
  closedAt: string | null
  targets: PauseTargetView[]
  /** Held changes of the execution with no active work (D6). */
  noActiveWork: string[]
  /** Changes whose merge or fast-forward has started and is left to settle. */
  landingInProgress: string[]
}

export interface ExecutionRevisionView {
  seq: number
  revision: number
  contentHash: string
  rationale: string | null
  appliedAt: string
  changes: PublicationChange[]
}
