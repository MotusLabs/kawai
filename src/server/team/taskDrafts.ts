// The human's task drafts (task-revision-publication design D1): one per
// task, an unpublished edit of direction, acceptance, and rationale based on
// a named published revision. A draft is never a revision — it changes
// neither `team_tasks.revision` nor `updated_at`, writes no mail, and is
// never read by agent paths (`TaskStore.get/list/detail`, `buildTaskContext`).
// Its own listeners refresh the human's task view only: `TaskStore.changed`
// never fires for a draft, so nothing that reacts to task changes (dispatch,
// member release, revision consumers) sees one.
import type { Database } from 'bun:sqlite'
import type { TaskDraft } from '../../shared/teamTasks'

export interface DraftInput {
  baseRevision: number
  direction: string
  acceptance: string | null
  rationale: string | null
}

const nowIso = () => new Date().toISOString()

export class TaskDraftStore {
  private readonly listeners = new Set<(taskId: string) => void>()

  constructor(private readonly db: Database) {}

  /** A draft was saved, rebased, or discarded: the human's task view refreshes. */
  subscribe(listener: (taskId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(taskId: string): TaskDraft | null {
    const row = this.db.prepare('SELECT * FROM team_task_drafts WHERE task_id = ?').get(taskId) as Record<string, unknown> | null
    if (!row) return null
    return {
      taskId: String(row.task_id),
      baseRevision: Number(row.base_revision),
      direction: String(row.direction),
      acceptance: row.acceptance === null ? null : String(row.acceptance),
      rationale: row.rationale === null ? null : String(row.rationale),
      updatedAt: String(row.updated_at),
    }
  }

  /** Save (overwrite) the task's one draft. */
  save(taskId: string, input: DraftInput, now = nowIso()): TaskDraft {
    this.db.prepare(`INSERT OR REPLACE INTO team_task_drafts (task_id, base_revision, direction, acceptance, rationale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(taskId, input.baseRevision, input.direction, input.acceptance, input.rationale, now)
    this.changed(taskId)
    return this.get(taskId)!
  }

  /** Move the draft onto a newer base, keeping its text; null when there is none. */
  rebase(taskId: string, baseRevision: number, now = nowIso()): TaskDraft | null {
    const changes = this.db.prepare('UPDATE team_task_drafts SET base_revision = ?, updated_at = ? WHERE task_id = ?')
      .run(baseRevision, now, taskId).changes
    if (changes === 0) return null
    this.changed(taskId)
    return this.get(taskId)
  }

  /** Drop the draft; `notify: false` inside a publication, whose own change event follows the commit. */
  discard(taskId: string, notify = true): boolean {
    const removed = this.db.prepare('DELETE FROM team_task_drafts WHERE task_id = ?').run(taskId).changes === 1
    if (removed && notify) this.changed(taskId)
    return removed
  }

  private changed(taskId: string): void {
    for (const listener of this.listeners) listener(taskId)
  }
}
