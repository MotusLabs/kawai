// Schema migration 11 `provider-limit-window` (providers-and-workers D7): a
// version-10 database keeps its events with NULL in both new columns, a fresh
// database has them, and the store records both beside the profile.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { LimitEventStore } from '../team/routing/limitEvents'
import { schemaDb } from './schemaDb'

const THROUGH_10 = MIGRATIONS.filter(migration => migration.version <= 10)

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-provider-limit-window-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** A version-10 database as the build before this change leaves it: one final event, no provider or window. */
function versionNineWithRow(): Database {
  const session = initDatabase({ path: dbPath, migrations: THROUGH_10 })
  session.db.prepare(`INSERT INTO profile_limit_events
    (id, profile_id, session_id, group_id, at, kind, final, status, message, resets_at)
    VALUES ('event-1', 'glm', 'session-1', 'devs', '2026-10-18T00:00:00.000Z', 'rate_limit', 1, 429, 'quota', '2026-10-18T03:00:00.000Z')`).run()
  expect(session.db.prepare("SELECT name FROM pragma_table_info('profile_limit_events') WHERE name = 'provider_id'").get()).toBeNull()
  return session.db
}

test('this build registers migration 11 provider-limit-window after context-exhausted', () => {
  expect(MIGRATIONS.map(migration => [migration.version, migration.name]).slice(-2))
    .toEqual([[10, 'context-exhausted'], [11, 'provider-limit-window']])
})

test('a version-10 database keeps its events with NULL provider and window', () => {
  versionNineWithRow().close()
  const session = initDatabase({ path: dbPath })
  const row = session.db.prepare('SELECT * FROM profile_limit_events WHERE id = \'event-1\'').get() as Record<string, unknown>
  expect(row.profile_id).toBe('glm')
  expect(row.final).toBe(1)
  expect(row.provider_id).toBeNull()
  expect(row.limit_window).toBeNull()
  // The store reads the old row as provider-less: its profile alone cools.
  const limits = new LimitEventStore(session.db, () => Date.parse('2026-10-18T01:00:00.000Z'))
  expect(limits.forProfile('glm')).toEqual([{
    id: 'event-1', profileId: 'glm', sessionId: 'session-1', groupId: 'devs', at: '2026-10-18T00:00:00.000Z',
    kind: 'rate_limit', final: true, status: 429, message: 'quota', resetsAt: '2026-10-18T03:00:00.000Z',
    providerId: null, window: null,
  }])
  session.close()
})

test('a fresh database records provider and window beside the profile', () => {
  const db = schemaDb()
  const limits = new LimitEventStore(db, () => Date.parse('2026-10-18T01:00:00.000Z'))
  limits.record({
    profileId: 'opus', sessionId: 'session-2', groupId: null, kind: 'rate_limit', final: true,
    status: 429, message: null, resetsAt: '2026-10-21T00:00:00.000Z', providerId: 'claude', window: 'seven_day_opus',
  })
  const row = db.prepare('SELECT provider_id, limit_window FROM profile_limit_events').get() as Record<string, unknown>
  expect(row).toEqual({ provider_id: 'claude', limit_window: 'seven_day_opus' })
  db.close()
})
