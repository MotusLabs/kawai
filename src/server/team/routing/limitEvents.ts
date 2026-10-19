// Per-profile limit events (profile-routing design D6/D7): every rate-limit,
// billing, or overload failure a chat agent hits is recorded with its
// profile, session, group, HTTP status, raw message, and the provider's reset
// time when known — retried attempts as `final: false`, the turn's failure as
// `final: true`. Rows persist (routing must still see them after a restart)
// and are pruned after 15 days, so process metrics (team-process-metrics D8)
// can read a 7-day window with its 7-day baseline; routing still reads only
// the last 24 hours. Cooldown is computed from them on read and never
// stored, so changing the policy needs no migration; `coolingTimeline`
// reconstructs past cooling by the same rule. A `credit` event (a 402,
// openrouter-provider D8) can end early through an in-memory overlay fed by
// provider usage pulls; tracking starts when this process records the event,
// so an event loaded from the database after a restart ends only at the
// one-hour bound, whatever later pulls report.
import type { Database } from 'bun:sqlite'
import type { LimitEvent } from '../../../shared/routing'
import { CREDIT_LIMIT_WINDOW } from '../../chat/limitSignals'

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
 * Migration 12 `provider-limit-window` (providers-and-workers D7): the two
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

/** One remaining-credit reading from a provider usage pull, epoch ms and USD. */
interface CreditReading {
  at: number
  remainingUsd: number
}

export class LimitEventStore {
  private readonly listeners = new Set<(event: LimitEvent) => void>()
  /** Provider id → its remaining-credit readings, oldest first (in memory only, D8). */
  private readonly credit = new Map<string, CreditReading[]>()
  /** Credit events this process recorded, `creditKey(event)` → the event's epoch ms (in memory only, D8). */
  private readonly creditTracking = new Map<string, number>()

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
    if (event.window === CREDIT_LIMIT_WINDOW) this.creditTracking.set(creditKey(event), Date.parse(event.at))
    for (const listener of this.listeners) listener(event)
    return event
  }

  /**
   * A provider usage pull completed and reported `remainingUsd`
   * (openrouter-provider D8). Readings older than the read window (plus the
   * one-hour bound) are dropped, with the credit events tracked alongside
   * them; nothing is persisted.
   */
  reportRemainingCredit(providerId: string, remainingUsd: number): void {
    if (!Number.isFinite(remainingUsd)) return
    const now = this.now()
    const cutoff = now - LIMIT_EVENT_READ_WINDOW_MS - DEFAULT_COOLDOWN_MS
    const readings = (this.credit.get(providerId) ?? []).filter(reading => reading.at >= cutoff)
    readings.push({ at: now, remainingUsd })
    this.credit.set(providerId, readings)
    for (const [key, at] of this.creditTracking) {
      if (at < cutoff) this.creditTracking.delete(key)
    }
  }

  /**
   * When credit returned after `event` (epoch ms), else null: the overlay's
   * early end. Only an event this process recorded is tracked (D8) — one
   * loaded from the database after a restart ends at its one-hour bound.
   */
  private creditReturned = (event: LimitEvent): number | null => {
    if (!this.creditTracking.has(creditKey(event))) return null
    return creditReturnedAt(this.credit.get(event.providerId ?? event.profileId) ?? [], Date.parse(event.at))
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

  /** A provider's events (any profile on it) within routing's 24-hour read window, oldest first. */
  forProvider(providerId: string): LimitEvent[] {
    const cutoff = new Date(this.now() - LIMIT_EVENT_READ_WINDOW_MS).toISOString()
    return (this.db.prepare('SELECT * FROM profile_limit_events WHERE provider_id = ? AND at >= ? ORDER BY at, rowid')
      .all(providerId, cutoff) as Row[]).map(fromRow)
  }

  /**
   * The profile's effective cooldown (providers-and-workers D8): its own
   * events and its provider's provider-scoped ones decide it; `provider`
   * says whose end won, `providerId` names that provider (null without one).
   */
  cooldownFor(profileId: string, providerId: string | null = null): EffectiveCooldown {
    const now = this.now()
    const own = this.forProfile(profileId)
    const providerEvents = providerId === null ? [] : this.forProvider(providerId)
    const end = latestCoolingEnd(relevantEvents([...own, ...providerEvents], profileId, providerId), now, this.creditReturned)
    const until = end?.until ?? null
    const providerEnd = providerCooldownUntil(providerId, providerEvents, now, this.creditReturned)
    return {
      until,
      provider: providerEnd !== null && until !== null && Date.parse(providerEnd) >= Date.parse(until),
      providerId,
      ...(end?.credit ? { credit: true } : {}),
    }
  }

  /** The provider's own cooldown end (D8): its provider-scoped events alone. */
  providerCooldownUntil(providerId: string | null): string | null {
    if (providerId === null) return null
    return providerCooldownUntil(providerId, this.forProvider(providerId), this.now(), this.creditReturned)
  }
}

