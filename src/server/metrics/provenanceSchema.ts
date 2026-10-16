// Agent-start provenance tables (team-process-metrics D2): one `agent_starts`
// row per spawned agent process, naming what it launched with, and one
// `memory_manifests` row per distinct memory-directory state (its per-file
// hashes), shared by every start that saw it. Never pruned: starts are small
// and turns name them. The DDL is schema migration 5 `agent-starts`
// (`dbSafety/migrations.ts`) and frozen like every applied migration.
export const CREATE_AGENT_START_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS agent_starts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  team_id TEXT,
  group_id TEXT,
  profile_id TEXT,
  model TEXT,
  effort TEXT,
  cwd TEXT NOT NULL,
  group_file_hash TEXT,
  prompt_append_hash TEXT,
  memory_hash TEXT,
  memory_files INTEGER,
  instructions_hash TEXT,
  unavailable TEXT,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_starts_team ON agent_starts (team_id, started_at);
CREATE INDEX IF NOT EXISTS agent_starts_session ON agent_starts (session_id, started_at);
CREATE TABLE IF NOT EXISTS memory_manifests (
  memory_hash TEXT PRIMARY KEY,
  files TEXT NOT NULL
);
`
