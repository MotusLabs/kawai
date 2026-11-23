// The human's task drafts (task-revision-publication design D1): one per
// task, an unpublished edit of direction, acceptance, and rationale based on
// a named published revision, plus its raw contract text (implementation-
// contract D3), which may not parse yet. A draft is never a revision — it changes
// neither `team_tasks.revision` nor `updated_at`, writes no mail, and is
// never read by agent paths (`TaskStore.get/list/detail`, `buildTaskContext`).
// Its own listeners refresh the human's task view only: `TaskStore.changed`
// never fires for a draft, so nothing that reacts to task changes (dispatch,
// member release, revision consumers) sees one.
//
// A draft loaded from a publication handoff (owner-publication-handoff D3,
// H-DRAFT) also carries the handoff's id and a server-owned lineage identity.
// The form sends the identity it observed; while the stored draft is linked,
// a save or rebase whose observed identity differs is refused (H43), a save
// at the same base keeps the link (H41), and one that moves the base keeps
// the text and detaches the link (H42). Matching bases never attach a draft.
import type { Database } from 'bun:sqlite'
import type { TaskDraft } from '../../shared/teamTasks'

export interface DraftInput {
  baseRevision: number
  direction: string
  acceptance: string | null
  rationale: string | null
  /** Raw contract text (implementation-contract D3): null = the base revision's contract, unedited; '' = cleared. */
  contractText?: string | null
}

/** The handoff link a load writes (H19); carried explicitly by every save that keeps it. */
export interface DraftLink {
  handoffId: string
  lineageId: string
}

/** H43's refusal: the stored linked draft is not the one the form observed. */
export const REPLACED_DRAFT_REFUSAL = 'The draft was replaced since this form loaded it (a prepared revision was loaded into it); nothing was saved or published. Refresh to see the stored draft; your unsaved text is kept in the form.'

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
      contractText: row.contract_text === null || row.contract_text === undefined ? null : String(row.contract_text),
      handoffId: row.handoff_id === null || row.handoff_id === undefined ? null : String(row.handoff_id),
      lineageId: row.lineage_id === null || row.lineage_id === undefined ? null : String(row.lineage_id),
      updatedAt: String(row.updated_at),
    }
  }

  /**
   * Save (overwrite) the task's one draft. `INSERT OR REPLACE` rewrites the
   * whole row, so the link columns are written explicitly: `link` keeps or
   * sets them, its absence clears them.
   */
  save(taskId: string, input: DraftInput, now = nowIso(), link: DraftLink | null = null): TaskDraft {
    this.db.prepare(`INSERT OR REPLACE INTO team_task_drafts (task_id, base_revision, direction, acceptance, rationale, contract_text, handoff_id, lineage_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, input.baseRevision, input.direction, input.acceptance, input.rationale, input.contractText ?? null,
      link?.handoffId ?? null, link?.lineageId ?? null, now)
    this.changed(taskId)
    return this.get(taskId)!
  }

  /**
   * The form's save (H41–H43): `observed` is the lineage identity the form
   * loaded (null for none). Checked and written in one transaction, so a
   * replacement landing between the read and the write is refused.
   */
  saveObserved(taskId: string, input: DraftInput, observed: string | null, now = nowIso()): TaskDraft {
    return this.db.transaction(() => {
      const stored = this.get(taskId)
      const link = this.observedLink(stored, observed)
      return this.save(taskId, input, now, link && stored!.baseRevision === input.baseRevision ? link : null)
    })()
  }

  /** Move the draft onto a newer base, keeping its text; a moved base detaches its link (H42); null when there is none. */
  rebase(taskId: string, baseRevision: number, now = nowIso(), observed: string | null = null): TaskDraft | null {
    return this.db.transaction(() => {
      const stored = this.get(taskId)
      if (!stored) return null
      const keep = this.observedLink(stored, observed) !== null && stored.baseRevision === baseRevision
      this.db.prepare(`UPDATE team_task_drafts SET base_revision = ?, updated_at = ?${keep ? '' : ', handoff_id = NULL, lineage_id = NULL'} WHERE task_id = ?`)
        .run(baseRevision, now, taskId)
      this.changed(taskId)
      return this.get(taskId)
    })()
  }

  /** The stored draft's link when the form observed it; null for an unlinked draft; H43 for any other observation. */
  observedLink(stored: TaskDraft | null, observed: string | null): DraftLink | null {
    if (!stored?.lineageId || !stored.handoffId) return null
    if (observed !== stored.lineageId) throw new Error(REPLACED_DRAFT_REFUSAL)
    return { handoffId: stored.handoffId, lineageId: stored.lineageId }
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
