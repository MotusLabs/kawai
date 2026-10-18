// The execution store's write vocabulary (plan-execution design D3),
// extracted from `executionStore.ts` to keep that file under 500 lines:
// the named conflicts a database race throws, the shape of an execution at
// Start, the fields a change transition may set with their column mapping,
// and the one constraint-to-conflict mapper. Pure declarations and helpers —
// no SQL — re-exported through the store so every importer is unchanged.
import type { ChangeState, ChangeStep, FloorMap, MergeMethod, StopDetail, StopReason } from '../../../shared/planExecution'

export type ExecutionConflictKind = 'one-execution' | 'changes-unclaimed' | 'slot-taken'

/** A database race lost, named; the message is fit for a refusal. */
export class ExecutionConflict extends Error {
  constructor(readonly kind: ExecutionConflictKind, message: string) { super(message) }
}

export interface NewExecution {
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
  /** In content order; a change with a landing fact starts `landed` and owns nothing (D4). */
  changes: Array<{ change: string; landed: boolean }>
}

/** Fields a transition may set; `undefined` leaves a column as it is, `null` clears it. */
export interface ChangePatch {
  state?: ChangeState
  step?: ChangeStep | null
  stopReason?: StopReason | null
  stopDetail?: StopDetail | null
  taskId?: string | null
  worktree?: string | null
  branch?: string | null
  baselineCommit?: string | null
  prNumber?: number | null
  prUrl?: string | null
  prOpenedByKawai?: boolean | null
  fixRounds?: number
  passedAt?: string | null
}

export interface ChangeGuard { state: ChangeState; generation: number }

const PATCH_COLUMNS: Record<keyof ChangePatch, string> = {
  state: 'state', step: 'step', stopReason: 'stop_reason', stopDetail: 'stop_detail_json', taskId: 'task_id',
  worktree: 'worktree', branch: 'branch', baselineCommit: 'baseline_commit', prNumber: 'pr_number', prUrl: 'pr_url',
  prOpenedByKawai: 'pr_opened_by_kawai', fixRounds: 'fix_rounds', passedAt: 'passed_at',
}

function columnValue(key: keyof ChangePatch, value: unknown): string | number | null {
  if (value === null) return null
  if (key === 'stopDetail') return JSON.stringify(value)
  if (key === 'prOpenedByKawai') return value ? 1 : 0
  return value as string | number
}

/** The SET columns and values of a patch, in a stable order; `undefined` fields are left as they are. */
export function patchAssignments(patch: ChangePatch): Array<[string, string | number | null]> {
  return (Object.keys(patch) as Array<keyof ChangePatch>)
    .filter(key => patch[key] !== undefined)
    .map(key => [PATCH_COLUMNS[key], columnValue(key, patch[key])])
}

/** Map a constraint error to its named conflict; anything else is rethrown as is. */
export function mapConstraint(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('UNIQUE constraint failed: plan_executions.plan_id')) {
    throw new ExecutionConflict('one-execution', 'The plan already has a running execution.')
  }
  if (message.includes('UNIQUE constraint failed: plan_execution_changes.team_id, plan_execution_changes.change')) {
    throw new ExecutionConflict('changes-unclaimed', 'A change of this plan is already owned by another running execution.')
  }
  if (message.includes('UNIQUE constraint failed: plan_landing_slots.team_id')) {
    throw new ExecutionConflict('slot-taken', "The team's landing slot is taken.")
  }
  throw error
}
