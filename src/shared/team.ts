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

/**
 * Last known identity of a team chat session (`team_session_directory`,
 * team-message-threads D3). Written on create and rename; kept after kill so
 * history can still name the participant.
 */
export interface SessionDirectoryEntry {
  sessionId: string
  /** Last known session name. */
  name: string
  /** Last known team group id; null = none. */
  group: string | null
}

/**
 * A participant resolved for display: a live session's current name, or the
 * directory's last known name marked gone once the session was killed.
 */
export interface ParticipantLabel {
  /** Null for the human, who has no session. */
  id: string | null
  name: string
  /** Role (team group id) recorded for the participant; null = none. */
  group: string | null
  /** Killed or never seen: render `Name (gone)` and never navigate. */
  gone: boolean
}

/**
 * One recorded message state change (team-message-threads D2). Written inside
 * the store's transitions, so no change can escape logging; durable rows that
 * survive restart with the messages they describe.
 */
export type MessageEventKind =
  | 'sent'
  | 'reserved'
  | 'claimed'
  | 'held-for-request'
  | 'pushed'
  | 'delivered'
  | 'requeued'
  | 'held-uncertain'
  | 'retried'
  | 'cancelled'
  | 'discarded'
  | 'dead-lettered'
  | 'parked'
  | 'unparked'
  | 'released'
  | 'forwarded'

/**
 * Who caused the change: the human through a UI action, or the system on
 * behalf of delivery, recovery, or a limit outcome. Deliberately not the
 * sender vocabulary of `from_kind` — an agent's send is a system action here,
 * and the message row already names its sender.
 */
export type MessageEventActor = 'system' | 'human'

export interface MessageEvent {
  messageId: string
  teamId: string
  /** 1-based order within the message. */
  seq: number
  createdAt: string
  kind: MessageEventKind
  actor: MessageEventActor
  /** State the transition moved off of. */
  prevState: MessageState | null
  /** Claimant the row update cleared (retry, requeue, release). */
  prevClaimedBy: string | null
  /** `to_id` before the change (release may retarget). */
  prevRecipient: string | null
  /** Reason the row carried before the change — what a clear overwrote. */
  prevReason: string | null
  /** Reason the transition wrote (hold, dead letter, forward); else null. */
  reason: string | null
}

