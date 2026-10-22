// The plan workspace's per-message context (plan-workspace 1.2, design D7,
// invariant I4): one immutable accepted envelope per user message, keyed
// (session_id, message_uuid); the turn id groups only and never keys
// anything. An identical re-insert is a no-op; a different context for the
// same key is refused and the first row stands — there is no OR IGNORE.
// Rows survive a session kill and are never pruned: this store has no
// UPDATE and no DELETE. Chat delivery (who records, when) is PR D §4.
import type { Database } from 'bun:sqlite'
import type { WorkspaceMessageContext } from '../../../shared/planWorkspace'

export interface StoredWorkspaceContext {
  sessionId: string
  messageUuid: string
  /** Grouping only (several user messages can share an active turn). */
  turnId: string | null
  context: WorkspaceMessageContext
  recordedAt: string
}

export type WorkspaceContextOutcome =
  | { ok: true; recorded: boolean }
  | { ok: false; reason: 'invalid' | 'conflict'; message: string }

type Row = Record<string, unknown>

export class PlanWorkspaceContext {
  constructor(private readonly db: Database) {}

  /**
   * Record the accepted envelope for one user message, in one transaction:
   * read the key, keep the first row on a differing re-insert, and treat an
   * identical re-insert (a replay of the same message) as a no-op.
   */
  record(input: { sessionId: string; messageUuid: string; turnId: string | null; context: WorkspaceMessageContext }, now = new Date().toISOString()): WorkspaceContextOutcome {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    const messageUuid = typeof input.messageUuid === 'string' ? input.messageUuid.trim() : ''
    if (sessionId === '' || messageUuid === '') {
      return { ok: false, reason: 'invalid', message: 'A context record needs the session id and the message UUID it belongs to.' }
    }
    return this.db.transaction((): WorkspaceContextOutcome => {
      const stored = this.db.prepare('SELECT context_json FROM chat_workspace_turn_context WHERE session_id = ? AND message_uuid = ?')
        .get(sessionId, messageUuid) as Row | null
      if (stored) {
        const previous = String(stored.context_json)
        if (previous === JSON.stringify(input.context)) return { ok: true, recorded: false }
        return { ok: false, reason: 'conflict', message: `Message ${messageUuid} already carries a different context; the first record stands.` }
      }
      this.db.prepare('INSERT INTO chat_workspace_turn_context (session_id, message_uuid, turn_id, context_json, team_id, plan_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sessionId, messageUuid, input.turnId, JSON.stringify(input.context), input.context.teamId, input.context.planId, now)
      return { ok: true, recorded: true }
    })()
  }

  /** The recorded context for one message, or null. */
  contextOf(sessionId: string, messageUuid: string): StoredWorkspaceContext | null {
    const row = this.db.prepare('SELECT * FROM chat_workspace_turn_context WHERE session_id = ? AND message_uuid = ?')
      .get(sessionId, messageUuid) as Row | null
    if (!row) return null
    return {
      sessionId: String(row.session_id),
      messageUuid: String(row.message_uuid),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      context: JSON.parse(String(row.context_json)) as WorkspaceMessageContext,
      recordedAt: String(row.recorded_at),
    }
  }

  /** Every context recorded for one turn, in insertion order (grouping only). */
  contextsOfTurn(sessionId: string, turnId: string): StoredWorkspaceContext[] {
    const rows = this.db.prepare('SELECT * FROM chat_workspace_turn_context WHERE session_id = ? AND turn_id = ? ORDER BY rowid').all(sessionId, turnId) as Row[]
    return rows.map(row => this.contextOf(String(row.session_id), String(row.message_uuid))!)
  }
}
