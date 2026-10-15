// Plan validation schema and row mapping (plan-validation design D1), beside
// the plan tables and never touching them: reports are only read by approval.
// Three append-only tables hold what this change records — immutable reports,
// agent and owner assessments, and owner decisions. Two facts live in the
// database: a report's `seq` is unique per revision (inserted as `max + 1`),
// and a command id is used once per plan (the owner's assessment form and
// every decision), while agent assessment rows carry a null `command_id` and
// SQLite keeps nulls distinct, so a retried agent call appends. The DDL is a
// numbered migration in `dbSafety/migrations.ts` named `plan-validation` and
// frozen like every applied migration. Pure: no policy, no writes.
import type {
  AssessmentAuthor,
  AssessmentRow,
  DecisionKind,
  DecisionRecord,
  PlanRelation,
  PlanValidationReport,
  ValidationEvidence,
  ValidationInputs,
  ValidationRequester,
} from '../../../shared/planValidation'
import type { Finding, Readiness } from '../../../shared/planValidation'

export const CREATE_VALIDATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plan_validation_reports (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  relations_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  readiness_json TEXT NOT NULL,
  ready INTEGER NOT NULL,
  requested_kind TEXT NOT NULL,
  requested_session TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, revision, seq)
);
CREATE INDEX IF NOT EXISTS plan_validation_reports_revision ON plan_validation_reports (plan_id, revision, seq);
CREATE TABLE IF NOT EXISTS plan_assessments (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  command_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, command_id)
);
CREATE INDEX IF NOT EXISTS plan_assessments_revision ON plan_assessments (plan_id, revision, created_at);
CREATE TABLE IF NOT EXISTS plan_validation_decisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  scope TEXT,
  actor_kind TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, command_id)
);
CREATE INDEX IF NOT EXISTS plan_validation_decisions_revision ON plan_validation_decisions (plan_id, revision, created_at);
`

const optText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

export function mapReport(row: Record<string, unknown>): PlanValidationReport {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    revision: Number(row.revision),
    seq: Number(row.seq),
    inputHash: String(row.input_hash),
    inputs: JSON.parse(String(row.inputs_json)) as ValidationInputs,
    findings: JSON.parse(String(row.findings_json)) as Finding[],
    relations: JSON.parse(String(row.relations_json)) as PlanRelation[],
    evidence: JSON.parse(String(row.evidence_json)) as ValidationEvidence,
    readiness: JSON.parse(String(row.readiness_json)) as Readiness,
    ready: Number(row.ready) === 1,
    requestedBy: { kind: String(row.requested_kind) === 'human' ? 'human' : 'agent', sessionId: optText(row.requested_session) },
    createdAt: String(row.created_at),
    dryRun: false,
  }
}

export function mapAssessment(row: Record<string, unknown>): AssessmentRow {
  const kind = String(row.kind) as AssessmentRow['kind']
  const payload = JSON.parse(String(row.payload_json))
  const author: AssessmentAuthor = {
    kind: String(row.author_kind) === 'human' ? 'human' : 'agent',
    sessionId: optText(row.author_session),
  }
  const base = { id: String(row.id), author, createdAt: String(row.created_at) }
  if (kind === 'alignment') return { ...base, kind, payload }
  if (kind === 'question') return { ...base, kind, payload }
  return { ...base, kind: 'finding', payload }
}

export function mapDecision(row: Record<string, unknown>): DecisionRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as DecisionKind,
    target: String(row.target),
    text: String(row.text),
    scope: optText(row.scope),
    createdAt: String(row.created_at),
  }
}

/** The compared payload a command row recorded. */
export function rowPayload(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(row.payload_json)) as Record<string, unknown>
}

/** The requester a run records. */
export function requester(kind: 'human' | 'agent', sessionId: string | null): ValidationRequester {
  return { kind, sessionId }
}
