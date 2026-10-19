// Label formatting for team waiting reasons (team-waiting-reasons D1/D6):
// one readable line per constraint kind, and the dead-letter code map. Known
// codes read as sentences with the raw code still visible; unknown codes pass
// through verbatim, so a future code degrades gracefully instead of lying.
import type { WaitingConstraint } from '@shared/team'

/** Last path segment of a worktree, for short display beside the full path. */
const basename = (worktree: string): string => worktree.split('/').filter(Boolean).at(-1) ?? worktree

/** Dead-letter reason codes (`TeamMessage.reason`) to readable labels. */
const DEAD_LETTER_LABELS: Record<string, string> = {
  'killed-recipient': 'The recipient session no longer exists',
  'killed-sender-without-group': 'The sender session no longer exists and has no group',
  'hop-limit': 'The reply chain reached its hop limit',
  'context-exhausted': "The recipient's context was exhausted; the message was not processed",
}

/** A readable label for a dead-letter reason; the code stays visible beside it. */
export function deadLetterLabel(reason: string): string {
  // `worktree-missing: <path>` carries its path after the code.
  const prefix = reason.split(':')[0] ?? reason
  if (prefix === 'worktree-missing') return 'The target worktree is missing'
  return DEAD_LETTER_LABELS[reason] ?? reason
}

/** How long a wait has lasted (age of a start, minutes granularity). */
export const elapsedLabel = (from: string, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(from)) / 60_000))
  return `${minutes}m`
}

/** One readable line for a constraint; the kind stays recognizable in the text. */
export function constraintLabel(constraint: WaitingConstraint, nameOf: (sessionId: string) => string = id => id): string {
  const names = (constraint.sessionIds ?? []).map(nameOf)
  switch (constraint.kind) {
    case 'group-cap':
      return `Group is at capacity (${constraint.counts?.live ?? '?'}/${constraint.counts?.cap ?? '?'})`
    case 'profile-cap':
      return `Profile ${constraint.detail ?? ''} is at capacity (${constraint.counts?.live ?? '?'}/${constraint.counts?.cap ?? '?'})`
    case 'team-spawn-cap':
      return `Team spawn cap reached (${constraint.counts?.live ?? '?'}/${constraint.counts?.cap ?? '?'})`
    case 'worktree-occupied':
      return names.length > 0
        ? `Worktree ${constraint.detail ?? ''} is held by ${names.join(', ')}`
        : `Worktree ${constraint.detail ?? ''} is held by a pending spawn`
    case 'recipient-busy':
      return 'Recipient is working; normal mail arrives when it is idle'
    case 'recipient-pending-request':
      return 'Recipient is awaiting an approval or answer'
    case 'recipient-unavailable':
      return constraint.detail ? `Recipient cannot start: ${constraint.detail}` : 'Recipient is unavailable'
    case 'outside-role':
      return constraint.detail ?? 'Outside the plan role\'s profiles'
    case 'profile-cooling': {
      // The provider's label reads instead of its raw id when the snapshot carries one (O1).
      const provider = constraint.providerLabel ?? constraint.detail
      return `Recipient's provider${provider ? ` ${provider}` : ''} is cooling${constraint.retryAt ? ` until ${new Date(constraint.retryAt).toLocaleTimeString()}` : ''}`
    }
    case 'startup-failed':
      return `Agent startup failed${constraint.detail ? `: ${constraint.detail}` : ''}`
    case 'no-eligible-member':
      return `No eligible member${constraint.members
        ? ` — ${constraint.members.map(member => `${nameOf(member.sessionId)} ${member.cause}${member.detail ? ` (${member.detail})` : ''}`).join('; ')}`
        : constraint.detail ? ` — ${constraint.detail}` : ''}`
    case 'spawn-backoff':
      return `A failed spawn retries${constraint.retryAt ? ` at ${new Date(constraint.retryAt).toLocaleTimeString()}` : ''}`
    case 'routing-hold':
      return `Routing hold${constraint.detail ? `: ${constraint.detail}` : ''}`
    case 'all-profiles-cooling':
      return `Every candidate profile is cooling${constraint.retryAt ? ` until ${new Date(constraint.retryAt).toLocaleTimeString()}` : ''}`
    case 'group-missing':
      return 'The group definition is missing'
    case 'starting-agent':
      return constraint.reservation
        ? `Starting agent (${constraint.reservation.group}, ${constraint.reservation.profile}, ${basename(constraint.reservation.worktree)})`
        : 'Starting agent'
  }
}
