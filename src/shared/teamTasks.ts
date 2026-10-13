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
}

export interface TeamTaskDetail {
  task: TeamTaskSummary
  /** Oldest first; the last one is the current direction. */
  revisions: TaskRevision[]
  /** Append-only, oldest first. */
  journal: TaskJournalEntry[]
  subtasks: TeamTaskSummary[]
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
