// SDK-free team task records (team-tasks design D1) shared by server and
// client views. A task's direction and acceptance criteria live in numbered,
// immutable revisions; `TeamTask` carries the latest one inline.
import type { TeamActor, TeamMessage } from './team'

export type TaskStatus = 'open' | 'active' | 'blocked' | 'done' | 'cancelled'
export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'active', 'blocked', 'done', 'cancelled']

/**
 * Who did something to a task: the human (through the UI) or an agent session.
 * An alias of the shared actor vocabulary (`TeamActor`), which message senders
 * use too — not of `TeamMessage['toKind']`'s routing vocabulary.
 */
export type TaskActor = TeamActor

export interface TeamTask {
  id: string
  teamId: string
  title: string
  status: TaskStatus
  creator: TaskActor
  parentId: string | null
  /** Target worktree root (normalized to `git worktree list`); null = none. */
  worktree: string | null
  /** Linked OpenSpec change name; null = none. */
  openspecChange: string | null
  /** Latest revision number; starts at 1. */
  revision: number
  direction: string
  acceptance: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskRevision {
  revision: number
  direction: string
  acceptance: string | null
  author: TaskActor
  createdAt: string
}

export interface TaskJournalEntry {
  id: string
  author: TaskActor
  text: string
  createdAt: string
}

/** A task as listed: the record plus everyone who has worked under it. */
export interface TeamTaskSummary extends TeamTask {
  /** Agent session ids: creator, associated sessions, mail senders/receivers, journal authors. */
  participants: string[]
  /**
   * The outstanding assignment (task-assignment D1): the newest dispatch that
   * is neither superseded nor failed; null when the task is unassigned.
   */
  assignment: TeamTaskAssignment | null
}

/**
 * One durable dispatch record (task-assignment D1): who is responsible, kept
 * separate from the derived participant list. The state is derived at read
 * time from the instruction mail (D5) — never a stored copy of it.
 */
export interface TeamTaskAssignment {
  id: string
  taskId: string
  /** The dispatch identity (D4): one user intent, unique within the team. */
  requestKey: string
  /** `group` (the group is the requested role) or `session` (a named member). */
  targetKind: 'group' | 'session'
  /** Group id, or session id. */
  targetId: string
  /** The requested role: the group id when one is known; null for a groupless session. */
  role: string | null
  /** The initial instruction, kept verbatim. */
  instruction: string
  createdBy: TaskActor
  /** The enqueued instruction mail; null until dispatch committed it. */
  messageId: string | null
  /** Copied from the mail's claim; null while nobody has taken it. */
  claimedBy: string | null
  claimedAt: string | null
  /** The assignment that replaced this one; null while it stands. */
  supersededBy: string | null
  /** Derived state (D5): queued, claimed, delivered, failed, parked, forwarded, uncertain, superseded. */
  state: 'queued' | 'claimed' | 'delivered' | 'failed' | 'parked' | 'forwarded' | 'uncertain' | 'superseded'
  /** Why a failed assignment failed (dead-letter reason); null otherwise. */
  reason: string | null
  createdAt: string
  updatedAt: string
}

export interface TeamTaskDetail {
  task: TeamTaskSummary
  /** Oldest first; the last one is the current direction. */
  revisions: TaskRevision[]
  /** Append-only, oldest first. */
  journal: TaskJournalEntry[]
  subtasks: TeamTaskSummary[]
  /** Assignment history, oldest first (superseded rows stay visible). */
  assignments: TeamTaskAssignment[]
  /** Mail referencing the task, oldest first. */
  messages: TeamMessage[]
}

/** The task section of a delivered peer message (design D3), built at delivery. */
export interface ChatPeerTaskContext {
  id: string
  title: string
  status: TaskStatus
  revision: number
  direction: string
  acceptance: string | null
  openspecChange: string | null
  worktree: string | null
  /** The most recent journal entries (at most five, each truncated), oldest first. */
  journal: Array<{ author: string; text: string; createdAt: string }>
}

/** An assignment's addressee: a group (its role) or one named session. */
export type AssignmentTarget = { kind: 'group' | 'session'; id: string }

/**
 * Read-only dispatch preview (task-assignment D6), computed from the same
 * sources the dispatcher uses. Informational: dispatch revalidates every
 * constraint, so a stale preview can mislead but cannot misroute.
 */
export interface TaskDispatchPreview {
  /** The target worktree the dispatched instruction would route by; null = none. */
  worktree: string | null
  target: AssignmentTarget
  /** The requested role: the group's label; null for a session target. */
  role: string | null
  /** Effective profile: a session target's profile, or the profile a spawn would use. */
  profile: string | null
  /** Approval policy of the spawned member (group target) or the session. */
  approval: 'manual' | 'auto'
  /** A session target's resolved worktree; null for a group target. */
  sessionWorktree: string | null
  /** Idle members matching the target worktree (group targets); empty otherwise. */
  idleMembers: string[]
  /** Whether staffing could add a member, and what a spawn would use. */
  spawn: { allowed: boolean; profile: string | null; blockedBy: string | null }
  /** Advisory warning (e.g. a session target outside the task's worktree). */
  warning: string | null
}

/** The pickers' data (task-assignment D8): team-scoped worktrees and changes. */
export interface TaskTargetOptions {
  worktrees: Array<{ root: string; branch?: string }>
  changes: Array<{ name: string; locations: string[] }>
}
