// The execution-row writes of Apply (plan-revision-apply D3, D4), called only
// inside Apply's transaction. Apply advances the execution's current-revision
// columns — the revision, content hash, report, and input hash later readers
// use (planSteps, the task-link check, completion) — and never the started-from
// record, which stays immutable as the history's seq-1 row. Kept beside the
// execution store rather than in it, so that file stays under its size limit;
// the execution store remains the writer of every other execution column.
import type { Database } from 'bun:sqlite'

export interface ExecutionRevisionColumns {
  revision: number
  contentHash: string
  reportId: string
  inputHash: string
}

/**
 * Move a running execution's current revision, guarded by the revision it
 * held (Apply's compare-and-set); false when the guard is stale, so the
 * caller refuses instead of writing over a concurrent Apply.
 */
export function advanceExecutionRevision(db: Database, executionId: string, from: number, to: ExecutionRevisionColumns): boolean {
  return db.prepare(`UPDATE plan_executions SET revision = ?, content_hash = ?, report_id = ?, input_hash = ?
    WHERE id = ? AND revision = ? AND state = 'running'`)
    .run(to.revision, to.contentHash, to.reportId, to.inputHash, executionId, from).changes === 1
}

/**
 * An added change's row (CH7, CH8): `waiting` and owned, or `landed` and
 * not owned when a landing fact already exists. False when the team's
 * owner index refuses it — another running execution owns the name.
 */
export function insertAddedChange(db: Database, input: { executionId: string; teamId: string; change: string; position: number; landed: boolean }): boolean {
  try {
    db.prepare(`INSERT INTO plan_execution_changes (execution_id, change, team_id, position, state, owns, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.executionId, input.change, input.teamId, input.position,
      input.landed ? 'landed' : 'waiting', input.landed ? 0 : 1, new Date().toISOString())
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return false
    throw error
  }
}

/** Positions follow the target's content order; changes it no longer lists keep their relative order after it. */
export function reorderChanges(db: Database, executionId: string, order: readonly string[]): void {
  const rows = db.prepare('SELECT change FROM plan_execution_changes WHERE execution_id = ? ORDER BY position, rowid').all(executionId) as Array<{ change: string }>
  const rest = rows.map(row => row.change).filter(change => !order.includes(change))
  const update = db.prepare('UPDATE plan_execution_changes SET position = ? WHERE execution_id = ? AND change = ?')
  ;[...order, ...rest].forEach((change, position) => update.run(position, executionId, change))
}

/** A removed change gives up its name (CH9, CH10): `owns = 0`, so another execution may own it later. */
export function disownChange(db: Database, executionId: string, change: string): void {
  db.prepare('UPDATE plan_execution_changes SET owns = 0 WHERE execution_id = ? AND change = ?').run(executionId, change)
}

/** A restored re-add owns its name again (CH7); false when another running execution owns it (the owner index). */
export function ownChange(db: Database, executionId: string, change: string): boolean {
  try {
    db.prepare('UPDATE plan_execution_changes SET owns = 1 WHERE execution_id = ? AND change = ?').run(executionId, change)
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return false
    throw error
  }
}

/** A removed change's pending effects are cancelled (CH9); running ones settle and are dropped by the open guard. */
export function cancelChangeEffects(db: Database, executionId: string, change: string): void {
  db.prepare("UPDATE plan_execution_effects SET state = 'cancelled', finished_at = ? WHERE execution_id = ? AND change = ? AND state = 'pending'")
    .run(new Date().toISOString(), executionId, change)
}
