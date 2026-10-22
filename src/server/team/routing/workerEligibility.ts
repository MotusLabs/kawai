// The one pure eligibility check for group mail (dispatch-worker-choice D10).
// Given a stated routing state — the group's workers, caps and strategy, the
// message's filters, the members with their state, the staffing counts, the
// cooldowns in force, and the evaluation time — it names the eligible
// members and spawn slots in preference order and every excluded
// alternative with its reasons. It does no I/O and reads no clock: a live
// pass states the current objects, an observer at an incident cutoff states
// the state then, and both get the same answer for the same state.
//
// Two layers: `memberStateCauses` judges one member's own state (the cause
// reporter beneath the dispatcher's predicates, team-waiting-reasons D2), and
// `evaluateEligibility` applies the message's filters and the caps to the
// whole group. `buildCandidates` and `memberCauses.ts` are adapters over it.
// Cooling candidates stay candidates (a rule may take them; the built-in
// strategy skips them), so cooling is reported beside them, never as an
// exclusion — except the member cause direct mail rejects.
import type { RouteCandidate, RouteGroup } from '../../../shared/routing'

export type MemberExclusionKind =
  | 'busy'
  | 'pending-card'
  | 'parked'
  | 'context-exhausted'
  | 'other-worktree'
  | 'unavailable'
  | 'startup-failed'
  | 'excluded-profile'
  | 'outside-role'
  | 'worker-choice'
  | 'profile-cooling'

export interface MemberExclusion {
  sessionId: string
  kind: MemberExclusionKind
  /** A fact for the reason: where the member is, or the start error. */
  detail?: string
}

/** A member's own state, as the recipient view states it. */
export interface MemberFacts {
  sessionId: string
  idle: boolean
  pendingRequest: boolean
  available: boolean
  worktree?: string
  parked?: boolean
  contextExhausted?: boolean
  profileId?: string
  cooldownUntil?: string | null
  cooldownProvider?: string | null
}

/** The message facts the member causes read. */
export interface MailFacts {
  toKind: string
  excludedProfile?: string | null
  allowedProfiles?: string[] | null
}

/** The plan-role exclusion (plan-execution D15); null inside the role or with none set. */
export function outsideRoleExclusion(sessionId: string, profileId: string | null | undefined, allowedProfiles: string[] | null | undefined): MemberExclusion | null {
  if (allowedProfiles === null || allowedProfiles === undefined || allowedProfiles.includes(profileId ?? 'default')) return null
  return { sessionId, kind: 'outside-role', detail: `plan role allows only ${allowedProfiles.join(', ')}` }
}

/**
 * Every reason `member` cannot take `mail` right now (empty = it can). An
 * unavailable session's busy/card state is noise beneath the reason it
 * cannot start at all; cooling is reported, and only direct mail rejects it.
 */
export function memberStateCauses(
  member: MemberFacts,
  mail: MailFacts,
  options: { targetWorktree: string | null; now: number; startupFailed: boolean }
): MemberExclusion[] {
  const causes: MemberExclusion[] = []
  const add = (kind: MemberExclusionKind, detail?: string) =>
    causes.push({ sessionId: member.sessionId, kind, ...(detail !== undefined ? { detail } : {}) })
  if (!member.available) {
    add('unavailable')
  } else {
    if (member.pendingRequest) add('pending-card')
    if (!member.idle) add('busy')
  }
  if (member.parked) add('parked')
  // A context-exhausted session (chat-context-exhaustion D7) takes no mail.
  if (member.contextExhausted) add('context-exhausted')
  if (options.startupFailed) add('startup-failed')
  if (mail.toKind === 'group' && options.targetWorktree !== null && member.worktree !== options.targetWorktree) {
    add('other-worktree', member.worktree)
  }
  if (mail.excludedProfile && (member.profileId ?? 'default') === mail.excludedProfile) add('excluded-profile')
  const outsideRole = outsideRoleExclusion(member.sessionId, member.profileId, mail.allowedProfiles)
  if (outsideRole !== null) causes.push(outsideRole)
  if (Date.parse(member.cooldownUntil ?? '') > options.now) add('profile-cooling', member.cooldownProvider ?? undefined)
  return causes
}

/**
 * Whether `member` passes the group path's member-state predicates: every
 * cause rejects except the direct-only ones (`excluded-profile` is the
 * candidate filter's; cooling members stay candidates). The dispatcher's
 * eligible members and the dispatch preview's idle members both read it.
 */
export function groupPathEligible(member: MemberFacts, mail: MailFacts, options: { targetWorktree: string | null; now: number; startupFailed: boolean }): boolean {
  return !memberStateCauses(member, mail, options).some(cause => cause.kind !== 'excluded-profile' && cause.kind !== 'profile-cooling')
}

/** Profile spawned members get when the group lists none. */
export const DEFAULT_PROFILE_ID = 'default'

