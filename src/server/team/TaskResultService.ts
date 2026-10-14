// Results, findings, and acceptance (task-results-handoffs design D2/D4/D5).
// Identity comes from the calling session (agents) or the authenticated UI
// connection (the human), resolved through TaskService exactly as every task
// tool resolves it. Submission and findings are open to any member of the
// task's team — the cooperative trust model — and change no task status; the
// right that matters, closing the task, is TaskService.setStatus's own rule,
// evaluated before acceptance writes anything. Test outcomes and verdicts are
// claims: nothing here stores or implies verification.
import type { ChatSessionRecord } from '../db'
import type { TaskFindings, TaskResult, TaskTestClaim, TeamTask, TeamTaskSummary } from '../../shared/teamTasks'
import { statusRefusal, type TaskCaller, type TaskService } from './TaskService'
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

/** What an acceptance closed, with what the human was shown before it (D5). */
export interface AcceptOutcome {
  task: TeamTask
  result: TaskResult
  /** The task's acceptance criteria — free text the system shows, never resolves. */
  acceptanceCriteria: string | null
  /** Child tasks not done or cancelled at acceptance. */
  openChildren: TeamTaskSummary[]
}

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

  /**
   * Submit review or QA findings (D4), bound to the exact result examined —
   * a result of this task — and never to a later one. Open to any agent of
   * the team; the record names its author, so independence from the
   * submitter is visible. Answering the caller's outstanding handoff for that
   * result records its id (the attempt's identity).
   */
  async submitFindings(caller: TaskCaller, taskId: string, input: FindingsSubmission): Promise<TaskFindings> {
    const { team, actor } = await this.tasks.context(caller)
    if (actor.kind !== 'agent') throw new Error('Findings are submitted by the reviewing agent, with task_submit_findings')
    this.tasks.sameTeamTask(team, taskId)
    const result = this.store.results.get(input.resultId)
    if (!result || result.taskId !== taskId) throw new Error(`Result ${input.resultId} is not a result of task ${taskId}`)
    const findings = input.findings.trim()
    if (!findings) throw new Error('Findings need text')
    const handoff = this.store.outstandingAssignment(taskId)
    const answers = handoff?.handoffKind && handoff.resultId === result.id && handoff.claimedBy === actor.sessionId
    const stored = this.store.results.insertFindings({
      teamId: team.teamId, taskId, resultId: result.id, handoffId: answers ? handoff.id : null,
      kind: input.kind, verdict: input.verdict, findings, author: actor,
    })
    this.store.appendJournal(taskId, actor, `${input.kind === 'qa' ? 'QA' : 'Review'} findings on result ${result.id}: ${input.verdict}`)
    return stored
  }

  /**
   * Accept a result (D5): the human, or the task's creator agent — the exact
   * closing rule TaskService.setStatus enforces, checked first, so a refusal
   * writes nothing. A result labeled Needs re-evaluation, or child tasks
   * still open, require a stated reason. Then the result's acceptance, the
   * acceptor's journal entry, and the `done` status commit in one
   * transaction (setStatus's own, with its transition hook). Acceptance is
   * per task: no parent is touched.
   */
  async accept(caller: TaskCaller, taskId: string, resultId: string, reason?: string): Promise<AcceptOutcome> {
    const { team, actor } = await this.tasks.context(caller)
    const task = this.tasks.sameTeamTask(team, taskId)
    const refusal = statusRefusal(actor, task, 'done')
    if (refusal) throw new Error(refusal.replace(`set it to done`, 'accept its results and close it'))
    const result = this.store.results.get(resultId)
    if (!result || result.taskId !== taskId) throw new Error(`Result ${resultId} is not a result of task ${taskId}`)
    const openChildren = this.store.list(team.teamId).filter(child =>
      child.parentId === taskId && child.status !== 'done' && child.status !== 'cancelled')
    const flags = [
      ...(result.needsReevaluation ? [`needs re-evaluation (pinned at revision ${result.taskRevision}, task at ${task.revision})`] : []),
      ...(openChildren.length > 0 ? [`${openChildren.length} open child task${openChildren.length === 1 ? '' : 's'}`] : []),
    ]
    const stated = reason?.trim()
    if (flags.length > 0 && !stated) throw new Error(`Accepting despite ${flags.join(' and ')} needs a stated reason; nothing was accepted.`)
    const entry = flags.length > 0 ? `Accepted result ${resultId} despite ${flags.join(' and ')}: ${stated}` : `Accepted result ${resultId}`
    const closed = await this.tasks.setStatus(caller, taskId, 'done', undefined, () => {
      this.store.results.markAccepted(resultId, actor)
      this.store.appendJournal(taskId, actor, entry)
    })
    return { task: closed, result: this.store.results.get(resultId)!, acceptanceCriteria: task.acceptance, openChildren }
  }
}
