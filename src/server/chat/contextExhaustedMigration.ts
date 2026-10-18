// Migration 10 `context-exhausted` (chat-context-exhaustion D3): the session
// flag set when a turn fails on a context limit, as two nullable columns on
// `chat_sessions` — when it was flagged and the CLI's terminal reason. Old
// rows read as not flagged. Additive, no backfill; frozen once applied.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

export function applyContextExhaustedColumns(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'context_exhausted_at')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN context_exhausted_at TEXT')
  }
  if (!columns.some(column => column.name === 'context_exhausted_reason')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN context_exhausted_reason TEXT')
  }
}

export const contextExhaustedMigration: Migration = {
  version: 10,
  name: 'context-exhausted',
  up: applyContextExhaustedColumns,
}
