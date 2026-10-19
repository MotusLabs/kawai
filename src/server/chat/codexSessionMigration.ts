// Migration `codex-chat-runtime` (codex-chat-sessions 3.3, ruling R1):
// each chat's agent runtime, fixed at creation, as a column defaulting to
// `claude` so chats created before runtimes existed restore as Claude; the
// resolved Codex home a Codex chat was created against (re-checked at every
// start, never shown to the user); and the Codex transcript file path the
// driver records once its thread reveals it (§5). Additive, no backfill.
//
// The version is the next free one in the master this branch has merged
// (the registry must stay dense) and is renumbered at a later master merge
// per the standing MIGRATIONS rule.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

// Renumbered at the master merge: master's 13 is integration-candidates and
// its 14 process-observation-indexes; codex-chat-sessions lands as the next
// free version.
export const CODEX_SESSION_MIGRATION_VERSION = 15

export function applyCodexSessionColumns(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'runtime')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude'")
  }
  if (!columns.some(column => column.name === 'codex_home')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN codex_home TEXT')
  }
  if (!columns.some(column => column.name === 'transcript_path')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN transcript_path TEXT')
  }
}

export const codexSessionMigration: Migration = {
  version: CODEX_SESSION_MIGRATION_VERSION,
  name: 'codex-chat-runtime',
  up: applyCodexSessionColumns,
}
