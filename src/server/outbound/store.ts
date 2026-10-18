// The only SQL writer of the audit calls, outcomes, and acknowledgements
// (execution-safety-recovery D6, D10): append-only — this class exposes no
// update or delete, and no other module writes them. Calls dedupe on
// `(session_id, tool_use_id)` and outcomes on
// `(session_id, tool_use_id, outcome)` (both `INSERT … ON CONFLICT DO
// NOTHING`), so the second report of one tool use is a no-op and an outcome
// that lands before its deferred call row is kept and joins once the row
// exists. Acknowledgements are idempotent under `(team_id, command_id)`.
// Rows are never pruned. Reads keyset-page newest first with the verdict,
// rule, session, and time filters the Audit view layers on (D9).
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
  destination?: string
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

/**
 * D10's coverage test, aliased to the call table as `c`: an acknowledgement
 * of the same (team, rule, destination) whose `through_*` position is at or
 * after the call's covers it. Shared by the counts and the attention rows.
 */
const UNACKNOWLEDGED_EXISTS = `SELECT 1 FROM outbound_acknowledgements a
  WHERE a.team_id = c.team_id AND a.rule = c.rule AND a.destination = c.destination
    AND (a.through_created_at > c.created_at OR (a.through_created_at = c.created_at AND a.through_call_id >= c.id))`

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

/** One recorded acknowledgement (D10): covers a group through one call. */
export interface OutboundAcknowledgementInsert {
  id: string
  teamId: string
  commandId: string
  rule: string
  destination: string
  throughCreatedAt: string
  throughCallId: string
  note?: string
  acknowledgedAt: string
}

export interface OutboundAcknowledgement {
  id: string
  teamId: string
  commandId: string
  rule: string
  destination: string
  throughCreatedAt: string
  throughCallId: string
  note?: string
  acknowledgedAt: string
}

const toAcknowledgement = (raw: Record<string, unknown>): OutboundAcknowledgement => ({
  id: raw.id as string,
  teamId: raw.team_id as string,
  commandId: raw.command_id as string,
  rule: raw.rule as string,
  destination: raw.destination as string,
  throughCreatedAt: raw.through_created_at as string,
  throughCallId: raw.through_call_id as string,
  ...(raw.note === null || raw.note === undefined ? {} : { note: raw.note as string }),
  acknowledgedAt: raw.acknowledged_at as string,
})

export class OutboundStore {
  constructor(private readonly db: Database) {}

  /**
   * Append one call. A repeat of the same tool use writes nothing
   * (`changes` 0); anything else — a failed constraint, a null — throws,
   * because `ON CONFLICT` catches only the key, never a broken row.
   */
  insertCall(row: OutboundCallInsert): boolean {
    const result = this.db
      .prepare(`INSERT INTO outbound_calls (${CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, tool_use_id) DO NOTHING`)
      .run(
        row.id, row.teamId, row.sessionId, row.spawnId,
        row.groupId ?? null, row.profileId ?? null, row.taskId ?? null, row.agentId ?? null,
        row.tool, row.mcpServer ?? null, row.toolUseId,
        row.command, row.truncated ? 1 : 0,
        row.rule, row.verdict, row.destination, row.matches, row.classifierVersion,
        row.cwd, row.createdAt,
      )
    return result.changes === 1
  }

