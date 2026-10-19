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

export class PromotionEffectStore implements EffectQueue<PromotionEffectRow> {
  constructor(readonly db: Database, protected readonly now: () => Date = () => new Date()) {}

  protected iso(): string { return this.now().toISOString() }

  /** Insert one effect row; idempotent by key, like an execution effect. */
  insertEffect(input: { promotionId: string; kind: PromotionEffectKind; effectKey: string; command: Record<string, unknown> }): PromotionEffectRow {
    const existing = this.effectByKey(input.effectKey)
    if (existing) return existing
    const id = `peffect-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_promotion_effects (id, promotion_id, kind, effect_key, command_json, state, tries, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`).run(id, input.promotionId, input.kind, input.effectKey, JSON.stringify(input.command), this.iso())
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

  markEffectRunning(id: string): void {
    this.db.prepare("UPDATE plan_promotion_effects SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(this.iso(), id)
  }

  setEffectOutcome(id: string, outcome: { state: 'done' | 'failed' | 'unknown' | 'cancelled'; outcome?: unknown; error?: string | null }): void {
    this.db.prepare('UPDATE plan_promotion_effects SET state = ?, outcome_json = ?, error = ?, finished_at = ? WHERE id = ?').run(
      outcome.state, outcome.outcome === undefined ? null : JSON.stringify(outcome.outcome), outcome.error ?? null, this.iso(), id,
    )
  }

  scheduleEffectRetry(id: string, nextAt: string, error: string | null): void {
    this.db.prepare("UPDATE plan_promotion_effects SET state = 'pending', tries = tries + 1, next_at = ?, error = ? WHERE id = ?").run(nextAt, error, id)
  }

  /** A failure or a Cancel before the merge cancels the promotion's pending effects (D9, D10). */
  cancelPromotionEffects(promotionId: string): void {
    this.db.prepare("UPDATE plan_promotion_effects SET state = 'cancelled', finished_at = ? WHERE promotion_id = ? AND state = 'pending'").run(this.iso(), promotionId)
  }

  /** Startup recovery: a `running` promotion effect's process is gone, so it becomes `unknown` and is inspected before it repeats. */
  markRunningPromotionEffectsUnknown(): PromotionEffectRow[] {
    return this.db.transaction(() => {
      const rows = (this.db.prepare("SELECT * FROM plan_promotion_effects WHERE state = 'running'").all() as Array<Record<string, unknown>>).map(mapEffect)
      const update = this.db.prepare("UPDATE plan_promotion_effects SET state = 'unknown' WHERE id = ?")
      for (const row of rows) update.run(row.id)
      return rows
    })()
  }
}
