// Quota incident episodes (process-quota-history-and-incident-advice D4, R5):
// the one rule the live path and startup reconstruction share, so a replay
// forms exactly the episodes the live path formed. Each final limit's own end
// is the router's (providers-and-workers D8, `latestCoolingEnd`): its reset,
// else one hour after it. Oldest first, an event joins the episode while the
// episode's own end so far — the latest end of its members, never the
// provider's current aggregate — is still ahead of the event; otherwise it
// opens a new episode. A recorded resolution closes an episode with its
// witness (`EpisodeClosures`): the members it held then stay its members and
// nothing joins it after, so each final limit belongs to one episode only. An episode is in force at t while some member's own
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
  /** Whether a recorded resolution closed it: it admits nothing more and is never replayed. */
  closed: boolean
}

/** The event's own cooldown end (epoch ms): its reset, else one hour after it. */
export function eventEnd(event: EpisodeEvent): number {
  const reset = event.resetsAt ? Date.parse(event.resetsAt) : NaN
  return Number.isFinite(reset) ? reset : Date.parse(event.at) + DEFAULT_COOLDOWN_MS
}

/**
 * The recorded closures of a team's episodes (D5): an episode's first
 * `resolved` version is written with its witness — the limit events it held
 * at that instant — so a closed episode keeps exactly those members, whatever
 * their timestamps, and admits nothing after. A closure recorded without a
 * witness (before witnesses existed) closes at its recorded instant instead:
 * an event at that instant counts as after it, since the order is unknown.
 */
export interface EpisodeClosures {
  /** The key of the closed episode whose witness holds the event, else null. */
  witnessOf(eventId: string): string | null
  /** When the episode keyed by the event was recorded resolved without a witness (epoch ms), else null. */
  closedAt(eventId: string): number | null
}

export const NO_CLOSURES: EpisodeClosures = { witnessOf: () => null, closedAt: () => null }

/**
 * Partition final events into episodes, oldest first by their first event:
 * sorted by `at`, events at the same instant keep their given order (the
 * store's commit order, so a replay keys the episode by the event the live
 * path saw first). A witnessed event belongs to its closed episode; the rest
 * chain — an event joins the newest episode of the rest while that one's own
 * end is ahead of it and it precedes any witness-less recorded resolution,
 * else it opens a new one.
 */
export function quotaEpisodes<E extends EpisodeEvent>(events: readonly E[], closures: EpisodeClosures = NO_CLOSURES): QuotaEpisode<E>[] {
  const sorted = [...events].filter(event => Number.isFinite(Date.parse(event.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  type Entry = QuotaEpisode<E> & { closedAt: number | null }
  const episodes: Entry[] = []
  const witnessed = new Map<string, Entry>()
  let chain: Entry | undefined
  for (const event of sorted) {
    const key = closures.witnessOf(event.id)
    if (key !== null) {
      let entry = witnessed.get(key)
      if (!entry) {
        entry = { events: [], end: -Infinity, closed: true, closedAt: null }
        witnessed.set(key, entry)
        episodes.push(entry)
      }
      entry.events.push(event)
      entry.end = Math.max(entry.end, eventEnd(event))
      continue
    }
    const at = Date.parse(event.at)
    if (chain && at < chain.end && (chain.closedAt === null || at < chain.closedAt)) {
      chain.events.push(event)
      chain.end = Math.max(chain.end, eventEnd(event))
      // A tied leader can precede the episode's anchor: any member's recorded resolution closes it.
      const closed = closures.closedAt(event.id)
      if (closed !== null) chain.closedAt = chain.closedAt === null ? closed : Math.min(chain.closedAt, closed)
      chain.closed ||= closed !== null
    } else {
      const closedAt = closures.closedAt(event.id)
      chain = { events: [event], end: eventEnd(event), closed: closedAt !== null, closedAt }
      episodes.push(chain)
    }
  }
  return episodes.map(({ events: members, end, closed }) => ({ events: members, end, closed }))
}

/**
 * The episode `firstId` opened, over `events` (none before it): the one that
 * holds it, whichever event at its instant leads; null when that event is not
 * among them (pruned).
 */
export function episodeFrom<E extends EpisodeEvent>(events: readonly E[], firstId: string, closures: EpisodeClosures = NO_CLOSURES): QuotaEpisode<E> | null {
  const first = events.find(event => event.id === firstId)
  if (!first) return null
  const from = Date.parse(first.at)
  const later = events.filter(event => event.id === firstId || Date.parse(event.at) >= from)
  return quotaEpisodes(later, closures).find(entry => entry.events.some(event => event.id === firstId)) ?? null
}

/**
 * Whether the episode is in force at `atMs` (R5, the one predicate the live
 * `isOpen` and startup reconstruction share): some member's own end is ahead
 * and its own profile's router cooldown (`coolsAt`) still runs at `atMs`.
 */
export function episodeInForce<E extends EpisodeEvent>(members: readonly E[], atMs: number, coolsAt: (member: E, atMs: number) => boolean): boolean {
  return members.some(member => eventEnd(member) > atMs && coolsAt(member, atMs))
}