  /** Append one outcome; a repeat of the same outcome writes nothing. */
  insertOutcome(row: OutboundOutcomeInsert): boolean {
    const result = this.db
      .prepare('INSERT INTO outbound_outcomes (session_id, tool_use_id, outcome, detail, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, tool_use_id, outcome) DO NOTHING')
      .run(row.sessionId, row.toolUseId, row.outcome, row.detail ?? null, row.durationMs ?? null, row.createdAt)
    return result.changes === 1
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
    if (filters.destination !== undefined) { where.push('destination = ?'); args.push(filters.destination) }
    if (filters.sessionId !== undefined) { where.push('session_id = ?'); args.push(filters.sessionId) }
    if (filters.from !== undefined) { where.push('created_at >= ?'); args.push(filters.from) }
    if (filters.to !== undefined) { where.push('created_at < ?'); args.push(filters.to) }
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      const split = cursor.indexOf('\u0000')
      if (split === -1 || split === cursor.length - 1) throw new Error('invalid page cursor')
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

  /**
   * The Audit tab's header counts (D9): over the team's rows in the time
   * range only — never the verdict, rule, or session filters, or the counts
   * could not show allowed sends beside a violations-only list. The
   * unacknowledged figure joins the acknowledgements: a violation covered by
   * an acknowledgement of its group through it (D10's `through_*` at or
   * after the call's `(created_at, id)`) does not count.
   */
  counts(teamId: string, from?: string, to?: string): {
    allowedPerRule: Record<string, number>; unknown: number; violations: number; unacknowledgedViolations: number
  } {
    const range: string[] = []
    const args: SQLQueryBindings[] = [teamId]
    if (from !== undefined) { range.push('AND created_at >= ?'); args.push(from) }
    if (to !== undefined) { range.push('AND created_at < ?'); args.push(to) }
    const rows = this.db
      .prepare(`SELECT verdict, rule, COUNT(*) AS n FROM outbound_calls WHERE team_id = ? ${range.join(' ')} GROUP BY verdict, rule`)
      .all(...args) as Array<{ verdict: string; rule: string; n: number }>
    const counts = { allowedPerRule: {} as Record<string, number>, unknown: 0, violations: 0, unacknowledgedViolations: 0 }
    for (const row of rows) {
      if (row.verdict === 'allowed') counts.allowedPerRule[row.rule] = (counts.allowedPerRule[row.rule] ?? 0) + row.n
      else if (row.verdict === 'unknown-destination') counts.unknown += row.n
      else if (row.verdict === 'violation') counts.violations += row.n
    }
    counts.unacknowledgedViolations = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM outbound_calls c WHERE c.team_id = ? AND c.verdict = 'violation'
        ${range.map(condition => condition.replace('created_at', 'c.created_at')).join(' ')}
        AND NOT EXISTS (${UNACKNOWLEDGED_EXISTS})`)
      .get(...args) as { n: number } | undefined)?.n ?? 0
    return counts
  }

  /**
   * The attention source's rows (D10): every unacknowledged violation of the
   * team, newest first — the caller groups them by `(rule, destination)`.
   * No time range: the queue shows the current state, whatever its age.
   */
  unacknowledgedViolations(teamId: string): OutboundCallRow[] {
    const rows = this.db
      .prepare(`SELECT ${CALL_COLUMNS} FROM outbound_calls c WHERE c.team_id = ? AND c.verdict = 'violation'
        AND NOT EXISTS (${UNACKNOWLEDGED_EXISTS}) ORDER BY c.created_at DESC, c.id DESC`)
      .all(teamId) as Array<Record<string, unknown>>
    return rows.map(toRow)
  }

  /** One call by session and tool use, for the outcome commit's team (D7 join). */
  callByToolUse(sessionId: string, toolUseId: string): OutboundCallRow | null {
    const raw = this.db
      .prepare(`SELECT ${CALL_COLUMNS} FROM outbound_calls WHERE session_id = ? AND tool_use_id = ?`)
      .get(sessionId, toolUseId)
    return raw === undefined || raw === null ? null : toRow(raw as Record<string, unknown>)
  }

  /**
   * The acknowledgement a command id produced, for D10's replay: the same
   * payload returns it, a different one is refused naming the field.
   */
  acknowledgementByCommand(teamId: string, commandId: string): OutboundAcknowledgement | null {
    const raw = this.db
      .prepare('SELECT id, team_id, command_id, rule, destination, through_created_at, through_call_id, note, acknowledged_at FROM outbound_acknowledgements WHERE team_id = ? AND command_id = ?')
      .get(teamId, commandId)
    return raw === undefined || raw === null ? null : toAcknowledgement(raw as Record<string, unknown>)
  }

  /** Run `work` in one immediate transaction (the replay-then-insert pair). */
  exclusively<T>(work: () => T): T {
    return this.db.transaction(work).immediate()
  }

  /** Append one acknowledgement (D10); a repeat of the command id writes nothing. */
  insertAcknowledgement(row: OutboundAcknowledgementInsert): OutboundAcknowledgement | null {
    const result = this.db
      .prepare('INSERT INTO outbound_acknowledgements (id, team_id, command_id, rule, destination, through_created_at, through_call_id, note, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(team_id, command_id) DO NOTHING')
      .run(row.id, row.teamId, row.commandId, row.rule, row.destination, row.throughCreatedAt, row.throughCallId, row.note ?? null, row.acknowledgedAt)
    if (result.changes !== 1) return null
    return {
      id: row.id, teamId: row.teamId, commandId: row.commandId, rule: row.rule, destination: row.destination,
      throughCreatedAt: row.throughCreatedAt, throughCallId: row.throughCallId,
      ...(row.note !== undefined ? { note: row.note } : {}), acknowledgedAt: row.acknowledgedAt,
    }
  }
}
