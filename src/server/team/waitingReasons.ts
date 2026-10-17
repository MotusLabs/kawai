// Waiting-reason ordering and the per-team reason ledger
// (team-waiting-reasons D1/D3). The constraints a dispatch pass, a spawn
// failure, or a routing decision produces are ordered once, here, so every
// consumer (ledger, snapshot derivation, router diagnosis) agrees on which
// constraint is the immediate blocker. The ledger is in-memory only: nothing
// persists, and after a restart the first pass rebuilds every entry.
import type { WaitingConstraint, WaitingConstraintKind, WaitingReason } from '../../shared/team'

/**
 * D1's deterministic order, decided by the human (Q1): a missing group
 * definition first (nothing can proceed without it), then capacity — group
 * cap, per-profile cap, team spawn cap, worktree occupancy — then member
 * facts, then spawn and routing specifics. The first present entry is the
 * immediate blocker. `starting-agent` never competes: a `spawning` row's
 * blocker is pinned to it by the snapshot derivation, not by this order.
 */
const KIND_ORDER: Record<WaitingConstraintKind, number> = {
  'group-missing': 0,
  'group-cap': 1,
  'profile-cap': 2,
  'team-spawn-cap': 3,
  'worktree-occupied': 4,
  'startup-failed': 5,
  'no-eligible-member': 6,
  'recipient-busy': 7,
  'recipient-pending-request': 8,
  'recipient-unavailable': 9,
  'outside-role': 10,
  'profile-cooling': 11,
  'spawn-backoff': 12,
  'routing-hold': 13,
  'all-profiles-cooling': 14,
  'starting-agent': 15,
}

/** Constraints in blocker-first order; the sort is stable within a kind. */
export function orderConstraints(constraints: WaitingConstraint[]): WaitingConstraint[] {
  return [...constraints].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
}

/** A reason from unordered constraints: first is the blocker, rest are others. */
export function toReason(constraints: WaitingConstraint[]): WaitingReason | null {
  const ordered = orderConstraints(constraints)
  return ordered.length > 0 ? { blocker: ordered[0]!, others: ordered.slice(1) } : null
}

/**
 * Structural compare, not timestamps: reason churn must not flood snapshots,
 * so an unchanged reason — same kinds, counts, ids, times, details — never
 * re-publishes. Server-built constraints construct with stable key order.
 */
export function sameReason(a: WaitingReason | null | undefined, b: WaitingReason | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * The per-team reason ledger (D3's after-pass store): the single in-memory
 * place a message's current waiting reason lives between dispatch passes.
 * Transition-time writers (a spawn failure's backoff) and pass-end writers
 * (router diagnoses, direct-mail reasons) both land here; the snapshot
 * assembler reads it and derives `spawning` rows live.
 */
export class ReasonLedger {
  private readonly teams = new Map<string, Map<string, WaitingReason>>()

  /** Set one message's reason (null clears); true when the team changed. */
  set(teamId: string, messageId: string, reason: WaitingReason | null): boolean {
    const team = this.teams.get(teamId) ?? new Map<string, WaitingReason>()
    if (sameReason(team.get(messageId) ?? null, reason)) return false
    if (reason === null) team.delete(messageId)
    else team.set(messageId, reason)
    if (team.size === 0) this.teams.delete(teamId)
    else this.teams.set(teamId, team)
    return true
  }

  /** Drop entries for messages that left the waiting surface; teams changed. */
  prune(keep: ReadonlySet<string>): Set<string> {
    const changed = new Set<string>()
    for (const [teamId, team] of this.teams) {
      for (const messageId of team.keys()) {
        if (keep.has(messageId)) continue
        team.delete(messageId)
        changed.add(teamId)
      }
      if (team.size === 0) this.teams.delete(teamId)
    }
    return changed
  }

  /** The team's current reasons, keyed by message id, for the snapshot. */
  forTeam(teamId: string): Record<string, WaitingReason> {
    const out: Record<string, WaitingReason> = {}
    for (const [messageId, reason] of this.teams.get(teamId) ?? []) out[messageId] = reason
    return out
  }
}
