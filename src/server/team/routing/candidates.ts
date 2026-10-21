// Route candidates for one group message (profile-routing design D4/D4a),
// an adapter over the pure eligibility check (`workerEligibility.ts`) that
// returns only the candidates and counts; the router reads the check itself,
// for the excluded alternatives its diagnosis names. Pure: the dispatcher
// supplies the group's live members (already judged eligible or not by
// delivery rules, worktree, and parking) and whether
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
import { evaluateEligibility } from './workerEligibility'

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
  /** The sender's worker choice, resolved to the group's model keys (dispatch-worker-choice D2); null narrows nothing. */
  workerChoice?: { selector: string; profiles: readonly string[] } | null
}

export interface CandidateSet {
  candidates: RouteCandidate[]
  group: RouteGroup
}

export { DEFAULT_PROFILE_ID, memberCandidateId, spawnCandidateId } from './workerEligibility'

/** The candidates and counts of the one eligibility check (dispatch-worker-choice D10). */
export function buildCandidates(input: CandidateInput): CandidateSet {
  const { candidates, group } = evaluateEligibility(input)
  return { candidates, group }
}
