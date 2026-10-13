// The chat_sessions model column (chat-session-model design D4): fresh
// databases create it with the table migration, legacy databases gain it
// through the PRAGMA-guarded migration with every pre-existing row reading
// as null, and updateChatSession round-trips and replaces the string.
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

function seedRow(db: SessionDatabase, sessionId: string): void {
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

test('a fresh database creates chat_sessions with a nullable model column reading as null', () => {
  const dbPath = tempDbPath('chat-model-fresh-')
  const db = initDatabase({ path: dbPath })
  try {
    const columns = db.db
      .prepare('PRAGMA table_info(chat_sessions)')
      .all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('model')
    seedRow(db, 'fresh-row')
    expect(db.getChatSession('fresh-row')?.model).toBeNull()
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('an existing database without the column gains it with rows reading as null', () => {
  const dbPath = tempDbPath('chat-model-legacy-')
  const legacy = new Database(dbPath)
  legacy.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, sdk_session_id TEXT, profile_id TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, archived_at TEXT, approval_policy TEXT NOT NULL DEFAULT 'manual', name_source TEXT NOT NULL DEFAULT 'manual');
    INSERT INTO chat_sessions VALUES ('legacy', 'old', '/tmp', 'sdk-old', 'default', 'waiting', '2026-01-01', '2026-01-01', NULL, 'manual', 'manual');`)
  legacy.close()
  const db = initDatabase({ path: dbPath })
  try {
    expect(db.getChatSession('legacy')?.model).toBeNull()
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('updateChatSession round-trips the model and a later report replaces it', () => {
  const dbPath = tempDbPath('chat-model-roundtrip-')
  const db = initDatabase({ path: dbPath })
  try {
    seedRow(db, 'row')
    db.updateChatSession('row', { model: 'claude-sonnet-5-5' })
    expect(db.getChatSession('row')?.model).toBe('claude-sonnet-5-5')
    // A mid-session /model switch overwrites the stored value.
    db.updateChatSession('row', { model: 'sonnet' })
    expect(db.getChatSession('row')?.model).toBe('sonnet')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})
