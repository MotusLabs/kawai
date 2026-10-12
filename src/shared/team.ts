// SDK-free durable mailbox rows shared by server and client views.
export type MessageState =
  | 'queued'
  | 'claimed'
  /** Reserved for a member being spawned in its task's worktree (team-tasks D4). */
  | 'spawning'
  | 'awaiting-request'
  | 'delivered'
  | 'dead'
  | 'uncertain'
  | 'cancelled'
  | 'discarded'

export type MessagePriority = 'normal' | 'urgent'

export interface TeamMessage {
  id: string
  teamId: string
  toKind: 'group' | 'session'
  toId: string
  fromSession: string
  fromGroup: string | null
  originPath: string
  priority: MessagePriority
  tags: string[]
  threadId: string
  inReplyTo: string | null
  /** Position along the reply chain; a new thread starts at 1. */
  hop: number
  body: string
  state: MessageState
  claimedBy: string | null
  claimedAt: string | null
  /** Scheduled delivery time; null = deliverable now. */
  deliverAt: string | null
  createdAt: string
  pushedAt: string | null
  deliveredAt: string | null
  /** Why a message is dead or held (hop limit, killed recipient, …). */
  reason: string | null
  /** Human retry of an uncertain receipt: envelope carries a duplicate notice. */
  possibleDuplicate: boolean
  /** Killed-sender reply fallback: deliver with the whole thread attached. */
  attachThread: boolean
  /** The team task this message works under (team-tasks); null = none. */
  taskId: string | null
}

