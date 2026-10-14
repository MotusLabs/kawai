// Shared shapes for the client WebSocket message router: dependencies the
// handlers close over (stable refs and callbacks only — everything else is
// read from stores via getState()) plus the pending-operation state that
// survives across messages.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { AgentSession, Session } from '@shared/types'

/** Snapshot + selection state kept for kill-failed rollback. */
export interface PendingKillEntry {
  session: Session
  wasSelected: boolean
  epoch: number
}

/** A create-worktree request awaiting its result to open the session form. */
export interface WorktreeLaunchPending {
  repositoryId: string
  branch: string
}

/** A create-change-worktree request awaiting its result the same way. */
export interface ChangeLaunchPending {
  repositoryId: string
  change: string
}

/** Prefill for the New Session dialog, opened by worktree launches. */
export interface SessionFormPrefill {
  host?: string
  path?: string
  command?: string
  autoStartChange?: string
}

export interface MessageRouterDeps {
  /** Current connection epoch straight from the WS manager (never a render value). */
  getConnectionEpoch(): number
  /** Show the transient error banner (auto-clears after its timeout). */
  setTransientError(message: string): void
  /** Hide the transient error banner immediately (terminal-ready). */
  clearTransientError(): void
  /** Open the New Session dialog with the given prefill. */
  openSessionFormPrefilled(prefill: SessionFormPrefill): void
  /** App-level pending-hibernating-session state (used by wake/hibernate results). */
  setPendingHibernatingSession: Dispatch<SetStateAction<AgentSession | null>>
  pendingKills: MutableRefObject<Map<string, PendingKillEntry>>
  pendingHibernateSelection: MutableRefObject<string | null>
  pendingWakeSelection: MutableRefObject<string | null>
  pendingWorktreeLaunch: MutableRefObject<WorktreeLaunchPending | null>
  pendingChangeLaunch: MutableRefObject<ChangeLaunchPending | null>
}
