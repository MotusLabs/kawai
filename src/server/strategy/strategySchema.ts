// Strategy schema and row mapping (product-strategy design D1), split from
// the store so each stays under the file-size rule. The DDL creates the
// strategy tables beside the team tables; the mappers turn their rows into
// the shared records. Pure: no policy, no writes.
import type { Database } from 'bun:sqlite'
import type {
  ProductStrategy,
  StrategyActor,
  StrategyClaimKind,
  StrategyDecision,
  StrategyDraft,
  StrategyEvidence,
  StrategyImpactReview,
  StrategyRevision,
  StrategyRevisionStatus,
} from '../../shared/productStrategy'
import { STRATEGY_CLAIM_KINDS, STRATEGY_REVISION_STATUSES, normalizeStrategyContent } from '../../shared/productStrategy'

export const CREATE_STRATEGY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS product_strategies (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_session TEXT,
  lifecycle TEXT NOT NULL,
  current_approved_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS product_strategies_product ON product_strategies (product_id);
CREATE TABLE IF NOT EXISTS strategy_revisions (
  strategy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  impact_proposal TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, revision)
);
CREATE TABLE IF NOT EXISTS strategy_drafts (
  strategy_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  base_revision INTEGER,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  impact_proposal TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, draft_id)
);
CREATE TABLE IF NOT EXISTS strategy_evidence (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  claim_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_ref TEXT,
  observed_at TEXT,
  limitations TEXT,
  access_scope TEXT
);
CREATE INDEX IF NOT EXISTS strategy_evidence_revision ON strategy_evidence (strategy_id, revision);
-- Idempotency is a database fact (design D1/D4): a retried approve or
-- withdraw cannot insert a second decision, and S14's "impact-review item
-- once" is the same constraint one table over.
CREATE TABLE IF NOT EXISTS strategy_decisions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  revision INTEGER,
  content_hash TEXT,
  decision TEXT NOT NULL,
  rationale TEXT,
  actor_kind TEXT NOT NULL,
  actor_session TEXT,
  approval_scope TEXT,
  open_questions TEXT,
  command_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (strategy_id, command_id)
);
CREATE TABLE IF NOT EXISTS strategy_impact_reviews (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  command_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (strategy_id, command_id)
);
CREATE TABLE IF NOT EXISTS strategy_repo_bindings (
  strategy_id TEXT NOT NULL,
  root TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, root)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_repo_bindings_root ON strategy_repo_bindings (root);
`

export function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

export function actor(kind: unknown, session: unknown): StrategyActor {
  return kind === 'agent' && typeof session === 'string' ? { kind: 'agent', sessionId: session } : { kind: 'human', sessionId: null }
}

function revisionStatus(value: unknown): StrategyRevisionStatus {
  const status = String(value) as StrategyRevisionStatus
  return STRATEGY_REVISION_STATUSES.includes(status) ? status : 'in_review'
}

function claimKind(value: unknown): StrategyClaimKind {
  const kind = String(value) as StrategyClaimKind
  return STRATEGY_CLAIM_KINDS.includes(kind) ? kind : 'hypothesis'
}

export function mapStrategy(db: Database, row: Record<string, unknown>): ProductStrategy {
  const bindings = (db.prepare('SELECT root, kind FROM strategy_repo_bindings WHERE strategy_id = ? ORDER BY kind, root')
    .all(String(row.id)) as Record<string, unknown>[])
  return {
    id: String(row.id),
    productId: String(row.product_id),
    title: String(row.title),
    owner: actor(row.owner_kind, row.owner_session),
    lifecycle: 'active',
    currentApprovedRevision: row.current_approved_revision === null || row.current_approved_revision === undefined ? null : Number(row.current_approved_revision),
    repoBindings: bindings.map(binding => ({
      root: String(binding.root),
      kind: binding.kind === 'team' ? 'team' as const : 'worktree' as const,
    })),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export function mapRevision(row: Record<string, unknown>): StrategyRevision {
  return {
    revision: Number(row.revision),
    status: revisionStatus(row.status),
    content: normalizeStrategyContent(JSON.parse(String(row.content_json))),
    contentHash: String(row.content_hash),
    author: actor(row.author_kind, row.author_session),
    impactProposal: text(row.impact_proposal),
    createdAt: String(row.created_at),
  }
}

export function mapDraft(row: Record<string, unknown>): StrategyDraft {
  return {
    draftId: String(row.draft_id),
    baseRevision: row.base_revision === null || row.base_revision === undefined ? null : Number(row.base_revision),
    author: actor(row.author_kind, row.author_session),
    content: normalizeStrategyContent(JSON.parse(String(row.content_json))),
    contentHash: String(row.content_hash),
    impactProposal: text(row.impact_proposal),
    updatedAt: String(row.updated_at),
  }
}

export function mapDecision(row: Record<string, unknown>): StrategyDecision {
  return {
    id: String(row.id),
    revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
    contentHash: text(row.content_hash),
    decision: row.decision === 'withdraw' ? 'withdraw' as const : 'approve' as const,
    rationale: text(row.rationale),
    actor: actor(row.actor_kind, row.actor_session),
    approvalScope: text(row.approval_scope),
    openQuestions: text(row.open_questions),
    commandId: String(row.command_id),
    createdAt: String(row.created_at),
  }
}

export function mapImpactReview(row: Record<string, unknown>): StrategyImpactReview {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    contentHash: String(row.content_hash),
    commandId: String(row.command_id),
    state: 'pending' as const,
    createdAt: String(row.created_at),
  }
}

export function mapEvidence(row: Record<string, unknown>): StrategyEvidence {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    claimRef: String(row.claim_ref),
    kind: claimKind(row.kind),
    sourceRef: text(row.source_ref),
    observedAt: text(row.observed_at),
    limitations: text(row.limitations),
    accessScope: text(row.access_scope),
  }
}
