// Execution-revision store (revision-control design D2, D11): the only SQL
// writer of `plan_execution_revisions` and
// `plan_execution_publication_changes`. The `(execution_id, seq)` primary
// key arbitrates Apply: two concurrent applies on one base collide on the
// same seq, and the loser's constraint error becomes an
// `ExecutionRevisionConflict` of kind `execution-revision-unchanged` instead
// of leaving this file raw. A replay never rewrites: the command id replays
// upstream, so rows are inserted exactly once.
import type { Database } from 'bun:sqlite'
import type { ExecutionRevisionRecord, PublicationChange } from '../../../shared/planRevisionControl'

export type ExecutionRevisionConflictKind = 'execution-revision-unchanged'

/** The loser of a race on the execution's next revision seq (D2). */
export class ExecutionRevisionConflict extends Error {
  constructor(readonly kind: ExecutionRevisionConflictKind, message: string) {
    super(message)
    this.name = 'ExecutionRevisionConflict'
  }
}

export type NewExecutionRevision = Omit<ExecutionRevisionRecord, 'seq'>

export type NewPublicationChange = Omit<PublicationChange, 'executionId' | 'seq'>

type Row = Record<string, unknown>

function mapRevision(row: Row): ExecutionRevisionRecord {
  return {
    executionId: String(row.execution_id),
    seq: Number(row.seq),
    revision: Number(row.revision),
    contentHash: String(row.content_hash),
    reportId: String(row.report_id),
    inputHash: String(row.input_hash),
    rationale: typeof row.rationale === 'string' ? row.rationale : null,
    commandId: typeof row.command_id === 'string' ? row.command_id : null,
    payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) as Record<string, unknown> : null,
    appliedAt: String(row.applied_at),
  }
}

function mapPublication(row: Row): PublicationChange {
  return {
    executionId: String(row.execution_id),
    seq: Number(row.seq),
    change: String(row.change),
    class: String(row.class) as PublicationChange['class'],
    choice: typeof row.choice === 'string' ? row.choice : null,
    fields: typeof row.fields_json === 'string' ? JSON.parse(row.fields_json) as string[] : [],
    taskId: typeof row.task_id === 'string' ? row.task_id : null,
    taskRevision: typeof row.task_revision === 'number' ? row.task_revision : null,
  }
}

export class ExecutionRevisionStore {
  constructor(readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  /**
   * Append the execution's next revision row at `max(seq) + 1`, with its
   * publication rows.
   */
  record(input: NewExecutionRevision, publications: NewPublicationChange[]): { seq: number; record: ExecutionRevisionRecord } {
    const next = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM plan_execution_revisions WHERE execution_id = ?')
      .get(input.executionId) as { seq: number }
    return this.recordAt(next.seq, input, publications)
  }

  /**
   * Write one revision row at an exact seq with its publication rows. A
   * colliding insert — another Apply committed the same seq first, the
   * primary key arbitrating the race (D2) — becomes an
   * `ExecutionRevisionConflict` of kind `execution-revision-unchanged`
   * naming the seq that won.
   */
  recordAt(seq: number, input: NewExecutionRevision, publications: NewPublicationChange[]): { seq: number; record: ExecutionRevisionRecord } {
    const at = input.appliedAt ?? this.now().toISOString()
    try {
      this.db.prepare(`INSERT INTO plan_execution_revisions (execution_id, seq, revision, content_hash, report_id, input_hash, rationale, command_id, payload_json, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.executionId, seq, input.revision, input.contentHash, input.reportId, input.inputHash,
        input.rationale, input.commandId, input.payload ? JSON.stringify(input.payload) : null, at,
      )
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: plan_execution_revisions.execution_id, plan_execution_revisions.seq')) {
        throw new ExecutionRevisionConflict('execution-revision-unchanged',
          `Execution ${input.executionId} already holds revision seq ${seq}; the execution's revision was changed concurrently and nothing was applied.`)
      }
      throw error
    }
    const insertPublication = this.db.prepare(`INSERT INTO plan_execution_publication_changes (execution_id, seq, change, class, choice, fields_json, task_id, task_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const publication of publications) {
      insertPublication.run(
        input.executionId, seq, publication.change, publication.class, publication.choice,
        publication.fields.length > 0 ? JSON.stringify(publication.fields) : null, publication.taskId, publication.taskRevision,
      )
    }
    return { seq, record: this.revision(input.executionId, seq)! }
  }

  /** The execution's revision history, oldest first; seq 1 is what Start recorded. */
  history(executionId: string): ExecutionRevisionRecord[] {
    return (this.db.prepare('SELECT * FROM plan_execution_revisions WHERE execution_id = ? ORDER BY seq').all(executionId) as Row[])
      .map(mapRevision)
  }

  revision(executionId: string, seq: number): ExecutionRevisionRecord | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_revisions WHERE execution_id = ? AND seq = ?').get(executionId, seq) as Row | null
    return row ? mapRevision(row) : null
  }

  newest(executionId: string): ExecutionRevisionRecord | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_revisions WHERE execution_id = ? ORDER BY seq DESC LIMIT 1').get(executionId) as Row | null
    return row ? mapRevision(row) : null
  }

  publications(executionId: string, seq: number): PublicationChange[] {
    return (this.db.prepare('SELECT * FROM plan_execution_publication_changes WHERE execution_id = ? AND seq = ? ORDER BY change')
      .all(executionId, seq) as Row[]).map(mapPublication)
  }
}
