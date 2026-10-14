// Pins initDatabase's busy_timeout. PR #123's CI hit this: an e2e seeding
// child process held a lock on the fixture DB while the server read it, and
// the read failed at once with SQLITE_BUSY because SQLite's default timeout
// is 0. With 5000 ms, statements wait out short foreign locks instead.
// db.test.ts is at its size cap, so the pin lives here.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import type { SessionDatabase } from '../db'

const baseTimestamp = new Date('2026-06-01T00:00:00.000Z').toISOString()

let tempDir: string
const openDbs: SessionDatabase[] = []

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-db-busy-timeout-'))
})

afterAll(() => {
  for (const db of openDbs) {
    db.db.close()
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('initDatabase busy_timeout', () => {
  test('sets a 5000 ms busy timeout on the connection', () => {
    const db = initDatabase({ path: path.join(tempDir, 'pragma.db') })
    openDbs.push(db)
    // bun:sqlite names the pragma's result column "timeout"
    const row = db.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(row.timeout).toBe(5000)
  })

  // Mirrors the CI failure: another process holds BEGIN EXCLUSIVE while the
  // server connection reads. The child writes its lock timestamp into the
  // marker once the lock is granted, so the parent can prove its read really
  // blocked until the child's release — with the default timeout 0 the read
  // throws SQLITE_BUSY immediately instead. The hold is 150 ms to keep the
  // file comfortably under 1 s even at load; if the parent polls the marker
  // too late to overlap the hold window the observation proves nothing, so
  // it retries once with a fresh child and then fails rather than passing
  // vacuously.
  test('a read waits out another process holding an exclusive lock', async () => {
    const dbPath = path.join(tempDir, 'cross-process.db')
    const db = initDatabase({ path: dbPath })
    openDbs.push(db)
    db.insertSession({
      sessionId: 'busy-seed',
      logFilePath: path.join(tempDir, 'busy-seed.jsonl'),
      projectPath: path.join(tempDir, 'busy-seed'),
      slug: null,
      agentType: 'claude',
      displayName: 'busy-seed',
      createdAt: baseTimestamp,
      lastActivityAt: baseTimestamp,
      lastUserMessage: null,
      currentWindow: null,
      isPinned: false,
      lastResumeError: null,
      lastKnownLogSize: null,
      isCodexExec: false,
      launchCommand: null,
    })

    const HOLD_MS = 150
    const SLACK_MS = 20
    let proved = false
    let lateReason = ''
    for (let attempt = 1; attempt <= 2 && !proved; attempt++) {
      const marker = path.join(tempDir, `lock-held-${attempt}.marker`)
      const child = Bun.spawn({
        cmd: [
          'bun',
          '-e',
          [
            "import { Database } from 'bun:sqlite'",
            "import { writeFileSync } from 'node:fs'",
            'const db = new Database(process.env.LOCK_DB_PATH!)',
            "db.exec('BEGIN EXCLUSIVE')",
            "writeFileSync(process.env.LOCK_MARKER!, String(Date.now()))",
            'await Bun.sleep(Number(process.env.LOCK_HOLD_MS!))',
            "db.exec('COMMIT')",
            'db.close()',
          ].join('\n'),
        ],
        env: {
          ...process.env,
          LOCK_DB_PATH: dbPath,
          LOCK_MARKER: marker,
          LOCK_HOLD_MS: String(HOLD_MS),
        },
        cwd: process.cwd(),
        stdout: 'ignore',
        stderr: 'inherit',
      })
      let childDone = false
      try {
        const deadline = Date.now() + 5000
        while (!fs.existsSync(marker)) {
          if (Date.now() > deadline) throw new Error('child never acquired the exclusive lock')
          await Bun.sleep(2)
        }
        const lockedAt = Number(fs.readFileSync(marker, 'utf8'))
        const start = Date.now()
        if (start >= lockedAt + HOLD_MS) {
          lateReason = `observed the lock ${start - lockedAt} ms after it was granted, too late to overlap the ${HOLD_MS} ms hold`
          // Let this child commit and release cleanly before any retry.
          expect(await child.exited).toBe(0)
          childDone = true
          continue
        }
        expect(() => db.getActiveSessions()).not.toThrow()
        // The read can only return after the child's COMMIT, which happens
        // no earlier than lockedAt + HOLD_MS.
        const end = Date.now()
        expect(end).toBeGreaterThanOrEqual(lockedAt + HOLD_MS - SLACK_MS)
        expect(end - start).toBeLessThan(5000)
        expect(await child.exited).toBe(0)
        childDone = true
        proved = true
      } finally {
        if (!childDone) child.kill()
      }
    }
    if (!proved) {
      throw new Error(`could not prove the read waited for the lock: ${lateReason}`)
    }
  })
})
