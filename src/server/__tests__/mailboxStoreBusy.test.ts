// The SQLITE_BUSY crash mechanism (#269 CI) against real rollback-journal
// connections: a deferred transaction that has already read holds SHARED, and
// its first write gets SQLITE_BUSY at once — SQLite skips the busy handler on
// that upgrade path, so the pragma's budget goes unused. A transaction begun
// IMMEDIATE takes RESERVED at BEGIN, where the handler applies. The store
// tests run MailboxStore's real crash path (settling a claimed message) under
// the same holder.
//
// The holder and the writer interleave through an explicit handshake, not
// wall-clock margins: the writer runs on a worker thread (the holder and the
// writer cannot both run on one thread — a blocked BEGIN never yields). The
// worker first reads the holder's uncommitted marker row of this round —
// invisible while the holder still holds — and reports the read; the holder
// commits one macrotask after that report. The attempt starts within
// microseconds of the read, the commit no earlier than the report plus the
// timer, so the attempt's BEGIN meets a still-held lock and can only succeed
// by waiting it out; a worker stall longer than the timer would only turn
// the round into a trivial success, never a false failure. The old elapsed
// assertions (`>= 200` of a 300 ms budget) flaked once under host load and
// are gone — no lower-bound timing assertion remains; the one surviving
// bound (the BUSY-upgrade check's `ms < 2000`) is an upper bound that only
// fails when the upgrade waits out a budget it must never engage.
import { describe, expect, test } from 'bun:test'
import { Database, type Database as Db } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import type { WriterDone, WriterRequest } from './mailboxBusyWriterWorker'

/** A writer-side connection with table `t` set up; callers take RESERVED with `holdReserved`. */
function reservedHolder(dir: string, name = 'db.sqlite'): Db {
  const holder = new Database(join(dir, name))
  holder.exec('PRAGMA journal_mode = delete')
  // The handshake commit can land while the writer's marker read (or its
  // connection open) holds SHARED for a statement; the holder waits that out
  // instead of failing the round — the waiting writer holds nothing that
  // could block it back (probed: the commit lands mid-wait).
  holder.exec('PRAGMA busy_timeout = 10000')
  holder.exec('CREATE TABLE t (v TEXT)')
  return holder
}

/** Take RESERVED with an uncommitted marker row on a holder with no open transaction. */
function holdReserved(holder: Db, token: string): void {
  holder.exec('BEGIN IMMEDIATE')
  holder.prepare('INSERT INTO t VALUES ($token)').run({ $token: token })
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

/**
 * One writer round: the worker reads the holder's uncommitted marker (and
 * reports it), the holder commits on the report — one macrotask later, so
 * the commit never lands inside the worker's read→attempt window — and the
 * worker's outcome comes back as one `done` message.
 */
function writerRound(holder: Db, request: WriterRequest): Promise<WriterDone> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mailboxBusyWriterWorker.ts', import.meta.url).href, { type: 'module' })
    let commitTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (commitTimer !== undefined) clearTimeout(commitTimer)
      worker.terminate()
    }
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; held?: boolean }
      if (data.type === 'read') {
        if (data.held) {
          // The marker was visible while the holder still held: the commit
          // leaked ahead of the read — a protocol bug, not a pass.
          stop()
          reject(new Error('the writer saw the holder marker before the commit'))
          return
        }
        // One macrotask of margin: the worker's attempt starts within
        // microseconds of its read, this commit lands after the timer — the
        // begin is waiting by then.
        commitTimer = setTimeout(() => {
          try {
            holder.exec('COMMIT')
          } catch (error) {
            stop()
            reject(error)
          }
        }, 1)
        return
      }
      stop()
      resolve(data as WriterDone)
    }
    worker.onerror = (event: ErrorEvent) => {
      stop()
      reject(new Error(`the writer worker failed to start: ${event.message}`))
    }
    worker.postMessage(request)
  })
}

/** Take RESERVED with a fresh per-round marker row; the token names it. */
function heldRound(holder: Db): string {
  const token = `marker-${crypto.randomUUID()}`
  holdReserved(holder, token)
  return token
}

