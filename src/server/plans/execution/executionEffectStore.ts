// The effect rows of plan execution (design D14): recorded before they run,
// inspected before they repeat. ExecutionStore extends this class, so every
// caller keeps reaching these through the store; it holds the connection and
// the clock both halves share. Split out only to keep each file under 500
// lines — no behavior of its own.
import type { Database } from 'bun:sqlite'
import type { EffectKind } from '../../../shared/planExecution'
import { mapEffect, type EffectRow } from './executionRows'

export class ExecutionEffectStore {
  constructor(readonly db: Database, protected readonly now: () => Date = () => new Date()) {}

  protected iso(): string { return this.now().toISOString() }

  /**
   * Insert one effect row; idempotent by key — a step re-enqueued after a
   * restart returns the recorded row and never writes a second.
   */
  insertEffect(input: { executionId: string; change: string | null; roundId: string | null; kind: EffectKind; effectKey: string; command: Record<string, unknown> }): EffectRow {
    const existing = this.effectByKey(input.effectKey)
    if (existing) return existing
    const id = `effect-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_execution_effects (id, execution_id, change, round_id, kind, effect_key, command_json, state, tries, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`).run(
      id, input.executionId, input.change, input.roundId, input.kind, input.effectKey, JSON.stringify(input.command), this.iso(),
    )
    return this.effect(id)!
  }

  effect(id: string): EffectRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_effects WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? mapEffect(row) : null
  }

  effectByKey(effectKey: string): EffectRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_effects WHERE effect_key = ?').get(effectKey) as Record<string, unknown> | null
    return row ? mapEffect(row) : null
  }

  effectsOf(executionId: string): EffectRow[] {
    return (this.db.prepare('SELECT * FROM plan_execution_effects WHERE execution_id = ? ORDER BY created_at, rowid').all(executionId) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /**
   * The team's due pending effects, oldest first, across its running
   * executions (D5: one at a time per team). A finished execution's cleanup
   * (`remove-worktree`) stays due: the completion must not strand it.
   */
  dueEffects(teamId: string, now: string): EffectRow[] {
    return (this.db.prepare(`SELECT e.* FROM plan_execution_effects e
      JOIN plan_executions x ON x.id = e.execution_id
      WHERE x.team_id = ? AND (x.state = 'running' OR e.kind = 'remove-worktree')
        AND e.state = 'pending' AND (e.next_at IS NULL OR e.next_at <= ?)
      ORDER BY e.created_at, e.rowid`).all(teamId, now) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  markEffectRunning(id: string): void {
    this.db.prepare("UPDATE plan_execution_effects SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(this.iso(), id)
  }

  /** Commit a settled outcome (done, failed, unknown, cancelled) with its facts. */
  setEffectOutcome(id: string, outcome: { state: 'done' | 'failed' | 'unknown' | 'cancelled'; outcome?: unknown; error?: string | null }): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = ?, outcome_json = ?, error = ?, finished_at = ? WHERE id = ?`).run(
      outcome.state, outcome.outcome === undefined ? null : JSON.stringify(outcome.outcome), outcome.error ?? null, this.iso(), id,
    )
  }

  /** A transient failure goes back to pending, one try counted, retrying at `nextAt` (D14's backoff). */
  scheduleEffectRetry(id: string, nextAt: string, error: string | null): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = 'pending', tries = tries + 1, next_at = ?, error = ? WHERE id = ?`).run(nextAt, error, id)
  }

  /** Stop cancels every pending effect of the execution (D12). */
  cancelEffects(executionId: string): void {
    this.db.prepare("UPDATE plan_execution_effects SET state = 'cancelled', finished_at = ? WHERE execution_id = ? AND state = 'pending'").run(this.iso(), executionId)
  }

  /** Startup recovery (D14): a `running` effect's process is gone — it becomes `unknown`, inspected before it repeats. */
  markRunningEffectsUnknown(): EffectRow[] {
    return this.db.transaction(() => {
      const rows = (this.db.prepare("SELECT * FROM plan_execution_effects WHERE state = 'running'").all() as Array<Record<string, unknown>>).map(mapEffect)
      const update = this.db.prepare("UPDATE plan_execution_effects SET state = 'unknown' WHERE id = ?")
      for (const row of rows) update.run(row.id)
      return rows
    })()
  }

  /**
   * The done provision effects that created `branch` (D6): a name that
   * exists is accepted only when one of these belongs to an execution of
   * the same plan.
   */
  doneProvisions(branch: string): Array<{ executionId: string; command: Record<string, unknown> }> {
    return (this.db.prepare(`SELECT * FROM plan_execution_effects WHERE kind = 'provision' AND state = 'done'`)
      .all() as Array<Record<string, unknown>>)
      .map(mapEffect)
      .filter(effect => effect.command.branch === branch)
      .map(effect => ({ executionId: effect.executionId, command: effect.command }))
  }

  /** The due `unknown` effects, oldest first — inspected before anything else for their change runs (D14). */
  dueUnknownEffects(now: string): EffectRow[] {
    return (this.db.prepare(`SELECT e.* FROM plan_execution_effects e
      JOIN plan_executions x ON x.id = e.execution_id
      WHERE x.state = 'running' AND e.state = 'unknown' AND (e.next_at IS NULL OR e.next_at <= ?)
      ORDER BY e.created_at, e.rowid`).all(now) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /** An inspection that found the work not done puts the effect back to pending, to run again (D14). */
  resetEffect(id: string): void {
    this.db.prepare("UPDATE plan_execution_effects SET state = 'pending', next_at = NULL WHERE id = ?").run(id)
  }

  /** An undecidable inspection stays `unknown`, one try counted, retrying at `nextAt` (D14). */
  scheduleInspectionRetry(id: string, nextAt: string, error: string | null): void {
    this.db.prepare("UPDATE plan_execution_effects SET state = 'unknown', tries = tries + 1, next_at = ?, error = ? WHERE id = ?").run(nextAt, error, id)
  }
}
