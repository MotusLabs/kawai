// Task results and findings (task-results-handoffs design D1/D4/D6). A
// result is one submission: summary, commit or diff reference, worktree,
// claimed tests, limitations, the task revision pinned at submission, and the
// submitter. The task's outstanding result is the newest one nothing
// supersedes — submission sets `supersedes_result_id` to the previous
// outstanding result in its own transaction, so there is never more than one,
// and earlier results stay readable with their findings. Findings bind to the
// exact result examined and never transfer. Needs re-evaluation is derived on
// every read as `task_revision < team_tasks.revision` (task-revision-
// publication D8's row rule): never stored, so nothing can miss an event.
// The store is policy-free; TaskResultService decides who may do what.
import type { ActingParty } from '../../shared/team'
import { actorFromRow, partyFromRow } from './actorRow'
import type { Database } from 'bun:sqlite'
import type { TaskActor, TaskFindings, TaskResult, TaskTestClaim } from '../../shared/teamTasks'

export interface ResultInsert {
  teamId: string
  taskId: string
  summary: string
  commit: string | null
  diff: string | null
  worktree: string | null
  tests: TaskTestClaim[]
  limitations: string | null
  taskRevision: number
  submittedBy: TaskActor & { kind: 'agent' }
}

export interface FindingsInsert {
  teamId: string
  taskId: string
  resultId: string
  handoffId: string | null
  kind: TaskFindings['kind']
  verdict: TaskFindings['verdict']
  findings: string
  author: TaskActor & { kind: 'agent' }
}

const nowIso = () => new Date().toISOString()
const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
const actorOf = actorFromRow

function parseTests(value: unknown): TaskTestClaim[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed)
      ? parsed.filter((row): row is TaskTestClaim => !!row && typeof row.description === 'string' && typeof row.outcome === 'string')
      : []
  } catch {
    // A corrupt list reads as none; the result itself stays readable.
    return []
  }
}

export class TaskResultStore {
  constructor(private readonly db: Database) {}

  /** Insert a result, superseding the task's outstanding one in the same transaction (D1). */
  insert(input: ResultInsert, now = nowIso()): TaskResult {
    const id = `result-${crypto.randomUUID()}`
    this.db.transaction(() => {
      const previous = this.outstandingId(input.taskId)
      this.db.prepare(`INSERT INTO team_task_results
        (id, team_id, task_id, summary, commit_ref, diff_ref, worktree, tests, limitations, task_revision,
         submitted_by_kind, submitted_by_session, supersedes_result_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.teamId, input.taskId, input.summary, input.commit, input.diff, input.worktree,
        JSON.stringify(input.tests), input.limitations, input.taskRevision,
        input.submittedBy.kind, input.submittedBy.sessionId, previous, now,
      )
    })()
    return this.get(id)!
  }

  /** Findings bound to one result (D4). */
  insertFindings(input: FindingsInsert, now = nowIso()): TaskFindings {
    const id = `findings-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO team_task_findings
      (id, team_id, task_id, result_id, handoff_id, kind, verdict, findings, author_kind, author_session, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.teamId, input.taskId, input.resultId, input.handoffId, input.kind, input.verdict, input.findings,
      input.author.kind, input.author.sessionId, now,
    )
    return this.findingsFor(input.resultId).find(row => row.id === id)!
  }

  /** Mark one result accepted (D5); runs inside the acceptance transaction. */
  markAccepted(resultId: string, actor: ActingParty, now = nowIso()): boolean {
    return this.db.prepare('UPDATE team_task_results SET accepted_by_kind = ?, accepted_by_session = ?, accepted_at = ? WHERE id = ?')
      .run(actor.kind, actor.sessionId, now, resultId).changes === 1
  }

  get(id: string): TaskResult | null {
    const row = this.db.prepare('SELECT * FROM team_task_results WHERE id = ?').get(id) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  /** Every result of a task: the outstanding one first, then superseded ones newest first. */
  listByTask(taskId: string): TaskResult[] {
    return (this.db.prepare('SELECT * FROM team_task_results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(taskId) as Record<string, unknown>[]).map(row => this.map(row))
  }

  /** The task's outstanding result: the newest one nothing supersedes. */
  outstanding(taskId: string): TaskResult | null {
    const id = this.outstandingId(taskId)
    return id ? this.get(id) : null
  }

  /** The team's outstanding results submitted at or after `since` (morning summary, D8). */
  outstandingSince(teamId: string, since: string): TaskResult[] {
    return (this.db.prepare(`SELECT * FROM team_task_results r WHERE team_id = ? AND created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM team_task_results s WHERE s.supersedes_result_id = r.id)
      ORDER BY created_at, rowid`).all(teamId, since) as Record<string, unknown>[]).map(row => this.map(row))
  }

  /** Whether the session submitted a result for the task (the finished-turn bucket's test). */
  submittedBy(taskId: string, sessionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM team_task_results WHERE task_id = ? AND submitted_by_kind = ? AND submitted_by_session = ? LIMIT 1')
      .get(taskId, 'agent', sessionId) !== null
  }

  findingsFor(resultId: string): TaskFindings[] {
    return (this.db.prepare('SELECT * FROM team_task_findings WHERE result_id = ? ORDER BY created_at, rowid')
      .all(resultId) as Record<string, unknown>[]).map(row => ({
      id: String(row.id),
      taskId: String(row.task_id),
      resultId: String(row.result_id),
      handoffId: text(row.handoff_id),
      kind: row.kind === 'qa' ? 'qa' : 'review',
      verdict: row.verdict === 'pass' ? 'pass' : 'fail',
      findings: String(row.findings),
      author: actorOf(row.author_kind, row.author_session),
      createdAt: String(row.created_at),
    }))
  }

  private outstandingId(taskId: string): string | null {
    const row = this.db.prepare(`SELECT id FROM team_task_results r WHERE task_id = ?
      AND NOT EXISTS (SELECT 1 FROM team_task_results s WHERE s.supersedes_result_id = r.id)
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(taskId) as { id: string } | null
    return row?.id ?? null
  }

  private map(row: Record<string, unknown>): TaskResult {
    const id = String(row.id)
    const superseding = this.db.prepare('SELECT id FROM team_task_results WHERE supersedes_result_id = ? ORDER BY created_at, rowid LIMIT 1')
      .get(id) as { id: string } | null
    // D6: the revision-published contract's row rule, at every read.
    const current = this.db.prepare('SELECT revision FROM team_tasks WHERE id = ?').get(String(row.task_id)) as { revision: number } | null
    const taskRevision = Number(row.task_revision)
    return {
      id,
      taskId: String(row.task_id),
      summary: String(row.summary),
      commit: text(row.commit_ref),
      diff: text(row.diff_ref),
      worktree: text(row.worktree),
      tests: parseTests(row.tests),
      limitations: text(row.limitations),
      taskRevision,
      submittedBy: actorOf(row.submitted_by_kind, row.submitted_by_session),
      supersedesResultId: text(row.supersedes_result_id),
      supersededBy: superseding?.id ?? null,
      acceptedBy: row.accepted_at === null ? null : partyFromRow(row.accepted_by_kind, row.accepted_by_session),
      acceptedAt: text(row.accepted_at),
      needsReevaluation: current !== null && taskRevision < current.revision,
      findings: this.findingsFor(id),
      createdAt: String(row.created_at),
    }
  }
}
