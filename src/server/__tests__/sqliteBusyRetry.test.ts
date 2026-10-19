// The retry helper's contract, against two real rollback-journal connections:
// the deferred read→write upgrade the e2e seed children hit, a non-BUSY
// rethrow, and the attempt bound. The injected sleep carries the test's one
// state change (the holder commits), so nothing waits on wall-clock time.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUSY_RETRY_ATTEMPTS, BUSY_RETRY_DELAY_MS, isSqliteBusyError, retryOnSqliteBusy } from './sqliteBusyRetry'

/** A connection holding RESERVED through BEGIN IMMEDIATE, like the server's writer. */
function reservedHolder(dir: string): Database {
  const holder = new Database(join(dir, 'db.sqlite'))
  holder.exec('PRAGMA journal_mode = delete')
  holder.exec('CREATE TABLE t (v TEXT)')
  holder.exec('BEGIN IMMEDIATE')
  holder.prepare("INSERT INTO t VALUES ('held')").run()
  return holder
}

describe('retryOnSqliteBusy', () => {
  test('retries the deferred read→write and succeeds once the holder commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-busy-retry-'))
    try {
      const holder = reservedHolder(dir)
      const seeder = new Database(join(dir, 'db.sqlite'))
      // BUSY comes back at once, like the scripts' busy_timeout=5000 does on
      // this upgrade path — the bound must carry the waiting, not the pragma.
      seeder.exec('PRAGMA busy_timeout = 0')
      let attempts = 0
      const result = await retryOnSqliteBusy(() => seeder.transaction(() => {
        attempts += 1
        seeder.query('SELECT COUNT(*) AS n FROM t').get() // SHARED taken first
        seeder.prepare("INSERT INTO t VALUES ('seeded')").run() // needs RESERVED → BUSY
        return 'seeded'
      })(), {
        // No fixed sleep: the pause is what releases the holder, so the next
        // attempt opens a fresh transaction into a committed database.
        sleep: async () => { holder.exec('COMMIT') },
      })
      expect(result).toBe('seeded')
      expect(attempts).toBe(2)
      expect(seeder.query('SELECT v FROM t').all()).toEqual([{ v: 'held' }, { v: 'seeded' }])
      holder.close()
      seeder.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-BUSY error is rethrown without a retry', async () => {
    let attempts = 0
    let slept = false
    const failure = new Error('UNIQUE constraint failed: team_tasks.id')
    const outcome = await retryOnSqliteBusy(() => {
      attempts += 1
      throw failure
    }, { sleep: async () => { slept = true } }).then(() => null, error => error)
    expect(outcome).toBe(failure)
    expect(attempts).toBe(1)
    expect(slept).toBe(false)
  })

  test('the attempt bound is honored and the last BUSY is rethrown', async () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    let attempts = 0
    let sleeps = 0
    const outcome = await retryOnSqliteBusy(() => {
      attempts += 1
      throw busy
    }, { attempts: 4, sleep: async () => { sleeps += 1 } }).then(() => null, error => error)
    expect(outcome).toBe(busy)
    expect(attempts).toBe(4)
    expect(sleeps).toBe(3)
  })

  test('defaults are the documented bound', () => {
    expect(BUSY_RETRY_ATTEMPTS).toBe(20)
    expect(BUSY_RETRY_DELAY_MS).toBe(250)
  })
})

describe('isSqliteBusyError', () => {
  test('matches the shapes SQLite BUSY reaches the scripts as', () => {
    expect(isSqliteBusyError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))).toBe(true)
    expect(isSqliteBusyError(new Error('database is locked'))).toBe(true)
    expect(isSqliteBusyError(new Error('database table is locked'))).toBe(false)
    expect(isSqliteBusyError(new Error('no such table: team_tasks'))).toBe(false)
    expect(isSqliteBusyError('database is locked')).toBe(false)
    expect(isSqliteBusyError(null)).toBe(false)
  })
})