export const spawnCandidateId = (profileId: string) => `spawn:${profileId}`
export const memberCandidateId = (sessionId: string) => `member:${sessionId}`

/** The group as routing states it: its workers in preference order, caps, `max`, strategy. */
export interface EligibilityGroup {
  id: string
  profiles: Array<{ profileId: string; cap?: number }>
  max: number
  strategy: RouteGroup['strategy']
}

/** One live (non-archived) member of the group. */
export interface EligibilityMember {
  sessionId: string
  profileId: string
  cwd: string
  /** Passed the member-state predicates this pass (idle order, worktree, parking). */
  eligible: boolean
  idleForMs?: number
  /** Why it did not, when it did not (the member causes); reported on its exclusion. */
  causes?: MemberExclusion[]
}

/** Staffing counts behind whether a spawn is allowed (the waiting reasons' facts). */
export interface EligibilityStaffing {
  teamSpawned: number
  teamCap: number
  worktreeOccupants: string[]
  worktreePending: number
  /** Epoch ms when a failed spawn retries; null = no backoff. */
  backoffRetryAt: number | null
}

export interface EligibilityState {
  group: EligibilityGroup
  members: EligibilityMember[]
  /** Profiles of this group's pending spawn reservations. */
  pendingSpawnProfiles: string[]
  /** Staffing would spawn for this message (worktree mail, team and worktree caps allow). */
  spawnAllowed: boolean
  /** Where a spawned member would start; null = no spawn slots at all. */
  spawnCwd: string | null
  /** The staffing counts behind `spawnAllowed`, for the slots' exclusion reasons. */
  staffing?: EligibilityStaffing
  /** A forwarded message never goes back to the limited profile. */
  excludeProfile?: string
  /** The excluded model's provider while it cools (providers-and-workers D9). */
  excludeProvider?: string
  /** Resolves each worker's provider; ids stand in as their own provider. */
  providerOf?: (profileId: string) => string
  /** The role's profiles, in the role's order (plan-execution D15); null narrows nothing. */
  allowedProfiles?: string[] | null
  /**
   * The sender's worker choice (dispatch-worker-choice D2): its canonical
   * selector and the group's model keys it resolves to this pass. It narrows
   * within the role, never widens it; null narrows nothing.
   */
  workerChoice?: { selector: string; profiles: readonly string[] } | null
  /** Each profile's effective cooldown end (ISO) in force at `now`; absent = not cooling. */
  cooldowns?: Readonly<Record<string, string | null>>
  /** Evaluation time, epoch ms. */
  now?: number
}

/** One reason an alternative is excluded: a waiting-constraint kind or a member cause. */
export interface EligibilityReason {
  /** `spawn-not-allowed`: the state disallows spawning without staffing counts saying why. */
  kind: MemberExclusionKind | 'group-cap' | 'profile-cap' | 'team-spawn-cap' | 'worktree-occupied' | 'spawn-backoff' | 'spawn-not-allowed'
  counts?: { live: number; cap: number }
  detail?: string
  sessionIds?: string[]
  /** ISO. */
  retryAt?: string
}

export type EligibilityAlternative =
  | { kind: 'member'; sessionId: string; profileId: string }
  | { kind: 'spawn'; profileId: string }

export interface EligibilityResult {
  /** Eligible members (in the order given: longest idle first), then spawn slots in preference order. */
  candidates: RouteCandidate[]
  group: RouteGroup
  /** Every excluded member and worker slot, with its reasons. */
  excluded: Array<{ alternative: EligibilityAlternative; reasons: EligibilityReason[] }>
  /** Candidates on a profile cooling at `now`, by candidate id: the cooldown end (ISO). */
  cooling: Record<string, string>
}

