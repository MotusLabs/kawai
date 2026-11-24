import type { Migration } from '../../dbSafety/migrations'

/** The link exists before approval. A decision and its receipt are filled together. */
export const decisionPublicationMigration: Migration = {
  version: 30,
  name: 'decision-bound-task-publication',
  up: db => db.exec(`
    CREATE TABLE plan_decision_publications (
      card_id TEXT PRIMARY KEY NOT NULL,
      team_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      handoff_id TEXT NOT NULL UNIQUE,
      base_revision INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      binding_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      decision_id TEXT UNIQUE,
      receipt_json TEXT,
      receipt_hash TEXT,
      CHECK ((decision_id IS NULL) = (receipt_json IS NULL)),
      CHECK ((decision_id IS NULL) = (receipt_hash IS NULL))
    );
    CREATE INDEX plan_decision_publications_plan ON plan_decision_publications(team_id, plan_id);
  `),
}
