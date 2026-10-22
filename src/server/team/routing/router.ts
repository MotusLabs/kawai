// Profile routing for group mail (profile-routing design D4/D5). For one
// message: load its group, build the candidates (eligible members from the
// dispatcher plus spawn slots staffing allows), ask the group's rule — or
// the built-in strategy when there is none, it says `default`, fails, times
// out, or picks something not offered — and turn the choice into a member,
// a spawned member, a hold, or nothing. A held message is not re-asked
// until its retry time passes or its candidates change. Every decision is
// kept in a small per-group log for the mailbox view.
// Waiting reasons (team-waiting-reasons D2): a `none` or `hold` carries a
// diagnosis built from the same eligibility breakdown, live counts, spawn
// facts, and cooldowns the decision used — never scraped from the log.
import type { ChatUsageReport } from '../../../shared/chat'
import type { ChatSessionRecord } from '../../db'
import type {
  RouteCandidate, RouteContext, RouteDecisionLogEntry, RouteGroup, RouteMessage, RouteProfileState, RouteProviderState, RouteUsage,
} from '../../../shared/routing'
import type { WaitingConstraint } from '../../../shared/team'
import type { EligibleMember, GroupRouter, MemberExclusion, RouteResult, RouteView } from '../dispatcher'
import type { GroupDefinition } from '../groupFile'
import type { TeamMessage } from '../mailboxStore'
import type { SpawnContext, WorktreeStaffing } from '../staffing'
import { builtinPick } from './builtin'
import { DEFAULT_PROFILE_ID } from './candidates'
import { evaluateEligibility, type EligibilityResult } from './workerEligibility'
import { resolveWorkerSelector } from './workerSelector'
import type { LimitEventStore } from './limitEvents'
import type { RuleRegistry } from './ruleLoader'

/** Entries kept per group. */
export const DECISION_LOG_SIZE = 50

/** A live (non-archived) member of a group, whatever its state. */
export interface GroupMemberRecord {
  sessionId: string
  profileId: string
  cwd: string
}

/**
 * Every live (non-archived) member of a team's group: the members routing
 * counts toward caps, busy or idle, spawned or not. The one counter both the
 * router and `team_capacity` read (dispatch-worker-choice D6).
 */
export function liveGroupMembers(
  records: Iterable<ChatSessionRecord>, teamOf: (sessionId: string) => string | undefined, teamId: string, groupId: string,
): GroupMemberRecord[] {
  return [...records].flatMap(record =>
    record.archivedAt == null && record.groupId === groupId && teamOf(record.sessionId) === teamId
      ? [{ sessionId: record.sessionId, profileId: record.claudeProfileId ?? 'default', cwd: record.projectPath }]
      : [])
}

export interface ProfileRouterOptions {
  /** The message's group definition; undefined when the group is gone. */
  groupOf: (message: TeamMessage) => Promise<GroupDefinition | undefined>
  /** Every live member of a team's group. */
  members: (teamId: string, groupId: string) => GroupMemberRecord[]
  targetWorktree: (message: TeamMessage) => string | null
  staffing: Pick<WorktreeStaffing, 'spawnContext' | 'spawnFor'>
  rules: Pick<RuleRegistry, 'rule'>
  limits: Pick<LimitEventStore, 'forProfile' | 'forProvider' | 'cooldownFor' | 'providerCooldownUntil'>
  /** The provider owning a profile (providers-and-workers D10); unresolved ids stand in as their own provider. */
  providerOf?: (profileId: string) => string
  /** The provider's catalog label; null when unknown (the D14 rule context). */
  providerLabel?: (providerId: string) => string | null
  usageOf: (profileId: string) => ChatUsageReport | null
  /** A provider's report keyed by provider id (the D14 provider view); no profile mapping. */
  providerUsageOf: (providerId: string) => ChatUsageReport | null
  /** The profile a forwarded message must not go back to. */
  excludedProfile?: (message: TeamMessage) => string | undefined
  /** The role's profiles execution mail may route to, in the role's order (plan-execution D15). */
  allowedProfiles?: (message: TeamMessage) => string[] | null
  onDecision?: (entry: RouteDecisionLogEntry) => void
  now?: () => number
}

