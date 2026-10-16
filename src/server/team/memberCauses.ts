// Member-state cause reporter (team-waiting-reasons D2): why one live member
// cannot take a message, over the shared recipient fields. A reporter beneath
// the unchanged eligibility and claim predicates — they reject different
// subsets of these causes, so this module reports and never decides.
import type { TeamMessage } from './mailboxStore'
import type { MailRecipient } from './dispatcher'

export type MemberExclusionKind =
  | 'busy'
  | 'pending-card'
  | 'parked'
  | 'other-worktree'
  | 'unavailable'
  | 'startup-failed'
  | 'excluded-profile'
  | 'outside-role'
  | 'profile-cooling'

export interface MemberExclusion {
  sessionId: string
  kind: MemberExclusionKind
  /** A fact for the reason: where the member is, or the start error. */
  detail?: string
}

/**
 * Every reason `recipient` cannot take `message` right now (empty = it can).
 * The group path rejects every group-relevant cause; the claim predicate
 * rejects its own subset (busy unless interrupting, cooling only for direct
 * mail, parked only for unreserved group mail). Cooling is reported but never
 * a group-path rejection — cooling members stay candidates; only direct mail
 * excludes a cooling recipient. An unavailable session's busy/card state is
 * noise beneath the reason it cannot start at all.
 */
export function memberExclusions(
  recipient: MailRecipient,
  message: TeamMessage,
  options: { targetWorktree: string | null; now: number; startupFailed: boolean }
): MemberExclusion[] {
  const causes: MemberExclusion[] = []
  const add = (kind: MemberExclusionKind, detail?: string) =>
    causes.push({ sessionId: recipient.sessionId, kind, ...(detail !== undefined ? { detail } : {}) })
  if (!recipient.available) {
    add('unavailable')
  } else {
    if (recipient.pendingRequest) add('pending-card')
    if (!recipient.idle) add('busy')
  }
  if (recipient.parked) add('parked')
  if (options.startupFailed) add('startup-failed')
  if (message.toKind === 'group' && options.targetWorktree !== null && recipient.worktree !== options.targetWorktree) {
    add('other-worktree', recipient.worktree)
  }
  if (message.excludedProfile && (recipient.profileId ?? 'default') === message.excludedProfile) add('excluded-profile')
  if (message.allowedProfiles && !message.allowedProfiles.includes(recipient.profileId ?? 'default')) {
    add('outside-role', `plan role allows only ${message.allowedProfiles.join(', ')}`)
  }
  if (Date.parse(recipient.cooldownUntil ?? '') > options.now) add('profile-cooling')
  return causes
}
