import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'

test('profile column migrates legacy rows and round-trips named identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-db-'))
  const dbPath = path.join(dir, 'test.db')
  const legacy = new Database(dbPath)
  legacy.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, sdk_session_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL);
    INSERT INTO chat_sessions VALUES ('legacy', 'old', '/tmp', 'sdk-old', 'waiting', '2026-01-01', '2026-01-01');`)
  legacy.close()
  const db = initDatabase({ path: dbPath })
  try {
    expect(db.getChatSession('legacy')?.claudeProfileId).toBe('default')
    const row = db.getChatSession('legacy')!
    db.insertChatSession({ ...row, sessionId: 'new', claudeProfileId: 'mimo' })
    expect(db.getChatSession('new')?.claudeProfileId).toBe('mimo')
    db.updateChatSession('new', { claudeProfileId: 'lan' })
    expect(db.getChatSession('new')?.claudeProfileId).toBe('lan')
    expect(db.getChatSession('legacy')?.sdkSessionId).toBe('sdk-old')
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
