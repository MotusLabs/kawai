// Task status rights (team-tasks D2; plan-execution D2): who may set which
// status. The one rule every closing path — status changes and result
// acceptance — checks first.
import type { ActingParty } from '../../shared/team'
import type { TaskStatus, TeamTask } from '../../shared/teamTasks'
import { originLabel, type SystemOrigin } from './systemCaller'

/**
 * The status rights (team-tasks D2): an agent sets `done`/`cancelled` only on
 * a task it created and never reopens; the human sets anything. The one rule
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
      if (closing && task.creator.sessionId !== actor.sessionId) {
        return `Only the task's creator can set it to ${status}. Report your result in a journal note or a message to the creator instead.`
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
