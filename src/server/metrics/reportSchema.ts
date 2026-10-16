// Process report tables (team-process-metrics D6): reports with their frozen
// metrics snapshot, the proposals they carry, the human's one decision per
// proposal, the append-only link history (link, replace, unlink), and the
// command rows that keep each human command's outcome apart from what it
// produced, so a replayed key returns its stored outcome even after a later
// command replaced or removed it. The DDL is schema migration 7
// `process-reports` (`dbSafety/migrations.ts`) and frozen like every applied
// migration.
export const CREATE_PROCESS_REPORT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS process_reports (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  author_session TEXT NOT NULL,
  window TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  summary TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS process_reports_team ON process_reports (team_id, created_at);
CREATE TABLE IF NOT EXISTS process_proposals (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  edit TEXT NOT NULL,
  rationale TEXT NOT NULL,
  expected TEXT NOT NULL,
  revert_to_hash TEXT
);
CREATE INDEX IF NOT EXISTS process_proposals_report ON process_proposals (report_id, position);
CREATE INDEX IF NOT EXISTS process_proposals_team ON process_proposals (team_id);
CREATE TABLE IF NOT EXISTS process_proposal_decisions (
  proposal_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  target_hash_at_decision TEXT,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS process_proposal_link_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  action TEXT NOT NULL,
  change_start_id TEXT,
  change_hash TEXT,
  change_at TEXT,
  actor_kind TEXT NOT NULL,
  actor_session TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS process_proposal_link_events_proposal ON process_proposal_link_events (proposal_id, id);
CREATE TABLE IF NOT EXISTS process_commands (
  team_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (team_id, command_id)
);
`
