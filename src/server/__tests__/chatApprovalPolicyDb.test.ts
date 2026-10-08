// approval_policy column tests: fresh databases create it with the table,
// legacy databases gain it through the PRAGMA-guarded migration with every
// pre-existing row reading as manual, and insert/update round-trip the value.
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

test('a fresh database creates chat_sessions with approval_policy manual by default', () => {
  const dbPath = tempDbPath('chat-policy-fresh-')
  const db = initDatabase({ path: dbPath })
  try {
    const columns = db.db
      .prepare('PRAGMA table_info(chat_sessions)')
      .all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('approval_policy')
    seedRow(db, 'fresh-row')
    expect(db.getChatSession('fresh-row')?.approvalPolicy).toBe('manual')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('an existing database without approval_policy gains the column with rows reading as manual', () => {
  const dbPath = tempDbPath('chat-policy-legacy-')
  const legacy = new Database(dbPath)
  legacy.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, sdk_session_id TEXT, profile_id TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, archived_at TEXT);
    INSERT INTO chat_sessions VALUES ('legacy', 'old', '/tmp', 'sdk-old', 'default', 'waiting', '2026-01-01', '2026-01-01', NULL);`)
  legacy.close()
  const db = initDatabase({ path: dbPath })
  try {
    expect(db.getChatSession('legacy')?.approvalPolicy).toBe('manual')
    db.updateChatSession('legacy', { approvalPolicy: 'auto' })
    expect(db.getChatSession('legacy')?.approvalPolicy).toBe('auto')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('an unknown stored approval_policy value reads as manual', () => {
  const dbPath = tempDbPath('chat-policy-unknown-')
  const db = initDatabase({ path: dbPath })
  try {
    seedRow(db, 'row')
    db.db.prepare("UPDATE chat_sessions SET approval_policy = 'yolo' WHERE session_id = 'row'").run()
    expect(db.getChatSession('row')?.approvalPolicy).toBe('manual')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('insert and update round-trip the approval policy', () => {
  const dbPath = tempDbPath('chat-policy-roundtrip-')
  const db = initDatabase({ path: dbPath })
  try {
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId: 'auto-row',
      name: 'row',
      projectPath: '/tmp/proj',
      sdkSessionId: null,
      status: 'waiting',
      createdAt: now,
      lastActivityAt: now,
      approvalPolicy: 'auto',
    })
    expect(db.getChatSession('auto-row')?.approvalPolicy).toBe('auto')
    db.updateChatSession('auto-row', { approvalPolicy: 'manual' })
    expect(db.getChatSession('auto-row')?.approvalPolicy).toBe('manual')
    expect(db.getChatSessions().every((row) => row.approvalPolicy === 'manual' || row.approvalPolicy === 'auto')).toBe(true)
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})
