// SDK-free durable mailbox rows shared by server and client views.

/**
 * Who acted (team-message-threads D4): the human, or an agent session. The
 * actor vocabulary of task creators and message senders — deliberately not
 * the routing vocabulary of `TeamMessage['toKind']`, which answers where a
 * row goes. `TaskActor` is an alias of this.
 */
export type TeamActor =
  | { kind: 'human'; sessionId: null }
  | { kind: 'agent'; sessionId: string }

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
  /**
   * Routing vocabulary (D4): where the row goes. `human` is the human's
   * composer — there is no agent session to claim or push a reply to it.
   */
  toKind: 'group' | 'session' | 'human'
  /** Recipient id; null for `toKind: 'human'`. */
  toId: string | null
  /** Actor vocabulary (D4): who sent it. Alias of `TeamActor['kind']`. */
  fromKind: 'agent' | 'human'
  /** Sender session; null for a human sender. */
  fromSession: string | null
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
  /**
   * Task revision the delivery carried (D6), recorded at push time beside the
   * delivery-time task context. A later amendment does not rewrite it; null
   * for taskless messages and rows pushed before this column existed.
   */
  taskRevision: number | null
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
 * sender vocabulary of `from_kind`, nor the task journal's author: `agent` is
 * an agent's mailbox management (cancel, discard) and names its session in
 * `MessageEvent.actorSession`; an agent's plain send is still a system action.
 */
export type MessageEventActor = 'system' | 'human' | 'agent'

export interface MessageEvent {
  messageId: string
  teamId: string
  /** 1-based order within the message. */
  seq: number
  createdAt: string
  kind: MessageEventKind
  actor: MessageEventActor
  /** The acting agent's session; non-null only when `actor` is `agent`. */
  actorSession: string | null
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


/**
 * What a Messages list is on (team-message-threads D1): every filter is
 * optional and absent means "keep everything". Shared because the client
 * sends these on open and the server echoes them back on the snapshot, so a
 * reconnect can see which filters its page is the answer to.
 */
export interface MessageQueryFilters {
  /** Task the message works under. */
  taskId?: string
  /** Thread the message belongs to. */
  threadId?: string
  /**
   * Role involvement (the spec's "role"): the recipient group of group mail,
   * or the sender's group.
   */
  groupId?: string
  /** Session involvement: sender, current recipient, or claimant. */
  sessionId?: string
  priority?: MessagePriority
  /** One state or several; absent keeps every delivery state. */
  state?: MessageState | MessageState[]
  /**
   * Human involvement: `true` keeps only mail to or from the human, `false`
   * only agent-to-agent mail. Absent keeps both.
   */
  human?: boolean
  /**
   * Text search (team-workspace-pages D7): a case-insensitive substring of
   * the body, a sender or recipient group id, or a participant's name (a
   * session's recorded name, or `Human`). Blank text keeps everything.
   */
  text?: string
}

/**
 * One reason a waiting message cannot move (team-waiting-reasons D1). A
 * constraint is a typed fact from the dispatch, staffing, or routing state
 * that made the delivery decision — never an inference from session badges.
 */
export type WaitingConstraintKind =
  | 'recipient-busy'
  | 'recipient-pending-request'
  | 'recipient-unavailable'
  | 'profile-cooling'
  | 'startup-failed'
  | 'no-eligible-member'
  | 'group-cap'
  | 'profile-cap'
  | 'team-spawn-cap'
  | 'worktree-occupied'
  | 'spawn-backoff'
  | 'routing-hold'
  | 'all-profiles-cooling'
  | 'group-missing'
  | 'starting-agent'

export interface WaitingConstraint {
  kind: WaitingConstraintKind
  /** Capacity facts as `live of cap` (group, profile, team, worktree). */
  counts?: { live: number; cap: number }
  /** Sessions the constraint implicates: a worktree's occupant, the excluded members. */
  sessionIds?: string[]
  /** When the constraint clears on its own (cooldown end, retry time); ISO. */
  retryAt?: string
  /** Free-form facts: a worktree path, a profile id, an error text, a rule reason. */
  detail?: string
  /** Per-member breakdown for `no-eligible-member`: each implicated member's cause (S1). */
  members?: Array<{ sessionId: string; cause: string; detail?: string }>
  /** The spawn reservation behind `starting-agent` (D3): derived from `team_spawns`. */
  reservation?: { group: string; profile: string; worktree: string; startedAt: string }
}

/**
 * Why a message waits (D1): the immediate blocker plus every other constraint
 * that also applies, ordered deterministically — a missing group definition,
 * then capacity (group, per-profile, team spawn, worktree occupancy), then
 * member facts, then spawn and routing specifics. A `spawning` row always
 * carries `starting-agent` as its blocker, its own reservation's capacity
 * effects among `others`.
 */
export interface WaitingReason {
  blocker: WaitingConstraint
  others: WaitingConstraint[]
}

/**
 * A team's live (non-archived) sessions grouped by resolved worktree root
 * (team-waiting-reasons D4): the one occupancy read model the waiting
 * reasons, staffing decisions, and the mailbox snapshot share. Manual and
 * spawned sessions are listed; only spawned sessions and pending
 * reservations block spawning.
 */
export interface TeamWorktreeOccupancy {
  worktree: string
  sessions: Array<{
    sessionId: string
    group: string | null
    profile: string
    status: string
    spawned: boolean
    taskId: string | null
  }>
  pendingSpawns: Array<{ group: string; profile: string }>
}

/** Keyset position: the row after which the next (older) page starts. */
export interface MessageCursor {
  createdAt: string
  rowid: number
}

/** One page of a Messages list: the rows and how to ask for the next one. */
export interface MessagePage {
  messages: TeamMessage[]
  /** Key of the last row, for the next older page; null when exhausted. */
  nextCursor: MessageCursor | null
  /**
   * Whole-thread message counts for every thread on the page, regardless of
   * the filters (team-workspace-pages D7), so a collapsed thread row can
   * state its size without loading the thread.
   */
  threadSizes: Record<string, number>
}

/** One thread row with the history that happened to it. */
export interface ThreadEntry {
  message: TeamMessage
  events: MessageEvent[]
}

/**
 * Whether a row belongs in a list on these filters. The SQL in the server's
 * `messageQuery.ts` is the other half of this contract — it pages the list —
 * and the client applies this side to each unfiltered change push, so a row
 * that has just left its filter is dropped rather than lingering.
 */
/** ASCII-only case folding: the same comparison SQLite's `LIKE` makes. */
const foldAscii = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase())

