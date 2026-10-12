// Profile routing for group mail (profile-routing design D4/D5). For one
// message: load its group, build the candidates (eligible members from the
// dispatcher plus spawn slots staffing allows), ask the group's rule — or
// the built-in strategy when there is none, it says `default`, fails, times
// out, or picks something not offered — and turn the choice into a member,
// a spawned member, a hold, or nothing. A held message is not re-asked
// until its retry time passes or its candidates change. Every decision is
// kept in a small per-group log for the mailbox view.
import type { ChatUsageReport } from '../../../shared/chat'
import type {
  RouteCandidate, RouteContext, RouteDecisionLogEntry, RouteMessage, RouteProfileState,
} from '../../../shared/routing'
import type { EligibleMember, GroupRouter, RouteResult, RouteView } from '../dispatcher'
import type { GroupDefinition } from '../groupFile'
import type { TeamMessage } from '../mailboxStore'
import type { WorktreeStaffing } from '../staffing'
import { builtinPick } from './builtin'
import { buildCandidates, DEFAULT_PROFILE_ID } from './candidates'
import { cooldownUntil, type LimitEventStore } from './limitEvents'
import type { RuleRegistry } from './ruleLoader'

/** Entries kept per group. */
export const DECISION_LOG_SIZE = 50

/** A live (non-archived) member of a group, whatever its state. */
export interface GroupMemberRecord {
  sessionId: string
  profileId: string
  cwd: string
}

export interface ProfileRouterOptions {
  /** The message's group definition; undefined when the group is gone. */
  groupOf: (message: TeamMessage) => Promise<GroupDefinition | undefined>
  /** Every live member of a team's group. */
  members: (teamId: string, groupId: string) => GroupMemberRecord[]
  targetWorktree: (message: TeamMessage) => string | null
  staffing: Pick<WorktreeStaffing, 'spawnContext' | 'spawnFor'>
  rules: Pick<RuleRegistry, 'rule'>
  limits: Pick<LimitEventStore, 'forProfile'>
  usageOf: (profileId: string) => ChatUsageReport | null
  /** The profile a forwarded message must not go back to. */
  excludedProfile?: (message: TeamMessage) => string | undefined
  onDecision?: (entry: RouteDecisionLogEntry) => void
  now?: () => number
}

export class ProfileRouter implements GroupRouter {
  private readonly holds = new Map<string, { until: number | null; signature: string }>()
  private readonly log = new Map<string, RouteDecisionLogEntry[]>()

  constructor(private readonly options: ProfileRouterOptions) {}

  /** Newest first, for one team. */
  decisions(teamId: string): RouteDecisionLogEntry[] {
    return [...this.log.entries()].filter(([key]) => key.startsWith(`${teamId}\0`))
      .flatMap(([, entries]) => entries).sort((a, b) => b.at.localeCompare(a.at))
  }

