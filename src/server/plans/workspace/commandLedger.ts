// The plan workspace's keyed-command ledger (plan-workspace I3, design D4):
// every command — bind, ref-add, ref-remove — replays by (team_id,
// command_id). The same kind and payload returns the recorded outcome and
// writes nothing; a different kind or payload is refused naming the field;
// a refusal (or any throw) records no ledger row, so the same command id
// resent after the state changes is evaluated afresh. Rows are never pruned.
import type { Database } from 'bun:sqlite'
import { firstDifferingField } from '../../metrics/reportStore'

export type LedgerOutcome<T> =
  | { ok: true; replayed: boolean; value: T }
  | { ok: false; reason: 'payload'; field: string; message: string }

/**
 * Look the command id up in the ledger: the stored outcome returns untouched
 * on an identical kind and payload, a drift refuses naming the first
 * differing field (kind compared first), and no row reads as null.
 */
export function ledgerLookup<T>(db: Database, teamId: string, commandId: string, kind: string, payload: Record<string, unknown>): LedgerOutcome<T> | null {
  const stored = db.prepare('SELECT kind, payload, outcome FROM plan_workspace_commands WHERE team_id = ? AND command_id = ?')
    .get(teamId, commandId) as Record<string, unknown> | null
  if (!stored) return null
  const recorded = JSON.parse(String(stored.payload)) as Record<string, unknown>
  const field = String(stored.kind) !== kind ? 'kind' : firstDifferingField(recorded, payload)
  if (field) return { ok: false, reason: 'payload', field, message: `Command key ${commandId} was already used with a different ${field}.` }
  return { ok: true, replayed: true, value: JSON.parse(String(stored.outcome)) as T }
}

/** Record a committed command's outcome. Called only after the write itself succeeded. */
export function ledgerRecord(db: Database, teamId: string, commandId: string, kind: string, payload: Record<string, unknown>, value: unknown, now: string): void {
  db.prepare('INSERT INTO plan_workspace_commands (team_id, command_id, kind, payload, outcome, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(teamId, commandId, kind, JSON.stringify(payload), JSON.stringify(value), now)
}
