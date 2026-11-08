// Contract columns (implementation-contract design D3), migration 23:
// additive and nullable, with no backfill (I4). `team_task_revisions` gains
// the contract's normal form as JSON and its sha256; both are null for a
// revision without a contract, whose text identity is computed on read.
// `team_task_drafts` gains the human's raw contract text, which may not
// parse yet, so a half-edited draft survives restart.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

const COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['team_task_revisions', 'contract'],
  ['team_task_revisions', 'contract_hash'],
  ['team_task_drafts', 'contract_text'],
]

export function applyTaskContractSchema(db: Database): void {
  for (const [table, column] of COLUMNS) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))
    if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
  }
}

export const TASK_CONTRACT_MIGRATION_VERSION = 23
export const taskContractMigration: Migration = {
  version: TASK_CONTRACT_MIGRATION_VERSION,
  name: 'task-contracts',
  up: applyTaskContractSchema,
}