export class ProfileRouter implements GroupRouter {
  private readonly holds = new Map<string, { until: number | null; signature: string; reason?: string }>()
  private readonly log = new Map<string, RouteDecisionLogEntry[]>()

  constructor(private readonly options: ProfileRouterOptions) {}

  /** A reload changes policy even when the candidates stay the same. */
  invalidateHolds(): void { this.holds.clear() }

  /** Newest first, for one team. */
  decisions(teamId: string): RouteDecisionLogEntry[] {
    return [...this.log.entries()].filter(([key]) => key.startsWith(`${teamId}\0`))
      .flatMap(([, entries]) => entries).sort((a, b) => b.at.localeCompare(a.at))
  }

  async route(message: TeamMessage, view: RouteView): Promise<RouteResult> {
    const now = this.options.now?.() ?? Date.now()
    const group = await this.options.groupOf(message)
    if (!group) {
      // A group file that is gone keeps its members' mail flowing to them;
      // with no member to take it, the missing definition is the blocker.
      return view.eligible[0]
        ? { kind: 'member', sessionId: view.eligible[0].sessionId }
        : { kind: 'none', diagnosis: [{ kind: 'group-missing' }, ...noEligible(view)] }
    }
    const worktree = this.options.targetWorktree(message)
    const spawn = await this.options.staffing.spawnContext(message, worktree)
    if (spawn === 'worktree-missing') return { kind: 'none' }
    const eligible = new Map(view.eligible.map(row => [row.sessionId, row]))
    const members = this.options.members(message.teamId, group.id)
    const providerOf = (id: string) => this.options.providerOf?.(id) ?? id
    // The sender's worker choice (dispatch-worker-choice D1/D2), resolved to
    // the group's model keys on each pass, so a group or catalog edit after
    // sending applies the way every other group edit does.
    const workerChoice = message.workerChoice ? {
      selector: message.workerChoice,
      profiles: resolveWorkerSelector(message.workerChoice,
        group.profiles.length > 0 ? group.profiles.map(entry => entry.profileId) : [DEFAULT_PROFILE_ID], providerOf),
    } : null
    const { candidates, group: routeGroup, excluded } = evaluateEligibility({
      group,
      members: members.map(member => memberState(member, eligible.get(member.sessionId))),
      pendingSpawnProfiles: spawn?.pendingProfiles ?? [],
      spawnAllowed: spawn?.allowed ?? false,
      spawnCwd: spawn?.worktree ?? null,
      providerOf,
      ...(this.options.excludedProfile?.(message) ? { excludeProfile: this.options.excludedProfile(message)! } : {}),
      // A forward also skips the excluded model's provider while it cools
      // (providers-and-workers D9): a hard filter, so a rule cannot pick it.
      ...(() => {
        const excluded = this.options.excludedProfile?.(message)
        if (excluded === undefined) return {}
        const excludedProvider = providerOf(excluded)
        if (this.options.limits.providerCooldownUntil(excludedProvider) === null) return {}
        return { excludeProvider: excludedProvider }
      })(),
      ...(this.options.allowedProfiles?.(message) ? { allowedProfiles: this.options.allowedProfiles(message)! } : {}),
      workerChoice,
    })
    if (candidates.length === 0) {
      this.holds.delete(message.id)
      // Members the dispatcher found eligible were dropped by the message's
      // filters; each names its first filter reason from the one eligibility
      // check (D2/D10), beside the others' member-state causes.
      const breakdown = { ...view, exclusions: [...(view.exclusions ?? []), ...filterExclusions(excluded, eligible)] }
      // A choice waits on its own workers' caps, never on a filtered-out one's (D5).
      const diagnosis = diagnoseNone(routeGroup, spawn, breakdown, workerChoice ? new Set(workerChoice.profiles) : null)
      // The choice names itself beside the capacity it waits on (D5).
      if (workerChoice) diagnosis.push({ kind: 'worker-choice', detail: workerChoice.selector })
      return { kind: 'none', diagnosis }
    }
    const signature = candidates.map(candidate => candidate.id).sort().join(',')
    const held = this.holds.get(message.id)
    if (held && held.signature === signature && (held.until === null || held.until > now)) {
      return { kind: 'hold', retryAt: held.until, diagnosis: [routingHold(held.until, held.reason)] }
    }
    this.holds.delete(message.id)

    const profiles = this.profileStates(group, candidates, now)
    const cooling = (profileId: string) => profiles[profileId]?.cooldownUntil != null
    // The rule context's provider view (D14): keyed once, from the same ids.
    const providerStates = this.providerStates(profiles)
    // With a role, profile-order ranks by the role's order (D15); the
    // candidates outside it are already filtered out.
    const order = this.options.allowedProfiles?.(message) ?? routeGroup.profiles.map(entry => entry.profileId)
    const record = (source: RouteDecisionLogEntry['source'], decision: string, reason?: string) =>
      this.record({ at: new Date(now).toISOString(), teamId: message.teamId, groupId: group.id, messageId: message.id, source, decision, ...(reason ? { reason } : {}) })

    let chosen: RouteCandidate | null = null
    const rule = view.attempt < 2 ? this.options.rules.rule(group.id) : undefined
    if (rule) {
      const ctx: RouteContext = {
        now: new Date(now).toISOString(), group: routeGroup, message: routeMessage(message, worktree), candidates, profiles,
        providers: providerStates,
      }
      try {
        const decision = await rule.route(ctx)
        if (decision.type === 'hold') {
          const until = decision.retryAfterMs !== undefined ? now + decision.retryAfterMs : null
          this.holds.set(message.id, { until, signature, ...(decision.reason ? { reason: decision.reason } : {}) })
          record('rule', 'hold', decision.reason)
          return { kind: 'hold', retryAt: until, diagnosis: [routingHold(until, decision.reason)] }
        }
        if (decision.type === 'pick') {
          chosen = candidates.find(candidate => candidate.id === decision.candidateId) ?? null
          if (chosen) record('rule', chosen.id)
          else record('fallback', 'built-in', `rule picked unknown candidate ${decision.candidateId}`)
        }
      } catch (error) {
        record('fallback', 'built-in', `rule failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!chosen) {
      chosen = builtinPick(group.strategy, candidates, order, cooling)
      if (!chosen) {
        // Every candidate is cooling: try again when the first cooldown ends.
        const ends = candidates.map(candidate => Date.parse(profiles[candidate.profileId]?.cooldownUntil ?? ''))
          .filter(Number.isFinite)
        const retryAt = ends.length > 0 ? Math.min(...ends) : null
        // The log names the provider when its cooldown decides (providers-and-workers D15).
        const states = candidates
          .map(candidate => this.options.limits.cooldownFor(candidate.profileId, providerOf(candidate.profileId)))
        const providers = [...new Set(states
          .filter(state => state.provider && state.providerId !== null)
          .map(state => state.providerId!))]
        // Out of credit only when every cooling candidate is (openrouter-provider D8).
        const credit = states.some(state => state.until !== null) && states.every(state => state.until === null || state.credit)
        record('builtin', 'hold', providers.length > 0
          ? `every candidate profile is cooling (provider ${providers.join(', ')})`
          : 'every candidate profile is cooling')
        const until = retryAt !== null ? { retryAt: new Date(retryAt).toISOString() } : {}
        return { kind: 'hold', retryAt, diagnosis: [
          // A cooling choice holds with the cooldown end as its retry (D5).
          ...(workerChoice ? [{ kind: 'worker-choice' as const, detail: workerChoice.selector, ...until }] : []),
          { kind: 'all-profiles-cooling', ...until, ...(credit ? { credit: true as const } : {}) },
        ] }
      }
      record('builtin', chosen.id, view.attempt === 2 ? 'stale pick retried' : undefined)
    }
    if (chosen.kind === 'member') return { kind: 'member', sessionId: chosen.sessionId! }
    const assignment = await this.options.staffing.spawnFor(message, chosen.cwd, group, chosen.profileId)
    return assignment ? { kind: 'spawned', assignment } : { kind: 'none' }
  }

  private profileStates(group: GroupDefinition, candidates: RouteCandidate[], _now: number): Record<string, RouteProfileState> {
    const ids = new Set([...group.profiles.map(entry => entry.profileId), ...candidates.map(candidate => candidate.profileId)])
    if (group.profiles.length === 0) ids.add(DEFAULT_PROFILE_ID)
    const states: Record<string, RouteProfileState> = {}
    for (const id of ids) {
      const events = this.options.limits.forProfile(id)
      states[id] = {
        providerId: this.providerOf(id),
        usage: usageView(this.options.usageOf(id)),
        limitEvents: events,
        // The profile's effective cooldown (providers-and-workers D8): its
        // provider's provider-scoped events cool it too.
        cooldownUntil: this.options.limits.cooldownFor(id, this.providerOf(id)).until,
      }
    }
    return states
  }

  /**
   * The D14 provider view of a profile-state map: one entry per profile's
   * provider, holding the account's own facts — its catalog label, its
   * members, its report, its provider-scoped events, and its own cooldown.
   */
  private providerStates(profiles: Record<string, RouteProfileState>): Record<string, RouteProviderState> {
    const byProvider = new Map<string, string[]>()
    for (const [id, state] of Object.entries(profiles)) {
      const members = byProvider.get(state.providerId) ?? []
      members.push(id)
      byProvider.set(state.providerId, members)
    }
    const states: Record<string, RouteProviderState> = {}
    for (const [providerId, members] of byProvider) {
      states[providerId] = {
        label: this.options.providerLabel?.(providerId) ?? null,
        profiles: members,
        // Keyed by provider id (D14): a provider id can double as another
        // provider's model key, so the profile-keyed source would re-map it.
        usage: usageView(this.options.providerUsageOf(providerId)),
        limitEvents: this.options.limits.forProvider(providerId),
        cooldownUntil: this.options.limits.providerCooldownUntil(providerId),
      }
    }
    return states
  }

  private providerOf(profileId: string): string {
    return this.options.providerOf?.(profileId) ?? profileId
  }

  private record(entry: RouteDecisionLogEntry) {
    const key = `${entry.teamId}\0${entry.groupId}`
    const entries = [entry, ...(this.log.get(key) ?? [])].slice(0, DECISION_LOG_SIZE)
    this.log.set(key, entries)
    this.options.onDecision?.(entry)
  }
}

/** The rule view of a report: the window facts a rule reads, nothing else. */
export function usageView(usage: ChatUsageReport | null): RouteUsage | null {
  return usage ? {
    status: usage.status, receivedAt: usage.receivedAt, source: usage.source ?? 'unknown',
    windows: usage.windows.map(window => ({ key: window.key, percentUsed: window.percentUsed, resetsAt: window.resetsAt })),
  } : null
}

function memberState(member: GroupMemberRecord, eligible: EligibleMember | undefined) {
  return {
    sessionId: member.sessionId, profileId: member.profileId, cwd: member.cwd, eligible: !!eligible,
    ...(eligible ? { idleForMs: eligible.idleForMs } : {}),
  }
}

/** The message filter that dropped each dispatcher-eligible member, from the eligibility check. */
function filterExclusions(excluded: EligibilityResult['excluded'], eligible: ReadonlyMap<string, EligibleMember>): MemberExclusion[] {
  return excluded.flatMap(({ alternative, reasons }) => {
    if (alternative.kind !== 'member' || !eligible.has(alternative.sessionId)) return []
    const reason = reasons.find(entry => FILTER_KINDS.has(entry.kind))
    if (!reason) return []
    return [{ sessionId: alternative.sessionId, kind: reason.kind as MemberExclusion['kind'], ...(reason.detail !== undefined ? { detail: reason.detail } : {}) }]
  })
}

const FILTER_KINDS: ReadonlySet<string> = new Set(['outside-role', 'worker-choice', 'excluded-profile'])

/** A readable cause for the no-eligible-member breakdown line. */
const CAUSE_LABELS: Record<MemberExclusion['kind'], string> = {
  'busy': 'working',
  'pending-card': 'awaiting an approval or answer',
  'parked': 'parked',
  'context-exhausted': 'context exhausted',
  'other-worktree': 'in another worktree',
  'unavailable': 'unavailable',
  'startup-failed': 'startup failed',
  'excluded-profile': 'on the excluded profile',
  'outside-role': 'outside the plan role\'s profiles',
  'worker-choice': 'not on the chosen worker',
  'profile-cooling': 'cooling',
}

/** The no-eligible-member constraint from the dispatcher's member breakdown. */
function noEligible(view: RouteView): WaitingConstraint[] {
  const exclusions = view.exclusions ?? []
  if (exclusions.length === 0) return [{ kind: 'no-eligible-member', detail: 'the group has no live members' }]
  // Structured, not pre-joined: the client names and links each member (S1).
  return [{
    kind: 'no-eligible-member',
    sessionIds: exclusions.map(entry => entry.sessionId),
    members: exclusions.map(entry => ({
      sessionId: entry.sessionId,
      cause: CAUSE_LABELS[entry.kind],
      ...(entry.kind === 'other-worktree' && entry.detail ? { detail: entry.detail } : {}),
    })),
  }]
}

/** A routing hold with the rule's reason and retry time. */
function routingHold(until: number | null, reason?: string): WaitingConstraint {
  return { kind: 'routing-hold', ...(reason ? { detail: reason } : {}), ...(until !== null ? { retryAt: new Date(until).toISOString() } : {}) }
}

/**
 * The constraints behind a `none` (team-waiting-reasons D2/Q1): the same
 * live counts the candidate builder tallied, the spawn facts staffing
 * reported, and the dispatcher's member breakdown. Caps lead — group, then
 * per-profile, then team spawn, then worktree occupancy — then member
 * facts, then spawn specifics; `orderConstraints` fixes the final order.
 * Under a worker choice only the chosen profiles' caps are listed.
 */
function diagnoseNone(
  group: RouteGroup, spawn: SpawnContext | null, view: RouteView, chosenProfiles: ReadonlySet<string> | null,
): WaitingConstraint[] {
  const constraints: WaitingConstraint[] = []
  if (group.live >= group.max) constraints.push({ kind: 'group-cap', counts: { live: group.live, cap: group.max } })
  for (const profile of group.profiles) {
    if (chosenProfiles && !chosenProfiles.has(profile.profileId)) continue
    if (profile.cap !== undefined && profile.live >= profile.cap) {
      constraints.push({ kind: 'profile-cap', counts: { live: profile.live, cap: profile.cap }, detail: profile.profileId })
    }
  }
  const facts = spawn?.facts
  if (facts && facts.teamSpawned >= facts.teamCap) {
    constraints.push({ kind: 'team-spawn-cap', counts: { live: facts.teamSpawned, cap: facts.teamCap } })
  }
  if (facts && facts.worktreeOccupants.length + facts.worktreePending >= 1) {
    constraints.push({
      kind: 'worktree-occupied',
      counts: { live: facts.worktreeOccupants.length + facts.worktreePending, cap: 1 },
      ...(facts.worktreeOccupants.length > 0 ? { sessionIds: facts.worktreeOccupants } : {}),
      detail: spawn!.worktree,
    })
  }
  const startup = (view.exclusions ?? []).find(entry => entry.kind === 'startup-failed')
  if (startup) constraints.push({ kind: 'startup-failed', ...(startup.detail ? { detail: startup.detail } : {}) })
  constraints.push(...noEligible(view))
  if (facts?.backoffRetryAt != null) {
    constraints.push({ kind: 'spawn-backoff', retryAt: new Date(facts.backoffRetryAt).toISOString() })
  }
  return constraints
}

function routeMessage(message: TeamMessage, worktree: string | null): RouteMessage {
  return {
    id: message.id, priority: message.priority, senderGroup: message.fromGroup, tags: message.tags,
    worktree, taskId: message.taskId,
    ...(message.handoff ? { forwardedFromProfile: message.handoff.fromProfile } : {}),
    ...(message.workerChoice ? { worker: message.workerChoice } : {}),
  }
}
