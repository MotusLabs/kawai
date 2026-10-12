// Built-in routing strategies (profile-routing spec "Built-in routing
// strategy"), used when a group has no rule, the rule says `default`, or the
// rule fails. Candidates on a cooling profile are skipped, and an idle member
// always beats spawning a new one:
// - `first-available`: the longest-idle member, else the spawn slot of the
//   first allowed profile;
// - `profile-order`: the member whose profile comes earliest in `profiles`
//   (longest idle among equals; unlisted profiles last), else the earliest
//   profile's spawn slot.
import type { RouteCandidate } from '../../../shared/routing'
import type { RoutingStrategy } from '../groupFile'

export function builtinPick(
  strategy: RoutingStrategy,
  all: readonly RouteCandidate[],
  profileOrder: readonly string[],
  cooling: (profileId: string) => boolean = () => false
): RouteCandidate | null {
  const candidates = all.filter(candidate => !cooling(candidate.profileId))
  const rank = (candidate: RouteCandidate) => {
    const index = profileOrder.indexOf(candidate.profileId)
    return index < 0 ? profileOrder.length : index
  }
  const members = candidates.filter(candidate => candidate.kind === 'member')
    .sort((a, b) => (strategy === 'profile-order' ? rank(a) - rank(b) : 0) || (b.idleForMs ?? 0) - (a.idleForMs ?? 0))
  if (members[0]) return members[0]
  const spawns = candidates.filter(candidate => candidate.kind === 'spawn').sort((a, b) => rank(a) - rank(b))
  return spawns[0] ?? null
}
