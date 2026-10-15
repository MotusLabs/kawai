// Strategy impact schema and row mapping (strategy-revision-impact design
// D1), beside the strategy tables and never touching them: the impact-review
// rows a strategy approval creates are only read. Three append-only tables
// hold what this change records — agent proposals, owner decisions, and
// assessment requests. Two facts live in the database: a command id is used
// once per strategy (decisions and requests each), and the chain index lets
// only one decision name a given predecessor for a (review, plan), so a
// forked chain — including two first decisions, whose null predecessor
// `IFNULL` maps to one key — can never commit. Pure: no policy, no writes.
import type { ImpactDecision, ImpactDisposition, ImpactProposal, ImpactRequest, ImpactRevisionPin } from '../../shared/strategyImpact'
import { IMPACT_DISPOSITIONS } from '../../shared/strategyImpact'

export const CREATE_IMPACT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS strategy_impact_proposals (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  disposition TEXT NOT NULL,
  rationale TEXT NOT NULL,
  author_session TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS strategy_impact_proposals_plan ON strategy_impact_proposals (review_id, plan_id, created_at);
CREATE TABLE IF NOT EXISTS strategy_impact_decisions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  disposition TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposal_id TEXT,
  supersedes_decision_id TEXT,
  plan_snapshot_json TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (strategy_id, command_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_impact_decisions_chain
  ON strategy_impact_decisions (review_id, plan_id, IFNULL(supersedes_decision_id, ''));
CREATE TABLE IF NOT EXISTS strategy_impact_requests (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  target_group TEXT NOT NULL,
  message_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (strategy_id, command_id)
);
`

const disposition = (value: unknown): ImpactDisposition =>
  (IMPACT_DISPOSITIONS as readonly string[]).includes(String(value)) ? String(value) as ImpactDisposition : 'reconsider'

const optText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

export function mapProposal(row: Record<string, unknown>): ImpactProposal {
  return {
    id: String(row.id),
    reviewId: String(row.review_id),
    planId: String(row.plan_id),
    disposition: disposition(row.disposition),
    rationale: String(row.rationale),
    author: { kind: 'agent', sessionId: String(row.author_session) },
    createdAt: String(row.created_at),
  }
}

export function mapDecision(row: Record<string, unknown>): ImpactDecision {
  return {
    id: String(row.id),
    reviewId: String(row.review_id),
    planId: String(row.plan_id),
    disposition: disposition(row.disposition),
    rationale: String(row.rationale),
    proposalId: optText(row.proposal_id),
    supersedesDecisionId: optText(row.supersedes_decision_id),
    planSnapshot: JSON.parse(String(row.plan_snapshot_json)) as ImpactRevisionPin[],
    actor: { kind: 'human', sessionId: null },
    commandId: String(row.command_id),
    createdAt: String(row.created_at),
  }
}

export function mapRequest(row: Record<string, unknown>): ImpactRequest {
  return {
    id: String(row.id),
    reviewId: String(row.review_id),
    targetGroup: String(row.target_group),
    messageId: String(row.message_id),
    commandId: String(row.command_id),
    createdAt: String(row.created_at),
  }
}

/** The compared payload a command row recorded. */
export function rowPayload(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(row.payload_json)) as Record<string, unknown>
}
