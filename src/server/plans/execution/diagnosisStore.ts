// Diagnoses (review-convergence decision 4): one row per failed round that
// opened a diagnosis instead of a fix (`UNIQUE(round_id)`, the replay key).
// Open while `closed_at` is null; `outcome` is 'amend' while an open
// diagnosis waits for the owner's revision, else the applied outcome once
// closed. Every close is guarded by `closed_at IS NULL`, so a closed
// diagnosis is never applied again (invariant I5). No policy here.
import type { Database } from 'bun:sqlite'
import type { DiagnosisSignal } from '../../../shared/reviewConvergence'

export type DiagnosisOutcomeKind = 'fix' | 'reject' | 'amend' | 'reassign' | 'escalate'
export type DiagnosisCloseReason = 'decision' | 'revision'

export interface DiagnosisRow {
  id: string
  executionId: string
  change: string
  roundId: string
  /** The counted review it opened on; null for a backstop on a review-less round. */
  reviewSubmissionId: string | null
  signals: DiagnosisSignal[]
  cardId: string
  messageId: string | null
  openedAt: string
  outcome: DiagnosisOutcomeKind | null
  decisionId: string | null
  closedAt: string | null
  closeReason: DiagnosisCloseReason | null
}

type Row = Record<string, unknown>
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

function mapDiagnosis(row: Row): DiagnosisRow {
  return {
    id: String(row.id),
    executionId: String(row.execution_id),
    change: String(row.change),
    roundId: String(row.round_id),
    reviewSubmissionId: text(row.review_submission_id),
    signals: JSON.parse(String(row.signals_json)) as DiagnosisSignal[],
    cardId: String(row.card_id),
    messageId: text(row.message_id),
    openedAt: String(row.opened_at),
    outcome: text(row.outcome) as DiagnosisOutcomeKind | null,
    decisionId: text(row.decision_id),
    closedAt: text(row.closed_at),
    closeReason: text(row.close_reason) as DiagnosisCloseReason | null,
  }
}

export class DiagnosisStore {
  constructor(readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  insert(input: Pick<DiagnosisRow, 'executionId' | 'change' | 'roundId' | 'reviewSubmissionId' | 'signals' | 'cardId' | 'messageId'> & { id?: string }): DiagnosisRow {
    const id = input.id ?? `diagnosis-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_execution_diagnoses (id, execution_id, change, round_id, review_submission_id, signals_json, card_id, message_id, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.executionId, input.change, input.roundId, input.reviewSubmissionId, JSON.stringify(input.signals), input.cardId, input.messageId,
      this.now().toISOString(),
    )
    return this.get(id)!
  }

  get(id: string): DiagnosisRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_diagnoses WHERE id = ?').get(id) as Row | null
    return row ? mapDiagnosis(row) : null
  }

  forRound(roundId: string): DiagnosisRow | null {
    const row = this.db.prepare('SELECT * FROM plan_execution_diagnoses WHERE round_id = ?').get(roundId) as Row | null
    return row ? mapDiagnosis(row) : null
  }

  /** Every diagnosis of a change in an execution, oldest first. */
  ofChange(executionId: string, change: string): DiagnosisRow[] {
    return (this.db.prepare('SELECT * FROM plan_execution_diagnoses WHERE execution_id = ? AND change = ? ORDER BY opened_at, rowid')
      .all(executionId, change) as Row[]).map(mapDiagnosis)
  }

  /** The change's open diagnosis, if any. */
  open(executionId: string, change: string): DiagnosisRow | null {
    return this.ofChange(executionId, change).find(entry => entry.closedAt === null) ?? null
  }

  /** The window's anchor: the counted review of the change's newest closed diagnosis that opened on one. */
  anchor(executionId: string, change: string): string | null {
    return this.ofChange(executionId, change).filter(entry => entry.closedAt !== null && entry.reviewSubmissionId !== null).at(-1)?.reviewSubmissionId ?? null
  }

  /** Record `amend` on an open diagnosis; it stays open. False when it was closed meanwhile. */
  markAmend(id: string, decisionId: string): boolean {
    return this.db.prepare("UPDATE plan_execution_diagnoses SET outcome = 'amend', decision_id = ? WHERE id = ? AND closed_at IS NULL").run(decisionId, id).changes === 1
  }

  /** Close an open diagnosis; false when it was already closed (nothing written). */
  close(id: string, input: { reason: DiagnosisCloseReason; outcome: DiagnosisOutcomeKind | null; decisionId: string | null }): boolean {
    return this.db.prepare('UPDATE plan_execution_diagnoses SET closed_at = ?, close_reason = ?, outcome = ?, decision_id = ? WHERE id = ? AND closed_at IS NULL')
      .run(this.now().toISOString(), input.reason, input.outcome, input.decisionId, id).changes === 1
  }
}
