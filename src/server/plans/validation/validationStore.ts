// The validation store (plan-validation design D1): policy-free primitives
// over the three append-only tables. There is no update path — a report is
// never rewritten, a later decision on the same target supersedes the earlier
// only by being newer, and both stay readable. `ValidationService` composes
// these inside `atomically` and decides who may do what. Insert methods raise
// `ValidationCommandRaceError` on a used command id so the service can
// resolve it as a replay, never surfacing the constraint raw.
import type { Database } from 'bun:sqlite'
import type {
  AssessmentRow,
  DecisionKind,
  DecisionRecord,
  Finding,
  PlanRelation,
  PlanValidationReport,
  ValidationEvidence,
  ValidationInputs,
  ValidationRequester,
} from '../../../shared/planValidation'
import type { Readiness } from '../../../shared/planValidation'
import { mapAssessment, mapDecision, mapReport, rowPayload } from './validationSchema'

/** Thrown by inserts when the command id is already recorded for the plan. */
export class ValidationCommandRaceError extends Error {
  constructor(readonly commandId: string) { super(`plan validation command race: ${commandId}`) }
}

const isUnique = (error: unknown) => String(error).includes('UNIQUE constraint failed')
const nowIso = () => new Date().toISOString()

export interface NewValidationReport {
  planId: string
  revision: number
  inputHash: string
  inputs: ValidationInputs
  findings: Finding[]
  relations: PlanRelation[]
  evidence: ValidationEvidence
  readiness: Readiness
  ready: boolean
  requestedBy: ValidationRequester
}

export interface NewAssessment {
  planId: string
  revision: number
  kind: AssessmentRow['kind']
  payload: Record<string, unknown>
  author: ValidationRequester
  /** The owner's form; null for agent tool calls. */
  commandId: string | null
}

export interface NewDecision {
  planId: string
  revision: number
  kind: DecisionKind
  target: string
  text: string
  scope: string | null
  commandId: string
  payload: Record<string, unknown>
}

export class ValidationStore {
  constructor(private readonly db: Database) {}

  /** Run writes as one transaction. */
  atomically<T>(write: () => T): T {
    return this.db.transaction(write)()
  }

