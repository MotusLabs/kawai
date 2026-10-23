// SDK-free plan execution records and views (plan-execution design D3, D8,
// D17, contracts X1, X2, X8), shared by the server, `plan_get`, and the Plans
// view. States, steps, stop reasons, and effect kinds are append-only
// vocabularies: later changes add to them and never rename. The pure gate
// functions live in `planExecutionGates.ts` and progress in
// `planExecutionProgress.ts`; hashing a manifest is server-side, over
// `manifestHashInput`.
import { canonicalJson } from './productStrategy'
import { PLAN_CHECK_FLOOR } from './plans'

/** The floor-map version an execution records with its snapshot (D16). */
export const FLOOR_VERSION = 1

/** The floor checks CI runs: every floor entry but the review (D10, C7). */
export const CI_FLOOR_CHECKS = PLAN_CHECK_FLOOR.filter((name): name is Exclude<typeof name, 'review'> => name !== 'review')
export type CiFloorCheck = (typeof CI_FLOOR_CHECKS)[number]

/** Floor check → the CI check names that cover it. */
export type FloorMap = Record<CiFloorCheck, string[]>

export type MergeMethod = 'merge' | 'squash' | 'rebase'
export const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase']

export type ExecutionState = 'running' | 'finished'
export type ExecutionOutcome = 'completed' | 'stopped'

/** A change's state within one execution (X1). */
export type ChangeState =
  | 'waiting'
  | 'provisioning'
  | 'implementing'
  | 'gating'
  | 'landing'
  | 'landed'
  | 'stopped'
  | 'cancelled'
export const CHANGE_STATES: readonly ChangeState[] = [
  'waiting', 'provisioning', 'implementing', 'gating', 'landing', 'landed', 'stopped', 'cancelled',
]

/** The sub-step of `gating` or `landing` (X1). */
export type ChangeStep =
  | 'pushing'
  | 'opening-pr'
  | 'awaiting-ci'
  | 'releasing'
  | 'reviewing'
  | 'conditions'
  | 'awaiting-slot'
  | 'up-to-date'
  | 'updating'
  | 'merging'
  /** Retry of a failed or closed stage: the stage's instruction is sent again (D12). */
  | 'redispatch'

/** Why a change stopped (X8, append-only). */
export type StopReason =
  | 'round-limit'
  | 'name-taken'
  | 'instruction-failed'
  | 'task-closed'
  | 'review-unavailable'
  | 'effect-failed'
  | 'effect-unknown'
  | 'ci-missing'
  | 'ci-timeout'
  | 'pr-closed'
  | 'integration-rewritten'
export const STOP_REASONS: readonly StopReason[] = [
  'round-limit', 'name-taken', 'instruction-failed', 'task-closed', 'review-unavailable',
  'effect-failed', 'effect-unknown', 'ci-missing', 'ci-timeout', 'pr-closed', 'integration-rewritten',
]

/** What a stop names: every field optional, each reason filling its own. */
export interface StopDetail {
  message?: string
  effect?: EffectKind
  effectId?: string
  session?: string
  checks?: string[]
  files?: string[]
  names?: string[]
  taskId?: string
  assignmentId?: string
  /** A refused step (I2): the stage whose service call refused, and the refusal text. */
  stage?: string
  refusal?: string
  /** The state the change was in when it stopped; Retry resumes it (D12). */
  resumeState?: ChangeState
}

export type AttemptKind = 'implement' | 'fix' | 'update'
export type RoundOutcome = 'pass' | 'fail' | 'superseded'

/** Effect kinds (X3, append-only; a mechanism may add execution-level kinds). */
export type EffectKind = 'provision' | 'push' | 'open-pr' | 'rerun' | 'update-branch' | 'merge' | 'remove-worktree'
  // integration-candidates (D4, D5): the execution-level branch creation, and the non-forced landing.
  | 'create-integration' | 'fast-forward'
  // revision-control (D7): the checkpoint push — never a stop, never round evidence.
  | 'push-checkpoint'
export type EffectState = 'pending' | 'running' | 'done' | 'failed' | 'unknown' | 'cancelled'

/**
 * One CI report for a commit (D10): a check run or a commit status. `source`
 * says whether Kawai can rerun it: only an `actions` check run with a run id.
 * `conclusion` is the normalized GitHub value (a status's `failure`/`error`
 * read as `failure`, its `pending` as `pending`).
 */
export interface CiCheck {
  name: string
  source: 'actions' | 'check-run' | 'status'
  conclusion: string
  link: string | null
  runId?: number
  startedAt: string | null
  completedAt: string | null
}

/** D8: what one dispatch was given; immutable, hashed over its canonical form. */
export interface AttemptManifest {
  version: 1
  plan: { id: string; revision: number; contentHash: string }
  execution: string
  task: { id: string; revision: number }
  validation: { reportId: string; inputHash: string }
  /** The change's baseline commit. */
  baseline: string
  /** The branch head at dispatch. */
  startCommit: string
  /** Path → sha256 of `git show <startCommit>:<path>`. */
  artifacts: Record<string, string>
  roleProfiles: string[]
  answers?: { resultId: string; roundId: string; failingChecks: CiCheck[]; findingsIds: string[] }
  /** An update attempt's failed branch update (revision-control PR E, A1): the base head and the conflicting files; a failed check carries both empty. */
  update?: { base: string; files: string[] }
  /** A restart's start point (rev4 §4, D5): THIS pause target's own newest checkpoint on origin — id and commit. Omitted when none reached origin (the restart then starts from origin's branch head with the may-predates note); never null. */
  checkpoint?: { id: string; commit: string }
}

