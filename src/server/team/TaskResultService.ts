// Results, findings, and acceptance (task-results-handoffs design D2/D4/D5).
// Identity comes from the calling session (agents) or the authenticated UI
// connection (the human), resolved through TaskService exactly as every task
// tool resolves it. Submission and findings are open to any member of the
// task's team — the cooperative trust model — and change no task status; the
// right that matters, closing the task, is TaskService.setStatus's own rule,
// evaluated before acceptance writes anything. Test outcomes and verdicts are
// claims: nothing here stores or implies verification.
import type { ChatSessionRecord } from '../db'
import type { TaskFindings, TaskResult, TaskTestClaim } from '../../shared/teamTasks'
import type { TaskCaller, TaskService } from './TaskService'
import { worktreeRootOf } from './worktreeRoots'

export interface ResultSubmission {
  summary: string
  commit?: string | null
  diff?: string | null
  tests?: TaskTestClaim[]
  limitations?: string | null
}

export interface FindingsSubmission {
  resultId: string
  kind: TaskFindings['kind']
  verdict: TaskFindings['verdict']
  findings: string
}

const blankToNull = (value: string | null | undefined) => (value?.trim() ? value.trim() : null)

export class TaskResultService {
  constructor(readonly tasks: TaskService, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
  }) {}

  private get store() { return this.tasks.store }

  /**
   * Submit a result (D2): any agent of the task's team. The server pins the
   * task's current revision and worktree (the task's, else the submitter's
   * resolved worktree), journals one submitter-authored note — the result
   * news every task-mail recipient's journal excerpt carries — and leaves
   * the task's status alone: a submitted result is not a finished task.
   */
  async submit(caller: TaskCaller, taskId: string, input: ResultSubmission): Promise<TaskResult> {
    const { team, actor } = await this.tasks.context(caller)
    if (actor.kind !== 'agent') throw new Error('Results are submitted by the agent that did the work, with task_submit_result')
    const task = this.tasks.sameTeamTask(team, taskId)
    const summary = input.summary.trim()
    if (!summary) throw new Error('A result needs a summary')
    const commit = blankToNull(input.commit)
    const diff = blankToNull(input.diff)
    if (!commit && !diff) throw new Error('A result needs a commit or a diff reference')
    const tests = (input.tests ?? []).map(row => ({ description: row.description.trim(), outcome: row.outcome.trim() }))
    if (tests.some(row => !row.description || !row.outcome)) throw new Error('Each test needs a description and an outcome')
    const session = this.options.getSession(actor.sessionId)
    const result = this.store.results.insert({
      teamId: team.teamId, taskId, summary, commit, diff,
      worktree: task.worktree ?? (session ? worktreeRootOf(session.projectPath) : null),
      tests, limitations: blankToNull(input.limitations), taskRevision: task.revision, submittedBy: actor,
    })
    this.store.appendJournal(taskId, actor, `Submitted result ${result.id}: ${summary}`)
    return this.store.results.get(result.id)!
  }
}
