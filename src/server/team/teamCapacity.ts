// The team's capacity as routing sees it (dispatch-worker-choice D6): each
// group's workers with provider, cap, and live count, and each provider's
// usage and cooldown. Built from the objects the router reads — the group
// catalog, `liveGroupMembers` plus staffing's pending reservations counted by
// `buildCandidates`, `cooldownFor`, and the provider-keyed usage store — so
// the answer cannot disagree with a dispatch pass. Reads memory and SQLite
// only: nothing is fetched, written, or started. The answer carries ids,
// counts, usage, and times; never an env value, credential, path, or URL —
// the login keys `sharesLoginWith` is computed from stay inside `read`.
import type { ChatUsageReport } from '../../shared/chat'
import type { RouteUsage } from '../../shared/routing'
import type { ChatSessionRecord } from '../db'
import type { LimitEventStore } from './routing/limitEvents'
import { buildCandidates } from './routing/candidates'
import { liveGroupMembers, usageView } from './routing/router'
import { sharedLogins } from './routing/sharedLogins'
import type { SessionTeams } from './sessionTeams'
import type { PendingSpawnRow } from './teamRoster'

export interface CapacityWorker {
  /** The model key (the stored profile id). */
  model: string
  provider: string
  /** The group's cap on live members of this worker; null when uncapped. */
  cap: number | null
  /** Live members on this worker, pending spawn reservations included. */
  live: number
  /** The worker's effective cooldown end (ISO); null when not cooling. */
  cooldownUntil: string | null
  /** Set when an out-of-credit limit decides that end. */
  credit?: true
}

export interface CapacityGroup {
  id: string
  /** Live-member cap of the whole group. */
  max: number
  /** Live members, pending spawn reservations included. */
  live: number
  strategy: 'first-available' | 'profile-order'
  /** In preference order. */
  workers: CapacityWorker[]
}

export interface CapacityProvider {
  id: string
  label: string | null
  /** The latest report kawai holds; null = unknown (none since the server started). */
  usage: RouteUsage | null
  /** The provider's own cooldown end (ISO); null when not cooling. */
  cooldownUntil: string | null
  /** Other team providers detected as drawing on the same login; empty = not detected. */
  sharesLoginWith: string[]
}

export interface TeamCapacityAnswer {
  computedAt: string
  groups: CapacityGroup[]
  providers: CapacityProvider[]
}

export interface TeamCapacityOptions {
  teams: Pick<SessionTeams, 'teamOf' | 'catalogOf'>
  /** Every chat session record; archived ones are skipped by the counter. */
  records: () => Iterable<ChatSessionRecord>
  /** Staffing's pending `team_spawns` reservations of a team. */
  pendingSpawns: (teamId: string) => PendingSpawnRow[]
  limits: Pick<LimitEventStore, 'cooldownFor' | 'providerCooldownUntil'>
  /** The router's provider resolution; unresolved ids stand in as their own provider. */
  providerOf: (profileId: string) => string
  providerLabel: (providerId: string) => string | null
  /** The provider-keyed usage store the router reads. */
  providerUsageOf: (providerId: string) => ChatUsageReport | null
  /**
   * A worker's stored-login key resolved at the team's groups root
   * (`storedLoginKey` over its launch), or null when it is not provably the
   * stored login or cannot be resolved. Never part of the answer.
   */
  loginKeyOf: (profileId: string, groupsRoot: string) => string | null
  now?: () => number
}

export class TeamCapacity {
  constructor(private readonly options: TeamCapacityOptions) {}

  /** The caller's team capacity, or only `group`'s; an unknown group is refused by name. */
  read(sessionId: string, input: { group?: string | undefined } = {}): TeamCapacityAnswer {
    const { teams, limits, providerOf } = this.options
    const team = teams.teamOf(sessionId)
    const catalog = teams.catalogOf(sessionId)
    if (!team || !catalog) throw new Error('This session belongs to no team yet, so there is no capacity to read.')
    if (input.group !== undefined && !catalog.groups.has(input.group)) {
      throw new Error(`Unknown group "${input.group}" in your team.`)
    }
    const records = [...this.options.records()]
    const pending = this.options.pendingSpawns(team.teamId)
    // Every group is counted: login sharing is judged over all the team's
    // workers whatever the filter, so a filtered answer agrees with the whole.
    const all = [...catalog.groups.values()].map(({ group }): CapacityGroup => {
      // The same counting a dispatch pass runs: every live member plus the
      // group's pending reservations, tallied by the one eligibility check.
      const { group: counted } = buildCandidates({
        group,
        members: liveGroupMembers(records, id => teams.teamOf(id)?.teamId, team.teamId, group.id)
          .map(member => ({ ...member, eligible: false })),
        pendingSpawnProfiles: pending.filter(row => row.groupId === group.id).map(row => row.profileId),
        spawnAllowed: false,
        spawnCwd: null,
        providerOf,
      })
      return {
        id: group.id, max: counted.max, live: counted.live, strategy: counted.strategy,
        workers: counted.profiles.map(worker => {
          const cooldown = limits.cooldownFor(worker.profileId, worker.providerId)
          return {
            model: worker.profileId, provider: worker.providerId, cap: worker.cap ?? null, live: worker.live,
            cooldownUntil: cooldown.until, ...(cooldown.credit ? { credit: true as const } : {}),
          }
        }),
      }
    })
    const keys = new Map<string, string | null>()
    const keyOf = (profileId: string) => {
      if (!keys.has(profileId)) keys.set(profileId, this.options.loginKeyOf(profileId, team.groupsRoot))
      return keys.get(profileId) ?? null
    }
    const logins = sharedLogins(all.flatMap(group => group.workers.map(worker => ({ provider: worker.provider, key: keyOf(worker.model) }))))
    const groups = all.filter(group => input.group === undefined || group.id === input.group)
    const providerIds = [...new Set(groups.flatMap(group => group.workers.map(worker => worker.provider)))]
    return {
      computedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      groups,
      providers: providerIds.map(id => ({
        id,
        label: this.options.providerLabel(id),
        usage: usageView(this.options.providerUsageOf(id)),
        cooldownUntil: limits.providerCooldownUntil(id),
        sharesLoginWith: logins.get(id) ?? [],
      })),
    }
  }
}
