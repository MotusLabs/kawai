// The only SQL writer of the audit tables (execution-safety-recovery D6):
// append-only — this class exposes no update or delete, and no other module
// writes them. Calls dedupe on `(session_id, tool_use_id)` and outcomes on
// `(session_id, tool_use_id, outcome)` (both `INSERT OR IGNORE`), so the
// second report of one tool use is a no-op and an outcome that lands before
// its queued call row is kept and joins once the row exists. Rows are never
// pruned. Reads keyset-page newest first with the verdict, rule, session,
// and time filters the Audit view layers on (D9).
import type { Database, SQLQueryBindings } from 'bun:sqlite'

/** One recorded send (D6 columns; `matches` stays its JSON string here). */
export interface OutboundCallInsert {
  id: string
  teamId: string
  sessionId: string
  spawnId: string
  groupId?: string
  profileId?: string
  taskId?: string
  agentId?: string
  tool: string
  mcpServer?: string
  toolUseId: string
  command: string
  truncated: boolean
  rule: string
  verdict: string
  destination: string
  matches: string
  classifierVersion: number
  cwd: string
  createdAt: string
}

export interface OutboundCallRow extends Omit<OutboundCallInsert, 'truncated'> {
  truncated: boolean
}

export interface OutboundOutcomeInsert {
  sessionId: string
  toolUseId: string
  outcome: 'completed' | 'failed' | 'denied' | 'started-background'
  detail?: string
  durationMs?: number
  createdAt: string
}

export interface OutboundCallFilters {
  teamId: string
  verdict?: string
  rule?: string
  sessionId?: string
  /** Inclusive ISO stamp the time range starts at. */
  from?: string
  /** Exclusive ISO stamp the time range ends at. */
  to?: string
}

export interface OutboundCallPage {
  rows: OutboundCallRow[]
  /** The next page's cursor, null at the end; opaque to the client. */
  cursor: string | null
}

const CALL_COLUMNS = 'id, team_id, session_id, spawn_id, group_id, profile_id, task_id, agent_id, tool, mcp_server, tool_use_id, command, truncated, rule, verdict, destination, matches, classifier_version, cwd, created_at'

const toRow = (raw: Record<string, unknown>): OutboundCallRow => ({
  id: raw.id as string,
  teamId: raw.team_id as string,
  sessionId: raw.session_id as string,
  spawnId: raw.spawn_id as string,
  groupId: (raw.group_id as string | null) ?? undefined,
  profileId: (raw.profile_id as string | null) ?? undefined,
  taskId: (raw.task_id as string | null) ?? undefined,
  agentId: (raw.agent_id as string | null) ?? undefined,
  tool: raw.tool as string,
  mcpServer: (raw.mcp_server as string | null) ?? undefined,
  toolUseId: raw.tool_use_id as string,
  command: raw.command as string,
  truncated: (raw.truncated as number) === 1,
  rule: raw.rule as string,
  verdict: raw.verdict as string,
  destination: raw.destination as string,
  matches: raw.matches as string,
  classifierVersion: raw.classifier_version as number,
  cwd: raw.cwd as string,
  createdAt: raw.created_at as string,
})

export class OutboundStore {
  constructor(private readonly db: Database) {}

  /** Append one call; a repeat of the same tool use writes nothing. */
  insertCall(row: OutboundCallInsert): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO outbound_calls (${CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id, row.teamId, row.sessionId, row.spawnId,
        row.groupId ?? null, row.profileId ?? null, row.taskId ?? null, row.agentId ?? null,
        row.tool, row.mcpServer ?? null, row.toolUseId,
        row.command, row.truncated ? 1 : 0,
        row.rule, row.verdict, row.destination, row.matches, row.classifierVersion,
        row.cwd, row.createdAt,
      )
  }

  /** Append one outcome; a repeat of the same outcome writes nothing. */
  insertOutcome(row: OutboundOutcomeInsert): void {
    this.db
      .prepare('INSERT OR IGNORE INTO outbound_outcomes (session_id, tool_use_id, outcome, detail, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.sessionId, row.toolUseId, row.outcome, row.detail ?? null, row.durationMs ?? null, row.createdAt)
  }

  /** One call by id, for the view's row link (D9). */
  callById(id: string): OutboundCallRow | null {
    const raw = this.db.prepare(`SELECT ${CALL_COLUMNS} FROM outbound_calls WHERE id = ?`).get(id)
    return raw === undefined || raw === null ? null : toRow(raw as Record<string, unknown>)
  }

  /** A call's outcomes, for the read-time state (D7). */
  outcomesOf(sessionId: string, toolUseId: string): Array<{ outcome: string; detail: string | null }> {
    const rows = this.db
      .prepare('SELECT outcome, detail FROM outbound_outcomes WHERE session_id = ? AND tool_use_id = ?')
      .all(sessionId, toolUseId) as Array<{ outcome: string; detail: string | null }>
    return rows
  }

  /** Newest first, keyset-paged over `(created_at, id)`, with the D9 filters. */
  page(filters: OutboundCallFilters, limit = 50, cursor?: string | null): OutboundCallPage {
    const where: string[] = ['team_id = ?']
    const args: SQLQueryBindings[] = [filters.teamId]
    if (filters.verdict !== undefined) { where.push('verdict = ?'); args.push(filters.verdict) }
    if (filters.rule !== undefined) { where.push('rule = ?'); args.push(filters.rule) }
    if (filters.sessionId !== undefined) { where.push('session_id = ?'); args.push(filters.sessionId) }
    if (filters.from !== undefined) { where.push('created_at >= ?'); args.push(filters.from) }
    if (filters.to !== undefined) { where.push('created_at < ?'); args.push(filters.to) }
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      const split = cursor.indexOf('\u0000')
      const createdAt = cursor.slice(0, split)
      const id = cursor.slice(split + 1)
      where.push('(created_at < ? OR (created_at = ? AND id < ?))')
      args.push(createdAt, createdAt, id)
    }
    const rows = this.db
      .prepare(`SELECT ${CALL_COLUMNS} FROM outbound_calls WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1) as Array<Record<string, unknown>>
    const page = rows.slice(0, limit).map(toRow)
    const last = page.at(-1)
    return {
      rows: page,
      cursor: rows.length > limit && last !== undefined ? `${last.createdAt}\u0000${last.id}` : null,
    }
  }
}
