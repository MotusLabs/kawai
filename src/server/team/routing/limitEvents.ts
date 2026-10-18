// Per-profile limit events (profile-routing design D6/D7): every rate-limit,
// billing, or overload failure a chat agent hits is recorded with its
// profile, session, group, HTTP status, raw message, and the provider's reset
// time when known — retried attempts as `final: false`, the turn's failure as
// `final: true`. Rows persist (routing must still see them after a restart)
// and are pruned after 15 days, so process metrics (team-process-metrics D8)
// can read a 7-day window with its 7-day baseline; routing still reads only
// the last 24 hours. Cooldown is computed from them on read and never
// stored, so changing the policy needs no migration; `coolingTimeline`
// reconstructs past cooling by the same rule.
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

/** How far back routing reads: `forProfile` and `cooldownUntil` see only this window. */
export const LIMIT_EVENT_READ_WINDOW_MS = 24 * 60 * 60 * 1000
/** How long events are kept (process metrics read 14 days plus the read window). */
export const LIMIT_EVENT_RETENTION_MS = 15 * 24 * 60 * 60 * 1000
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
  provider_id: string | null
  limit_window: string | null
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
  providerId: row.provider_id,
  window: row.limit_window,
})

/** Create the table; part of the frozen baseline step (execution-safety-recovery D13): the baseline step calls this, never the store. */
export function ensureLimitEventSchema(db: Database): void {
  db.exec(CREATE_TABLE_SQL)
}

/**
 * Migration 10 `provider-limit-window` (providers-and-workers D7): the two
 * nullable columns beside the frozen baseline table. Rows written before it
 * read with `providerId: null` — their profile alone cools. The guard keeps
 * re-application (schemaDb's versionless replay) idempotent; a real startup
 * runs it once under its version row.
 */
export function migrateProviderLimitWindow(db: Database): void {
  const columns = new Set((db.prepare("SELECT name FROM pragma_table_info('profile_limit_events')").all() as Array<{ name: string }>).map(row => row.name))
  if (!columns.has('provider_id')) db.exec('ALTER TABLE profile_limit_events ADD COLUMN provider_id TEXT')
  if (!columns.has('limit_window')) db.exec('ALTER TABLE profile_limit_events ADD COLUMN limit_window TEXT')
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
      providerId: input.providerId,
      window: input.window,
    }
    this.prune()
    this.db.prepare(`INSERT INTO profile_limit_events
      (id, profile_id, session_id, group_id, at, kind, final, status, message, resets_at, provider_id, limit_window)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id, event.profileId, event.sessionId, event.groupId, event.at, event.kind,
      event.final ? 1 : 0, event.status, event.message, event.resetsAt, event.providerId, event.window)
    for (const listener of this.listeners) listener(event)
    return event
  }

  /** Drop events older than the retention window. */
  prune(): void {
    const cutoff = new Date(this.now() - LIMIT_EVENT_RETENTION_MS).toISOString()
    this.db.prepare('DELETE FROM profile_limit_events WHERE at < ?').run(cutoff)
  }

  /** A profile's events within routing's 24-hour read window, oldest first. */
  forProfile(profileId: string): LimitEvent[] {
    const cutoff = new Date(this.now() - LIMIT_EVENT_READ_WINDOW_MS).toISOString()
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

/** One interval during which the router saw a profile as cooling, epoch ms, half-open. */
export interface CoolingInterval {
  start: number
  end: number
}

/**
 * The router's cooling timeline for one profile (team-process-metrics D4),
 * from its events in `(at, rowid)` order — the store's order. Each final
 * event decides from its `at` until the earliest of the next final event's
 * `at`, its own cooldown end (`cooldownUntil`'s rule), and `at + 24 h`, when
 * routing's read window drops it (no older event can take over then: older
 * events left the window first). Retried attempts never cool. Intervals are
 * returned in order, non-overlapping, with empty ones dropped.
 */
export function coolingTimeline(events: readonly LimitEvent[]): CoolingInterval[] {
  const finals = events
    .map((event, index) => ({ event, index, at: Date.parse(event.at) }))
    .filter(entry => entry.event.final && Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at || a.index - b.index)
  const intervals: CoolingInterval[] = []
  finals.forEach((entry, i) => {
    const reset = entry.event.resetsAt ? Date.parse(entry.event.resetsAt) : NaN
    const until = Number.isFinite(reset) ? reset : entry.at + DEFAULT_COOLDOWN_MS
    const next = finals[i + 1]?.at ?? Infinity
    const end = Math.min(next, until, entry.at + LIMIT_EVENT_READ_WINDOW_MS)
    if (end <= entry.at) return
    const last = intervals.at(-1)
    if (last && last.end >= entry.at) last.end = Math.max(last.end, end)
    else intervals.push({ start: entry.at, end })
  })
  return intervals
}

/** Milliseconds of `intervals` inside `[from, to)`. */
export function coolingMsWithin(intervals: readonly CoolingInterval[], from: number, to: number): number {
  let total = 0
  for (const interval of intervals) total += Math.max(0, Math.min(interval.end, to) - Math.max(interval.start, from))
  return total
}