/**
 * Windows whose quota covers one model only (providers-and-workers D8); any
 * other or unknown window — and none — cools the provider, the conservative
 * default.
 */
export const MODEL_SCOPED_WINDOWS: ReadonlySet<string> = new Set(['seven_day_opus', 'seven_day_sonnet'])

export const isModelScoped = (window: string | null): boolean => window !== null && MODEL_SCOPED_WINDOWS.has(window)

/**
 * A profile's effective cooldown (providers-and-workers D8): when it ends,
 * whether the provider's cooldown decided that end, and which provider was
 * considered.
 */
export interface EffectiveCooldown {
  until: string | null
  provider: boolean
  providerId: string | null
  /** Set when a credit limit's end decides (openrouter-provider D8): out of credit, ending by `until` at the latest. */
  credit?: true
}

/** The credit-tracking key (D8): the provider the readings are held under, and the event's time. */
const creditKey = (event: LimitEvent): string => `${event.providerId ?? event.profileId}\u0000${event.at}`

/**
 * The overlay's early end for a credit event at `eventAt` (openrouter-provider
 * D8), over this process's readings: readings from before the event are
 * ignored, the first pull after it only sets the baseline — a 402 can leave a
 * few cents that cannot cover a request — and a later pull ends the cooldown
 * when its amount exceeds the lowest earlier post-event pull. Null while none
 * has.
 */
export function creditReturnedAt(readings: readonly CreditReading[], eventAt: number): number | null {
  if (!Number.isFinite(eventAt)) return null
  let baseline: number | null = null
  let lowest = Number.POSITIVE_INFINITY
  for (const reading of readings) {
    if (reading.at <= eventAt) continue
    if (baseline === null) { baseline = reading.remainingUsd; lowest = reading.remainingUsd; continue }
    if (reading.remainingUsd > lowest) return reading.at
    lowest = Math.min(lowest, reading.remainingUsd)
  }
  return null
}

/**
 * The events relevant to `profileId` of `providerId` (D8): its own final
 * candidates whatever their provider or window — rows from before the
 * migration and model-scoped windows count only here — plus final events of
 * the provider's other profiles whose window is not model-scoped.
 */
export function relevantEvents(events: readonly LimitEvent[], profileId: string, providerId: string | null): LimitEvent[] {
  return events.filter(event =>
    event.profileId === profileId ||
    (providerId !== null && event.providerId === providerId && !isModelScoped(event.window)))
}

/** The overlay seam: when credit returned after a credit event, else null. */
type CreditReturned = (event: LimitEvent) => number | null

/**
 * The built-in cooldown end over one event set (D8): grouped by window, with
 * none as one group, the latest final event of each group sets its end — its
 * reset, else (unknown or unparseable) one hour after it, or for a credit
 * event the earlier of that and when credit returned — and the profile cools
 * until the latest end still in the future, `credit` saying a credit event
 * set it. Retried attempts never cool. Null once over.
 */
