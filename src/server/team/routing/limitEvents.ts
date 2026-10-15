// Per-profile limit events (profile-routing design D6/D7): every rate-limit,
// billing, or overload failure a chat agent hits is recorded with its
// profile, session, group, HTTP status, raw message, and the provider's reset
// time when known — retried attempts as `final: false`, the turn's failure as
// `final: true`. Rows persist (routing must still see them after a restart)
// and are pruned after 24 hours. Cooldown is computed from them on read and
// never stored, so changing the policy needs no migration.
import type { Database } from 'bun:sqlite'
import type { LimitEvent } from '../../../shared/routing'

export type { LimitEvent } from '../../../shared/routing'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS profile_limit_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  group_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  final INTEGER NOT NULL,
  status INTEGER,
  message TEXT,
  resets_at TEXT
);
CREATE INDEX IF NOT EXISTS profile_limit_events_profile ON profile_limit_events (profile_id, at);
`

/** How long events are kept. */
export const LIMIT_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000
/** Built-in cooldown when the provider gave no reset time. */
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000

export type LimitEventInput = Omit<LimitEvent, 'id' | 'at'> & { at?: string }

interface Row {
  id: string
  profile_id: string
  session_id: string
  group_id: string | null
  at: string
  kind: string
  final: number
  status: number | null
  message: string | null
  resets_at: string | null
}

const fromRow = (row: Row): LimitEvent => ({
  id: row.id,
  profileId: row.profile_id,
  sessionId: row.session_id,
  groupId: row.group_id,
  at: row.at,
  kind: row.kind,
  final: row.final === 1,
  status: row.status,
  message: row.message,
  resetsAt: row.resets_at,
})

/** Create the table; part of the frozen baseline step (execution-safety-recovery D13): the baseline step calls this, never the store. */
export function ensureLimitEventSchema(db: Database): void {
  db.exec(CREATE_TABLE_SQL)
}

export class LimitEventStore {
  private readonly listeners = new Set<(event: LimitEvent) => void>()

  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    this.prune()
  }

  /** Called after every recorded event (routing re-evaluates, outcomes resolve). */
  subscribe(listener: (event: LimitEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  record(input: LimitEventInput): LimitEvent {
    const event: LimitEvent = {
      id: crypto.randomUUID(),
      profileId: input.profileId,
      sessionId: input.sessionId,
      groupId: input.groupId,
      at: input.at ?? new Date(this.now()).toISOString(),
      kind: input.kind,
      final: input.final,
      status: input.status,
      message: input.message,
      resetsAt: input.resetsAt,
    }
    this.prune()
    this.db.prepare(`INSERT INTO profile_limit_events
      (id, profile_id, session_id, group_id, at, kind, final, status, message, resets_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id, event.profileId, event.sessionId, event.groupId, event.at, event.kind,
      event.final ? 1 : 0, event.status, event.message, event.resetsAt)
    for (const listener of this.listeners) listener(event)
    return event
  }

  /** Drop events older than the retention window. */
  prune(): void {
    const cutoff = new Date(this.now() - LIMIT_EVENT_RETENTION_MS).toISOString()
    this.db.prepare('DELETE FROM profile_limit_events WHERE at < ?').run(cutoff)
  }

  /** A profile's retained events, oldest first. */
  forProfile(profileId: string): LimitEvent[] {
    const cutoff = new Date(this.now() - LIMIT_EVENT_RETENTION_MS).toISOString()
    return (this.db.prepare('SELECT * FROM profile_limit_events WHERE profile_id = ? AND at >= ? ORDER BY at, rowid')
      .all(profileId, cutoff) as Row[]).map(fromRow)
  }

  /** The built-in cooldown end of a profile (ISO), or null when not cooling. */
  cooldownUntil(profileId: string): string | null {
    return cooldownUntil(this.forProfile(profileId), this.now())
  }
}

/**
 * Built-in cooldown (design D7): the latest final event's reset time, else
 * (unknown or unparseable) one hour after it. Retried attempts never cool a profile. Null once over.
 */
export function cooldownUntil(events: readonly LimitEvent[], now: number): string | null {
  let latest: LimitEvent | null = null
  for (const event of events) {
    if (event.final && (!latest || Date.parse(event.at) >= Date.parse(latest.at))) latest = event
  }
  if (!latest) return null
  const reset = latest.resetsAt ? Date.parse(latest.resetsAt) : NaN
  const until = Number.isFinite(reset) ? reset : Date.parse(latest.at) + DEFAULT_COOLDOWN_MS
  return Number.isFinite(until) && until > now ? new Date(until).toISOString() : null
}
