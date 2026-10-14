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
  // server connection reads. The child writes a marker only after the lock is
  // granted, so the parent's read provably starts while the lock is held —
  // with the default timeout 0 it would throw SQLITE_BUSY immediately.
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

    const marker = path.join(tempDir, 'lock-held.marker')
    const child = Bun.spawn({
      cmd: [
        'bun',
        '-e',
        [
          "import { Database } from 'bun:sqlite'",
          "import { writeFileSync } from 'node:fs'",
          'const db = new Database(process.env.LOCK_DB_PATH!)',
          "db.exec('BEGIN EXCLUSIVE')",
          "writeFileSync(process.env.LOCK_MARKER!, 'held')",
          'await Bun.sleep(300)',
          "db.exec('COMMIT')",
          'db.close()',
        ].join('\n'),
      ],
      env: { ...process.env, LOCK_DB_PATH: dbPath, LOCK_MARKER: marker },
      cwd: process.cwd(),
      stdout: 'ignore',
      stderr: 'inherit',
    })

    const deadline = Date.now() + 5000
    while (!fs.existsSync(marker)) {
      if (Date.now() > deadline) throw new Error('child never acquired the exclusive lock')
      await Bun.sleep(2)
    }

    const start = Date.now()
    expect(() => db.getActiveSessions()).not.toThrow()
    expect(Date.now() - start).toBeLessThan(5000)
    expect(await child.exited).toBe(0)
  })
})
