// The two phases of a task status change (plan-execution D12):
// `TaskService.prepareStatus` resolves the caller, checks the refusal, and
// prepares the transition hook; the commit it returns is synchronous so a
// caller can run it inside its own transaction.
import type { TaskStatus, TeamTask } from '../../shared/teamTasks'

/** A prepared status change whose task moved before its commit; nothing was written. */
export class StaleTaskStatus extends Error {
  constructor(readonly taskId: string, readonly status: TaskStatus) {
    super(`Task ${taskId} changed status to ${status} while this update was prepared; nothing changed.`)
    this.name = 'StaleTaskStatus'
  }
}

/** `prepareStatus`'s result: the synchronous commit, runnable inside a caller's transaction. */
export interface PreparedTaskStatus {
  commit(alsoWithin?: () => void): TeamTask
}
