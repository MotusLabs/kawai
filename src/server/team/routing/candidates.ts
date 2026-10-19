// Route candidates for one group message (profile-routing design D4/D4a).
// Pure: the dispatcher supplies the group's live members (already judged
// eligible or not by delivery rules, worktree, and parking) and whether
// staffing may spawn at all (worktree task mail, team cap, one spawned
// writer per worktree); this module applies the per-profile caps and the
// group `max`, and reports the live counts rules see. Cooling profiles stay
// among the candidates — a rule may decide otherwise; the built-in strategy
// skips them — except the profile a forwarded message left.
//
// Caps count every non-archived member of the group on a profile — created
// by the user or spawned, busy or parked — plus pending spawn reservations.
// Other groups never count.
import type { RouteCandidate, RouteGroup } from '../../../shared/routing'
import type { GroupDefinition } from '../groupFile'

/** One live (non-archived) member of the group. */
export interface GroupMemberState {
  sessionId: string
  profileId: string
  cwd: string
  /** May take this message now: idle, available, in the target worktree, not parked. */
  eligible: boolean
  idleForMs?: number
}

export interface CandidateInput {
  group: GroupDefinition
  members: GroupMemberState[]
  /** Profiles of this group's pending spawn reservations. */
  pendingSpawnProfiles: string[]
  /** Staffing would spawn for this message (worktree mail, team and worktree caps allow). */
  spawnAllowed: boolean
  /** Where a spawned member would start; required for spawn slots. */
  spawnCwd: string | null
  /** A forwarded message never goes back to the limited profile. */
  excludeProfile?: string
  /**
   * The excluded model's provider while it cools (providers-and-workers D9):
   * its other models are hard-filtered too, members and spawn slots alike.
   */
  excludeProvider?: string
  /** Resolves each candidate's provider for the exclusion; ids stand in as their own provider. */
  providerOf?: (profileId: string) => string
  /** The role's profiles this mail may route to, in the role's order (plan-execution D15); null narrows nothing. */
  allowedProfiles?: string[] | null
}

export interface CandidateSet {
  candidates: RouteCandidate[]
  group: RouteGroup
}

/** Profile spawned members get when the group lists none. */
export const DEFAULT_PROFILE_ID = 'default'

export const spawnCandidateId = (profileId: string) => `spawn:${profileId}`
export const memberCandidateId = (sessionId: string) => `member:${sessionId}`

export function buildCandidates(input: CandidateInput): CandidateSet {
  const { group } = input
  const liveOn = new Map<string, number>()
  const count = (profileId: string) => liveOn.set(profileId, (liveOn.get(profileId) ?? 0) + 1)
  for (const member of input.members) count(member.profileId)
  for (const profileId of input.pendingSpawnProfiles) count(profileId)
  const live = input.members.length + input.pendingSpawnProfiles.length
  const allowed = group.profiles.length > 0 ? group.profiles : [{ profileId: DEFAULT_PROFILE_ID }]
  const provider = input.providerOf ?? ((profileId: string) => profileId)
  const usable = (profileId: string) =>
    profileId !== input.excludeProfile && (input.excludeProvider === undefined || provider(profileId) !== input.excludeProvider)
  // A role narrows the mail: only its profiles may take it (D15).
  const inRole = (profileId: string) => input.allowedProfiles === null || input.allowedProfiles === undefined || input.allowedProfiles.includes(profileId)

  const candidates: RouteCandidate[] = []
  for (const member of input.members) {
    if (!member.eligible || !usable(member.profileId) || !inRole(member.profileId)) continue
    candidates.push({
      id: memberCandidateId(member.sessionId), kind: 'member', profileId: member.profileId,
      providerId: provider(member.profileId),
      sessionId: member.sessionId, cwd: member.cwd,
      ...(member.idleForMs !== undefined ? { idleForMs: member.idleForMs } : {}),
    })
  }
  if (input.spawnAllowed && input.spawnCwd !== null && live < group.max) {
    // Spawn slots are offered only for allowed profiles the group also
    // allows, in the role's order (D15).
    const byId = new Map(allowed.map(entry => [entry.profileId, entry]))
    const spawnOrder = input.allowedProfiles
      ? input.allowedProfiles.flatMap(profileId => (byId.has(profileId) ? [profileId] : []))
      : allowed.map(entry => entry.profileId)
    for (const profileId of spawnOrder) {
      const entry = byId.get(profileId)!
      if (!usable(profileId)) continue
      if (entry.cap !== undefined && (liveOn.get(profileId) ?? 0) >= entry.cap) continue
      candidates.push({ id: spawnCandidateId(profileId), kind: 'spawn', profileId, providerId: provider(profileId), cwd: input.spawnCwd })
    }
  }
  return {
    candidates,
    group: {
      id: group.id,
      profiles: allowed.map(entry => ({
        profileId: entry.profileId, providerId: provider(entry.profileId), live: liveOn.get(entry.profileId) ?? 0,
        ...(entry.cap !== undefined ? { cap: entry.cap } : {}),
      })),
      max: group.max,
      live,
      strategy: group.strategy,
    },
  }
}
