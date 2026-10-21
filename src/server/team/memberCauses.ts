// Member-state cause reporter (team-waiting-reasons D2): why one live member
// cannot take a message, over the shared recipient fields. A reporter beneath
// the unchanged eligibility and claim predicates — they reject different
// subsets of these causes, so this module reports and never decides.
import type { TeamMessage } from './mailboxStore'
import type { MailRecipient } from './dispatcher'
import { memberStateCauses, outsideRoleExclusion, type MemberExclusion, type MemberExclusionKind } from './routing/workerEligibility'

// The cause vocabulary and the plan-role exclusion live in the one pure
// eligibility check (dispatch-worker-choice D10); this module adapts them.
export type { MemberExclusion, MemberExclusionKind }
export { outsideRoleExclusion }

/**
 * The per-message breakdown the router's diagnosis reads (team-waiting-reasons
 * S1): one entry per group member — eligible ones carry only the causes the
 * candidate builder already dropped (excluded profile, outside the role);
 * the others their first non-cooling cause, with a start failure's error.
 */
export function messageExclusions(input: {
  message: TeamMessage
  recipients: MailRecipient[]
  eligibleIds: ReadonlySet<string>
  targetWorktree: string | null
  startFailure: { sessionId: string; error: string } | null
  now: number
  startupFailed: (sessionId: string) => boolean
}): MemberExclusion[] {
  const { message } = input
  const out: MemberExclusion[] = []
  for (const row of input.recipients) {
    if (row.teamId !== message.teamId || row.groupId !== message.toId) continue
    // A member on the excluded profile passes `eligibleFor` (the candidate
    // builder drops it instead), so its breakdown entry is added here.
    if (input.eligibleIds.has(row.sessionId)) {
      if (message.excludedProfile && (row.profileId ?? 'default') === message.excludedProfile) {
        out.push({ sessionId: row.sessionId, kind: 'excluded-profile' })
      }
      const outsideRole = outsideRoleExclusion(row.sessionId, row.profileId, message.allowedProfiles)
      if (outsideRole !== null) out.push(outsideRole)
      continue
    }
    const causes = memberExclusions(row, message, { targetWorktree: input.targetWorktree, now: input.now, startupFailed: input.startupFailed(row.sessionId) })
    // Cooling is never a breakdown cause (it is the separate all-profiles-
    // cooling constraint); every other cause — excluded profile included —
    // names this member's reason for not taking the message. A start
    // failure carries its error text for the standalone constraint.
    const cause = causes.find(entry => entry.kind !== 'profile-cooling')
      ?? causes[0] ?? { sessionId: row.sessionId, kind: 'busy' as const, detail: 'became idle after this pass began' }
    out.push(cause.kind === 'startup-failed' && input.startFailure?.sessionId === cause.sessionId ? { ...cause, detail: input.startFailure.error } : cause)
  }
  return out
}

/**
 * Every reason `recipient` cannot take `message` right now (empty = it can).
 * The group path rejects every group-relevant cause; the claim predicate
 * rejects its own subset (busy unless interrupting, cooling only for direct
 * mail, parked only for unreserved group mail). Cooling is reported but never
 * a group-path rejection — cooling members stay candidates; only direct mail
 * excludes a cooling recipient. The causes are the eligibility check's
 * member-state layer (`memberStateCauses`).
 */
export function memberExclusions(
  recipient: MailRecipient,
  message: TeamMessage,
  options: { targetWorktree: string | null; now: number; startupFailed: boolean }
): MemberExclusion[] {
  return memberStateCauses(recipient, message, options)
}
