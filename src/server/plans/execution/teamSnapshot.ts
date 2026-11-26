// The executor's per-pass snapshot reads (plan-execution D8), extracted from
// `executor.ts` so the executor and the tests that ask "what would the next
// tick run" build it from the same stores the same way: each task's results
// newest first, its revision and status, its newest standing assignment with
// the mailbox state that decides it, every assignment's request key (the
// owed-attempt test), and the plan's active holds and open pause targets.
import type { ActiveHold } from '../../../shared/planRevisionControl'
import type { OpenPauseTarget } from '../revisionControl/holdGate'
import type { TaskService } from '../../team/TaskService'
import type { MailboxStore } from '../../team/mailboxStore'
import { assignmentState } from '../../team/assignmentStore'
import type { PlanStore } from '../planStore'
import type { ExecutionStore } from './executionStore'
import { executionSnapshot, type ExecutionSnapshot } from './executionSnapshot'

export interface TeamSnapshotDeps {
  store: ExecutionStore
  plans: PlanStore
  tasks: Pick<TaskService, 'store'>
  mailbox: Pick<MailboxStore, 'get'>
  holds?: { active(teamId: string, planId: string): ActiveHold[]; openTargets(teamId: string, planId: string): OpenPauseTarget[] }
}

export function teamSnapshot(deps: TeamSnapshotDeps, teamId: string, groupsRoot: string): ExecutionSnapshot {
  const tasks = deps.tasks.store
  return executionSnapshot(teamId, groupsRoot, deps.store, deps.plans,
    taskId => tasks.results.listByTask(taskId)
      .map(result => ({ id: result.id, commit: result.commit, taskRevision: result.taskRevision, submittedBySession: result.submittedBy.kind === 'agent' ? result.submittedBy.sessionId : null }))
      .reverse(),
    taskId => tasks.get(taskId)?.revision ?? 1,
    taskId => tasks.get(taskId)?.status ?? 'active',
    taskId => {
      // The newest standing assignment is the stage's (a retried stage's
      // failed predecessor stays unsuperseded, older).
      const outstanding = tasks.assignmentsOf(taskId).filter(row => row.supersededBy === null).at(-1)
      if (outstanding === undefined) return null
      const state = assignmentState(outstanding, outstanding.messageId !== null ? deps.mailbox.get(outstanding.messageId) : null)
      return { id: outstanding.id, state: state.state, reason: state.reason, requestKey: outstanding.requestKey ?? null }
    },
    taskId => tasks.assignmentsOf(taskId).map(row => ({ requestKey: row.requestKey })),
    planId => deps.holds?.active(teamId, planId) ?? [],
    planId => deps.holds?.openTargets(teamId, planId) ?? [])
}