  async route(message: TeamMessage, view: RouteView): Promise<RouteResult> {
    const now = this.options.now?.() ?? Date.now()
    const group = await this.options.groupOf(message)
    if (!group) {
      // A group file that is gone keeps its members' mail flowing to them.
      return view.eligible[0] ? { kind: 'member', sessionId: view.eligible[0].sessionId } : { kind: 'none' }
    }
    const worktree = this.options.targetWorktree(message)
    const spawn = await this.options.staffing.spawnContext(message, worktree)
    if (spawn === 'worktree-missing') return { kind: 'none' }
    const eligible = new Map(view.eligible.map(row => [row.sessionId, row]))
    const members = this.options.members(message.teamId, group.id)
    const { candidates, group: routeGroup } = buildCandidates({
      group,
      members: members.map(member => memberState(member, eligible.get(member.sessionId))),
      pendingSpawnProfiles: spawn?.pendingProfiles ?? [],
      spawnAllowed: spawn?.allowed ?? false,
      spawnCwd: spawn?.worktree ?? null,
      ...(this.options.excludedProfile?.(message) ? { excludeProfile: this.options.excludedProfile(message)! } : {}),
    })
    if (candidates.length === 0) {
      this.holds.delete(message.id)
      return { kind: 'none' }
    }
    const signature = candidates.map(candidate => candidate.id).sort().join(',')
    const held = this.holds.get(message.id)
    if (held && held.signature === signature && (held.until === null || held.until > now)) {
      return { kind: 'hold', retryAt: held.until }
    }
    this.holds.delete(message.id)

    const profiles = this.profileStates(group, candidates, now)
    const cooling = (profileId: string) => profiles[profileId]?.cooldownUntil != null
    const order = routeGroup.profiles.map(entry => entry.profileId)
    const record = (source: RouteDecisionLogEntry['source'], decision: string, reason?: string) =>
      this.record({ at: new Date(now).toISOString(), teamId: message.teamId, groupId: group.id, messageId: message.id, source, decision, ...(reason ? { reason } : {}) })

    let chosen: RouteCandidate | null = null
    const rule = view.attempt < 2 ? this.options.rules.rule(group.id) : undefined
    if (rule) {
      const ctx: RouteContext = {
        now: new Date(now).toISOString(), group: routeGroup, message: routeMessage(message, worktree), candidates, profiles,
      }
      try {
        const decision = await rule.route(ctx)
        if (decision.type === 'hold') {
          const until = decision.retryAfterMs !== undefined ? now + decision.retryAfterMs : null
          this.holds.set(message.id, { until, signature })
          record('rule', 'hold', decision.reason)
          return { kind: 'hold', retryAt: until }
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
        record('builtin', 'hold', 'every candidate profile is cooling')
        return { kind: 'hold', retryAt }
      }
      record('builtin', chosen.id, view.attempt === 2 ? 'stale pick retried' : undefined)
    }
    if (chosen.kind === 'member') return { kind: 'member', sessionId: chosen.sessionId! }
    const assignment = await this.options.staffing.spawnFor(message, chosen.cwd, group, chosen.profileId)
    return assignment ? { kind: 'spawned', assignment } : { kind: 'none' }
  }

  private profileStates(group: GroupDefinition, candidates: RouteCandidate[], now: number): Record<string, RouteProfileState> {
    const ids = new Set([...group.profiles.map(entry => entry.profileId), ...candidates.map(candidate => candidate.profileId)])
    if (group.profiles.length === 0) ids.add(DEFAULT_PROFILE_ID)
    const states: Record<string, RouteProfileState> = {}
    for (const id of ids) {
      const events = this.options.limits.forProfile(id)
      const usage = this.options.usageOf(id)
      states[id] = {
        usage: usage ? {
          status: usage.status, receivedAt: usage.receivedAt, source: usage.source ?? 'unknown',
          windows: usage.windows.map(window => ({ key: window.key, percentUsed: window.percentUsed, resetsAt: window.resetsAt })),
        } : null,
        limitEvents: events,
        cooldownUntil: cooldownUntil(events, now),
      }
    }
    return states
  }

  private record(entry: RouteDecisionLogEntry) {
    const key = `${entry.teamId}\0${entry.groupId}`
    const entries = [entry, ...(this.log.get(key) ?? [])].slice(0, DECISION_LOG_SIZE)
    this.log.set(key, entries)
    this.options.onDecision?.(entry)
  }
}

function memberState(member: GroupMemberRecord, eligible: EligibleMember | undefined) {
  return {
    sessionId: member.sessionId, profileId: member.profileId, cwd: member.cwd, eligible: !!eligible,
    ...(eligible ? { idleForMs: eligible.idleForMs } : {}),
  }
}

function routeMessage(message: TeamMessage, worktree: string | null): RouteMessage {
  return {
    id: message.id, priority: message.priority, senderGroup: message.fromGroup, tags: message.tags,
    worktree, taskId: message.taskId,
  }
}
