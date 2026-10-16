// What a sender gives `MailboxStore.enqueue`: one new `team_messages` row.
// Kept apart from the store so its 500-line budget goes to behavior.
import type { ActingParty, ChatHandoffPackage, MessagePriority, TeamMessage } from '../../shared/team'
import type { RevisionNotice } from '../../shared/teamTasks'

export interface EnqueueInput {
  teamId: string
  /** Routing vocabulary (D4): `human` settles on send and never reaches the dispatcher. */
  toKind: 'group' | 'session' | 'human'
  /** Recipient id; null for `toKind: 'human'`. */
  toId: string | null
  /** Actor vocabulary (D4). Absent on agent sends; never merged with `toKind`; `system` is Kawai (plan-execution D2). */
  fromKind?: ActingParty['kind']
  /** Sender session; null for a human or Kawai sender. */
  fromSession: string | null
  fromGroup: string | null
  originPath: string
  priority?: MessagePriority
  tags?: string[]
  body: string
  /** The message being replied to; absent starts a new thread. */
  inReplyTo?: TeamMessage
  deliverAt?: string | null
  attachThread?: boolean
  /** Sender group's hopLimit, else the default. */
  hopLimit?: number
  /** Team task the message works under (validated by the caller). */
  taskId?: string | null
  /** Forwarded work after a limit (profile routing). */
  handoff?: ChatHandoffPackage | null
  excludedProfile?: string | null
  /**
   * The role's profiles this mail may route to, in the role's order
   * (plan-execution D15). System mail only; a forward keeps the list
   * without the limited profile.
   */
  allowedProfiles?: string[] | null
  /** Who caused the send (event log): the human through a composer, else the system. */
  actor?: 'system' | 'human'
  /** The revision a notice announces (task-revision-publication D3); absent for every other row. */
  revisionNotice?: RevisionNotice | null
}
