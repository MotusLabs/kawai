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
  /** Kept on its agent after a provider limit; a resume is scheduled (profile routing). */
  | 'parked'
  /** Handed off after a provider limit; a new message carries the work on. */
  | 'forwarded'

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
  /** Repository HEAD in the claimant's directory at claim time (profile routing). */
  claimCommit: string | null
  /** While parked: when the scheduled resume is due. */
  parkedUntil: string | null
  /** Times this message was parked after a limit. */
  parkCount: number
  /** While parked: the scheduled resume message. */
  resumeMessageId: string | null
  /** Forwarded work: what the previous agent did (rendered in the envelope). */
  handoff: ChatHandoffPackage | null
  /** Forwarded work never goes back to the profile that hit the limit. */
  excludedProfile: string | null
}

/** Progress of the agent that hit a limit, handed to whoever takes over. */
export interface ChatHandoffPackage {
  fromSession: string
  fromProfile: string
  /** HEAD when the previous agent claimed the work; null outside git. */
  claimCommit: string | null
  lastError: string | null
  progress: {
    toolCalls: number
    /** Tool names in call order (latest 30). */
    tools: string[]
    filesTouched: string[]
  }
}

