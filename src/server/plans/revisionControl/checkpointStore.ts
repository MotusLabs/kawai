// Checkpoint store (revision-control design D2, D7): the only SQL writer of
// `plan_checkpoints`. A new checkpoint supersedes the target's earlier one in
// the same write; the superseded rows stay readable — the history the
// checkpoint dialog shows. Reads are scoped by team through the pause the
// checkpoint belongs to.
import type { Database } from 'bun:sqlite'
import type { CheckpointKind, PlanCheckpoint } from '../../../shared/planRevisionControl'

export type NewPlanCheckpoint = Omit<PlanCheckpoint, 'id' | 'supersededBy' | 'createdAt'>

type Row = Record<string, unknown>

function mapCheckpoint(row: Row): PlanCheckpoint {
  return {
    id: String(row.id),
    executionId: String(row.execution_id),
    change: String(row.change),
    pauseId: String(row.pause_id),
    attemptId: typeof row.attempt_id === 'string' ? row.attempt_id : null,
    sessionId: String(row.session_id),
    kind: String(row.kind) as CheckpointKind,
    commitSha: typeof row.commit_sha === 'string' ? row.commit_sha : null,
    baselineCommit: typeof row.baseline_commit === 'string' ? row.baseline_commit : null,
    manifestHash: typeof row.manifest_hash === 'string' ? row.manifest_hash : null,
    resultId: typeof row.result_id === 'string' ? row.result_id : null,
    summary: String(row.summary),
    unfinished: typeof row.unfinished === 'string' ? row.unfinished : null,
    errorsTests: typeof row.errors_tests === 'string' ? row.errors_tests : null,
    nextSteps: String(row.next_steps),
    effectId: typeof row.effect_id === 'string' ? row.effect_id : null,
    supersededBy: typeof row.superseded_by === 'string' ? row.superseded_by : null,
    createdAt: String(row.created_at),
  }
}

export class CheckpointStore {
  constructor(readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  /**
   * Insert one checkpoint, superseding the target's earlier ones: their
   * `superseded_by` names this row, and they stay readable. The id is
   * `checkpoint-<uuid>`.
   */
  insert(input: NewPlanCheckpoint): PlanCheckpoint {
    const id = `checkpoint-${crypto.randomUUID()}`
    const at = this.now().toISOString()
    this.db.prepare(`INSERT INTO plan_checkpoints (id, execution_id, change, pause_id, attempt_id, session_id, kind, commit_sha, baseline_commit,
      manifest_hash, result_id, summary, unfinished, errors_tests, next_steps, effect_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.executionId, input.change, input.pauseId, input.attemptId, input.sessionId, input.kind,
      input.commitSha, input.baselineCommit, input.manifestHash, input.resultId, input.summary,
      input.unfinished, input.errorsTests, input.nextSteps, input.effectId, at,
    )
    this.db.prepare('UPDATE plan_checkpoints SET superseded_by = ? WHERE pause_id = ? AND change = ? AND id != ? AND superseded_by IS NULL')
      .run(id, input.pauseId, input.change, id)
    return this.get(id)!
  }

  get(id: string): PlanCheckpoint | null {
    const row = this.db.prepare('SELECT * FROM plan_checkpoints WHERE id = ?').get(id) as Row | null
    return row ? mapCheckpoint(row) : null
  }

  /** The target's checkpoints, newest first; the newest is the one in force. */
  forTarget(pauseId: string, change: string): PlanCheckpoint[] {
    return (this.db.prepare('SELECT * FROM plan_checkpoints WHERE pause_id = ? AND change = ? ORDER BY created_at DESC, rowid DESC')
      .all(pauseId, change) as Row[]).map(mapCheckpoint)
  }

  newest(pauseId: string, change: string): PlanCheckpoint | null {
    return this.forTarget(pauseId, change)[0] ?? null
  }

  /** Record the push effect once it exists (kind `commit` only, D7). */
  setEffect(id: string, effectId: string): void {
    this.db.prepare('UPDATE plan_checkpoints SET effect_id = ? WHERE id = ?').run(effectId, id)
  }
}
