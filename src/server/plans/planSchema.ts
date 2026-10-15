// Plan schema and row mapping (durable-plans design D1), split from the
// store so each stays under the file-size rule. The DDL creates the four plan
// tables beside the team tables; `migratePlanTaskLink` adds the nullable
// plan-change link to `team_tasks` (D9), run by TaskStore after its own DDL
// so a legacy table gains the columns before their index. Additive only:
// existing tasks stay unlinked and no plan is invented for them.
import type { Database } from 'bun:sqlite'
import type {
  Plan,
  PlanActor,
  PlanDraft,
  PlanEvent,
  PlanLifecycle,
  PlanRevision,
  PlanRevisionStatus,
} from '../../shared/plans'
import { PLAN_LIFECYCLES, PLAN_REVISION_STATUSES, normalizePlanContent } from '../../shared/plans'

export const CREATE_PLAN_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  current_approved_revision INTEGER,
  creator_kind TEXT NOT NULL,
  creator_session TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_team ON plans (team_id, created_at);
CREATE TABLE IF NOT EXISTS plan_revisions (
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  strategy_id TEXT,
  strategy_revision INTEGER,
  strategy_hash TEXT,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, revision)
);
-- At most one approved revision per plan is a database fact (D1): two racing
-- approvals cannot both commit even past the service's stale check.
CREATE UNIQUE INDEX IF NOT EXISTS plan_revisions_one_approved ON plan_revisions (plan_id) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS plan_revisions_strategy ON plan_revisions (strategy_id);
CREATE TABLE IF NOT EXISTS plan_drafts (
  plan_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  base_revision INTEGER,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, draft_id)
);
-- Append-only (contract C6). Human commands carry their command id and
-- compared payload (D7); the unique key makes a replay a database fact.
CREATE TABLE IF NOT EXISTS plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER,
  content_hash TEXT,
  actor_kind TEXT NOT NULL,
  actor_session TEXT,
  reason TEXT,
  command_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, command_id)
);
CREATE INDEX IF NOT EXISTS plan_events_plan ON plan_events (plan_id, created_at);
`

/**
 * The plan-change link on tasks (D9): two nullable columns through the same
 * add-if-missing path `request_key` took, with the index created after the
 * ALTER (a legacy table gains the column only there).
 */
export function migratePlanTaskLink(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(team_tasks)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'plan_id')) db.exec('ALTER TABLE team_tasks ADD COLUMN plan_id TEXT')
  if (!columns.some(column => column.name === 'plan_change')) db.exec('ALTER TABLE team_tasks ADD COLUMN plan_change TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS team_tasks_plan ON team_tasks (plan_id)')
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
const int = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

export function planActor(kind: unknown, session: unknown): PlanActor {
  return kind === 'agent' && typeof session === 'string' ? { kind: 'agent', sessionId: session } : { kind: 'human', sessionId: null }
}

export function mapPlan(row: Record<string, unknown>): Plan {
  const lifecycle = String(row.lifecycle) as PlanLifecycle
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    title: String(row.title),
    lifecycle: PLAN_LIFECYCLES.includes(lifecycle) ? lifecycle : 'open',
    currentApprovedRevision: int(row.current_approved_revision),
    creator: planActor(row.creator_kind, row.creator_session),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export function mapPlanRevision(row: Record<string, unknown>): PlanRevision {
  const status = String(row.status) as PlanRevisionStatus
  const strategyId = text(row.strategy_id)
  return {
    revision: Number(row.revision),
    status: PLAN_REVISION_STATUSES.includes(status) ? status : 'in_review',
    content: normalizePlanContent(JSON.parse(String(row.content_json))),
    contentHash: String(row.content_hash),
    pin: strategyId ? { strategyId, revision: Number(row.strategy_revision), hash: String(row.strategy_hash) } : null,
    author: planActor(row.author_kind, row.author_session),
    createdAt: String(row.created_at),
  }
}

export function mapPlanDraft(row: Record<string, unknown>): PlanDraft {
  return {
    draftId: String(row.draft_id),
    baseRevision: int(row.base_revision),
    author: planActor(row.author_kind, row.author_session),
    content: normalizePlanContent(JSON.parse(String(row.content_json))),
    contentHash: String(row.content_hash),
    updatedAt: String(row.updated_at),
  }
}

export function mapPlanEvent(row: Record<string, unknown>): PlanEvent {
  const payload = row.payload_json ? JSON.parse(String(row.payload_json)) as Record<string, unknown> : {}
  return {
    id: String(row.id),
    kind: String(row.kind),
    revision: int(row.revision),
    contentHash: text(row.content_hash),
    actor: row.actor_kind === 'system' ? { kind: 'system', sessionId: null } : planActor(row.actor_kind, row.actor_session),
    reason: text(row.reason),
    commandId: text(row.command_id),
    draftId: typeof payload.draftId === 'string' ? payload.draftId : null,
    createdAt: String(row.created_at),
  }
}