export function evaluateEligibility(state: EligibilityState): EligibilityResult {
  const { group } = state
  const liveOn = new Map<string, number>()
  const count = (profileId: string) => liveOn.set(profileId, (liveOn.get(profileId) ?? 0) + 1)
  for (const member of state.members) count(member.profileId)
  for (const profileId of state.pendingSpawnProfiles) count(profileId)
  const live = state.members.length + state.pendingSpawnProfiles.length
  const workers = group.profiles.length > 0 ? group.profiles : [{ profileId: DEFAULT_PROFILE_ID }]
  const provider = state.providerOf ?? ((profileId: string) => profileId)

  /**
   * The message's filters, role first (D2): the reasons a profile may not
   * take it. A profile outside the role reports only `outside-role`; one
   * inside it but outside the worker choice reports `worker-choice`.
   */
  const filterReasons = (profileId: string): EligibilityReason[] => {
    const reasons: EligibilityReason[] = []
    const role = state.allowedProfiles
    const choice = state.workerChoice
    if (role !== null && role !== undefined && !role.includes(profileId)) {
      reasons.push({ kind: 'outside-role', detail: `plan role allows only ${role.join(', ')}` })
    } else if (choice && !choice.profiles.includes(profileId)) {
      reasons.push({ kind: 'worker-choice', detail: choice.selector })
    }
    if (profileId === state.excludeProfile) reasons.push({ kind: 'excluded-profile', detail: profileId })
    else if (state.excludeProvider !== undefined && provider(profileId) === state.excludeProvider) {
      reasons.push({ kind: 'excluded-profile', detail: `provider ${state.excludeProvider}` })
    }
    return reasons
  }

  const candidates: RouteCandidate[] = []
  const excluded: EligibilityResult['excluded'] = []
  for (const member of state.members) {
    const filtered = filterReasons(member.profileId)
    if (member.eligible && filtered.length === 0) {
      candidates.push({
        id: memberCandidateId(member.sessionId), kind: 'member', profileId: member.profileId,
        providerId: provider(member.profileId),
        sessionId: member.sessionId, cwd: member.cwd,
        ...(member.idleForMs !== undefined ? { idleForMs: member.idleForMs } : {}),
      })
      continue
    }
    const own: EligibilityReason[] = member.eligible ? [] : (member.causes && member.causes.length > 0
      ? member.causes.map(cause => ({ kind: cause.kind, ...(cause.detail !== undefined ? { detail: cause.detail } : {}) }))
      : [{ kind: 'busy', detail: 'not eligible this pass' }])
    const reasons = [...filtered.filter(reason => !own.some(entry => entry.kind === reason.kind)), ...own]
    excluded.push({ alternative: { kind: 'member', sessionId: member.sessionId, profileId: member.profileId }, reasons })
  }

  if (state.spawnCwd !== null) {
    // Spawn slots follow the role's order when one is set, else the group's
    // (D15); the worker choice only drops slots, so the order is kept (D3).
    const byId = new Map(workers.map(entry => [entry.profileId, entry]))
    const order = state.allowedProfiles
      ? [...state.allowedProfiles.filter(profileId => byId.has(profileId)), ...workers.map(entry => entry.profileId).filter(id => !state.allowedProfiles!.includes(id))]
      : workers.map(entry => entry.profileId)
    const staffingReasons = spawnStaffingReasons(state, live)
    for (const profileId of order) {
      const entry = byId.get(profileId)!
      const reasons = [...filterReasons(profileId)]
      const onProfile = liveOn.get(profileId) ?? 0
      if (entry.cap !== undefined && onProfile >= entry.cap) {
        reasons.push({ kind: 'profile-cap', counts: { live: onProfile, cap: entry.cap }, detail: profileId })
      }
      reasons.push(...staffingReasons)
      if (reasons.length > 0) {
        excluded.push({ alternative: { kind: 'spawn', profileId }, reasons })
        continue
      }
      candidates.push({ id: spawnCandidateId(profileId), kind: 'spawn', profileId, providerId: provider(profileId), cwd: state.spawnCwd })
    }
  }

  const cooling: Record<string, string> = {}
  for (const candidate of candidates) {
    const until = state.cooldowns?.[candidate.profileId] ?? null
    if (until !== null && (state.now === undefined || Date.parse(until) > state.now)) cooling[candidate.id] = until
  }
  return {
    candidates,
    group: {
      id: group.id,
      profiles: workers.map(entry => ({
        profileId: entry.profileId, providerId: provider(entry.profileId), live: liveOn.get(entry.profileId) ?? 0,
        ...(entry.cap !== undefined ? { cap: entry.cap } : {}),
      })),
      max: group.max,
      live,
      strategy: group.strategy,
    },
    excluded,
    cooling,
  }
}

/** Why no slot may spawn at all: the group's `max`, then the staffing facts behind `spawnAllowed`. */
function spawnStaffingReasons(state: EligibilityState, live: number): EligibilityReason[] {
  const reasons: EligibilityReason[] = []
  if (live >= state.group.max) reasons.push({ kind: 'group-cap', counts: { live, cap: state.group.max } })
  if (state.spawnAllowed) return reasons
  const facts = state.staffing
  if (facts && facts.teamSpawned >= facts.teamCap) {
    reasons.push({ kind: 'team-spawn-cap', counts: { live: facts.teamSpawned, cap: facts.teamCap } })
  }
  const writers = facts ? facts.worktreeOccupants.length + facts.worktreePending : 0
  if (facts && writers >= 1) {
    reasons.push({
      kind: 'worktree-occupied', counts: { live: writers, cap: 1 },
      ...(facts.worktreeOccupants.length > 0 ? { sessionIds: facts.worktreeOccupants } : {}),
      ...(state.spawnCwd !== null ? { detail: state.spawnCwd } : {}),
    })
  }
  if (facts?.backoffRetryAt != null) reasons.push({ kind: 'spawn-backoff', retryAt: new Date(facts.backoffRetryAt).toISOString() })
  // A state that disallows spawning without stating why still offers no slot.
  if (!reasons.some(reason => reason.kind !== 'group-cap')) reasons.push({ kind: 'spawn-not-allowed' })
  return reasons
}
