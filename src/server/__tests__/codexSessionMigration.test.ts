// Schema migration `codex-chat-runtime` (codex-chat-sessions 3.3, ruling R1):
// a predecessor database keeps its chats — the new columns arrive empty and
// legacy rows read as Claude — a fresh database carries them, and a Codex
// row round-trips its creation-fixed runtime and home with the transcript
// path on the update path.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'

const BEFORE_CODEX = MIGRATIONS.filter(migration => migration.version < 13)

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-session-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const BASE_CHAT = {
  sdkSessionId: null,
  status: 'waiting' as const,
  createdAt: '2026-10-18T00:00:00.000Z',
  lastActivityAt: '2026-10-18T00:00:00.000Z',
}

/** A predecessor database — the build before this change — holding one chat. */
function predecessorWithChat(): SessionDatabase {
  const session = initDatabase({ path: dbPath, migrations: BEFORE_CODEX })
  session.insertChatSession({ ...BASE_CHAT, sessionId: 'chat-legacy', name: 'Legacy', projectPath: '/tmp/legacy' })
  expect(session.db.prepare("SELECT name FROM pragma_table_info('chat_sessions') WHERE name = 'runtime'").get())
    .toBeNull()
  return session
}

test('this build registers codex-chat-runtime as the dense next numbered migration', () => {
  const entries = MIGRATIONS.map(migration => [migration.version, migration.name] as const)
  const at = entries.findIndex(([, name]) => name === 'codex-chat-runtime')
  expect(entries.slice(at - 1, at + 1))
    .toEqual([[12, 'provider-limit-window'], [13, 'codex-chat-runtime']])
})

test('a predecessor database keeps its chats: the migration adds the columns and legacy rows read Claude', () => {
  predecessorWithChat().close()
  const session = initDatabase({ path: dbPath })
  const names = (session.db.prepare("SELECT name FROM pragma_table_info('chat_sessions') WHERE name IN ('runtime','codex_home','transcript_path')").all() as Array<{ name: string }>)
    .map(row => row.name)
  expect(names).toEqual(['runtime', 'codex_home', 'transcript_path'])
  const row = session.getChatSessions().find(row => row.sessionId === 'chat-legacy')
  expect(row?.runtime).toBe('claude')
  expect(row?.codexHome).toBeNull()
  expect(row?.transcriptPath).toBeNull()
})

test('a fresh database has the columns, and a codex row round-trips runtime and home with the transcript path on the update path', () => {
  const session = initDatabase({ path: dbPath })
  session.insertChatSession({
    ...BASE_CHAT,
    sessionId: 'chat-codex',
    name: 'Codex',
    projectPath: '/tmp/codex',
    runtime: 'codex',
    codexHome: '/home/smoke/.codex',
  })
  const row = session.getChatSessions().find(row => row.sessionId === 'chat-codex')
  expect(row?.runtime).toBe('codex')
  expect(row?.codexHome).toBe('/home/smoke/.codex')
  // The transcript path arrives once the driver's thread reveals it (§5);
  // runtime and home have no patch path — they are creation-fixed.
  session.updateChatSession('chat-codex', { transcriptPath: '/home/smoke/.codex/sessions/thread.jsonl' })
  expect(session.getChatSessions().find(row => row.sessionId === 'chat-codex')?.transcriptPath)
    .toBe('/home/smoke/.codex/sessions/thread.jsonl')
  expect(session.db.prepare("SELECT name FROM pragma_table_info('chat_sessions')").all())
    .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'codex_home' })]))
})
