// compact-observation-detail D6, oracle O-M1: migration 21 on a version-20
// database seeded with every observation kind, start rows, orphan resolutions,
// partial rows, totals, checkpoints, team associations, and durable and
// ephemeral ledger keys.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrateSchema, MIGRATIONS } from '../dbSafety/migrations'
import { ObservationStore } from '../metrics/observations/store'
import { isDurableObservationKey } from '../../shared/processObservations'

const at = '2026-10-18T00:00:00.000Z'

/** [source key, kind, data, deleted by the migration]. */
const SEED: [string, string, Record<string, unknown>, boolean][] = [
  ['segment:s:t:1', 'activity', { phase: 'thinking', startedAt: at, durationSeconds: 2, partial: false }, true],
  ['chat:s:e1', 'turn_started', {}, false],
  ['chat:s:e2', 'turn_attribution', {}, false],
  ['chat:s:e3', 'tool', { category: 'shell', startedAt: at, durationSeconds: null, partial: false }, true],
  ['chat:s:e4', 'tool', { category: 'shell', startedAt: at, durationSeconds: 3, outcome: 'success', partial: false }, false],
  ['chat:s:e5', 'tool', { category: 'other', startedAt: null, durationSeconds: null, outcome: 'failed', partial: true }, false],
  ['segment:s:t:2', 'tool', { category: 'file', startedAt: at, durationSeconds: 1, outcome: 'unavailable', partial: true }, false],
  ['chat:s:e6', 'request', { requestKind: 'approval', startedAt: at, durationSeconds: null }, true],
  ['chat:s:e7', 'request', { requestKind: 'approval', startedAt: at, durationSeconds: 4, outcome: 'allowed', partial: false }, false],
  ['chat:s:e8', 'request', { requestKind: 'unknown', startedAt: null, durationSeconds: null, outcome: 'allowed', partial: true }, true],
  ['segment:s:t:3', 'request', { requestKind: 'question', startedAt: at, durationSeconds: 9, outcome: 'unavailable', partial: true }, false],
  ['chat:s:e9', 'turn_ended', { outcome: 'success', durationSeconds: 10, partial: false, usageAvailable: true }, false],
  ['context:s:u1', 'context', { usedTokens: 10, thresholdTokens: 100, approximate: false, boundary: true }, false],
  ['settings:s:u2', 'settings', { effort: 'high' }, false],
  ['compaction:s:b1', 'compaction', { trigger: 'auto', outcome: 'completed' }, false],
  ['gap:u3', 'gap', { since: at, until: at, source: 'managed-turn' }, false],
  ['restart-gap:s:t', 'gap', { since: at, until: at, source: 'managed-turn' }, false],
  ['usage:s:t', 'usage', { input: 10, output: 2 }, false],
  ['source:team_tasks:t1', 'task', { revision: 1 }, false],
  ['source:team_message_events:m:1', 'mail', { transition: 'sent', actorKind: 'agent' }, false],
  ['acceptance:r1', 'acceptance', { revision: 1, first: true }, false],
]

function seeded(): Database {
  const db = new Database(':memory:')
  migrateSchema(db, ':memory:', { backups: null, migrations: MIGRATIONS.filter(migration => migration.version <= 20) })
  db.transaction(() => {
    for (const [index, [key, kind, data]] of SEED.entries()) {
      const team = index % 5 === 0 ? 'other' : 'team'
      const { lastInsertRowid } = db
        .prepare('INSERT INTO process_observations (source_key,kind,observed_at,recorded_at,version,team_id,session_id,turn_id,data) VALUES (?,?,?,?,1,?,?,?,?)')
        .run(key, kind, at, at, team, 's', 't', JSON.stringify(data))
      db.prepare('INSERT INTO process_observation_teams VALUES (?,?)').run(lastInsertRowid, team)
      db.prepare('INSERT INTO process_observation_keys VALUES (?,1)').run(key)
    }
    // A durable key whose row was already pruned, and the first-acceptance marker.
    db.exec("INSERT INTO process_observation_keys VALUES ('usage:s:pruned',1),('first-acceptance:task-1',1)")
    db.exec("INSERT INTO process_export_totals VALUES ('kawai_turns_total','{\"outcome\":\"success\"}','value',7),('kawai_tool_seconds','{}','sum',1.25)")
    db.exec("INSERT INTO process_collection_checkpoints VALUES ('cursor:team_tasks','12'),('detail-retained-since','" + at + "')")
    db.exec("INSERT INTO process_live_observations VALUES ('s','{}')")
  })()
  return db
}

