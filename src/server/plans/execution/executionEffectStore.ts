// The effect rows of plan execution (design D14): recorded before they run,
// inspected before they repeat. ExecutionStore extends this class, so every
// caller keeps reaching these through the store; it holds the connection and
// the clock both halves share. Split out only to keep each file under 500
// lines — no behavior of its own.
import type { Database } from 'bun:sqlite'
import type { EffectKind } from '../../../shared/planExecution'
import { canonicalJson } from '../../../shared/productStrategy'
import { mapEffect, type EffectRow } from './executionRows'

/** The states an effect write may still change: a settled effect (done, failed, cancelled) stays settled (O3). */
const OPEN = "state IN ('pending', 'running', 'unknown')"

/**
 * A1 (effect lifecycle): a live effect of one identity was issued again with
 * a different command. Nothing is inserted or adopted — the caller keeps its
 * step and waits, because the live row's verdict is what decides the change
 * (I-B); running the re-derived command instead could act twice.
 */
export class EffectPinConflict extends Error {
  constructor(readonly effectId: string, readonly kind: string) {
    super(`effect ${effectId} (${kind}) is live with a different command; waiting for it to settle`)
    this.name = 'EffectPinConflict'
  }
}

/** Whether the row is still open to change (A1's live set). */
const isLive = (state: string): boolean => state === 'pending' || state === 'running' || state === 'unknown'

/**
 * Whether insertEffect applies A1's identity predicate. Every kind but
 * `provision` has one: the round effects (push, rerun, open-pr, merge,
 * update-branch, fast-forward, remove-worktree) key by (execution, change,
 * kind, round), the execution-level `create-integration` by (execution,
 * kind) — change null. Provision keeps the planner's standing check, which
 * already serializes it (a provisioning change plans nothing else).
 */
const hasIdentity = (kind: EffectKind): boolean => kind !== 'provision'

export class ExecutionEffectStore {
  constructor(readonly db: Database, protected readonly now: () => Date = () => new Date()) {}

  protected iso(): string { return this.now().toISOString() }

