// Migration 31 (process-quota-history-and-incident-advice D3/D5): quota
// history plus the incident advice stores.
//
// - `process_recommendations`: one stable recommendation per team, incident
//   kind and episode, with the routing facts frozen at the incident
//   (`snapshot_json`). `snapshot_basis` is `reconstructed` when the snapshot
//   was rebuilt at startup.
// - `process_assessments`: immutable numbered assessments. Triggers refuse
//   every UPDATE and DELETE (I3). `source_position` orders the evidence an
//   assessment saw, so a stale replay never becomes the latest.
// - `process_assessment_evidence`: the frozen evidence summaries, with the
//   observation each one came from. They outlive observation pruning (R9).
// - `process_recommendation_gaps`: evaluator failures (R4). Managed work never
//   waits on them.
import type { Migration } from '../../dbSafety/migrations'
import { QUOTA_OBSERVATIONS_SQL } from '../observations/quotaObservations'

export const RECOMMENDATIONS_SQL = `
CREATE TABLE process_recommendations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('quota','context')),
  episode_key TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  group_id TEXT,
  profile_id TEXT,
  provider_id TEXT,
  attention_id TEXT,
  cutoff TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_basis TEXT NOT NULL CHECK (snapshot_basis IN ('incident','reconstructed')),
  created_at TEXT NOT NULL,
  UNIQUE (team_id, kind, episode_key)
);
CREATE INDEX process_recommendations_team ON process_recommendations (team_id, created_at);
CREATE TABLE process_assessments (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES process_recommendations(id),
  version INTEGER NOT NULL,
  evaluator_version TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  source_position TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('new','strengthened','revised','withdrawn','resolved')),
  cutoff TEXT NOT NULL,
  advice_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (recommendation_id, version)
);
CREATE TRIGGER process_assessments_immutable BEFORE UPDATE ON process_assessments
BEGIN SELECT RAISE(ABORT, 'process assessments are immutable'); END;
CREATE TRIGGER process_assessments_kept BEFORE DELETE ON process_assessments
BEGIN SELECT RAISE(ABORT, 'process assessments are immutable'); END;
CREATE TABLE process_assessment_evidence (
  assessment_id TEXT NOT NULL REFERENCES process_assessments(id),
  ordinal INTEGER NOT NULL,
  observation_id TEXT,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (assessment_id, ordinal)
);
CREATE TRIGGER process_assessment_evidence_immutable BEFORE UPDATE ON process_assessment_evidence
BEGIN SELECT RAISE(ABORT, 'frozen evidence is immutable'); END;
CREATE TRIGGER process_assessment_evidence_kept BEFORE DELETE ON process_assessment_evidence
BEGIN SELECT RAISE(ABORT, 'frozen evidence is immutable'); END;
CREATE TABLE process_recommendation_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  episode_key TEXT NOT NULL,
  error_kind TEXT NOT NULL,
  at TEXT NOT NULL
);
`

export const processAdviceMigration: Migration = {
  version: 31,
  name: 'process-quota-history-and-advice',
  up: db => db.exec(QUOTA_OBSERVATIONS_SQL + RECOMMENDATIONS_SQL),
}
