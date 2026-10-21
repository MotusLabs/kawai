// The SQLITE_BUSY crash mechanism (#269 CI) against real rollback-journal
// connections: a deferred transaction that has already read holds SHARED, and
// its first write gets SQLITE_BUSY at once — SQLite skips the busy handler on
// that upgrade path, so the pragma's budget goes unused. A transaction begun
// IMMEDIATE takes RESERVED at BEGIN, where the handler applies, so it waits
// out the holder and succeeds once it commits. The store tests run
// MailboxStore's real crash path (settling a claimed message) under the same
// holder; single thread means the holder commits between attempts, and the
// elapsed time proves which mode each attempt used.
import { describe, expect, test } from 'bun:test'
import { Database, type Database as Db } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'

/** A connection holding RESERVED through BEGIN IMMEDIATE, like the server's writer. */
function reservedHolder(dir: string, name = 'db.sqlite'): Db {
  const holder = new Database(join(dir, name))
  holder.exec('PRAGMA journal_mode = delete')
  holder.exec('CREATE TABLE t (v TEXT)')
  holder.exec('BEGIN IMMEDIATE')
  holder.prepare("INSERT INTO t VALUES ('held')").run()
  return holder
}

/** Error message of a read-then-write upgrade against the holder, and how long it took. */
function elapsedUpgrade(db: Db, immediate: boolean): { error: unknown; ms: number } {
  const start = performance.now()
  try {
    const run = db.transaction(() => {
      db.query('SELECT COUNT(*) AS n FROM t').get() // SHARED taken first
      db.prepare("INSERT INTO t VALUES ('x')").run() // needs RESERVED → BUSY
    })
    if (immediate) run.immediate()
    else run()
    return { error: null, ms: performance.now() - start }
  } catch (error) {
    return { error, ms: performance.now() - start }
  }
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'mailbox-store-busy-'))
}

