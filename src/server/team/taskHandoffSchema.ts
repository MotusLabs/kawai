// Migration `task-publication-handoffs` (owner-publication-handoff D1): the
// handoff record, its append-only transition events, the wakeup key (D6),
// the draft's handoff link with its server-owned lineage marker (D3's draft
// provenance), and the revision's server-written `handoff_id` association —
// the only proof that a revision fulfilled a handoff. Additive and nullable;
// nothing is backfilled, so existing tasks start with no handoffs (D12).
//
// The partial unique index on `(task_id) WHERE state IN ('open','stale')`
// keeps one pending handoff per task (U2); `(task_id, request_key)` is the
// request key's uniqueness; `(handoff_id)` on revisions keeps one fulfilling
// revision per handoff.
//
// The version is the next free one after the last entry of the master this
// branch is based on (the registry must stay dense) and is renumbered at a
// later master merge.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

export const TASK_HANDOFF_MIGRATION_VERSION = 29

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS team_task_handoffs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_contract_hash TEXT,
  direction TEXT,
  acceptance TEXT,
  contract_text TEXT,
  rationale TEXT NOT NULL,
  notify INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  base_commit TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  requester_session TEXT NOT NULL,
  requester_group TEXT,
  request_key TEXT NOT NULL,
  state TEXT NOT NULL,
  state_reason TEXT,
  state_actor_kind TEXT,
  state_actor_session TEXT,
  published_revision INTEGER,
  published_payload_hash TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS team_task_handoffs_request_key ON team_task_handoffs (task_id, request_key);
CREATE UNIQUE INDEX IF NOT EXISTS team_task_handoffs_pending ON team_task_handoffs (task_id) WHERE state IN ('open', 'stale');
CREATE INDEX IF NOT EXISTS team_task_handoffs_team ON team_task_handoffs (team_id, state);
CREATE TABLE IF NOT EXISTS team_task_handoff_events (
  handoff_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_session TEXT,
  reason TEXT,
  revision INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (handoff_id, seq)
);
CREATE TABLE IF NOT EXISTS team_task_handoff_wakeups (
  handoff_id TEXT NOT NULL,
  transition TEXT NOT NULL,
  message_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (handoff_id, transition)
);
`

function columnsOf(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))
}

/** Create the handoff tables and add the draft and revision columns. */
export function applyTaskHandoffSchema(db: Database): void {
  db.exec(CREATE_TABLES_SQL)
  const drafts = columnsOf(db, 'team_task_drafts')
  if (!drafts.has('handoff_id')) db.exec('ALTER TABLE team_task_drafts ADD COLUMN handoff_id TEXT')
  if (!drafts.has('lineage_id')) db.exec('ALTER TABLE team_task_drafts ADD COLUMN lineage_id TEXT')
  if (!columnsOf(db, 'team_task_revisions').has('handoff_id')) db.exec('ALTER TABLE team_task_revisions ADD COLUMN handoff_id TEXT')
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS team_task_revisions_handoff
    ON team_task_revisions (handoff_id) WHERE handoff_id IS NOT NULL`)
}

export const taskHandoffMigration: Migration = {
  version: TASK_HANDOFF_MIGRATION_VERSION,
  name: 'task-publication-handoffs',
  up: applyTaskHandoffSchema,
}
