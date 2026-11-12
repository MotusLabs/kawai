// The findings ledger's rows (review-findings-ledger D3): structured
// submissions with their items, ledger events, and dispute cards. Policy-free
// like TaskResultStore: TaskFindingService decides what may be written, and
// calls these inside its own transaction. `ledger_seq` and finding numbers
// are allocated per task as max + 1 across both tables, so the caller's
// immediate transaction makes them dense and monotonic (P2).
import type { Database } from 'bun:sqlite'
import type { LedgerEvent, LedgerEventKind, LedgerItem, LedgerSubmission } from '../../shared/findingsLedger'
import type { Disposition, FindingClass, FindingLevel } from '../../shared/reviewFindings'
import type { TaskActor, TaskFindings } from '../../shared/teamTasks'

export interface StructuredInsert {
  teamId: string
  taskId: string
  resultId: string
  handoffId: string | null
  kind: TaskFindings['kind']
  verdict: TaskFindings['verdict']
  notes: string
  author: TaskActor & { kind: 'agent' }
  counted: boolean
  contractIdentity: string
  ledgerSeq: number
  items: LedgerItem[]
}

export interface EventInsert {
  taskId: string
  findingId: string
  kind: LedgerEventKind
  resultId?: string | null
  cardId?: string | null
  decisionId?: string | null
  revision?: number | null
  contractIdentity?: string | null
  clause?: string | null
  actor: { kind: string; sessionId: string | null }
  text?: string | null
  /** Replay key (I5); a second insert under the same key writes nothing. */
  sourceKey: string
}

export interface CardLink { cardId: string; taskId: string; findingId: string; disputeEventId: string }

const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
const nowIso = () => new Date().toISOString()

export function mapItem(row: Record<string, unknown>): LedgerItem {
  return {
    findingId: String(row.finding_id),
    itemKind: row.item_kind === 'disposition' ? 'disposition' : 'finding',
    level: String(row.level) as FindingLevel,
    clause: text(row.clause),
    clauseId: text(row.clause_id),
    evidence: text(row.evidence),
    impact: text(row.impact),
    reproduction: text(row.reproduction),
    locus: String(row.locus ?? ''),
    class: text(row.class) as FindingClass | null,
    reason: text(row.reason),
    disposition: text(row.disposition) as Disposition | null,
    regressed: Number(row.regressed) === 1,
  }
}

export class FindingStore {
  constructor(private readonly db: Database) {}

  /**
   * Whether a plan round on this result was decided pass or fail (D5's
   * finality), read from the persisted rounds — a database without plan
   * executions has none. A superseded round was never decided on its review.
   */
  roundDecided(resultId: string): boolean {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plan_execution_rounds'").get() === null) return false
    return this.db.prepare("SELECT 1 FROM plan_execution_rounds WHERE result_id = ? AND outcome IN ('pass', 'fail') LIMIT 1").get(resultId) !== null
  }

  /** The task's next ledger position: one past the highest across submissions and events. */
  nextSeq(taskId: string): number {
    const row = this.db.prepare(`SELECT max(seq) AS seq FROM (
      SELECT max(ledger_seq) AS seq FROM team_task_findings WHERE task_id = ?
      UNION ALL SELECT max(ledger_seq) FROM team_task_finding_events WHERE task_id = ?)`).get(taskId, taskId) as { seq: number | null }
    return (row.seq ?? 0) + 1
  }

  /** The task's next finding number: ids are never reused, whatever their submission's standing. */
  nextFindingNumber(taskId: string): number {
    const row = this.db.prepare(`SELECT max(CAST(substr(finding_id, 2) AS INTEGER)) AS n FROM team_task_finding_items WHERE task_id = ?`)
      .get(taskId) as { n: number | null }
    return (row.n ?? 0) + 1
  }

