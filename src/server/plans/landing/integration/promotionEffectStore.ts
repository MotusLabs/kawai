// The promotion effect rows (integration-candidates D3, D10). They are
// `plan_execution_effects`' shape keyed by promotion, because a promotion
// belongs to no execution. Rows are recorded before they run and inspected
// before they repeat. This class is the `EffectQueue` the effects runner
// works through for promotions; `IntegrationStore` extends it, so it is part
// of that store's sole-writer surface over the integration tables.
import type { Database } from 'bun:sqlite'
import type { PromotionEffectKind } from '../../../../shared/planIntegration'
import type { EffectState } from '../../../../shared/planExecution'
import type { EffectQueue } from '../../execution/effects'

export interface PromotionEffectRow {
  id: string
  promotionId: string
  kind: PromotionEffectKind
  effectKey: string
  command: Record<string, unknown>
  state: EffectState
  tries: number
  nextAt: string | null
  outcome: unknown
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

function mapEffect(row: Record<string, unknown>): PromotionEffectRow {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    id: String(row.id), promotionId: String(row.promotion_id), kind: String(row.kind) as PromotionEffectKind,
    effectKey: String(row.effect_key), command: JSON.parse(String(row.command_json)) as Record<string, unknown>,
    state: String(row.state) as EffectState, tries: Number(row.tries ?? 0), nextAt: text(row.next_at),
    outcome: typeof row.outcome_json === 'string' ? JSON.parse(row.outcome_json) as unknown : null,
    error: text(row.error), createdAt: String(row.created_at), startedAt: text(row.started_at), finishedAt: text(row.finished_at),
  }
}

/** A committed write's plan: its team and, when known, the plan whose detail it changes. */
export type IntegrationChangeListener = (teamId: string, planId: string | undefined) => void

/** The states an effect write may still change: a settled effect (done, failed, cancelled) stays settled (O3). */
const OPEN = "state IN ('pending', 'running', 'unknown')"

export class PromotionEffectStore implements EffectQueue<PromotionEffectRow> {
  private readonly listeners = new Set<IntegrationChangeListener>()
  private readonly pending = new Map<string, Set<string | undefined>>()
  private scheduled = false

  constructor(readonly db: Database, protected readonly now: () => Date = () => new Date()) {}

  protected iso(): string { return this.now().toISOString() }

