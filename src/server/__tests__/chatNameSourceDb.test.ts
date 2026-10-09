// name_source column tests (chat-session-naming design D6): fresh databases
// create it with the table, and legacy databases gain it through the
// PRAGMA-guarded migration stamped by name shape — `placeholder` only for a
// generator-shaped `adjective-noun` pair, `manual` for anything else, so a
// user-supplied name survives the upgrade.
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

function seedRow(db: SessionDatabase, sessionId: string, name: string): void {
  const now = new Date().toISOString()
  db.insertChatSession({
    sessionId,
    name,
    projectPath: '/tmp/proj',
    sdkSessionId: null,
    status: 'waiting',
    createdAt: now,
    lastActivityAt: now,
  })
}

/** Build a pre-feature chat_sessions table with no name_source column. */
function createLegacyDb(dbPath: string, rows: Array<[string, string]>): void {
  const legacy = new Database(dbPath)
  legacy.exec(
    `CREATE TABLE chat_sessions (
      session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      sdk_session_id TEXT,
      profile_id TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      archived_at TEXT,
      approval_policy TEXT NOT NULL DEFAULT 'manual'
    );`
  )
  const insert = legacy.prepare(
    'INSERT INTO chat_sessions (session_id, name, project_path, status, created_at, last_activity_at) VALUES ($sessionId, $name, $projectPath, $status, $createdAt, $lastActivityAt)'
  )
  for (const [sessionId, name] of rows) {
    insert.run({
      $sessionId: sessionId,
      $name: name,
      $projectPath: '/tmp/proj',
      $status: 'waiting',
      $createdAt: '2026-01-01T00:00:00.000Z',
      $lastActivityAt: '2026-01-01T00:00:00.000Z',
    })
  }
  legacy.close()
}

test('a fresh database creates chat_sessions with name_source manual by default', () => {
  const dbPath = tempDbPath('chat-name-source-fresh-')
  const db = initDatabase({ path: dbPath })
  try {
    const columns = db.db
      .prepare('PRAGMA table_info(chat_sessions)')
      .all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('name_source')
    seedRow(db, 'fresh-row', 'sure-mark')
    expect(db.getChatSession('fresh-row')?.nameSource).toBe('manual')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('a generator-shaped pre-feature name becomes placeholder', () => {
  const dbPath = tempDbPath('chat-name-source-shaped-')
  createLegacyDb(dbPath, [['legacy-placeholder', 'sure-mark']])
  const db = initDatabase({ path: dbPath })
  try {
    expect(db.getChatSession('legacy-placeholder')?.nameSource).toBe(
      'placeholder'
    )
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('a user-supplied pre-feature name stays manual', () => {
  const dbPath = tempDbPath('chat-name-source-user-')
  createLegacyDb(dbPath, [['legacy-manual', 'show-chat-rate-limits']])
  const db = initDatabase({ path: dbPath })
  try {
    expect(db.getChatSession('legacy-manual')?.nameSource).toBe('manual')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('migration stamps each legacy row independently by its own name shape', () => {
  const dbPath = tempDbPath('chat-name-source-mixed-')
  createLegacyDb(dbPath, [
    ['legacy-shape-a', 'sure-mark'],
    ['legacy-user', 'show-chat-rate-limits'],
    ['legacy-shape-b', 'calm-raven'],
    ['legacy-user-dotted', 'docs-chat-session-naming'],
  ])
  const db = initDatabase({ path: dbPath })
  try {
    expect(db.getChatSession('legacy-shape-a')?.nameSource).toBe('placeholder')
    expect(db.getChatSession('legacy-user')?.nameSource).toBe('manual')
    expect(db.getChatSession('legacy-shape-b')?.nameSource).toBe('placeholder')
    expect(db.getChatSession('legacy-user-dotted')?.nameSource).toBe('manual')
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('migration is not re-run once the column exists', () => {
  const dbPath = tempDbPath('chat-name-source-once-')
  createLegacyDb(dbPath, [['legacy-row', 'sure-mark']])
  const first = initDatabase({ path: dbPath })
  expect(first.getChatSession('legacy-row')?.nameSource).toBe('placeholder')
  // A later rename must not be undone by reopening the database.
  first.updateChatSession('legacy-row', { name: 'show-chat-rate-limits' })
  first.close()
  const second = initDatabase({ path: dbPath })
  try {
    expect(second.getChatSession('legacy-row')?.name).toBe(
      'show-chat-rate-limits'
    )
    expect(second.getChatSession('legacy-row')?.nameSource).toBe('placeholder')
  } finally {
    second.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('insertChatSession round-trips every nameSource value', () => {
  const dbPath = tempDbPath('chat-name-source-insert-')
  const db = initDatabase({ path: dbPath })
  try {
    const now = new Date().toISOString()
    for (const nameSource of ['manual', 'auto', 'placeholder'] as const) {
      db.insertChatSession({
        sessionId: `row-${nameSource}`,
        name: `n-${nameSource}`,
        projectPath: '/tmp/proj',
        sdkSessionId: null,
        status: 'waiting',
        createdAt: now,
        lastActivityAt: now,
        nameSource,
      })
      expect(db.getChatSession(`row-${nameSource}`)?.nameSource).toBe(nameSource)
    }
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('updateChatSession round-trips a nameSource change', () => {
  const dbPath = tempDbPath('chat-name-source-update-')
  const db = initDatabase({ path: dbPath })
  try {
    seedRow(db, 'row', 'sure-mark')
    expect(db.getChatSession('row')?.nameSource).toBe('manual')
    for (const nameSource of ['placeholder', 'auto', 'manual'] as const) {
      db.updateChatSession('row', { nameSource })
      expect(db.getChatSession('row')?.nameSource).toBe(nameSource)
    }
  } finally {
    db.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})

test('nameSource survives closing and reopening the database', () => {
  const dbPath = tempDbPath('chat-name-source-reopen-')
  const first = initDatabase({ path: dbPath })
  const now = new Date().toISOString()
  first.insertChatSession({
    sessionId: 'persisted',
    name: 'sure-mark',
    projectPath: '/tmp/proj',
    sdkSessionId: null,
    status: 'waiting',
    createdAt: now,
    lastActivityAt: now,
    nameSource: 'placeholder',
  })
  first.close()
  const second = initDatabase({ path: dbPath })
  try {
    expect(second.getChatSession('persisted')?.nameSource).toBe('placeholder')
  } finally {
    second.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  }
})
