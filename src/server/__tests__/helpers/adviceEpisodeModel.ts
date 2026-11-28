// An independent step model of quota advice episodes (process-quota-history-
// and-incident-advice D5, R5; contract r3 V7), written from the design rather
// than from `adviceEpisodes.ts`, so the replay property's expected anchors
// and memberships never come from the partition it checks. It follows the
// observable steps one at a time, in the order they happen:
//
// - a live commit (the subscriber runs) joins the team's open episode whose
//   own end — the latest reset (else one hour) of its members — is ahead of
//   it, else opens one; a crash-gap commit is held until the restart;
// - an evaluation at time t asks whether the episode is in force at its
//   cutoff (the anchor's time for a first version, else t): some member's own
//   end is ahead and the router (routing's own `cooldownUntil`, I5) still
//   cools that member's profile then. The first not-in-force evaluation
//   records the resolution and closes the episode with the members it holds
//   at that instant; nothing joins it after;
// - a restart processes the held commits by the live join rule, keeps only
//   the team's newest new episode and only when it is in force at the
//   restart, then evaluates every unresolved or unevaluated episode, twice.
import type { LimitEvent } from '../../../shared/routing'
import { cooldownUntil, DEFAULT_COOLDOWN_MS, LIMIT_EVENT_READ_WINDOW_MS } from '../../team/routing/limitEvents'

export interface ModelLimit { team: string; profileId: string; window: string; at: number; resetsAt: number | null }

export interface ModelEpisode { team: string; anchor: number; members: number[]; closedAt: number | null; evaluated: boolean; reconstructed: boolean }

export class EpisodeModel {
  readonly limits: ModelLimit[] = []
  readonly episodes: ModelEpisode[] = []
  private pending = new Set<ModelEpisode>()
  private held: number[] = []

  constructor(private readonly providerId: string) {}

  /** A committed final limit; `live` when the advice subscriber runs. */
  commit(limit: ModelLimit, live: boolean): void {
    const index = this.limits.push(limit) - 1
    if (!live) {
      this.held.push(index)
      return
    }
    const joined = this.join(index, true)
    if (joined) this.pending.add(joined)
    else this.pending.add(this.open(index, false))
  }

  /** Quota history was written for the teams: their unresolved episodes are evaluated next. */
  historyWritten(teams: readonly string[]): void {
    for (const episode of this.episodes) if (episode.closedAt === null && teams.includes(episode.team)) this.pending.add(episode)
  }

  drain(now: number): void {
    const due = [...this.pending]
    this.pending = new Set()
    for (const episode of due) this.evaluate(episode, now)
  }

  /** A restart at `now`: held commits replayed, the newest new episode per team kept while in force, then reconciliation and two drains. */
  restart(now: number): void {
    this.pending = new Set()
    const created: ModelEpisode[] = []
    for (const index of this.held) {
      const joined = this.join(index, false, created)
      if (!joined) created.push({ team: this.limits[index]!.team, anchor: index, members: [index], closedAt: null, evaluated: false, reconstructed: true })
    }
    this.held = []
    for (const team of new Set(created.map(episode => episode.team))) {
      const newest = created.filter(episode => episode.team === team).at(-1)!
      if (this.inForce(newest.members, now)) this.episodes.push(newest)
    }
    for (const episode of this.episodes) if (episode.closedAt === null || !episode.evaluated) this.pending.add(episode)
    this.drain(now)
    this.drain(now)
  }

  /** The member indexes of each recorded episode, keyed by its anchor index. */
  memberships(team: string): Array<{ anchor: number; members: number[]; resolved: boolean; reconstructed: boolean }> {
    return this.episodes.filter(episode => episode.team === team)
      .map(({ anchor, members, closedAt, reconstructed }) => ({ anchor, members: [...members], resolved: closedAt !== null, reconstructed }))
      .sort((a, b) => a.anchor - b.anchor)
  }

  private end(members: readonly number[]): number {
    return Math.max(...members.map(index => {
      const limit = this.limits[index]!
      return limit.resetsAt ?? limit.at + DEFAULT_COOLDOWN_MS
    }))
  }

  /** The team's open episode the limit joins (the first one whose own end is ahead of it), enqueueing ended ones when live. */
  private join(index: number, live: boolean, extra: ModelEpisode[] = []): ModelEpisode | null {
    const limit = this.limits[index]!
    let joined: ModelEpisode | null = null
    for (const episode of [...this.episodes, ...extra]) {
      if (episode.team !== limit.team || episode.closedAt !== null) continue
      const end = this.end(episode.members)
      if (joined === null && end > limit.at) joined = episode
      else if (live && end <= limit.at) this.pending.add(episode)
    }
    joined?.members.push(index)
    return joined
  }

  private open(index: number, reconstructed: boolean): ModelEpisode {
    const episode = { team: this.limits[index]!.team, anchor: index, members: [index], closedAt: null, evaluated: false, reconstructed }
    this.episodes.push(episode)
    return episode
  }

  private evaluate(episode: ModelEpisode, now: number): void {
    if (episode.closedAt !== null) return
    const anchorAt = this.limits[episode.anchor]!.at
    const cutoff = episode.evaluated ? Math.max(anchorAt, now) : anchorAt
    const first = !episode.evaluated
    episode.evaluated = true
    const members = episode.members.filter(index => this.limits[index]!.at <= cutoff)
    if (!this.inForce(members, cutoff)) episode.closedAt = now
    // A late first version: the next one follows at the current time.
    else if (first && cutoff < now) this.pending.add(episode)
  }

  private inForce(members: readonly number[], at: number): boolean {
    const events = this.limits.map((limit, index) => this.event(limit, index))
      .filter(event => Date.parse(event.at) <= at && Date.parse(event.at) >= at - LIMIT_EVENT_READ_WINDOW_MS)
    return members.some(index => {
      const limit = this.limits[index]!
      return (limit.resetsAt ?? limit.at + DEFAULT_COOLDOWN_MS) > at && cooldownUntil(limit.profileId, this.providerId, events, at) !== null
    })
  }

  private event(limit: ModelLimit, index: number): LimitEvent {
    return {
      id: `m${index}`, profileId: limit.profileId, sessionId: limit.team, groupId: null, at: new Date(limit.at).toISOString(), kind: 'rate_limit',
      final: true, status: 429, message: null, resetsAt: limit.resetsAt === null ? null : new Date(limit.resetsAt).toISOString(),
      providerId: this.providerId, window: limit.window,
    }
  }
}
