// Pause store (revision-control design D2, D6, D8, D9): the only SQL writer
// of `plan_pauses` and `plan_pause_targets`. Paused is a stored fact: the
// guarded `recordPaused` writes once (`WHERE paused_at IS NULL`), and so does
// the guarded decision (`WHERE decision IS NULL`) — the database arbitrates
// a double write, never a second decision. The target's mail, holder,
// checkpoint, and withdrawal are plain setters for the pause service; the
// pause closes when every target is decided or the execution finished.
import type { Database } from 'bun:sqlite'
import type { PauseDecision, PauseStage, PlanPause, PlanPauseTarget } from '../../../shared/planRevisionControl'

export type NewPlanPause = Omit<PlanPause, 'id' | 'createdAt' | 'closedAt'>

export type NewPauseTarget = Pick<PlanPauseTarget, 'change' | 'stage' | 'attemptId' | 'assignmentId' | 'holderSession'> & { withdrawn?: boolean }

type Row = Record<string, unknown>

function mapPause(row: Row): PlanPause {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    planId: String(row.plan_id),
    executionId: String(row.execution_id),
    holdId: String(row.hold_id),
    deadline: String(row.deadline),
    note: typeof row.note === 'string' ? row.note : null,
    createdAt: String(row.created_at),
    commandId: String(row.command_id),
    closedAt: typeof row.closed_at === 'string' ? row.closed_at : null,
  }
}

function mapTarget(row: Row): PlanPauseTarget {
  return {
    pauseId: String(row.pause_id),
    change: String(row.change),
    stage: String(row.stage) as PauseStage,
    attemptId: typeof row.attempt_id === 'string' ? row.attempt_id : null,
    assignmentId: String(row.assignment_id),
    holderSession: typeof row.holder_session === 'string' ? row.holder_session : null,
    messageId: typeof row.message_id === 'string' ? row.message_id : null,
    withdrawn: row.withdrawn === 1,
    pausedAt: typeof row.paused_at === 'string' ? row.paused_at : null,
    checkpointId: typeof row.checkpoint_id === 'string' ? row.checkpoint_id : null,
    decision: typeof row.decision === 'string' ? row.decision as PauseDecision : null,
    decisionDetail: typeof row.decision_detail_json === 'string' ? JSON.parse(row.decision_detail_json) as Record<string, unknown> : null,
    decidedAt: typeof row.decided_at === 'string' ? row.decided_at : null,
    decisionCommandId: typeof row.decision_command_id === 'string' ? row.decision_command_id : null,
  }
}

export class PauseStore {
  constructor(readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  /** Insert one pause with its targets; the id is `pause-<uuid>`. */
  insert(input: NewPlanPause, targets: NewPauseTarget[]): PlanPause {
    const id = `pause-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_pauses (id, team_id, plan_id, execution_id, hold_id, deadline, note, created_at, command_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.teamId, input.planId, input.executionId, input.holdId, input.deadline, input.note,
      this.now().toISOString(), input.commandId,
    )
    const insertTarget = this.db.prepare(`INSERT INTO plan_pause_targets (pause_id, change, stage, attempt_id, assignment_id, holder_session, withdrawn)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const target of targets) {
      insertTarget.run(id, target.change, target.stage, target.attemptId, target.assignmentId, target.holderSession, target.withdrawn === true ? 1 : 0)
    }
    return this.get(input.teamId, id)!
  }

  get(teamId: string, pauseId: string): PlanPause | null {
    const row = this.db.prepare('SELECT * FROM plan_pauses WHERE id = ? AND team_id = ?').get(pauseId, teamId) as Row | null
    return row ? mapPause(row) : null
  }

  /** Every pause of the plan, oldest first; `open` keeps only the unclosed ones. */
  forPlan(teamId: string, planId: string, open = false): PlanPause[] {
    const rows = this.db.prepare(`SELECT * FROM plan_pauses WHERE plan_id = ? AND team_id = ?${open ? ' AND closed_at IS NULL' : ''} ORDER BY created_at, rowid`)
      .all(planId, teamId) as Row[]
    return rows.map(mapPause)
  }

  targets(pauseId: string): PlanPauseTarget[] {
    return (this.db.prepare('SELECT * FROM plan_pause_targets WHERE pause_id = ? ORDER BY change').all(pauseId) as Row[]).map(mapTarget)
  }

  target(pauseId: string, change: string): PlanPauseTarget | null {
    const row = this.db.prepare('SELECT * FROM plan_pause_targets WHERE pause_id = ? AND change = ?').get(pauseId, change) as Row | null
    return row ? mapTarget(row) : null
  }

  /** The pause mail's id, and the holder when a spawn's claim arrives after the insert (D6). */
  setMail(pauseId: string, change: string, messageId: string): void {
    this.db.prepare('UPDATE plan_pause_targets SET message_id = ? WHERE pause_id = ? AND change = ?').run(messageId, pauseId, change)
  }

  setHolder(pauseId: string, change: string, holderSession: string): void {
    this.db.prepare('UPDATE plan_pause_targets SET holder_session = ? WHERE pause_id = ? AND change = ?').run(holderSession, pauseId, change)
  }

  setCheckpoint(pauseId: string, change: string, checkpointId: string): void {
    this.db.prepare('UPDATE plan_pause_targets SET checkpoint_id = ? WHERE pause_id = ? AND change = ?').run(checkpointId, pauseId, change)
  }

  /**
   * Record Paused once: the guarded write is a no-op on a target that already
   * reads Paused or decided, and `written` says whether this call wrote it.
   */
  recordPaused(pauseId: string, change: string, checkpointId: string | null): { written: boolean; target: PlanPauseTarget | null } {
    const changes = this.db.prepare('UPDATE plan_pause_targets SET paused_at = ?, checkpoint_id = COALESCE(?, checkpoint_id) WHERE pause_id = ? AND change = ? AND paused_at IS NULL AND decision IS NULL')
      .run(this.now().toISOString(), checkpointId, pauseId, change).changes
    return { written: changes === 1, target: this.target(pauseId, change) }
  }

  /**
   * Record the target's decision once (D9): a second decision on a decided
   * target writes nothing and returns `written: false` with the standing one.
   */
  recordDecision(input: { pauseId: string; change: string; decision: PauseDecision; detail: Record<string, unknown>; commandId: string }): { written: boolean; target: PlanPauseTarget | null } {
    const changes = this.db.prepare(`UPDATE plan_pause_targets SET decision = ?, decision_detail_json = ?, decided_at = ?, decision_command_id = ?
      WHERE pause_id = ? AND change = ? AND decision IS NULL`)
      .run(input.decision, JSON.stringify(input.detail), this.now().toISOString(), input.commandId, input.pauseId, input.change).changes
    return { written: changes === 1, target: this.target(input.pauseId, input.change) }
  }

  /**
   * Close the pause when every target carries a decision (the execution's
   * finish decides the rest); `closed` says whether this call closed it.
   */
  closeIfDecided(pauseId: string): boolean {
    const open = this.db.prepare('SELECT 1 FROM plan_pause_targets WHERE pause_id = ? AND decision IS NULL LIMIT 1').get(pauseId)
    if (open) return false
    return this.db.prepare('UPDATE plan_pauses SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(this.now().toISOString(), pauseId).changes === 1
  }
}
