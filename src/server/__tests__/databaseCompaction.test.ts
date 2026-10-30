// compact-observation-detail D7, table T4: startup compaction into
// incremental auto_vacuum through the real `initDatabase`, and the free pages
// a pruning pass releases.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { compactDatabase } from '../dbSafety/compaction'
import { migrateSchema, MIGRATIONS } from '../dbSafety/migrations'
import { logger } from '../logger'
import { ProcessObservationService } from '../metrics/observations/service'

let dir: string, dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-compaction-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const pragma = (db: Database, name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0] as number
const at = '2026-10-18T00:00:00.000Z'

/** A pre-upgrade file: `auto_vacuum = NONE`, migrated to `version`, holding `rows` activity segments. */
function legacyFile(version: number, rows: number): void {
  const db = new Database(dbPath)
  migrateSchema(db, dbPath, { backups: null, migrations: MIGRATIONS.filter(migration => migration.version <= version) })
  const insert = db.prepare("INSERT INTO process_observations (source_key,kind,observed_at,recorded_at,version,team_id,data) VALUES (?,'activity',?,?,1,'team',?)")
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`segment:s:t:${i}`, at, at, JSON.stringify({ phase: 'thinking', startedAt: at, durationSeconds: i, partial: false }))
  })()
  db.close()
}

// @covers: database-safety › Pruned space returns to the file › First start after upgrade
test('T4 C2: the first start after the upgrade converts to incremental mode and shrinks to live pages', () => {
  legacyFile(20, 5000)
  const raw = new Database(dbPath)
  const pagesBefore = pragma(raw, 'page_count')
  expect(pragma(raw, 'auto_vacuum')).toBe(0)
  raw.close()
  const info = spyOn(logger, 'info')
  try {
    const session = initDatabase({ path: dbPath })
    expect(pragma(session.db, 'auto_vacuum')).toBe(2)
    expect(pragma(session.db, 'freelist_count')).toBe(0)
    expect(pragma(session.db, 'page_count')).toBeLessThan(pagesBefore / 2)
    expect(session.db.prepare("SELECT count(*) AS n FROM process_observations WHERE kind='activity'").get()).toEqual({ n: 0 })
    session.close()
    const compacted = info.mock.calls.filter(([event]) => event === 'db_compacted')
    expect(compacted).toHaveLength(1)
    expect(compacted[0]![1]).toMatchObject({ pagesBefore: expect.any(Number), pagesAfter: expect.any(Number), durationMs: expect.any(Number) })
  } finally {
    info.mockRestore()
  }
  expect(fs.statSync(dbPath).size).toBeLessThan(pagesBefore * 4096 / 2)
})

// @covers: database-safety › Pruned space returns to the file › Already converted
test('T4 C1: a database already in incremental mode is not compacted again', () => {
  initDatabase({ path: dbPath }).close()
  const info = spyOn(logger, 'info')
  try {
    const session = initDatabase({ path: dbPath })
    expect(pragma(session.db, 'auto_vacuum')).toBe(2)
    session.close()
    expect(info.mock.calls.filter(([event]) => event === 'db_compacted')).toEqual([])
  } finally {
    info.mockRestore()
  }
})

test('a new database file starts in incremental mode without a compaction pass', () => {
  const info = spyOn(logger, 'info')
  try {
    const session = initDatabase({ path: dbPath })
    expect(pragma(session.db, 'auto_vacuum')).toBe(2)
    session.close()
    expect(info.mock.calls.filter(([event]) => event === 'db_compacted')).toEqual([])
  } finally {
    info.mockRestore()
  }
})

// @covers: database-safety › Pruned space returns to the file › Conversion fails
test('T4 C3: a failed conversion is logged, keeps contents and mode, never stops the start, and is retried', () => {
  legacyFile(21, 0)
  const raw = new Database(dbPath)
  raw.exec("INSERT INTO process_collection_checkpoints VALUES ('kept','1')")
  // A statement still in progress makes VACUUM fail, as a full disk would.
  const statement = raw.prepare('SELECT * FROM process_collection_checkpoints')
  const reading = statement.iterate()
  reading.next()
  const warn = spyOn(logger, 'warn')
  let failures: unknown[][]
  try {
    expect(() => compactDatabase(raw)).not.toThrow()
    failures = warn.mock.calls.filter(([event]) => event === 'db_compaction_failed')
  } finally {
    warn.mockRestore()
  }
  expect(failures).toHaveLength(1)
  expect(failures[0]![1]).toEqual({ error: expect.stringContaining('VACUUM') })
  // Finalize before closing: a live statement keeps the connection and its read lock open.
  statement.finalize()
  raw.close(true)
  const reopened = new Database(dbPath)
  expect(pragma(reopened, 'auto_vacuum')).toBe(0)
  expect(reopened.prepare("SELECT value FROM process_collection_checkpoints WHERE source='kept'").get()).toEqual({ value: '1' })
  reopened.close()
  // The next start retries and converts.
  const session = initDatabase({ path: dbPath })
  expect(pragma(session.db, 'auto_vacuum')).toBe(2)
  session.close()
})

// @covers: database-safety › Pruned space returns to the file › Pruning shrinks the file
test('a pruning pass releases the freed pages, so the file shrinks', () => {
  const session = initDatabase({ path: dbPath })
  const db = session.db
  let now = Date.parse(at)
  const service = new ProcessObservationService(db, () => ({}), () => now)
  db.transaction(() => {
    for (let i = 0; i < 400; i++) {
      service.store.record({ sourceKey: `chat:s:${i}`, kind: 'tool', teamId: 'team', observedAt: at, data: { category: 'shell', startedAt: at, durationSeconds: i, outcome: 'success', partial: false } })
    }
  })()
  const pagesBefore = pragma(db, 'page_count')
  now += 15 * 24 * 3600000
  service.tick()
  service.stop()
  expect(db.prepare("SELECT count(*) AS n FROM process_observations WHERE kind='tool'").get()).toEqual({ n: 0 })
  expect(pragma(db, 'freelist_count')).toBe(0)
  expect(pragma(db, 'page_count')).toBeLessThan(pagesBefore)
  session.close()
})
