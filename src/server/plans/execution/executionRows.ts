// Execution row types and mappers (plan-execution design D3): the stored
// shapes `executionStore` reads back. JSON columns parse here and nowhere
// else; booleans are SQLite integers. Pure: no SQL, no policy.
import type {
  AttemptKind,
  AttemptManifest,
  ChangeState,
  ChangeStep,
  CiCheck,
  ExecutionOutcome,
  ExecutionState,
  FloorMap,
  MergeMethod,
  StopDetail,
  StopReason,
} from '../../../shared/planExecution'

export interface ExecutionRow {
  id: string
  teamId: string
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
}

export interface ChangeRow {
  executionId: string
  change: string
  teamId: string
  position: number
  state: ChangeState
  step: ChangeStep | null
  stopReason: StopReason | null
  stopDetail: StopDetail | null
  taskId: string | null
  worktree: string | null
  branch: string | null
  baselineCommit: string | null
  prNumber: number | null
  prUrl: string | null
  prOpenedByKawai: boolean | null
  /** Consecutive failed fix rounds (D12). */
  fixRounds: number
  /** Whether this row holds the team's ownership of the change (D3). */
  owns: boolean
  passedAt: string | null
  generation: number
  updatedAt: string
}

export interface SlotRow {
  teamId: string
  holderKind: string
  holderId: string
  since: string
}

export interface AttemptRow {
  id: string
  executionId: string
  change: string
  number: number
  kind: AttemptKind
  assignmentId: string | null
  manifest: AttemptManifest
  manifestHash: string
  createdAt: string
}

export interface LandingRow {
  planId: string
  change: string
  executionId: string
  teamId: string
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

type Row = Record<string, unknown>
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
const int = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
const json = <T>(value: unknown): T | null => (value === null || value === undefined ? null : JSON.parse(String(value)) as T)
const flag = (value: unknown): boolean | null => (value === null || value === undefined ? null : Number(value) === 1)

export function mapExecution(row: Row): ExecutionRow {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    planId: String(row.plan_id),
    revision: Number(row.revision),
    contentHash: String(row.content_hash),
    reportId: String(row.report_id),
    inputHash: String(row.input_hash),
    landingMode: String(row.landing_mode),
    baseBranch: String(row.base_branch),
    baseCommit: String(row.base_commit),
    floor: json<ExecutionRow['floor']>(row.floor_json)!,
    maxParallel: Number(row.max_parallel),
    mergeMethod: String(row.merge_method) as MergeMethod,
    state: String(row.state) as ExecutionState,
    outcome: text(row.outcome) as ExecutionOutcome | null,
    stopReason: text(row.stop_reason),
    startedAt: String(row.started_at),
    finishedAt: text(row.finished_at),
  }
}

export function mapChange(row: Row): ChangeRow {
  return {
    executionId: String(row.execution_id),
    change: String(row.change),
    teamId: String(row.team_id),
    position: Number(row.position),
    state: String(row.state) as ChangeState,
    step: text(row.step) as ChangeStep | null,
    stopReason: text(row.stop_reason) as StopReason | null,
    stopDetail: json<StopDetail>(row.stop_detail_json),
    taskId: text(row.task_id),
    worktree: text(row.worktree),
    branch: text(row.branch),
    baselineCommit: text(row.baseline_commit),
    prNumber: int(row.pr_number),
    prUrl: text(row.pr_url),
    prOpenedByKawai: flag(row.pr_opened_by_kawai),
    fixRounds: Number(row.fix_rounds),
    owns: Number(row.owns) === 1,
    passedAt: text(row.passed_at),
    generation: Number(row.generation),
    updatedAt: String(row.updated_at),
  }
}

export function mapSlot(row: Row): SlotRow {
  return { teamId: String(row.team_id), holderKind: String(row.holder_kind), holderId: String(row.holder_id), since: String(row.since) }
}

export function mapAttempt(row: Row): AttemptRow {
  return {
    id: String(row.id),
    executionId: String(row.execution_id),
    change: String(row.change),
    number: Number(row.number),
    kind: String(row.kind) as AttemptKind,
    assignmentId: text(row.assignment_id),
    manifest: json<AttemptManifest>(row.manifest_json)!,
    manifestHash: String(row.manifest_hash),
    createdAt: String(row.created_at),
  }
}

export function mapLanding(row: Row): LandingRow {
  return {
    planId: String(row.plan_id),
    change: String(row.change),
    executionId: String(row.execution_id),
    teamId: String(row.team_id),
    mechanism: String(row.mechanism),
    prNumber: int(row.pr_number),
    prUrl: text(row.pr_url),
    headSha: String(row.head_sha),
    baseSha: String(row.base_sha),
    mergeSha: String(row.merge_sha),
    landedAt: String(row.landed_at),
    treeVerified: Number(row.tree_verified) === 1,
    postCi: json<CiCheck[]>(row.post_ci_json),
  }
}

/** The slot holder id of a change (D3). */
export const changeHolderId = (executionId: string, change: string) => `${executionId}:${change}`
