// Plan workspace schema (plan-workspace design D4, D6, D7; tasks 1.2) and the
// numbered migration `plan-workspace` in `dbSafety/migrations.ts`, frozen like
// every applied migration. Four additive tables, no backfill:
// - `plan_workspace_chats`: the repository's Architect/Lead bindings. The
//   `(team_id, role)` primary key holds one row per role and
//   `UNIQUE (team_id, session_id)` keeps the two roles distinct; `version`
//   starts at 1 and only grows — every accepted bind bumps it, and it is the
//   CAS token the bind command compares. There is no unbind and this schema
//   has no DELETE for the table.
// - `plan_document_refs`: labelled supporting references at plan or change
//   scope. The CHECK encodes D4's shape rule (local ⇒ worktree + relative
//   path and no url; external ⇒ url and neither). No other unique index: the
//   same target may be referenced under two labels; idempotency is the
//   command ledger's job.
// - `chat_workspace_turn_context`: the immutable per-message context
//   snapshot (D7), keyed by (session_id, message_uuid); `turn_id` groups
//   only. `team_id`/`plan_id` allow later per-plan reads without parsing the
//   JSON. Rows survive a session kill and are never pruned.
// - `plan_workspace_commands`: the (team_id, command_id) replay ledger for
//   the workspace's keyed human commands (bind, ref-add, ref-remove), after
//   `process_commands`. A refusal writes nothing, so a resend is evaluated
//   afresh against the state then; the ledger only replays recorded
//   outcomes. Rows are never pruned.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../../dbSafety/migrations'

/** The four tables this change owns, in schema order (inventory tests read this). */
export const PLAN_WORKSPACE_TABLES: string[] = [
  'plan_workspace_chats', 'plan_document_refs', 'chat_workspace_turn_context', 'plan_workspace_commands',
]

export const CREATE_PLAN_WORKSPACE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plan_workspace_chats (
  team_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('architect','lead')),
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (team_id, role),
  UNIQUE (team_id, session_id)
);

CREATE TABLE IF NOT EXISTS plan_document_refs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  change_name TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local','external')),
  worktree_id TEXT,
  relative_path TEXT,
  url TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (kind = 'local' AND worktree_id IS NOT NULL AND relative_path IS NOT NULL AND url IS NULL)
    OR (kind = 'external' AND url IS NOT NULL AND worktree_id IS NULL AND relative_path IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS chat_workspace_turn_context (
  session_id TEXT NOT NULL,
  message_uuid TEXT NOT NULL,
  turn_id TEXT,
  context_json TEXT NOT NULL,
  team_id TEXT,
  plan_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (session_id, message_uuid)
);

CREATE TABLE IF NOT EXISTS plan_workspace_commands (
  team_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bind','ref-add','ref-remove')),
  payload TEXT NOT NULL,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (team_id, command_id)
);
`

export function applyPlanWorkspaceSchema(db: Database): void {
  db.exec(CREATE_PLAN_WORKSPACE_TABLES_SQL)
}

export const planWorkspaceMigration: Migration = {
  version: 19,
  name: 'plan-workspace',
  up: applyPlanWorkspaceSchema,
}
