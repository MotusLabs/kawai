// archived_at column tests: fresh databases create it with the table, legacy
// databases gain it through the PRAGMA-guarded migration, and every
// pre-existing row defaults to not archived.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'

function tempDbPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return path.join(dir, 'test.db')
}

function seedLiveRow(db: SessionDatabase, sessionId: string): void {
  const now = new Date().toISOString()
  db.insertChatSession({
    sessionId,
    name: 'row',
    projectPath: '/tmp/proj',
    sdkSessionId: null,
    status: 'waiting',
    createdAt: now,
    lastActivityAt: now,
  })
}

test('a fresh database creates chat_sessions with archived_at null by default', () => {
  const dbPath = tempDbPath('chat-archive-fresh-')
  const db = initDatabase({ path: dbPath })
  try {
    const columns = db.db
      .prepare('PRAGMA table_info(chat_sessions)')
      .all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('archived_at')
    seedLiveRow(db, 'fresh-row')
    expect(db.getChatSession('fresh-row')?.archivedAt).toBeNull()
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('an existing database without archived_at gains the column and keeps its rows not archived', () => {
  const dbPath = tempDbPath('chat-archive-legacy-')
  const legacy = new Database(dbPath)
  legacy.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, sdk_session_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL);
    INSERT INTO chat_sessions VALUES ('legacy', 'old', '/tmp', 'sdk-old', 'waiting', '2026-01-01', '2026-01-01');`)
  legacy.close()
  const db = initDatabase({ path: dbPath })
  try {
    const columns = db.db
      .prepare('PRAGMA table_info(chat_sessions)')
      .all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('archived_at')
    expect(db.getChatSession('legacy')?.archivedAt).toBeNull()
    expect(db.getChatSessions().every((row) => row.archivedAt == null)).toBe(true)
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('archivedAt round-trips through update, including clearing it', () => {
  const dbPath = tempDbPath('chat-archive-roundtrip-')
  const db = initDatabase({ path: dbPath })
  try {
    seedLiveRow(db, 'round-trip')
    const archivedAt = '2026-10-01T12:00:00.000Z'
    db.updateChatSession('round-trip', { archivedAt })
    expect(db.getChatSession('round-trip')?.archivedAt).toBe(archivedAt)
    db.updateChatSession('round-trip', { archivedAt: null })
    expect(db.getChatSession('round-trip')?.archivedAt).toBeNull()
    // Reopening the same file keeps archived rows archived.
    const archivedAgain = '2026-10-02T08:30:00.000Z'
    db.updateChatSession('round-trip', { archivedAt: archivedAgain })
    db.close()
    const reopened = initDatabase({ path: dbPath })
    try {
      expect(reopened.getChatSession('round-trip')?.archivedAt).toBe(archivedAgain)
    } finally {
      reopened.close()
    }
  } finally {
    // db was closed inside the test; reopening used the same file.
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})