function latestCoolingEnd(events: readonly LimitEvent[], now: number, creditReturned?: CreditReturned): { until: string; credit: boolean } | null {
  const latest = new Map<string, LimitEvent>()
  for (const event of events) {
    if (!event.final) continue
    const key = event.window ?? '\u0000'
    const prev = latest.get(key)
    if (prev === undefined || Date.parse(event.at) >= Date.parse(prev.at)) latest.set(key, event)
  }
  let end: { at: number; credit: boolean } | null = null
  for (const event of latest.values()) {
    const reset = event.resetsAt ? Date.parse(event.resetsAt) : NaN
    let until = Number.isFinite(reset) ? reset : Date.parse(event.at) + DEFAULT_COOLDOWN_MS
    const credit = event.window === CREDIT_LIMIT_WINDOW
    const returned = credit ? creditReturned?.(event) ?? null : null
    if (returned !== null) until = Math.min(until, returned)
    if (Number.isFinite(until) && until > now && (end === null || until > end.at)) end = { at: until, credit }
  }
  return end === null ? null : { until: new Date(end.at).toISOString(), credit: end.credit }
}

/** The profile's effective cooldown end (D8) over a read window's events. */
export function cooldownUntil(profileId: string, providerId: string | null, events: readonly LimitEvent[], now: number,
  creditReturned?: CreditReturned): string | null {
  return latestCoolingEnd(relevantEvents(events, profileId, providerId), now, creditReturned)?.until ?? null
}

/** The provider's own cooldown end (D8): its provider-scoped events alone decide it. */
export function providerCooldownUntil(providerId: string | null, events: readonly LimitEvent[], now: number,
  creditReturned?: CreditReturned): string | null {
  if (providerId === null) return null
  return latestCoolingEnd(events.filter(event => event.providerId === providerId && !isModelScoped(event.window)), now, creditReturned)?.until ?? null
}

/** One interval during which the router saw a profile as cooling, epoch ms, half-open. */
export interface CoolingInterval {
  start: number
  end: number
}

/**
 * The router's cooling timeline for one profile (team-process-metrics D4),
 * from its events in `(at, rowid)` order — the store's order. It follows the
 * router's own rule (providers-and-workers D8): final events group by
 * window, with none as one group — `latestCoolingEnd`'s key — and a later
 * final event replaces only an earlier event of its OWN window; each event
 * decides from its `at` until the earliest of the next same-window event's
 * `at`, its own cooldown end (reset, else one hour after it), and one
 * millisecond past `at + 24 h` — the read window's inclusive edge, where the
 * router stops reading it (`at >= t - 24 h`). The union of the groups'
 * intervals is returned in order, non-overlapping, with empty ones dropped.
 * Retried attempts never cool.
 */
export function coolingTimeline(events: readonly LimitEvent[]): CoolingInterval[] {
  const groups = new Map<string, { event: LimitEvent; index: number; at: number }[]>()
  events.forEach((event, index) => {
    if (!event.final) return
    const at = Date.parse(event.at)
    if (!Number.isFinite(at)) return
    const key = event.window ?? '\u0000'
    const group = groups.get(key)
    if (group) group.push({ event, index, at })
    else groups.set(key, [{ event, index, at }])
  })
  const intervals: CoolingInterval[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => a.at - b.at || a.index - b.index)
    // Merge within the group only: a later group's interval may overlap an
    // earlier group's tail, and absorbing it here would lose its leading
    // span — the union happens once, after every group has contributed.
    const groupIntervals: CoolingInterval[] = []
    group.forEach((entry, i) => {
      const reset = entry.event.resetsAt ? Date.parse(entry.event.resetsAt) : NaN
      const until = Number.isFinite(reset) ? reset : entry.at + DEFAULT_COOLDOWN_MS
      const next = group[i + 1]?.at ?? Infinity
      const end = Math.min(next, until, entry.at + LIMIT_EVENT_READ_WINDOW_MS + 1)
      if (end <= entry.at) return
      const last = groupIntervals.at(-1)
      if (last && last.end >= entry.at) last.end = Math.max(last.end, end)
      else groupIntervals.push({ start: entry.at, end })
    })
    intervals.push(...groupIntervals)
  }
  intervals.sort((a, b) => a.start - b.start)
  const merged: CoolingInterval[] = []
  for (const interval of intervals) {
    const last = merged.at(-1)
    if (last && last.end >= interval.start) last.end = Math.max(last.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

/** Milliseconds of `intervals` inside `[from, to)`. */
export function coolingMsWithin(intervals: readonly CoolingInterval[], from: number, to: number): number {
  let total = 0
  for (const interval of intervals) total += Math.max(0, Math.min(interval.end, to) - Math.max(interval.start, from))
  return total
}
