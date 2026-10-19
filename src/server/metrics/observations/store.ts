// Atomic, idempotent observation storage. Durable-source keys outlive detailed retention.
import type { Database } from 'bun:sqlite';
import { OBSERVATION_RETENTION_MS, OBSERVATION_VERSION, validateObservation, type ProcessObservation, type StoredObservation } from '../../../shared/processObservations';
const COLUMNS = ['teamId', 'taskId', 'taskRevision', 'assignmentId', 'resultId', 'sessionId', 'turnId', 'startId', 'groupId', 'profileId', 'providerId', 'model', 'accountRevision', 'actorSession', 'toolCallId', 'requestId'] as const;
const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
/**
 * Keys of live chat facts: unique per event, turn or a random id, never replayed once the turn ends,
 * so they leave with their detail row. Durable-source keys (`source:`, `usage:`, `acceptance:`) stay.
 */
const EPHEMERAL_KEY = /^(chat|segment|turn-end|context|settings|compaction|gap|restart-gap):/;
export class ObservationStore {
  /** The aggregate sink runs in the same transaction; failure rolls the observation back too. */
  accumulate?: (row: StoredObservation) => void;
  constructor(readonly db: Database, readonly now: () => number = Date.now) { }
  record(input: ProcessObservation, teams: readonly string[] = []): StoredObservation | null {
    validateObservation(input);
    return this.db.transaction(() => {
      const key = this.db.prepare('INSERT OR IGNORE INTO process_observation_keys VALUES (?, ?)').run(input.sourceKey, OBSERVATION_VERSION);
      if (!key.changes)
        return null;
      const at = new Date(this.now()).toISOString();
      const columns = COLUMNS.map(snake).join(',');
      const result = this.db.prepare(`INSERT INTO process_observations (source_key,kind,observed_at,recorded_at,version,${columns},data) VALUES (${Array(COLUMNS.length + 6).fill('?').join(',')})`)
        .run(input.sourceKey, input.kind, input.observedAt, at, OBSERVATION_VERSION, ...COLUMNS.map(k => input[k] ?? null), JSON.stringify(input.data));
      const seq = Number(result.lastInsertRowid);
      for (const team of new Set([...teams, ...(input.teamId ? [input.teamId] : [])]))
        this.db.prepare('INSERT INTO process_observation_teams VALUES (?, ?)').run(seq, team);
      const row = { ...input, seq, recordedAt: at, version: OBSERVATION_VERSION };
      this.accumulate?.(row);
      return row;
    })();
  }
  forTeam(teamId: string, after = 0, limit = 500): StoredObservation[] {
    return this.db.prepare('SELECT o.* FROM process_observations o JOIN process_observation_teams t ON t.seq=o.seq WHERE t.team_id=? AND o.seq>? ORDER BY o.seq LIMIT ?')
      .all(teamId, after, Math.min(1000, Math.max(1, limit))).map(row => this.map(row as Record<string, unknown>));
  }
  checkpoint(source: string): string | null {
    return (this.db.prepare('SELECT value FROM process_collection_checkpoints WHERE source=?').get(source) as {
      value: string;
    } | null)?.value ?? null;
  }
  setCheckpoint(source: string, value: string): void {
    this.db.prepare('INSERT INTO process_collection_checkpoints VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET value=excluded.value').run(source, value);
  }
  prune(retentionMs = OBSERVATION_RETENTION_MS): number {
    return this.db.transaction(() => {
      const cutoff = new Date(this.now() - Math.max(24 * 3600000, retentionMs)).toISOString();
      const rows = this.db.prepare('SELECT seq,source_key FROM process_observations WHERE recorded_at<? LIMIT 500').all(cutoff) as {
        seq: number;
        source_key: string;
      }[];
      for (const { seq, source_key } of rows) {
        this.db.prepare('DELETE FROM process_observation_teams WHERE seq=?').run(seq);
        this.db.prepare('DELETE FROM process_observations WHERE seq=?').run(seq);
        if (EPHEMERAL_KEY.test(source_key))
          this.db.prepare('DELETE FROM process_observation_keys WHERE source_key=?').run(source_key);
      }
      this.setCheckpoint('detail-retained-since', cutoff);
      return rows.length;
    })();
  }
  private map(row: Record<string, unknown>): StoredObservation {
    const identity = Object.fromEntries(COLUMNS.map(k => [k, row[snake(k)]]));
    return { ...identity, seq: Number(row.seq), sourceKey: String(row.source_key), kind: row.kind as StoredObservation['kind'], observedAt: String(row.observed_at), recordedAt: String(row.recorded_at), version: Number(row.version), data: JSON.parse(String(row.data)) };
  }
}