  insertSubmission(input: StructuredInsert, now = nowIso()): string {
    const id = `findings-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO team_task_findings
      (id, team_id, task_id, result_id, handoff_id, kind, verdict, findings, author_kind, author_session, created_at,
       structured, counted, contract_identity, ledger_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
      id, input.teamId, input.taskId, input.resultId, input.handoffId, input.kind, input.verdict, input.notes,
      input.author.kind, input.author.sessionId, now, input.counted ? 1 : 0, input.contractIdentity, input.ledgerSeq,
    )
    const insert = this.db.prepare(`INSERT INTO team_task_finding_items
      (id, submission_id, task_id, finding_id, item_kind, level, clause, clause_id, evidence, impact, reproduction, locus,
       class, reason, disposition, regressed, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    input.items.forEach((item, position) => insert.run(
      `item-${crypto.randomUUID()}`, id, input.taskId, item.findingId, item.itemKind, item.level, item.clause, item.clauseId,
      item.evidence, item.impact, item.reproduction, item.locus, item.class, item.reason, item.disposition, item.regressed ? 1 : 0,
      position, now,
    ))
    return id
  }

  markReplaced(id: string, by: string): void {
    this.db.prepare('UPDATE team_task_findings SET replaced_by = ? WHERE id = ?').run(by, id)
  }

  itemsOf(submissionId: string): LedgerItem[] {
    return (this.db.prepare('SELECT * FROM team_task_finding_items WHERE submission_id = ? ORDER BY position')
      .all(submissionId) as Record<string, unknown>[]).map(mapItem)
  }

  /** The submissions the ledger counts (D5): structured, counted, not replaced, in ledger order. */
  countedSubmissions(taskId: string): LedgerSubmission[] {
    return (this.db.prepare(`SELECT id, result_id, ledger_seq, contract_identity, created_at FROM team_task_findings
      WHERE task_id = ? AND structured = 1 AND counted = 1 AND replaced_by IS NULL ORDER BY ledger_seq`)
      .all(taskId) as Record<string, unknown>[]).map(row => ({
      id: String(row.id), resultId: String(row.result_id), ledgerSeq: Number(row.ledger_seq),
      contractIdentity: text(row.contract_identity), createdAt: String(row.created_at), items: this.itemsOf(String(row.id)),
    }))
  }

  events(taskId: string): LedgerEvent[] {
    return (this.db.prepare('SELECT * FROM team_task_finding_events WHERE task_id = ? ORDER BY ledger_seq')
      .all(taskId) as Record<string, unknown>[]).map(row => ({
      id: String(row.id), findingId: String(row.finding_id), ledgerSeq: Number(row.ledger_seq),
      kind: String(row.kind) as LedgerEventKind, resultId: text(row.result_id), cardId: text(row.card_id),
      decisionId: text(row.decision_id), contractIdentity: text(row.contract_identity), clause: text(row.clause),
      text: text(row.text), createdAt: String(row.created_at),
    }))
  }

  /** Insert one event at the task's next position; false (nothing written) when its key already stands. */
  insertEvent(input: EventInsert, now = nowIso()): string | null {
    const id = `fevent-${crypto.randomUUID()}`
    const changes = this.db.prepare(`INSERT OR IGNORE INTO team_task_finding_events
      (id, task_id, finding_id, ledger_seq, kind, result_id, card_id, decision_id, revision, contract_identity, clause,
       actor_kind, actor_session, text, source_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.taskId, input.findingId, this.nextSeq(input.taskId), input.kind, input.resultId ?? null, input.cardId ?? null,
      input.decisionId ?? null, input.revision ?? null, input.contractIdentity ?? null, input.clause ?? null,
      input.actor.kind, input.actor.sessionId, input.text ?? null, input.sourceKey, now,
    ).changes
    return changes === 1 ? id : null
  }

  hasEvent(sourceKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM team_task_finding_events WHERE source_key = ?').get(sourceKey) !== null
  }

  linkCard(link: CardLink): void {
    this.db.prepare('INSERT OR IGNORE INTO team_task_finding_cards (card_id, task_id, finding_id, dispute_event_id) VALUES (?, ?, ?, ?)')
      .run(link.cardId, link.taskId, link.findingId, link.disputeEventId)
  }

  cardLink(cardId: string): CardLink | null {
    const row = this.db.prepare('SELECT * FROM team_task_finding_cards WHERE card_id = ?').get(cardId) as Record<string, unknown> | null
    return row ? { cardId: String(row.card_id), taskId: String(row.task_id), findingId: String(row.finding_id), disputeEventId: String(row.dispute_event_id) } : null
  }

  /** Every linked card; the startup replay walks them (D6). */
  allCardLinks(): CardLink[] {
    return (this.db.prepare('SELECT * FROM team_task_finding_cards ORDER BY rowid').all() as Record<string, unknown>[])
      .map(row => ({ cardId: String(row.card_id), taskId: String(row.task_id), findingId: String(row.finding_id), disputeEventId: String(row.dispute_event_id) }))
  }

  /** The newest evidence a finding was raised with (the dispute card's context). */
  evidenceOf(taskId: string, findingId: string): string | null {
    const row = this.db.prepare(`SELECT evidence FROM team_task_finding_items WHERE task_id = ? AND finding_id = ? AND item_kind = 'finding'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(taskId, findingId) as { evidence: string | null } | null
    return row?.evidence ?? null
  }

  /** Counted submissions on one result (the replace and finality checks). */
  countedOn(resultId: string): Array<{ id: string; ledgerSeq: number; items: LedgerItem[] }> {
    return (this.db.prepare(`SELECT id, ledger_seq FROM team_task_findings WHERE result_id = ? AND structured = 1 AND counted = 1 AND replaced_by IS NULL ORDER BY ledger_seq`)
      .all(resultId) as Record<string, unknown>[]).map(row => ({ id: String(row.id), ledgerSeq: Number(row.ledger_seq), items: this.itemsOf(String(row.id)) }))
  }
}