  /**
   * Insert one effect row; idempotent by key — a step re-enqueued after a
   * restart returns the recorded row and never writes a second. A1: while a
   * live row of the same identity stands, the insert adopts it only when the
   * command matches its pin (a re-derived command is a deterministic
   * re-computation of the same facts) and refuses with `EffectPinConflict`
   * otherwise; a row of another identity is never adopted.
   */
  insertEffect(input: { executionId: string; change: string | null; roundId: string | null; kind: EffectKind; effectKey: string; command: Record<string, unknown> }): EffectRow {
    const pin = hasIdentity(input.kind) ? canonicalJson(input.command) : ''
    const existing = this.effectByKey(input.effectKey)
    if (existing) {
      if (pin !== '' && isLive(existing.state) && canonicalJson(existing.command) !== pin) throw new EffectPinConflict(existing.id, existing.kind)
      return existing
    }
    if (pin !== '') {
      const live = this.liveOfIdentity(input.executionId, input.change, input.kind, input.roundId)
      if (live !== null) {
        if (canonicalJson(live.command) !== pin) throw new EffectPinConflict(live.id, live.kind)
        return live
      }
    }
    const id = `effect-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_execution_effects (id, execution_id, change, round_id, kind, effect_key, command_json, state, tries, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`).run(
      id, input.executionId, input.change, input.roundId, input.kind, input.effectKey, JSON.stringify(input.command), this.iso(),
    )
    return this.effect(id)!
  }

  /** The newest live row of one A1 identity, or null. */
  private liveOfIdentity(executionId: string, change: string | null, kind: EffectKind, roundId: string | null): EffectRow | null {
    const row = this.db.prepare(`SELECT * FROM plan_execution_effects
      WHERE execution_id = ? AND change IS ? AND kind = ? AND round_id IS ? AND ${OPEN}
      ORDER BY created_at, rowid DESC LIMIT 1`).get(executionId, change, kind, roundId) as Record<string, unknown> | null
    return row ? mapEffect(row) : null
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
   * A8's slot rule: a landing-kind row of a change runs only while the
   * change holds the landing slot (`landing`) — a row left waiting by the
   * Retry's slot-taken fallback settles first, and its verdict is applied
   * when the change holds the slot again.
   */
  dueEffects(teamId: string, now: string): EffectRow[] {
    return (this.db.prepare(`SELECT e.* FROM plan_execution_effects e
      JOIN plan_executions x ON x.id = e.execution_id
      LEFT JOIN plan_execution_changes c ON c.execution_id = e.execution_id AND c.change = e.change
      WHERE x.team_id = ? AND (x.state = 'running' OR e.kind = 'remove-worktree')
        AND e.state = 'pending' AND (e.next_at IS NULL OR e.next_at <= ?)
        AND NOT (e.kind IN ('merge', 'update-branch', 'fast-forward') AND e.change IS NOT NULL AND (c.state IS NULL OR c.state <> 'landing'))
      ORDER BY e.created_at, e.rowid`).all(teamId, now) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /** Marks an open effect running; false when it had already settled (O3) — the runner then never calls the adapter. */
  markEffectRunning(id: string): boolean {
    const result = this.db.prepare(`UPDATE plan_execution_effects SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND ${OPEN}`).run(this.iso(), id)
    return result.changes === 1
  }

  /** Commit a settled outcome (done, failed, unknown, cancelled) with its facts; a settled row is never rewritten. */
  setEffectOutcome(id: string, outcome: { state: 'done' | 'failed' | 'unknown' | 'cancelled'; outcome?: unknown; error?: string | null }): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = ?, outcome_json = ?, error = ?, finished_at = ? WHERE id = ? AND ${OPEN}`).run(
      outcome.state, outcome.outcome === undefined ? null : JSON.stringify(outcome.outcome), outcome.error ?? null, this.iso(), id,
    )
  }

  /** A transient failure goes back to pending, one try counted, retrying at `nextAt` (D14's backoff). */
  scheduleEffectRetry(id: string, nextAt: string, error: string | null): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = 'pending', tries = tries + 1, next_at = ?, error = ? WHERE id = ? AND ${OPEN}`).run(nextAt, error, id)
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

  /**
   * The due `unknown` effects, oldest first — inspected before anything else
   * for their change runs (D14); one team's, or every team's at startup.
   * A4: every execution's unknowns are due, a stopped or completed one
   * included — a row left unknown when its execution finished is still
   * inspected until it settles or its inspection exhausts, never forever
   * (the backoff bounds it); running them stays gated by `dueEffects`.
   */
  dueUnknownEffects(now: string, teamId?: string): EffectRow[] {
    return (this.db.prepare(`SELECT e.* FROM plan_execution_effects e
      JOIN plan_executions x ON x.id = e.execution_id
      WHERE e.state = 'unknown' AND (e.next_at IS NULL OR e.next_at <= ?)
      ${teamId === undefined ? '' : 'AND x.team_id = ?'}
      ORDER BY e.created_at, e.rowid`).all(...(teamId === undefined ? [now] : [now, teamId])) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /** An inspection that found the work not done puts the effect back to pending, to run again (D14). */
  resetEffect(id: string): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = 'pending', next_at = NULL WHERE id = ? AND ${OPEN}`).run(id)
  }

  /**
   * The human Retry's reset after an `effect-unknown` stop: the one writer a
   * settled row obeys. Only a `failed` row re-opens — done and cancelled stay
   * settled — and it re-enters inspection (`unknown`), never `pending`: the
   * row stopped as unknown because its outcome could not be decided, so an
   * inspection must answer it before it ever runs again; only an inspected
   * not-done effect returns to `pending` (resetEffect). The inspection budget
   * is fresh (A3): the tries the exhausted inspection spent are not carried
   * into the retry's own. Synchronous, in the retry's own transaction —
   * never a late write after an await (O3).
   */
  retryFailedEffect(id: string): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = 'unknown', tries = 0, next_at = NULL WHERE id = ? AND state = 'failed'`).run(id)
  }

  /** An undecidable inspection stays `unknown`, one try counted, retrying at `nextAt` (D14). */
  scheduleInspectionRetry(id: string, nextAt: string, error: string | null): void {
    this.db.prepare(`UPDATE plan_execution_effects SET state = 'unknown', tries = tries + 1, next_at = ?, error = ? WHERE id = ? AND ${OPEN}`).run(nextAt, error, id)
  }
}
