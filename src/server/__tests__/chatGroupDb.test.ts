// group_id column tests (agent-teams): fresh databases create it, legacy
// databases gain it with every pre-existing row reading as no group, insert
// round-trips the value, and no update patch can change it afterwards.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type ChatSessionRecord } from '../db'

function withDb(prefix: string, run: (dbPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    run(path.join(dir, 'test.db'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const row = (sessionId: string, groupId?: string | null): ChatSessionRecord => {
  const now = new Date().toISOString()
  return {
    sessionId, name: 'row', projectPath: '/tmp/proj', sdkSessionId: null,
    status: 'waiting', createdAt: now, lastActivityAt: now,
    ...(groupId !== undefined ? { groupId } : {}),
  }
}

test('insert round-trips a group and an absent group reads as none', () => {
  withDb('chat-group-roundtrip-', (dbPath) => {
    const db = initDatabase({ path: dbPath })
    try {
      db.insertChatSession(row('dev', 'devs'))
      db.insertChatSession(row('solo'))
      expect(db.getChatSession('dev')?.groupId).toBe('devs')
      expect(db.getChatSession('solo')?.groupId).toBeNull()
    } finally {
      db.close()
    }
  })
})

test('the group survives archive, restore, and reopening the database', () => {
  withDb('chat-group-archive-', (dbPath) => {
    const db = initDatabase({ path: dbPath })
    db.insertChatSession(row('dev', 'devs'))
    db.updateChatSession('dev', { archivedAt: '2026-10-11T00:00:00.000Z' })
    db.updateChatSession('dev', { archivedAt: null })
    db.close()
    const reopened = initDatabase({ path: dbPath })
    try {
      expect(reopened.getChatSession('dev')?.groupId).toBe('devs')
    } finally {
      reopened.close()
    }
  })
})

test('an update patch never changes the group', () => {
  withDb('chat-group-fixed-', (dbPath) => {
    const db = initDatabase({ path: dbPath })
    try {
      db.insertChatSession(row('dev', 'devs'))
      const updated = db.updateChatSession('dev', { groupId: 'qa', name: 'renamed' })
      expect(updated).toMatchObject({ name: 'renamed', groupId: 'devs' })
    } finally {
      db.close()
    }
  })
})

test('a legacy database gains group_id with existing rows in no group', () => {
  withDb('chat-group-legacy-', (dbPath) => {
    const legacy = new Database(dbPath)
    legacy.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, sdk_session_id TEXT, profile_id TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, archived_at TEXT);
      INSERT INTO chat_sessions VALUES ('legacy', 'old', '/tmp', 'sdk-old', 'default', 'waiting', '2026-01-01', '2026-01-01', NULL);`)
    legacy.close()
    const db = initDatabase({ path: dbPath })
    try {
      const columns = db.db.prepare('PRAGMA table_info(chat_sessions)').all() as { name: string }[]
      expect(columns.map((column) => column.name)).toContain('group_id')
      expect(db.getChatSession('legacy')?.groupId).toBeNull()
    } finally {
      db.close()
    }
  })
})