  /**
   * Insert with `seq = max(seq) + 1` (D1); the newest report is `max(seq)`.
   * Runs inside `atomically` on this single connection (SQLite serializes
   * the read and the insert), so a `seq` unique violation reaching a caller
   * means a second writer — never an expected race to resolve here.
   */
  insertReport(input: NewValidationReport, now = nowIso()): PlanValidationReport {
    const seq = this.nextSeq(input.planId, input.revision)
    const id = `pvr-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO plan_validation_reports
      (id, plan_id, revision, seq, input_hash, inputs_json, findings_json, relations_json, evidence_json, readiness_json, ready, requested_kind, requested_session, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.planId, input.revision, seq, input.inputHash,
      JSON.stringify(input.inputs), JSON.stringify(input.findings), JSON.stringify(input.relations),
      JSON.stringify(input.evidence), JSON.stringify(input.readiness), input.ready ? 1 : 0,
      input.requestedBy.kind, input.requestedBy.sessionId, now,
    )
    return mapReport(this.db.prepare('SELECT * FROM plan_validation_reports WHERE id = ?').get(id) as Record<string, unknown>)
  }

  private nextSeq(planId: string, revision: number): number {
    const row = this.db.prepare('SELECT MAX(seq) AS max FROM plan_validation_reports WHERE plan_id = ? AND revision = ?').get(planId, revision) as { max: number | null }
    return (row.max ?? 0) + 1
  }

  report(id: string): PlanValidationReport | null {
    const row = this.db.prepare('SELECT * FROM plan_validation_reports WHERE id = ?').get(id)
    return row ? mapReport(row as Record<string, unknown>) : null
  }

  /** The revision's newest report (`max(seq)`), or null. */
  newestReport(planId: string, revision: number): PlanValidationReport | null {
    const row = this.db.prepare('SELECT * FROM plan_validation_reports WHERE plan_id = ? AND revision = ? ORDER BY seq DESC LIMIT 1').get(planId, revision)
    return row ? mapReport(row as Record<string, unknown>) : null
  }

  /** The revision's reports, oldest first. */
  reports(planId: string, revision: number): PlanValidationReport[] {
    return (this.db.prepare('SELECT * FROM plan_validation_reports WHERE plan_id = ? AND revision = ? ORDER BY seq').all(planId, revision) as Record<string, unknown>[])
      .map(mapReport)
  }

  /** Append an assessment; a used command id raises ValidationCommandRaceError. */
  insertAssessment(input: NewAssessment, now = nowIso()): AssessmentRow {
    const id = `pas-${crypto.randomUUID()}`
    try {
      this.db.prepare(`INSERT INTO plan_assessments (id, plan_id, revision, kind, payload_json, author_kind, author_session, command_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.planId, input.revision, input.kind, JSON.stringify(input.payload),
        input.author.kind, input.author.sessionId, input.commandId, now,
      )
    } catch (error) {
      if (isUnique(error) && input.commandId) throw new ValidationCommandRaceError(input.commandId)
      throw error
    }
    return this.assessment(id)!
  }

  assessment(id: string): AssessmentRow | null {
    const row = this.db.prepare('SELECT * FROM plan_assessments WHERE id = ?').get(id)
    return row ? mapAssessment(row as Record<string, unknown>) : null
  }

  /** The owner's form row by command id, with its compared payload (D5 replay). */
  assessmentByCommand(planId: string, commandId: string): { row: AssessmentRow; payload: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT * FROM plan_assessments WHERE plan_id = ? AND command_id = ?').get(planId, commandId) as Record<string, unknown> | null
    return row ? { row: mapAssessment(row), payload: rowPayload(row) } : null
  }

  /** The revision's assessments, oldest first (D5: they accumulate). */
  assessments(planId: string, revision: number): AssessmentRow[] {
    return (this.db.prepare('SELECT * FROM plan_assessments WHERE plan_id = ? AND revision = ? ORDER BY created_at, rowid').all(planId, revision) as Record<string, unknown>[])
      .map(mapAssessment)
  }

  /** Append a decision; a used command id raises ValidationCommandRaceError. */
  insertDecision(input: NewDecision, now = nowIso()): DecisionRecord {
    const id = `pvd-${crypto.randomUUID()}`
    try {
      this.db.prepare(`INSERT INTO plan_validation_decisions (id, plan_id, revision, kind, target, text, scope, actor_kind, command_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?)`).run(
        id, input.planId, input.revision, input.kind, input.target, input.text, input.scope,
        input.commandId, JSON.stringify(input.payload), now,
      )
    } catch (error) {
      if (isUnique(error) && input.commandId) throw new ValidationCommandRaceError(input.commandId)
      throw error
    }
    return this.decision(id)!
  }

  decision(id: string): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM plan_validation_decisions WHERE id = ?').get(id)
    return row ? mapDecision(row as Record<string, unknown>) : null
  }

  /** The recorded decision by command id, with its compared payload (D6 replay). */
  decisionByCommand(planId: string, commandId: string): { decision: DecisionRecord; payload: Record<string, unknown> } | null {
    const row = this.db.prepare('SELECT * FROM plan_validation_decisions WHERE plan_id = ? AND command_id = ?').get(planId, commandId) as Record<string, unknown> | null
    return row ? { decision: mapDecision(row), payload: rowPayload(row) } : null
  }

  /** The revision's decisions, oldest first; a later one on the same target supersedes. */
  decisions(planId: string, revision: number): DecisionRecord[] {
    return (this.db.prepare('SELECT * FROM plan_validation_decisions WHERE plan_id = ? AND revision = ? ORDER BY created_at, rowid').all(planId, revision) as Record<string, unknown>[])
      .map(mapDecision)
  }
}
