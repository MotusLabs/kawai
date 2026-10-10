// Context-usage columns: fresh databases create them with the table, legacy
// databases gain them through the PRAGMA-guarded migration with every
// pre-existing row reading as no-measurement (null, never an invented zero),
// and updateChatSession round-trips the reading and clears it with null.
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

const READING = {
  usedTokens: 157_900,
  thresholdTokens: 167_000,
  percentage: 94.55,
  at: '2026-10-10T12:00:00.000Z',
}

test('a fresh database creates chat_sessions with the four context columns reading as null', () => {
  const dbPath = tempDbPath('chat-context-fresh-')
  const db = initDatabase({ path: dbPath })
  try {
    const columns = db.db
      .prepare('PRAGMA table_info(chat_sessions)')
      .all() as { name: string }[]
    const names = columns.map((column) => column.name)
    expect(names).toContain('context_tokens')
    expect(names).toContain('context_threshold')
    expect(names).toContain('context_pct')
    expect(names).toContain('context_at')
    seedRow(db, 'fresh-row')
    expect(db.getChatSession('fresh-row')?.contextUsage).toBeNull()
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('an existing database without the columns gains them with rows reading as null', () => {
  const dbPath = tempDbPath('chat-context-legacy-')
  const legacy = new Database(dbPath)
  legacy.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, sdk_session_id TEXT, profile_id TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, archived_at TEXT, approval_policy TEXT NOT NULL DEFAULT 'manual', name_source TEXT NOT NULL DEFAULT 'manual');
    INSERT INTO chat_sessions VALUES ('legacy', 'old', '/tmp', 'sdk-old', 'default', 'waiting', '2026-01-01', '2026-01-01', NULL, 'manual', 'manual');`)
  legacy.close()
  const db = initDatabase({ path: dbPath })
  try {
    expect(db.getChatSession('legacy')?.contextUsage).toBeNull()
    db.updateChatSession('legacy', { contextUsage: READING })
    expect(db.getChatSession('legacy')?.contextUsage).toEqual(READING)
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('updateChatSession round-trips the reading and clears it with null', () => {
  const dbPath = tempDbPath('chat-context-roundtrip-')
  const db = initDatabase({ path: dbPath })
  try {
    seedRow(db, 'row')
    db.updateChatSession('row', { contextUsage: READING })
    expect(db.getChatSession('row')?.contextUsage).toEqual(READING)

    // Null clears all four columns together: no partial reading survives.
    db.updateChatSession('row', { contextUsage: null })
    expect(db.getChatSession('row')?.contextUsage).toBeNull()
    const raw = db.db
      .prepare("SELECT context_tokens, context_threshold, context_pct, context_at FROM chat_sessions WHERE session_id = 'row'")
      .get() as Record<string, unknown>
    expect(raw.context_tokens).toBeNull()
    expect(raw.context_threshold).toBeNull()
    expect(raw.context_pct).toBeNull()
    expect(raw.context_at).toBeNull()
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})
