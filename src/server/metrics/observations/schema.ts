// Process-observability foundation. Frozen migration 11; later schema edits get a new migration.
export const CREATE_PROCESS_OBSERVATIONS_SQL = `
CREATE TABLE process_observations (
seq INTEGER PRIMARY KEY AUTOINCREMENT,
source_key TEXT NOT NULL UNIQUE,
kind TEXT NOT NULL,
observed_at TEXT NOT NULL,
recorded_at TEXT NOT NULL,
version INTEGER NOT NULL,
team_id TEXT, task_id TEXT, task_revision INTEGER, assignment_id TEXT, result_id TEXT,
session_id TEXT, turn_id TEXT, start_id TEXT, group_id TEXT, profile_id TEXT,
provider_id TEXT, model TEXT, account_revision TEXT, actor_session TEXT, tool_call_id TEXT, request_id TEXT,
data TEXT NOT NULL
);
CREATE INDEX process_observations_team_time ON process_observations(team_id, observed_at, seq);
CREATE INDEX process_observations_task ON process_observations(task_id, seq);
CREATE INDEX process_observations_turn ON process_observations(session_id, turn_id, seq);
CREATE INDEX process_observations_kind ON process_observations(kind, recorded_at);
CREATE TABLE process_observation_teams (seq INTEGER NOT NULL, team_id TEXT NOT NULL, PRIMARY KEY(seq, team_id));
CREATE INDEX process_observation_teams_team ON process_observation_teams(team_id, seq);
CREATE TABLE process_observation_keys (source_key TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE process_collection_checkpoints (source TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE process_live_observations (session_id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE process_export_totals (family TEXT NOT NULL, labels TEXT NOT NULL, bucket TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(family, labels, bucket));
CREATE TABLE process_export_aliases (dimension TEXT NOT NULL, original TEXT NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(dimension, original));
`

// Migration 13: the reconciler finds unrecorded usage and limit rows by a
// NOT EXISTS scan ordered by their time; these indexes let SQLite walk that
// order instead of sorting the whole table on every pass.
export const CREATE_OBSERVATION_SOURCE_INDEXES_SQL = `
CREATE INDEX chat_turn_usage_ended ON chat_turn_usage(ended_at);
CREATE INDEX profile_limit_events_at ON profile_limit_events(at);
`