/** One attempt row's dispatch state (revision-control PR E, H″ O1). */
export type AttemptStatus = 'answered' | 'owed' | 'out'

/**
 * The agent-held stage a change's newest fact names (revision-control PR E,
 * O3′): the one predicate every holder derivation shares — the pause targets,
 * the supervision loader, and the monitor's stage all read it. `null` is
 * Kawai-held (or nothing live): an owed newest attempt names no holder (H7),
 * whatever the change's state. A `gating` change whose newest attempt is an
 * update row that went out is agent-held work again — the update attempt is
 * a real handoff between the failed update and the fix round.
 */
export function agentHeldStage(row: { state: ChangeState; step: ChangeStep | null },
  newest: { kind: AttemptKind; status: AttemptStatus } | null): AttemptKind | 'review' | null {
  if (row.state === 'implementing') {
    if (newest?.status === 'owed') return null
    return newest?.kind ?? 'implement'
  }
  if (row.state === 'gating') {
    if (row.step === 'reviewing') return 'review'
    // Between the failed update and the fix round's pipeline the change sits
    // with no step; once a step runs again (CI, the review) Kawai holds it.
    if (row.step === null && newest?.kind === 'update' && newest.status === 'out') return 'update'
  }
  return null
}

/** The manifest's canonical serialization: the input of its sha256 (stable under key order). */
export function manifestHashInput(manifest: AttemptManifest): string {
  return canonicalJson(manifest)
}

/** What a change waits on, shown instead of "idle" (spec: waiting is explained). */
export type WaitingReason =
  | { kind: 'dependency'; changes: string[] }
  | { kind: 'parallel-limit'; limit: number }
  | { kind: 'effect'; effect: EffectKind; state: EffectState; nextAt: string | null }
  | { kind: 'instruction'; state: string; holder: string | null }
  | { kind: 'ci'; pending: string[] }
  | { kind: 'release'; member: string; reason: string }
  | { kind: 'review'; claimant: string | null }
  | { kind: 'conditions'; conditions: string[] }
  | { kind: 'slot'; holder: string | null }
  | { kind: 'merge' }

/** One extra check's standing in a round (D11). */
export interface ExtraCheckView {
  name: string
  description: string
  command: string | null
  by: 'ci' | 'reviewer'
  /** CI's conclusion, or the attesting reviewer's session. */
  outcome: string | null
}

/** The CI evidence of a round: every run kept, the flaky names marked. */
export interface RoundCiView {
  checks: CiCheck[]
  flaky: string[]
  rerunAt: string | null
  state: 'pending' | 'pass' | 'fail' | 'stopped'
}

export interface RoundView {
  id: string
  number: number
  attemptId: string
  resultId: string
  commit: string
  fixRound: boolean
  carriedFrom: string | null
  pushedAt: string | null
  ci: RoundCiView | null
  reviewAssignmentId: string | null
  verdict: { findingsId: string; verdict: 'pass' | 'fail'; reviewer: string } | null
  extraChecks: ExtraCheckView[]
  outcome: RoundOutcome | null
  decidedAt: string | null
}

export interface AttemptView {
  id: string
  number: number
  kind: AttemptKind
  assignmentId: string | null
  manifestHash: string
  createdAt: string
}

export interface EffectView {
  id: string
  kind: EffectKind
  state: EffectState
  tries: number
  error: string | null
  createdAt: string
  finishedAt: string | null
}

/** X7: one landing per plan and change. */
export interface LandingFactView {
  planId: string
  change: string
  executionId: string
  mechanism: string
  prNumber: number | null
  prUrl: string | null
  headSha: string
  baseSha: string
  mergeSha: string
  landedAt: string
  treeVerified: boolean
  postCi: CiCheck[] | null
}

export interface ExecutionChangeView {
  change: string
  position: number
  state: ChangeState
  step: ChangeStep | null
  waiting: WaitingReason | null
  stopReason: StopReason | null
  stopDetail: StopDetail | null
  taskId: string | null
  worktree: string | null
  branch: string | null
  baselineCommit: string | null
  prNumber: number | null
  prUrl: string | null
  fixRounds: number
  generation: number
  passedAt: string | null
  attempts: number
  attempt: AttemptView | null
  instruction: { assignmentId: string; state: string; holder: string | null } | null
  latestRound: RoundView | null
  landing: LandingFactView | null
  effects: EffectView[]
}

export interface PlanExecutionView {
  id: string
  planId: string
  revision: number
  contentHash: string
  reportId: string
  inputHash: string
  landingMode: string
  baseBranch: string
  baseCommit: string
  floor: { version: number; map: FloorMap }
  maxParallel: number
  mergeMethod: MergeMethod
  state: ExecutionState
  outcome: ExecutionOutcome | null
  /** The human's Stop reason. */
  stopReason: string | null
  startedAt: string
  finishedAt: string | null
  changes: ExecutionChangeView[]
}
