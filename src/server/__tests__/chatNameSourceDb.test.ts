// name_source column tests: fresh databases create it with the table, legacy
// databases gain it through the PRAGMA-guarded migration, and each pre-existing
// row is stamped by name shape (design D6) — placeholder only for a name the
// generator could have emitted, manual otherwise. Round-trips cover insert,
// update, and reopen.
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

function seedRow(
  db: SessionDatabase,
  sessionId: string,
  name = 'row',
  nameSource?: 'manual' | 'auto' | 'placeholder'
): void {
  const now = new Date().toISOString()
  db.insertChatSession({
    sessionId,
    name,
    projectPath: '/tmp/proj',
    sdkSessionId: null,
    status: 'waiting',
    createdAt: now,
    lastActivityAt: now,
    ...(nameSource ? { nameSource } : {}),
  })
}

test('a fresh database creates chat_sessions with name_source defaulting to manual', () => {
  const dbPath = tempDbPath('chat-namesource-fresh-')
  const db = initDatabase({ path: dbPath })
  try {
    const columns = db.db
      .prepare('PRAGMA table_info(chat_sessions)')
      .all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('name_source')
    seedRow(db, 'fresh-row')
    expect(db.getChatSession('fresh-row')?.nameSource).toBe('manual')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('legacy rows stamp by name shape: sure-mark -> placeholder, show-chat-rate-limits -> manual', () => {
  const dbPath = tempDbPath('chat-namesource-legacy-')
  const legacy = new Database(dbPath)
  legacy.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, sdk_session_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL);
    INSERT INTO chat_sessions (session_id, name, project_path, sdk_session_id, status, created_at, last_activity_at) VALUES
      ('legacy-placeholder', 'sure-mark', '/tmp', 'sdk-1', 'waiting', '2026-01-01', '2026-01-01'),
      ('legacy-manual', 'show-chat-rate-limits', '/tmp', 'sdk-2', 'waiting', '2026-01-01', '2026-01-01');`)
  legacy.close()
  const db = initDatabase({ path: dbPath })
  try {
    expect(db.getChatSession('legacy-placeholder')?.nameSource).toBe('placeholder')
    expect(db.getChatSession('legacy-manual')?.nameSource).toBe('manual')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('an already-migrated database keeps its stored name_source values', () => {
  const dbPath = tempDbPath('chat-namesource-idempotent-')
  const first = initDatabase({ path: dbPath })
  seedRow(first, 'kept', 'sure-mark', 'manual')
  first.close()
  // A manual sure-mark (typed on purpose) must not be re-stamped placeholder.
  const second = initDatabase({ path: dbPath })
  try {
    expect(second.getChatSession('kept')?.nameSource).toBe('manual')
  } finally {
    second.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('nameSource round-trips through insert, update, and reopen', () => {
  const dbPath = tempDbPath('chat-namesource-roundtrip-')
  const db = initDatabase({ path: dbPath })
  try {
    seedRow(db, 'round-trip', 'pure-bell', 'placeholder')
    expect(db.getChatSession('round-trip')?.nameSource).toBe('placeholder')
    db.updateChatSession('round-trip', { name: 'My chat!', nameSource: 'manual' })
    expect(db.getChatSession('round-trip')?.name).toBe('My chat!')
    expect(db.getChatSession('round-trip')?.nameSource).toBe('manual')
    db.updateChatSession('round-trip', { nameSource: 'auto' })
    db.close()
    const reopened = initDatabase({ path: dbPath })
    try {
      expect(reopened.getChatSession('round-trip')?.nameSource).toBe('auto')
      expect(reopened.getChatSessions().every((row) => typeof row.nameSource === 'string')).toBe(true)
    } finally {
      reopened.close()
    }
  } finally {
    // db was closed inside the test; reopening used the same file.
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})
