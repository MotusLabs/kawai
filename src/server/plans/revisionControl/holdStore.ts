// Hold store (revision-control design D2, D4): the only SQL writer of
// `plan_holds` and `plan_hold_changes`. A release has a row (stored, not
// derived): whole-hold releases stamp `released_at` on the hold guarded by
// `WHERE released_at IS NULL`, and per-change releases stamp the change's
// rows, releasing the hold itself once no change row remains. Reads are
// scoped by team. The extend writes the later deadline in place; the history
// lives in `plan_events`.
import type { Database } from 'bun:sqlite'
import type { HoldCites, HoldScope, PlanHold } from '../../../shared/planRevisionControl'

/** What placing a hold writes: the store mints the id and stamps `createdAt`; release fields are the release's. */
export type NewPlanHold = Omit<PlanHold, 'id' | 'createdAt' | 'releasedAt' | 'releaseReason' | 'releaseCommandId' | 'changes'> & {
  id?: string
  changes: string[]
}

type Row = Record<string, unknown>

function mapHold(row: Row, changes: string[]): PlanHold {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    planId: String(row.plan_id),
    scope: String(row.scope) as HoldScope,
    rationale: String(row.rationale),
    deadline: String(row.deadline),
    cites: row.cites_kind && row.cites_id ? { kind: String(row.cites_kind) as HoldCites['kind'], id: String(row.cites_id) } : null,
    createdAt: String(row.created_at),
    commandId: String(row.command_id),
    releasedAt: typeof row.released_at === 'string' ? row.released_at : null,
    releaseReason: typeof row.release_reason === 'string' ? row.release_reason : null,
    releaseCommandId: typeof row.release_command_id === 'string' ? row.release_command_id : null,
    changes,
  }
}

export class HoldStore {
  constructor(readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  /** Insert one hold with its change rows; the id is `hold-<uuid>`. */
  insert(input: NewPlanHold): PlanHold {
    const id = input.id || `hold-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_holds (id, team_id, plan_id, scope, rationale, deadline, cites_kind, cites_id, created_at, command_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.teamId, input.planId, input.scope, input.rationale, input.deadline,
      input.cites?.kind ?? null, input.cites?.id ?? null, this.now().toISOString(), input.commandId,
    )
    const insertChange = this.db.prepare('INSERT INTO plan_hold_changes (hold_id, change) VALUES (?, ?)')
    for (const change of input.scope === 'changes' ? input.changes : []) insertChange.run(id, change)
    return this.get(input.teamId, id)!
  }

  /** One hold of the team, with its still-held changes; null for another team's. */
  get(teamId: string, holdId: string): PlanHold | null {
    const row = this.db.prepare('SELECT * FROM plan_holds WHERE id = ? AND team_id = ?').get(holdId, teamId) as Row | null
    if (!row) return null
    return mapHold(row, this.changesOf(holdId))
  }

  /** Every hold of the plan, active first (oldest first within each group). */
  forPlan(teamId: string, planId: string): PlanHold[] {
    const rows = this.db.prepare('SELECT * FROM plan_holds WHERE plan_id = ? AND team_id = ? ORDER BY created_at, rowid').all(planId, teamId) as Row[]
    return rows.map(row => mapHold(row, this.changesOf(String(row.id))))
  }

  active(teamId: string, planId: string): PlanHold[] {
    return this.forPlan(teamId, planId).filter(hold => hold.releasedAt === null)
  }

  /**
   * Release the whole hold (no `changes`), or only the named change rows of a
   * changes-scoped hold. Guarded: an already-released row is left alone and
   * `written` is false. The hold itself releases once no change row remains.
   */
  release(input: { teamId: string; holdId: string; changes: string[]; reason: string; commandId: string }): { written: boolean; hold: PlanHold | null } {
    const at = this.now().toISOString()
    const hold = this.get(input.teamId, input.holdId)
    if (!hold || hold.releasedAt !== null) return { written: false, hold }
    let written = false
    if (hold.scope === 'plan' || input.changes.length === 0) {
      written = this.db.prepare('UPDATE plan_holds SET released_at = ?, release_reason = ?, release_command_id = ? WHERE id = ? AND released_at IS NULL')
        .run(at, input.reason, input.commandId, input.holdId).changes === 1
    } else {
      const releaseChange = this.db.prepare('UPDATE plan_hold_changes SET released_at = ?, release_command_id = ? WHERE hold_id = ? AND change = ? AND released_at IS NULL')
      for (const change of input.changes) {
        written = releaseChange.run(at, input.commandId, input.holdId, change).changes === 1 || written
      }
      const remaining = this.db.prepare('SELECT 1 FROM plan_hold_changes WHERE hold_id = ? AND released_at IS NULL LIMIT 1').get(input.holdId)
      if (!remaining) {
        this.db.prepare('UPDATE plan_holds SET released_at = ?, release_reason = ?, release_command_id = ? WHERE id = ? AND released_at IS NULL')
          .run(at, input.reason, input.commandId, input.holdId)
      }
    }
    return { written, hold: this.get(input.teamId, input.holdId) }
  }

  /** Set a later deadline on an active hold; the write lands only while it is active. */
  extend(input: { teamId: string; holdId: string; deadline: string }): boolean {
    const hold = this.get(input.teamId, input.holdId)
    if (!hold || hold.releasedAt !== null) return false
    return this.db.prepare('UPDATE plan_holds SET deadline = ? WHERE id = ? AND released_at IS NULL')
      .run(input.deadline, input.holdId).changes === 1
  }

  private changesOf(holdId: string): string[] {
    return (this.db.prepare('SELECT change FROM plan_hold_changes WHERE hold_id = ? AND released_at IS NULL ORDER BY change').all(holdId) as Array<{ change: string }>)
      .map(row => row.change)
  }
}