  /**
   * Every candidate, promotion, or effect write (integration-candidates D13):
   * the plan's detail re-pushes. Notices are collected and delivered in a
   * microtask, after the synchronous transaction that wrote them has
   * committed or rolled back, so a view never reads a write mid-transaction.
   */
  subscribe(listener: IntegrationChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected changed(teamId: string, planId: string | undefined): void {
    if (this.listeners.size === 0) return
    const plans = this.pending.get(teamId) ?? new Set<string | undefined>()
    plans.add(planId)
    this.pending.set(teamId, plans)
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const batch = [...this.pending]
      this.pending.clear()
      for (const [team, planIds] of batch) {
        // An unknown plan refreshes every plan of the team, so it subsumes the named ones.
        const targets = planIds.has(undefined) ? [undefined] : [...planIds]
        for (const target of targets) {
          for (const listener of this.listeners) {
            try {
              listener(team, target)
            } catch {
              // A view refresh never fails a write (I2): a throwing listener is dropped for this notice.
            }
          }
        }
      }
    })
  }

  /** Announce a write to the promotion's plan. */
  protected promotionChanged(promotionId: string): void {
    const row = this.db.prepare('SELECT team_id, plan_id FROM plan_promotions WHERE id = ?').get(promotionId) as { team_id: string; plan_id: string } | null
    if (row) this.changed(row.team_id, row.plan_id)
  }

  /** Announce a write to the effect's promotion's plan. */
  protected effectChanged(id: string): void {
    const row = this.db.prepare('SELECT promotion_id FROM plan_promotion_effects WHERE id = ?').get(id) as { promotion_id: string } | null
    if (row) this.promotionChanged(row.promotion_id)
  }

  /** Insert one effect row; idempotent by key, like an execution effect. */
  insertEffect(input: { promotionId: string; kind: PromotionEffectKind; effectKey: string; command: Record<string, unknown> }): PromotionEffectRow {
    const existing = this.effectByKey(input.effectKey)
    if (existing) return existing
    const id = `peffect-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_promotion_effects (id, promotion_id, kind, effect_key, command_json, state, tries, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`).run(id, input.promotionId, input.kind, input.effectKey, JSON.stringify(input.command), this.iso())
    this.promotionChanged(input.promotionId)
    return this.effect(id)!
  }

  effect(id: string): PromotionEffectRow | null {
    const row = this.db.prepare('SELECT * FROM plan_promotion_effects WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? mapEffect(row) : null
  }

  effectByKey(effectKey: string): PromotionEffectRow | null {
    const row = this.db.prepare('SELECT * FROM plan_promotion_effects WHERE effect_key = ?').get(effectKey) as Record<string, unknown> | null
    return row ? mapEffect(row) : null
  }

  promotionEffects(promotionId: string): PromotionEffectRow[] {
    return (this.db.prepare('SELECT * FROM plan_promotion_effects WHERE promotion_id = ? ORDER BY created_at, rowid').all(promotionId) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /**
   * The team's due pending promotion effects, oldest first, across its
   * running promotions. A finished promotion's `close-pr` stays due, because
   * the finish must not strand it (D10).
   */
  dueEffects(teamId: string, now: string): PromotionEffectRow[] {
    return (this.db.prepare(`SELECT e.* FROM plan_promotion_effects e
      JOIN plan_promotions p ON p.id = e.promotion_id
      WHERE p.team_id = ? AND (p.state = 'running' OR e.kind = 'close-pr')
        AND e.state = 'pending' AND (e.next_at IS NULL OR e.next_at <= ?)
      ORDER BY e.created_at, e.rowid`).all(teamId, now) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /** Marks an open effect running; false when it had already settled (O3) — the runner then never calls the adapter, and a no-op mark announces nothing. */
  markEffectRunning(id: string): boolean {
    const result = this.db.prepare(`UPDATE plan_promotion_effects SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND ${OPEN}`).run(this.iso(), id)
    const took = result.changes === 1
    if (took) this.effectChanged(id)
    return took
  }

  /**
   * Settles an open effect. Every write after an await is guarded on an open
   * state (O3), so a Cancel or finish that settled the effect meanwhile wins.
   */
  setEffectOutcome(id: string, outcome: { state: 'done' | 'failed' | 'unknown' | 'cancelled'; outcome?: unknown; error?: string | null }): void {
    this.db.prepare(`UPDATE plan_promotion_effects SET state = ?, outcome_json = ?, error = ?, finished_at = ? WHERE id = ? AND ${OPEN}`).run(
      outcome.state, outcome.outcome === undefined ? null : JSON.stringify(outcome.outcome), outcome.error ?? null, this.iso(), id,
    )
    this.effectChanged(id)
  }

  scheduleEffectRetry(id: string, nextAt: string, error: string | null): void {
    this.reopen(id, "UPDATE plan_promotion_effects SET state = 'pending', tries = tries + 1, next_at = ?, error = ? WHERE id = ? AND " + OPEN, nextAt, error, id)
  }

  /**
   * Puts an open effect back in the queue — unless its promotion finished
   * meanwhile and it is not the finish's `close-pr`: then it is cancelled
   * like the finish's own sweep, so no zombie pending row outlives it (O3).
   */
  private reopen(id: string, sql: string, ...args: Array<string | null>): void {
    this.db.transaction(() => {
      this.db.prepare(sql).run(...args)
      this.db.prepare(`UPDATE plan_promotion_effects SET state = 'cancelled', finished_at = ? WHERE id = ? AND state IN ('pending', 'unknown')
        AND kind <> 'close-pr' AND NOT EXISTS (SELECT 1 FROM plan_promotions p WHERE p.id = promotion_id AND p.state = 'running')`).run(this.iso(), id)
    })()
    this.effectChanged(id)
  }

  /** A failure or a Cancel before the merge cancels the promotion's pending and uninspected effects (D9, D10). */
  cancelPromotionEffects(promotionId: string): void {
    this.db.prepare("UPDATE plan_promotion_effects SET state = 'cancelled', finished_at = ? WHERE promotion_id = ? AND state IN ('pending', 'unknown')").run(this.iso(), promotionId)
    this.promotionChanged(promotionId)
  }

  /** The team's due unknown promotion effects, oldest first: each is inspected before it repeats (D14, review L1). */
  dueUnknownEffects(teamId: string, now: string): PromotionEffectRow[] {
    return (this.db.prepare(`SELECT e.* FROM plan_promotion_effects e
      JOIN plan_promotions p ON p.id = e.promotion_id
      WHERE p.team_id = ? AND (p.state = 'running' OR e.kind = 'close-pr')
        AND e.state = 'unknown' AND (e.next_at IS NULL OR e.next_at <= ?)
      ORDER BY e.created_at, e.rowid`).all(teamId, now) as Array<Record<string, unknown>>)
      .map(mapEffect)
  }

  /** An inspection that found the work not done puts the effect back to pending, to run again. */
  resetEffect(id: string): void {
    this.reopen(id, "UPDATE plan_promotion_effects SET state = 'pending', next_at = NULL WHERE id = ? AND " + OPEN, id)
  }

  /** An undecidable inspection stays `unknown`, one try counted, retrying at `nextAt`. */
  scheduleInspectionRetry(id: string, nextAt: string, error: string | null): void {
    this.reopen(id, "UPDATE plan_promotion_effects SET state = 'unknown', tries = tries + 1, next_at = ?, error = ? WHERE id = ? AND " + OPEN, nextAt, error, id)
  }

  /** The effect running now for the promotion, if any (Cancel lets a running merge settle). */
  runningEffect(promotionId: string): PromotionEffectRow | null {
    const row = this.db.prepare("SELECT * FROM plan_promotion_effects WHERE promotion_id = ? AND state = 'running' ORDER BY created_at DESC LIMIT 1").get(promotionId) as Record<string, unknown> | null
    return row ? mapEffect(row) : null
  }

  /** Startup recovery: a `running` promotion effect's process is gone, so it becomes `unknown` and is inspected before it repeats. */
  markRunningPromotionEffectsUnknown(): PromotionEffectRow[] {
    return this.db.transaction(() => {
      const rows = (this.db.prepare("SELECT * FROM plan_promotion_effects WHERE state = 'running'").all() as Array<Record<string, unknown>>).map(mapEffect)
      const update = this.db.prepare("UPDATE plan_promotion_effects SET state = 'unknown' WHERE id = ?")
      for (const row of rows) {
        update.run(row.id)
        this.effectChanged(row.id)
      }
      return rows
    })()
  }
}
