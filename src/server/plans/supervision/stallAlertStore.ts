// Stall-alert store (plan-supervision design D3, D11): the only SQL writer
// of `plan_stall_alerts`. One row per stall episode, keyed by execution,
// change, kind, and the durable episode key, so a restart during a stall
// finds the row and raises nothing new. `insert` answers whether this call
// wrote the row; a second insert of an episode returns the existing one
// instead. A null `messageId` records a stall of a plan without a Lead role,
// for which no mail is sent. Reads are scoped by team.
import type { Database } from 'bun:sqlite'
import type { SupervisionStall } from '../../../shared/planSupervision'

export interface StallAlert {
  id: string
  teamId: string
  planId: string
  executionId: string
  change: string
  kind: SupervisionStall['kind']
  episodeKey: string
  detail: Record<string, unknown>
  messageId: string | null
  raisedAt: string
}

export type NewStallAlert = Omit<StallAlert, 'id' | 'raisedAt'>

type Row = Record<string, unknown>

function mapAlert(row: Row): StallAlert {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    planId: String(row.plan_id),
    executionId: String(row.execution_id),
    change: String(row.change),
    kind: String(row.kind) as StallAlert['kind'],
    episodeKey: String(row.episode_key),
    detail: JSON.parse(String(row.detail_json)) as Record<string, unknown>,
    messageId: typeof row.message_id === 'string' ? row.message_id : null,
    raisedAt: String(row.raised_at),
  }
}

export class StallAlertStore {
  constructor(readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  /** Record an episode's alert once: `inserted` is false, with the stored row, when the episode already has one. */
  insert(input: NewStallAlert): { inserted: boolean; alert: StallAlert } {
    const id = `stall-${crypto.randomUUID()}`
    const changes = this.db.prepare(`INSERT INTO plan_stall_alerts (id, team_id, plan_id, execution_id, change, kind, episode_key, detail_json, message_id, raised_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (execution_id, change, kind, episode_key) DO NOTHING`).run(
      id, input.teamId, input.planId, input.executionId, input.change, input.kind, input.episodeKey, JSON.stringify(input.detail),
      input.messageId, this.now().toISOString(),
    ).changes
    const row = this.db.prepare('SELECT * FROM plan_stall_alerts WHERE execution_id = ? AND change = ? AND kind = ? AND episode_key = ?')
      .get(input.executionId, input.change, input.kind, input.episodeKey) as Row
    return { inserted: changes === 1, alert: mapAlert(row) }
  }

  episode(teamId: string, executionId: string, change: string, kind: StallAlert['kind'], episodeKey: string): StallAlert | null {
    const row = this.db.prepare('SELECT * FROM plan_stall_alerts WHERE team_id = ? AND execution_id = ? AND change = ? AND kind = ? AND episode_key = ?')
      .get(teamId, executionId, change, kind, episodeKey) as Row | null
    return row ? mapAlert(row) : null
  }

  ofPlan(teamId: string, planId: string): StallAlert[] {
    return (this.db.prepare('SELECT * FROM plan_stall_alerts WHERE team_id = ? AND plan_id = ? ORDER BY raised_at, rowid').all(teamId, planId) as Row[]).map(mapAlert)
  }

  /** Alerts raised at or after `since` (the summary window, D13). */
  raisedSince(teamId: string, since: string): StallAlert[] {
    return (this.db.prepare('SELECT * FROM plan_stall_alerts WHERE team_id = ? AND raised_at >= ? ORDER BY raised_at, rowid').all(teamId, since) as Row[]).map(mapAlert)
  }
}