const all = (db: Database, sql: string) => db.prepare(sql).all()
const tableNames = (db: Database) => (all(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") as { name: string }[]).map(row => row.name)
const indexNames = (db: Database) => (all(db, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='process_observations' AND name NOT LIKE 'sqlite_%' ORDER BY name") as { name: string }[]).map(row => row.name)

// @covers: process-observations › Existing detail is compacted once › Upgrade with ten days of detail
test('O-M1: migration 21 removes only the deleted classes and keeps totals, checkpoints and durable keys', () => {
  const db = seeded()
  const totals = all(db, 'SELECT * FROM process_export_totals ORDER BY family')
  const checkpoints = all(db, 'SELECT * FROM process_collection_checkpoints ORDER BY source')
  const live = all(db, 'SELECT * FROM process_live_observations')
  const keptKeys = SEED.filter(([, , , deleted]) => !deleted).map(([key]) => key)
  const kept = (all(db, 'SELECT * FROM process_observations ORDER BY seq') as { source_key: string }[]).filter(row => keptKeys.includes(row.source_key))
  const keys = (all(db, 'SELECT source_key FROM process_observation_keys ORDER BY source_key') as { source_key: string }[]).map(row => row.source_key)

  migrateSchema(db, ':memory:', { backups: null })

  expect(all(db, 'SELECT * FROM process_observations ORDER BY seq')).toEqual(kept)
  expect(all(db, 'SELECT * FROM process_export_totals ORDER BY family')).toEqual(totals)
  expect(all(db, 'SELECT * FROM process_collection_checkpoints ORDER BY source')).toEqual(checkpoints)
  expect(all(db, 'SELECT * FROM process_live_observations')).toEqual(live)
  expect((all(db, 'SELECT source_key FROM process_observation_keys ORDER BY source_key') as { source_key: string }[]).map(row => row.source_key))
    .toEqual(keys.filter(isDurableObservationKey))
  expect(keys.filter(isDurableObservationKey)).toEqual(['acceptance:r1', 'first-acceptance:task-1', 'source:team_message_events:m:1', 'source:team_tasks:t1', 'usage:s:pruned', 'usage:s:t'])
  expect(tableNames(db)).not.toContain('process_observation_teams')
  expect(indexNames(db)).toEqual(['process_observations_kind', 'process_observations_team', 'process_observations_turn'])
  const store = new ObservationStore(db)
  expect(store.forTeam('team', 0, 1000).map(row => row.sourceKey)).toEqual(
    (kept as { source_key: string; team_id: string }[]).filter(row => row.team_id === 'team').map(row => row.source_key),
  )
  expect(store.forTeam('other', 0, 1000).map(row => row.sourceKey)).toEqual(
    (kept as { source_key: string; team_id: string }[]).filter(row => row.team_id === 'other').map(row => row.source_key),
  )
  // A durable source stays deduplicated; a second start applies nothing.
  expect(store.record({ sourceKey: 'usage:s:pruned', kind: 'usage', observedAt: at, data: {} })).toBeNull()
  const after = all(db, 'SELECT * FROM process_observations ORDER BY seq')
  migrateSchema(db, ':memory:', { backups: null })
  expect(all(db, 'SELECT * FROM process_observations ORDER BY seq')).toEqual(after)
  db.close()
})
