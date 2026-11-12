// Task status rights (team-tasks D2; plan-execution D2): who may set which
// status. The one rule every closing path — status changes and result
// acceptance — checks first. An agent's rights follow the task's owner
// (group-mail-task-affinity D7), which starts as the creating agent and moves
// only by `task_transfer_owner`; `taskOwner` is the one reading of it.
import type { ActingParty } from '../../shared/team'
import type { TaskStatus, TeamTask } from '../../shared/teamTasks'
import { originLabel, type SystemOrigin } from './systemCaller'

/**
 * The agent session holding a task's agent rights (D7): its recorded owner;
 * a record read without the field (a fixture, or a row from before the
 * owner existed) falls back to the creating agent.
 */
export function taskOwner(task: TeamTask): string | null {
  if (task.ownerSession !== undefined) return task.ownerSession
  return task.creator.kind === 'agent' ? task.creator.sessionId : null
}

/** How a refusal names whom to report to instead: the owner session, else the human. */
export function ownerLabel(task: TeamTask): string {
  const owner = taskOwner(task)
  return owner ? `the owner (${owner})` : 'the human'
}

/**
 * The status rights (team-tasks D2): an agent sets `done`/`cancelled` only on
 * a task it owns and never reopens; the human sets anything. The one rule
 * every closing path — status changes and result acceptance — checks first.
 */
export function statusRefusal(actor: ActingParty, task: TeamTask, status: TaskStatus): string | null {
  const closing = status === 'done' || status === 'cancelled'
  switch (actor.kind) {
    case 'human':
      return null
    case 'system':
      // Kawai closes only its own tasks, as their creator (plan-execution D2).
      if (status === 'open') return 'Only the human can reopen a task'
      return closing && task.creator.kind !== 'system' ? `Kawai sets ${status} only on the tasks it created.` : null
    case 'agent':
      if (status === 'open') return 'Only the human can reopen a task'
      if (closing && taskOwner(task) !== actor.sessionId) {
        return `Only the task's owner can set it to ${status}. Report your result in a journal note or a message to ${ownerLabel(task)} instead.`
      }
      return null
    default: {
      const never: never = actor
      return String(never)
    }
  }
}

/**
 * A decision origin (plan-supervision D7) closes only the fix and correction
 * tasks it creates, which link to no plan change; an execution origin keeps
 * plan-execution D2's reach over every task Kawai created.
 */
export function originStatusRefusal(origin: SystemOrigin, task: TeamTask): string | null {
  if (origin.kind === 'execution') return null
  return task.planId ? `Kawai acting for ${originLabel(origin)} closes only fix and correction tasks, never a plan change's task.` : null
}
