// The plan workspace's repository role bindings (plan-workspace design D6,
// task 1.2) and their keyed-command ledger (D4's bind command; ref commands
// join the ledger as they land). The store reads and writes only: team
// scoping and session validation belong to the connection that resolves the
// team, availability to the snapshot builder, and rights to nobody — a
// binding grants nothing.
//
// CAS and replay (D6): a bind carries the `version` the binder saw (null =
// unbound) and a command id. Inside one transaction the ledger is consulted
// first — the same payload returns the recorded outcome and writes nothing,
// a different payload is refused naming the first differing field — then the
// CAS is compared and the row written with `version = prior + 1`. A refusal
// writes nothing anywhere, so the same command id resent after the state
// changes is evaluated afresh. There is no unbind and this file has no
// DELETE for `plan_workspace_chats`: the version only grows.
import type { Database } from 'bun:sqlite'
import { ledgerLookup, ledgerRecord } from './commandLedger'
import type { PlanWorkspaceRole, WorkspaceBindPayload } from '../../../shared/planWorkspace'
import { parseWorkspaceRole } from '../../../shared/planWorkspace'

export interface StoredWorkspaceBinding {
  teamId: string
  role: PlanWorkspaceRole
  sessionId: string
  version: number
  boundAt: string
}

export type WorkspaceBindOutcome =
  | { ok: true; replayed: boolean; role: PlanWorkspaceRole; sessionId: string; version: number }
  | { ok: false; reason: 'invalid' | 'stale' | 'session' | 'payload'; message: string; field?: string }

type Row = Record<string, unknown>

/** Thrown inside the bind transaction to refuse it and roll back. */
class BindConflict extends Error {
  constructor(readonly reason: 'stale' | 'session', message: string, readonly field: string) {
    super(message)
  }
}

/** Map a racing writer's constraint error: the role's key means the CAS lost, the session key the duplicate. Exported for the store test's direct coverage of both mappings. */
export function mapConstraint(error: unknown): BindConflict | null {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('UNIQUE constraint failed')) return null
  return message.includes('session_id')
    ? new BindConflict('session', 'That session is already bound to the other role of this team.', 'sessionId')
    : new BindConflict('stale', 'Another bind of this role committed first; re-read the workspace and retry.', 'expectedVersion')
}

export class PlanWorkspaceStore {
  constructor(private readonly db: Database) {}

  /**
   * One keyed bind, in one transaction: replay first, then CAS, then the row
   * and the ledger row together. A throwing CAS rolls everything back.
   */
  bind(teamId: string, commandId: string, payload: WorkspaceBindPayload, now = new Date().toISOString()): WorkspaceBindOutcome {
    const role = parseWorkspaceRole(payload.role)
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
    const expected = payload.expectedVersion
    if (!role || sessionId === '' || (expected !== null && typeof expected !== 'number')) {
      return { ok: false, reason: 'invalid', field: 'payload', message: 'A bind needs a role (architect or lead), a session id, and the version the binder saw (null when unbound).' }
    }
    const id = typeof commandId === 'string' ? commandId.trim() : ''
    if (id === '') return { ok: false, reason: 'invalid', field: 'commandId', message: 'A bind needs a stable command id so a resend replays instead of repeating.' }
    const clean: WorkspaceBindPayload = { role, sessionId, expectedVersion: expected }
    try {
      return this.db.transaction((): WorkspaceBindOutcome => {
        const outcome = { role, sessionId }
        const ledger = ledgerLookup<{ role: PlanWorkspaceRole; sessionId: string; version: number }>(
          this.db, teamId, id, 'bind', clean as unknown as Record<string, unknown>)
        if (ledger) {
          return ledger.ok ? { ok: true, replayed: true, ...ledger.value } : { ...ledger }
        }
        const version = this.writeBinding(teamId, clean, now)
        const recorded = { ...outcome, version }
        ledgerRecord(this.db, teamId, id, 'bind', clean as unknown as Record<string, unknown>, recorded, now)
        return { ok: true, replayed: false, ...recorded }
      })()
    } catch (error) {
      if (error instanceof BindConflict) {
        return { ok: false, reason: error.reason, field: error.field, message: error.message }
      }
      const mapped = mapConstraint(error)
      if (mapped) return { ok: false, reason: mapped.reason, field: mapped.field, message: mapped.message }
      throw error
    }
  }

  /** Both roles' rows, architect first (the snapshot's order). */
  bindings(teamId: string): StoredWorkspaceBinding[] {
    const rows = this.db.prepare('SELECT * FROM plan_workspace_chats WHERE team_id = ? ORDER BY role').all(teamId) as Row[]
    return rows.map(row => this.toBinding(row))
  }

  binding(teamId: string, role: PlanWorkspaceRole): StoredWorkspaceBinding | null {
    const row = this.db.prepare('SELECT * FROM plan_workspace_chats WHERE team_id = ? AND role = ?').get(teamId, role) as Row | null
    return row ? this.toBinding(row) : null
  }

  /**
   * The CAS write: compare the expected version against the row (null =
   * unbound), then insert with version 1 or update to prior + 1. A racing
   * writer's constraint error is mapped, never escaped raw.
   */
  private writeBinding(teamId: string, { role, sessionId, expectedVersion }: WorkspaceBindPayload, now: string): number {
    const stale = (bound: number | null) => new BindConflict('stale',
      bound === null
        ? `expectedVersion ${expectedVersion} does not match the unbound role; re-read the workspace and retry.`
        : `expectedVersion ${expectedVersion} does not match the bound version ${bound}; re-read the workspace and retry.`,
      'expectedVersion')
    const row = this.db.prepare('SELECT version FROM plan_workspace_chats WHERE team_id = ? AND role = ?').get(teamId, role) as Row | null
    try {
      if (row === null) {
        if (expectedVersion !== null) throw stale(null)
        this.db.prepare('INSERT INTO plan_workspace_chats (team_id, role, session_id, version, bound_at) VALUES (?, ?, ?, 1, ?)')
          .run(teamId, role, sessionId, now)
        return 1
      }
      const current = Number(row.version)
      if (expectedVersion !== current) throw stale(current)
      this.db.prepare('UPDATE plan_workspace_chats SET session_id = ?, version = version + 1, bound_at = ? WHERE team_id = ? AND role = ?')
        .run(sessionId, now, teamId, role)
      return current + 1
    } catch (error) {
      if (error instanceof BindConflict) throw error
      const mapped = mapConstraint(error)
      if (mapped) throw mapped
      throw error
    }
  }

  private toBinding(row: Row): StoredWorkspaceBinding {
    const role = String(row.role) as PlanWorkspaceRole
    return {
      teamId: String(row.team_id),
      role: role === 'lead' ? 'lead' : 'architect',
      sessionId: String(row.session_id),
      version: Number(row.version),
      boundAt: String(row.bound_at),
    }
  }
}