describe('the deferred read→write upgrade', () => {
  test('gets SQLITE_BUSY at once, far below busy_timeout', () => {
    const dir = freshDir()
    const holder = reservedHolder(dir)
    const seeder = new Database(join(dir, 'db.sqlite'))
    try {
      seeder.exec('PRAGMA busy_timeout = 5000')
      holdReserved(holder, 'held')
      const { error, ms } = elapsedUpgrade(seeder, false)
      expect((error as Error).message).toContain('database is locked')
      // The pragma's budget is 5000 ms; the upgrade path never waits it out.
      // (A handler engaged here would return after the full budget; the
      // failed attempt returns at once, whatever the host is doing.)
      expect(ms).toBeLessThan(2000)
    } finally {
      holder.close()
      seeder.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the same work begun IMMEDIATE', () => {
  test('waits out the busy budget under the holder, then succeeds once it commits', async () => {
    const dir = freshDir()
    const holder = reservedHolder(dir)
    const checker = new Database(join(dir, 'db.sqlite'))
    try {
      // The holder commits only after the writer read its uncommitted
      // marker, so the IMMEDIATE begin below met a still-held lock and could
      // only complete by waiting it out — the busy handler's job. Reverted
      // to a deferred transaction, the upgrade inside the write fails at
      // once instead.
      const token = heldRound(holder)
      const done = await writerRound(holder, { type: 'immediate', path: join(dir, 'db.sqlite'), token })
      expect(done.ok).toBe(true)
      expect(done.error).toBe(null)
      // This round's marker row and the writer's row, in write order: the
      // commit landed between the writer's begin and its insert.
      expect(checker.query('SELECT v FROM t WHERE v IN ($token, $x) ORDER BY rowid').all({ $token: token, $x: 'x' }))
        .toEqual([{ v: token }, { v: 'x' }])
    } finally {
      holder.close()
      checker.close()
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

  test('settling the claimed message waits out the holder and succeeds once it commits', async () => {
    const dir = freshDir()
    // The full migrated schema, like the server's own connection.
    const db = initDatabase({ path: join(dir, 'db.sqlite') }).db
    const store = new MailboxStore(db)
    // The claimed, pushed mail exists first — enqueueing is itself a write,
    // so it must not race the holder — then the holder takes RESERVED over
    // the live mailbox, like the server's own writer at a turn end.
    const id = claimedMail(store)
    const holder = reservedHolder(dir)
    try {
      // The writer runs the store's own `logged` settle on its thread. It
      // succeeds only because the settle's IMMEDIATE begin waited out the
      // holder until the handshake commit; a deferred settle (the old
      // upgrade path) fails at once with SQLITE_BUSY instead.
      const token = heldRound(holder)
      const done = await writerRound(holder, { type: 'settle', path: join(dir, 'db.sqlite'), id, token })
      expect(done.ok).toBe(true)
      expect(store.get(id)?.state).toBe('delivered')
      expect(store.eventsFor(id).map(event => event.kind)).toEqual(['sent', 'claimed', 'pushed', 'delivered'])
    } finally {
      holder.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('claimWhen waits out the holder and claims once it commits', async () => {
    const dir = freshDir()
    const db = initDatabase({ path: join(dir, 'db.sqlite') }).db
    const store = new MailboxStore(db)
    const mail = store.enqueue({
      teamId: 't', toKind: 'session', toId: 's1', fromSession: 's1',
      fromGroup: null, originPath: '/tmp/proj', body: 'work',
    })
    const holder = reservedHolder(dir)
    try {
      // The worker's eligibility read runs on the store connection, like the
      // dispatcher's availability check. A deferred claimWhen would take
      // SHARED at that read and fail its claim write at once.
      const token = heldRound(holder)
      const done = await writerRound(holder, { type: 'claimWhen', path: join(dir, 'db.sqlite'), id: mail.id, token })
      expect(done.ok).toBe(true)
      expect(store.get(mail.id)?.state).toBe('claimed')
      expect(store.get(mail.id)?.claimedBy).toBe('s1')
    } finally {
      holder.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('cancelling a queued message waits out the holder and succeeds once it commits', async () => {
    const dir = freshDir()
    const db = initDatabase({ path: join(dir, 'db.sqlite') }).db
    const store = new MailboxStore(db)
    const mail = store.enqueue({
      teamId: 't', toKind: 'session', toId: 's1', fromSession: 's1',
      fromGroup: null, originPath: '/tmp/proj', body: 'work',
    })
    const holder = reservedHolder(dir)
    try {
      // ParkedCancel's transaction reads the row before its transition
      // write; a deferred transaction would fail the write at once.
      const token = heldRound(holder)
      const done = await writerRound(holder, { type: 'cancel', path: join(dir, 'db.sqlite'), id: mail.id, token })
      expect(done.ok).toBe(true)
      expect(store.get(mail.id)?.state).toBe('cancelled')
    } finally {
      holder.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
