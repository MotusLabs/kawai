// Migration 9 `outbound-audit` (execution-safety-recovery D6): the three
// append-only audit tables — `outbound_calls`, `outbound_outcomes`,
// `outbound_acknowledgements`. No UPDATE or DELETE statement for them exists
// anywhere (E3); rows are never pruned. `OutboundStore`
// (`src/server/outbound/store.ts`) is the only writer of the calls and
// outcomes tables. An outcome may be written before its call row (the call
// insert is deferred, D3), so outcomes key on
// `(session_id, tool_use_id, outcome)` and the read joins.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

export const OUTBOUND_AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS outbound_calls (
  id TEXT PRIMARY KEY,                 -- 'obc-<uuid>'
  team_id TEXT NOT NULL,               -- resolved from the effective cwd at the call
  session_id TEXT NOT NULL,
  spawn_id TEXT NOT NULL,              -- the agent process that made the call (D7)
  group_id TEXT,                       -- the session's group, profile, and task when called
  profile_id TEXT,
  task_id TEXT,
  agent_id TEXT,                       -- subagent id; null on the main thread
  tool TEXT NOT NULL,                  -- Bash | Monitor | mcp__<server>__<tool>
  mcp_server TEXT,
  tool_use_id TEXT NOT NULL,
  command TEXT NOT NULL,               -- redacted (D8), at most 4096 characters
  truncated INTEGER NOT NULL DEFAULT 0,
  rule TEXT NOT NULL,                  -- E3 rule id of the strongest candidate
  verdict TEXT NOT NULL,               -- violation | allowed | unknown-destination
  destination TEXT NOT NULL,           -- e.g. 'github:origin', 'internal:<host>', 'unresolved:<why>'
  matches TEXT NOT NULL,               -- JSON: every candidate {rule, segment, verdict, destination}
  classifier_version INTEGER NOT NULL,
  cwd TEXT NOT NULL,                   -- the session's cwd at the call
  created_at TEXT NOT NULL,
  UNIQUE (session_id, tool_use_id)
);
CREATE INDEX IF NOT EXISTS outbound_calls_team_time ON outbound_calls (team_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS outbound_outcomes (
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  outcome TEXT NOT NULL,               -- completed | failed | denied | started-background
  detail TEXT,                         -- redacted error or deny reason, at most 1024 characters
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, tool_use_id, outcome)
);

CREATE TABLE IF NOT EXISTS outbound_acknowledgements (
  id TEXT PRIMARY KEY,                 -- 'oba-<uuid>'
  team_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  rule TEXT NOT NULL,                  -- the violation group (D10): rule and destination
  destination TEXT NOT NULL,
  through_created_at TEXT NOT NULL,    -- covers the group's violations up to this call
  through_call_id TEXT NOT NULL REFERENCES outbound_calls(id),
  note TEXT,                           -- optional, at most 300 characters
  acknowledged_at TEXT NOT NULL,
  UNIQUE (team_id, command_id)
);
`

/**
 * Migration 9 (D6), after migrations 2-8; numbers stay dense from the
 * baseline (D13, E5). `IF NOT EXISTS` like migration 2: the runner guarantees
 * one run per database, and `schemaDb` re-applies every migration on an
 * existing file for store-level tests.
 */
export const outboundAuditMigration: Migration = {
  version: 9,
  name: 'outbound-audit',
  up(db: Database): void {
    db.exec(OUTBOUND_AUDIT_SQL)
  },
}
