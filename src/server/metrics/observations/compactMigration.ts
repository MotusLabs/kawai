// Migration 21 (compact-observation-detail D5/D6): one set-based pass over
// stored detail. It deletes per-segment activity rows, tool and request start
// rows (no `outcome`), and unmatched request resolutions (`requestKind`
// unknown); drops the team association table and every non-durable ledger
// key; and swaps the unread `team_time` and `task` indexes for `(team_id,
// seq)`. Export totals and checkpoints are untouched. Space returns to the file
// at startup compaction (`dbSafety/compaction.ts`), outside this transaction.
import type { Database } from 'bun:sqlite'
import { DURABLE_KEY_PREFIXES } from '../../../shared/processObservations'
import type { Migration } from '../../dbSafety/migrations'

export const COMPACT_OBSERVATION_DETAIL_MIGRATION_VERSION = 21

const durableKey = DURABLE_KEY_PREFIXES.map(
  prefix => `substr(source_key,1,${prefix.length})='${prefix}'`,
).join(' OR ')

export function compactObservationDetail(db: Database): void {
  db.exec(`
DELETE FROM process_observations WHERE kind='activity';
DELETE FROM process_observations WHERE kind IN ('tool','request') AND json_extract(data,'$.outcome') IS NULL;
DELETE FROM process_observations WHERE kind='request' AND json_extract(data,'$.requestKind')='unknown';
DROP TABLE process_observation_teams;
DELETE FROM process_observation_keys WHERE NOT (${durableKey});
DROP INDEX process_observations_team_time;
DROP INDEX process_observations_task;
CREATE INDEX process_observations_team ON process_observations(team_id, seq);
`)
}

export const compactObservationDetailMigration: Migration = {
  version: COMPACT_OBSERVATION_DETAIL_MIGRATION_VERSION,
  name: 'compact-observation-detail',
  up: compactObservationDetail,
}
