// Quota incident episodes (process-quota-history-and-incident-advice D4, R5):
// the one rule the live path and startup reconstruction share, so a replay
// forms exactly the episodes the live path formed. Each final limit's own end
// is the router's (providers-and-workers D8, `latestCoolingEnd`): its reset,
// else one hour after it. Oldest first, an event joins the episode while the
// episode's own end so far — the latest end of its members, never the
// provider's current aggregate — is still ahead of the event; otherwise it
// opens a new episode.
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

/** Chain final events (any order; sorted by `at`, then id) into episodes, oldest first. */
export function quotaEpisodes<E extends EpisodeEvent>(events: readonly E[]): QuotaEpisode<E>[] {
  const sorted = [...events].filter(event => Number.isFinite(Date.parse(event.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const episodes: QuotaEpisode<E>[] = []
  for (const event of sorted) {
    const last = episodes.at(-1)
    if (last && Date.parse(event.at) < last.end) {
      last.events.push(event)
      last.end = Math.max(last.end, eventEnd(event))
    } else {
      episodes.push({ events: [event], end: eventEnd(event) })
    }
  }
  return episodes
}

/**
 * The end of the episode `firstId` opened, over `events` (the episode's
 * candidates); null when that event is not among them (pruned).
 */
export function episodeEndFrom(events: readonly EpisodeEvent[], firstId: string): number | null {
  const first = events.find(event => event.id === firstId)
  if (!first) return null
  const from = Date.parse(first.at)
  const later = events.filter(event => event.id === firstId || Date.parse(event.at) >= from)
  const episode = quotaEpisodes(later).find(entry => entry.events[0]?.id === firstId)
  return episode?.end ?? null
}
