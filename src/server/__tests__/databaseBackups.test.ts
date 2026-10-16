// Online backups (execution-safety-recovery D15): an atomic, integrity-checked
// copy that never fails a concurrent commit; corrupt copies marked and kept out
// of rotation; the hourly interval skipped while nothing changed; leftovers
// and per-reason rotation. Every file lives in a temporary directory.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { newestVersion } from '../dbSafety/migrations'
import { logger } from '../logger'
import { DatabaseBackups, integrityCheck, type DatabaseBackupsOptions } from '../dbSafety/backups'
import { RETENTION, backupFileName, formatStamp, parseBackupFile, rotationVictims, type BackupFile } from '../dbSafety/backupFiles'

let dir: string
let dbPath: string
let backupsDir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-backups-'))
  dbPath = path.join(dir, 'agentboard.db')
  backupsDir = path.join(dir, 'backups')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const names = () => fs.readdirSync(backupsDir).sort()
const insertSetting = (db: Database, key: string) => db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, 'v')

/** A clock that advances one minute per call, so every stamp differs and sorts. */
function steppingClock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
  let now = start
  return () => (now += 60_000)
}

describe('a snapshot', () => {
  test('is renamed into place, passes integrity_check on a separate connection, and holds the rows', async () => {
    const session = initDatabase({ path: dbPath })
    insertSetting(session.db, 'before')
    const backups = new DatabaseBackups({ db: session.db, dbPath })
    const outcome = await backups.snapshot('interval')
    session.close()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(path.dirname(outcome.path)).toBe(backupsDir)
    expect(path.basename(outcome.path)).toMatch(/^agentboard-\d{8}T\d{9}Z-interval\.db$/)
    expect(names().some(name => name.endsWith('.partial'))).toBe(false)
    expect(integrityCheck(outcome.path)).toBeNull()
    const copy = new Database(outcome.path, { readonly: true })
    expect(copy.prepare("SELECT value FROM app_settings WHERE key = 'before'").get()).toEqual({ value: 'v' })
    copy.close()
  })

  test('taken while another process writes under its busy timeout loses no commit', async () => {
    initDatabase({ path: dbPath }).close()
    const writes = 100
    const writer = Bun.spawn(['bun', '-e', `
      const { Database } = require('bun:sqlite')
      const db = new Database(process.argv[1])
      db.exec('PRAGMA busy_timeout = 5000')
      const insert = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      for (let i = 0; i < ${writes}; i++) insert.run('k' + i, 'v')
      db.close()
    `, dbPath], { stdout: 'pipe', stderr: 'pipe' })
    const session = initDatabase({ path: dbPath })
    const backups = new DatabaseBackups({ db: session.db, dbPath, now: steppingClock() })
    const outcomes = []
    while (writer.exitCode === null && outcomes.length < 200) {
      outcomes.push(await backups.snapshot('interval'))
    }
    const exit = await writer.exited
    const stderr = await new Response(writer.stderr).text()
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    expect(outcomes.length).toBeGreaterThan(0)
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
    const count = (session.db.prepare("SELECT count(*) AS n FROM app_settings WHERE key LIKE 'k%'").get() as { n: number }).n
    session.close()
    expect(count).toBe(writes)
  }, 60_000)

  test('a torn copy is renamed corrupt, logged in the status, and kept out of rotation', async () => {
    const session = initDatabase({ path: dbPath })
    const good = new DatabaseBackups({ db: session.db, dbPath, now: steppingClock() })
    const first = await good.snapshot('interval')
    const torn = new DatabaseBackups({
      db: session.db, dbPath, now: steppingClock(Date.parse('2026-02-01T00:00:00.000Z')),
      serialize: () => session.db.serialize().slice(0, 1500),
    })
    const outcome = await torn.snapshot('interval')
    session.close()
    expect(outcome.ok).toBe(false)
    if (outcome.ok || !first.ok) throw new Error('unexpected outcomes')
    expect(outcome.path).toMatch(/-interval\.db\.corrupt$/)
    expect(outcome.error).toMatch(/integrity check failed/)
    expect(fs.existsSync(outcome.path!)).toBe(true)
    expect(fs.existsSync(first.path)).toBe(true)
    const status = torn.status()
    expect(status.failures).toEqual([expect.objectContaining({ reason: 'interval', path: outcome.path })])
    // The newest good interval backup is still the earlier one.
    expect(status.newest.find(entry => entry.reason === 'interval')?.name).toBe(path.basename(first.path))
  })

  describe('a torn copy that cannot be renamed corrupt', () => {
    const renameFails = () => { throw new Error('EACCES: rename refused') }
    const intervals = () => names().filter(name => name.includes('-interval.db'))
    const tornAfterGood = async (fileOps: DatabaseBackupsOptions['fileOps']) => {
      const session = initDatabase({ path: dbPath })
      const first = await new DatabaseBackups({ db: session.db, dbPath, now: steppingClock() }).snapshot('interval')
      const torn = new DatabaseBackups({
        db: session.db, dbPath, now: steppingClock(Date.parse('2026-02-01T00:00:00.000Z')), fileOps,
        serialize: () => session.db.serialize().slice(0, 1500),
      })
      const outcome = torn.snapshotSync('interval')
      session.close()
      if (!first.ok || outcome.ok) throw new Error('unexpected outcomes')
      return { first: path.basename(first.path), outcome, torn }
    }

    test('is removed, so only the earlier good copy remains', async () => {
      const { first, outcome, torn } = await tornAfterGood({ renameSync: renameFails, unlinkSync: fs.unlinkSync })
      expect(outcome.path).toBeNull()
      expect(outcome.error).toMatch(/integrity check failed: .*renaming it \.corrupt failed \(EACCES: rename refused\), so it was removed/)
      expect(intervals()).toEqual([first])
      expect(torn.newestGood('interval')?.name).toBe(first)
      expect(torn.status().newest.filter(entry => entry.reason === 'interval').map(entry => entry.name)).toEqual([first])
    })

    test('and cannot be removed is kept out of files(), newestGood, and the status', async () => {
      const { first, outcome, torn } = await tornAfterGood({
        renameSync: renameFails, unlinkSync: () => { throw new Error('EPERM: unlink refused') },
      })
      const tornName = path.basename(outcome.path!)
      expect(tornName).toMatch(/-interval\.db$/)
      expect(outcome.error).toMatch(/removing it failed \(EPERM: unlink refused\), so it is kept out of the good backups/)
      expect(intervals()).toEqual([first, tornName])
      expect(torn.files().find(file => file.name === tornName)?.kind).toBe('corrupt')
      expect(torn.newestGood('interval')?.name).toBe(first)
      expect(torn.status().newest.filter(entry => entry.reason === 'interval').map(entry => entry.name)).toEqual([first])
      // A later process does not remember it, and still never names it as good.
      initDatabase({ path: dbPath }).close()
      const db = new Database(dbPath)
      expect(new DatabaseBackups({ db, dbPath }).newestGood('interval')?.name).toBe(first)
      db.close()
    })
  })

  test('a spurious "Out of memory" copy is retried and logged, failing only after three attempts', () => {
    const session = initDatabase({ path: dbPath })
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    let calls = 0
    const flaky = (failures: number, message = 'Out of memory') => () => {
      calls++
      if (calls <= failures) throw new Error(message)
      return session.db.serialize()
    }
    try {
      expect(new DatabaseBackups({ db: session.db, dbPath, serialize: flaky(2) }).snapshotSync('interval')).toMatchObject({ ok: true })
      expect(calls).toBe(3)
      const retries = () => warn.mock.calls.filter(([event]) => event === 'db_backup_serialize_retry')
      expect(retries().map(([, fields]) => fields)).toEqual([
        { attempt: 1, error: 'Out of memory' },
        { attempt: 2, error: 'Out of memory' },
      ])
      calls = 0
      expect(new DatabaseBackups({ db: session.db, dbPath, serialize: flaky(3) }).snapshotSync('interval'))
        .toMatchObject({ ok: false, error: 'Out of memory' })
      expect(calls).toBe(3)

      // Any other error fails on the first try, with no retry logged.
      calls = 0
      warn.mockClear()
      expect(new DatabaseBackups({ db: session.db, dbPath, serialize: flaky(1, 'disk I/O error') }).snapshotSync('interval'))
        .toMatchObject({ ok: false, error: 'disk I/O error' })
      expect(calls).toBe(1)
      expect(retries()).toEqual([])
    } finally {
      warn.mockRestore()
      session.close()
    }
  })

  test('creates backups/ owner-only and tightens an existing one to 0700', () => {
    const session = initDatabase({ path: dbPath })
    try {
      expect(new DatabaseBackups({ db: session.db, dbPath }).snapshotSync('interval')).toMatchObject({ ok: true })
      expect(fs.statSync(backupsDir).mode & 0o777).toBe(0o700)
      fs.chmodSync(backupsDir, 0o755)
      expect(new DatabaseBackups({ db: session.db, dbPath }).snapshotSync('interval')).toMatchObject({ ok: true })
      expect(fs.statSync(backupsDir).mode & 0o777).toBe(0o700)
    } finally {
      session.close()
    }
  })

  test('a chmod refusal is logged and skipped, not failed', () => {
    const session = initDatabase({ path: dbPath })
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const backups = new DatabaseBackups({
        db: session.db, dbPath,
        chmod: () => { throw new Error('operation not permitted') },
      })
      const outcome = backups.snapshotSync('interval')
      expect(outcome).toMatchObject({ ok: true })
      expect(path.dirname(outcome.ok ? outcome.path : '')).toBe(backupsDir)
      expect(warn.mock.calls.filter(([event]) => event === 'db_backup_chmod_skipped')).toHaveLength(1)
    } finally {
      warn.mockRestore()
      session.close()
    }
  })

  test('refuses inside a transaction instead of copying mid-write', async () => {
    const session = initDatabase({ path: dbPath })
    const backups = new DatabaseBackups({ db: session.db, dbPath })
    let outcome
    session.db.exec('BEGIN')
    try { outcome = backups.snapshotSync('interval') } finally { session.db.exec('ROLLBACK') }
    session.close()
    expect(outcome).toMatchObject({ ok: false, error: 'a transaction is open on the connection' })
  })
})

