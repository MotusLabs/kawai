// Quota incident episodes (process-quota-history-and-incident-advice D4, R5):
// the one rule the live path and startup reconstruction share, so a replay
// forms exactly the episodes the live path formed. Each final limit's own end
// is the router's (providers-and-workers D8, `latestCoolingEnd`): its reset,
// else one hour after it. Oldest first, an event joins the episode while the
// episode's own end so far — the latest end of its members, never the
// provider's current aggregate — is still ahead of the event and the event
// precedes the episode's recorded resolution (`closedAt`: once resolved, an
// episode admits nothing, so each final limit belongs to one episode only);
// otherwise it opens a new episode. An episode is in force at t while some member's own
// end is ahead of t and that member's profile cooldown (the router's
// aggregate, as of t) still runs (`episodeInForce`) — members can hold different
// model-scoped windows, so neither the first nor the newest member decides.
import { DEFAULT_COOLDOWN_MS } from '../../team/routing/limitEvents'

export interface EpisodeEvent {
  id: string
  at: string
  resetsAt: string | null
}

export interface QuotaEpisode<E extends EpisodeEvent> {
  events: E[]
  /** Epoch ms when the episode's own cooldown ends. */
  end: number
}

/** The event's own cooldown end (epoch ms): its reset, else one hour after it. */
export function eventEnd(event: EpisodeEvent): number {
  const reset = event.resetsAt ? Date.parse(event.resetsAt) : NaN
  return Number.isFinite(reset) ? reset : Date.parse(event.at) + DEFAULT_COOLDOWN_MS
}

/** When the episode keyed by an event was recorded resolved (epoch ms), else null: the durable admission boundary. */
export type ClosedAt = (eventId: string) => number | null

/**
 * Chain final events into episodes, oldest first: sorted by `at`, events at
 * the same instant keep their given order (the store's commit order, so a
 * replay keys the episode by the event the live path saw first). An event at
 * or after the episode's recorded resolution opens a new one.
 */
export function quotaEpisodes<E extends EpisodeEvent>(events: readonly E[], closedAt: ClosedAt = () => null): QuotaEpisode<E>[] {
  const sorted = [...events].filter(event => Number.isFinite(Date.parse(event.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const episodes: Array<QuotaEpisode<E> & { closed: number | null }> = []
  for (const event of sorted) {
    const last = episodes.at(-1)
    const at = Date.parse(event.at)
    if (last && at < last.end && (last.closed === null || at < last.closed)) {
      last.events.push(event)
      last.end = Math.max(last.end, eventEnd(event))
      // A tied leader can precede the episode's anchor: any member's recorded resolution closes it.
      const closed = closedAt(event.id)
      if (closed !== null) last.closed = last.closed === null ? closed : Math.min(last.closed, closed)
    } else {
      episodes.push({ events: [event], end: eventEnd(event), closed: closedAt(event.id) })
    }
  }
  return episodes.map(({ events: members, end }) => ({ events: members, end }))
}

/**
 * The episode `firstId` opened, over `events` (none before it): the one that
 * holds it, whichever event at its instant leads; null when that event is not
 * among them (pruned).
 */
export function episodeFrom<E extends EpisodeEvent>(events: readonly E[], firstId: string, closedAt: ClosedAt = () => null): QuotaEpisode<E> | null {
  const first = events.find(event => event.id === firstId)
  if (!first) return null
  const from = Date.parse(first.at)
  const later = events.filter(event => event.id === firstId || Date.parse(event.at) >= from)
  return quotaEpisodes(later, closedAt).find(entry => entry.events.some(event => event.id === firstId)) ?? null
}

/**
 * Whether the episode is in force at `atMs` (R5, the one predicate the live
 * `isOpen` and startup reconstruction share): some member's own end is ahead
 * and its own profile's router cooldown (`coolsAt`) still runs at `atMs`.
 */
export function episodeInForce<E extends EpisodeEvent>(members: readonly E[], atMs: number, coolsAt: (member: E, atMs: number) => boolean): boolean {
  return members.some(member => eventEnd(member) > atMs && coolsAt(member, atMs))
}