/** The search text a filter carries, or null when it keeps everything. */
export function messageSearchText(filters: MessageQueryFilters): string | null {
  const text = filters.text?.trim()
  return text ? text : null
}

/**
 * Whether a message matches a text search: its body, a sender or recipient
 * group id, a participant's name from `labelOf`, or `Human` for the human
 * side. The server's SQL makes the same match over the recorded names.
 */
export function matchesMessageText(
  text: string,
  message: TeamMessage,
  labelOf: (sessionId: string) => string | undefined = () => undefined,
): boolean {
  const needle = foldAscii(text)
  const has = (value: string | null | undefined) => value != null && foldAscii(value).includes(needle)
  if (has(message.body) || has(message.fromGroup)) return true
  if (message.toKind === 'group' && has(message.toId)) return true
  if ((message.fromKind === 'human' || message.toKind === 'human') && has('Human')) return true
  const participants = [message.fromSession, message.toKind === 'session' ? message.toId : null, message.claimedBy]
  return participants.some(sessionId => sessionId != null && has(labelOf(sessionId)))
}

export function matchesMessageFilters(
  filters: MessageQueryFilters,
  message: TeamMessage,
  labelOf?: (sessionId: string) => string | undefined,
): boolean {
  if (filters.taskId !== undefined && message.taskId !== filters.taskId) return false
  if (filters.threadId !== undefined && message.threadId !== filters.threadId) return false
  if (filters.groupId !== undefined
    && !((message.toKind === 'group' && message.toId === filters.groupId) || message.fromGroup === filters.groupId)) return false
  if (filters.sessionId !== undefined
    && message.fromSession !== filters.sessionId
    && !(message.toKind === 'session' && message.toId === filters.sessionId)
    && message.claimedBy !== filters.sessionId) return false
  if (filters.priority !== undefined && message.priority !== filters.priority) return false
  if (filters.state !== undefined) {
    const states = Array.isArray(filters.state) ? filters.state : [filters.state]
    if (!states.includes(message.state)) return false
  }
  if (filters.human === true && message.fromKind !== 'human' && message.toKind !== 'human') return false
  if (filters.human === false && (message.fromKind !== 'agent' || message.toKind === 'human')) return false
  const text = messageSearchText(filters)
  if (text !== null && !matchesMessageText(text, message, labelOf)) return false
  return true
}

/**
 * Refusal of a human team view whose `teamPath` names no known team
 * (team-workspace-pages D1): not a discovered repository, one of its
 * worktrees, or an existing chat's directory.
 */
export const UNKNOWN_TEAM = 'unknown-team'

export function unknownTeamError(teamPath: string): string {
  return `${UNKNOWN_TEAM}: ${teamPath}`
}