describe('the interval schedule', () => {
  test('an idle hour takes nothing, including the first hour after a restart', async () => {
    initDatabase({ path: dbPath }).close()
    // A restart: initDatabase takes the startup snapshot, which stores the first total_changes().
    const session = initDatabase({ path: dbPath })
    const backups = session.backups!
    const before = names()
    expect(await backups.tick()).toBeNull()
    expect(names()).toEqual(before)
    insertSetting(session.db, 'changed')
    const taken = await backups.tick()
    expect(taken).toMatchObject({ ok: true, reason: 'interval' })
    expect(await backups.tick()).toBeNull()
    session.close()
  })

  test('each snapshot stores its total_changes(), and the skip compares against the last snapshot', async () => {
    const session = initDatabase({ path: dbPath })
    const backups = new DatabaseBackups({ db: session.db, dbPath, now: steppingClock() })
    const total = () => (session.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const first = await backups.snapshot('interval')
    expect(first).toMatchObject({ ok: true, changes: total() })
    insertSetting(session.db, 'a')
    const second = await backups.tick()
    expect(second).toMatchObject({ ok: true, changes: total() })
    expect(await backups.tick()).toBeNull()
    session.close()
  })
})

describe('rotation', () => {
  const file = (minute: number, reason: BackupFile['reason'], kind: BackupFile['kind'] = 'good'): BackupFile => {
    const stamp = formatStamp(Date.parse('2026-01-01T00:00:00.000Z') + minute * 60_000)
    const base = backupFileName('agentboard', stamp, reason)
    return { name: kind === 'good' ? base : `${base}.${kind}`, stamp, reason, kind }
  }

  test('keeps 24 interval, 7 startup, and every backup of the newest 3 migrations', () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => file(i, 'interval')),
      ...Array.from({ length: 10 }, (_, i) => file(100 + i, 'startup')),
      ...[2, 3, 4, 5].flatMap(n => [file(200 + n, `pre-migration-${n}`), file(210 + n, `pre-migration-${n}`)]),
    ]
    const victims = new Set(rotationVictims(files))
    const kept = (reason: string) => files.filter(entry => entry.reason === reason && !victims.has(entry.name)).map(entry => entry.name)
    expect(kept('interval')).toEqual(files.filter(entry => entry.reason === 'interval').slice(6).map(entry => entry.name))
    expect(kept('startup')).toHaveLength(RETENTION.startup)
    expect(kept('pre-migration-2')).toEqual([])
    for (const n of [3, 4, 5]) expect(kept(`pre-migration-${n}`)).toHaveLength(2)
  })

  test('keeps the newest 3 partial and 3 corrupt files, never counting or deleting the partial being written', () => {
    const partials = Array.from({ length: 5 }, (_, i) => file(i, 'interval', 'partial'))
    const corrupts = Array.from({ length: 5 }, (_, i) => file(i, 'startup', 'corrupt'))
    const writing = file(99, 'interval', 'partial')
    const victims = rotationVictims([...partials, ...corrupts, writing], writing.name)
    expect(victims.sort()).toEqual([partials[0]!.name, partials[1]!.name, corrupts[0]!.name, corrupts[1]!.name].sort())
  })

  test('at startup five leftover partial and five corrupt files shrink to the newest three of each', () => {
    initDatabase({ path: dbPath }).close()
    for (let i = 0; i < 5; i++) {
      const stamp = formatStamp(Date.parse('2020-01-01T00:00:00.000Z') + i * 1000)
      fs.writeFileSync(path.join(backupsDir, `${backupFileName('agentboard', stamp, 'interval')}.partial`), 'x')
      fs.writeFileSync(path.join(backupsDir, `${backupFileName('agentboard', stamp, 'startup')}.corrupt`), 'x')
    }
    fs.writeFileSync(path.join(backupsDir, 'notes.txt'), 'owner file')
    initDatabase({ path: dbPath }).close()
    expect(names().filter(name => name.endsWith('.partial'))).toHaveLength(3)
    expect(names().filter(name => name.endsWith('.corrupt'))).toHaveLength(3)
    expect(names().filter(name => name.endsWith('.partial'))[0]).toContain(formatStamp(Date.parse('2020-01-01T00:00:02.000Z')))
    expect(names()).toContain('notes.txt')
  })

  test('a 25th interval backup deletes the oldest interval and leaves startup and pre-migration backups', async () => {
    const session = initDatabase({ path: dbPath })
    const backups = new DatabaseBackups({ db: session.db, dbPath, now: steppingClock() })
    // The newest migration's: rotation keeps only the newest three migrations' backups.
    const premigration = backups.snapshotSync(`pre-migration-${newestVersion()}`)
    const intervals = []
    for (let i = 0; i < 25; i++) intervals.push(await backups.snapshot('interval'))
    session.close()
    const files = backups.files()
    expect(files.filter(entry => entry.reason === 'interval')).toHaveLength(24)
    expect(fs.existsSync((intervals[0] as { path: string }).path)).toBe(false)
    expect(fs.existsSync((intervals[1] as { path: string }).path)).toBe(true)
    expect(files.filter(entry => entry.reason === 'startup')).toHaveLength(1)
    expect(fs.existsSync((premigration as { path: string }).path)).toBe(true)
  })

  test('names this module did not write are never parsed', () => {
    expect(parseBackupFile('agentboard', 'agentboard.db')).toBeNull()
    expect(parseBackupFile('agentboard', 'agentboard-20260101T000000000Z-manual.db')).toBeNull()
    expect(parseBackupFile('agentboard', 'other-20260101T000000000Z-startup.db')).toBeNull()
    expect(parseBackupFile('agentboard', 'agentboard-20260101T000000000Z-pre-migration-12.db.corrupt'))
      .toEqual({ name: 'agentboard-20260101T000000000Z-pre-migration-12.db.corrupt', stamp: '20260101T000000000Z', reason: 'pre-migration-12', kind: 'corrupt' })
  })
})

test('an in-memory database has no backups', () => {
  const session = initDatabase({ path: ':memory:' })
  expect(session.backups).toBeNull()
  session.close()
})