describe('the deferred read→write upgrade', () => {
  test('gets SQLITE_BUSY at once, far below busy_timeout', () => {
    const dir = freshDir()
    const holder = reservedHolder(dir)
    const seeder = new Database(join(dir, 'db.sqlite'))
    try {
      seeder.exec('PRAGMA busy_timeout = 5000')
      const { error, ms } = elapsedUpgrade(seeder, false)
      expect((error as Error).message).toContain('database is locked')
      // The pragma's budget is 5000 ms; the upgrade path never waits it out.
      expect(ms).toBeLessThan(2000)
    } finally {
      holder.close()
      seeder.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the same work begun IMMEDIATE', () => {
  test('waits out the busy budget under the holder, then succeeds once it commits', () => {
    const dir = freshDir()
    const holder = reservedHolder(dir)
    const seeder = new Database(join(dir, 'db.sqlite'))
    try {
      // A short budget keeps the proof fast: the handler applies here, so the
      // failure takes the budget instead of coming back at once.
      seeder.exec('PRAGMA busy_timeout = 300')
      const held = elapsedUpgrade(seeder, true)
      expect((held.error as Error).message).toContain('database is locked')
      expect(held.ms).toBeGreaterThanOrEqual(200)

      holder.exec('COMMIT')
      seeder.prepare("INSERT INTO t VALUES ('x')").run()
      expect(seeder.query('SELECT v FROM t').all()).toEqual([{ v: 'held' }, { v: 'x' }])
    } finally {
      holder.close()
      seeder.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MailboxStore under a RESERVED holder', () => {
  /** The #269 crash path: a claimed, pushed message waiting for its turn-end settle. */
  function claimedMail(store: MailboxStore): string {
    const mail = store.enqueue({
      teamId: 't', toKind: 'session', toId: 's1', fromSession: 's1',
      fromGroup: null, originPath: '/tmp/proj', body: 'work',
    })
    expect(store.claim(mail.id, 's1')).toBe(true)
    expect(store.markPushed(mail.id)).toBe(true)
    return mail.id
  }

  test('settling the claimed message waits out the holder and succeeds once it commits', () => {
    const dir = freshDir()
    // The full migrated schema, like the server's own connection.
    const db = initDatabase({ path: join(dir, 'db.sqlite') }).db
    // A short budget keeps the proof fast: the busy handler must spend it.
    db.exec('PRAGMA busy_timeout = 300')
    const store = new MailboxStore(db)
    // The claimed, pushed mail exists first — enqueueing is itself a write,
    // so it must not race the holder — then the holder takes RESERVED over
    // the live mailbox, like the server's own writer at a turn end.
    const id = claimedMail(store)
    const holder = reservedHolder(dir)
    try {
      // The fix's property: the settle attempt does not fail at once (the
      // deferred upgrade would); it spends the busy budget first. Reverted
      // (deferred `logged`), this assertion fails in under a millisecond.
      const start = performance.now()
      expect(() => store.markDelivered(id)).toThrow(/database is locked/)
      expect(performance.now() - start).toBeGreaterThanOrEqual(200)
      expect(store.get(id)?.state).toBe('claimed')

      // The holder commits; the retry (the guard's, in production) settles.
      holder.exec('COMMIT')
      expect(store.markDelivered(id)).toBe(true)
      expect(store.get(id)?.state).toBe('delivered')
      expect(store.eventsFor(id).map(event => event.kind)).toEqual(['sent', 'claimed', 'pushed', 'delivered'])
    } finally {
      holder.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('claimWhen waits out the holder and claims once it commits', () => {
    const dir = freshDir()
    const db = initDatabase({ path: join(dir, 'db.sqlite') }).db
    db.exec('PRAGMA busy_timeout = 300')
    const store = new MailboxStore(db)
    const mail = store.enqueue({
      teamId: 't', toKind: 'session', toId: 's1', fromSession: 's1',
      fromGroup: null, originPath: '/tmp/proj', body: 'work',
    })
    const holder = reservedHolder(dir)
    try {
      // Eligibility reads on the store connection, like the dispatcher's
      // availability check: a deferred transaction takes SHARED at that read
      // and its claim write gets BUSY at once, while IMMEDIATE spends the
      // budget at BEGIN (the :215 mutant dies on the elapsed assertion).
      const eligible = () => {
        void store.get(mail.id)
        return true
      }
      const start = performance.now()
      expect(() => store.claimWhen(mail.id, 's1', eligible)).toThrow(/database is locked/)
      expect(performance.now() - start).toBeGreaterThanOrEqual(200)
      expect(store.get(mail.id)?.state).toBe('queued')

      holder.exec('COMMIT')
      expect(store.claimWhen(mail.id, 's1', eligible)).toBe(true)
      expect(store.get(mail.id)?.state).toBe('claimed')
      expect(store.get(mail.id)?.claimedBy).toBe('s1')
    } finally {
      holder.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('cancelling a queued message waits out the holder and succeeds once it commits', () => {
    const dir = freshDir()
    const db = initDatabase({ path: join(dir, 'db.sqlite') }).db
    db.exec('PRAGMA busy_timeout = 300')
    const store = new MailboxStore(db)
    const mail = store.enqueue({
      teamId: 't', toKind: 'session', toId: 's1', fromSession: 's1',
      fromGroup: null, originPath: '/tmp/proj', body: 'work',
    })
    const holder = reservedHolder(dir)
    try {
      // ParkedCancel's transaction (:65) reads the row (get, parkedFor)
      // before its transition write: a deferred transaction takes SHARED at
      // that read and the write gets BUSY at once, while IMMEDIATE spends
      // the budget at BEGIN (the :65 mutant dies on the elapsed assertion).
      const start = performance.now()
      expect(() => store.cancel(mail.id, { kind: 'human' })).toThrow(/database is locked/)
      expect(performance.now() - start).toBeGreaterThanOrEqual(200)
      expect(store.get(mail.id)?.state).toBe('queued')

      holder.exec('COMMIT')
      expect(store.cancel(mail.id, { kind: 'human' })).toBe(true)
      expect(store.get(mail.id)?.state).toBe('cancelled')
    } finally {
      holder.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
