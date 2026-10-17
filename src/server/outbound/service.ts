// The audit view's reads and the one human command (execution-safety-recovery
// D9, D10). Reads are projections over `OutboundStore` — the only writer of
// the audit tables — with the row enrichment the view layers on: matches
// parsed from their stored JSON, the outcome state derived at read time (D7),
// and the session named through the manager's records and durable directory
// (`Name (gone)`, clickable only while the session lives or is archived).
// The command path refuses an agent caller first; nothing here ever blocks,
// re-runs, or re-judges a recorded call.
import type {
  OutboundAuditBackups,
  OutboundAuditFilters,
  OutboundAuditPage,
  OutboundAuditRow,
  OutboundMatch,
} from '../../shared/outbound'
export type { OutboundAuditBackups }
import type { TeamIdentity } from '../team/teamIdentity'
import { outcomeState } from './outcomeState'
import type { OutboundCallInsert, OutboundCallRow, OutboundOutcomeInsert, OutboundStore } from './store'

/** Who may act on the audit records: the human owner, never an agent (D10). */
export type OutboundCaller = { kind: 'agent'; sessionId: string } | { kind: 'human'; team: TeamIdentity }

export interface OutboundServiceOptions {
  store: OutboundStore
  /** A session's display name and whether its chat may be opened (D9). */
  sessionOf: (teamId: string, sessionId: string) => { name: string; clickable: boolean }
  /** Whether the agent process that made a call still lives (D7's pending). */
  spawnLive: (sessionId: string, spawnId: string) => boolean
  /** The backup status footer's facts; null when backups are off. */
  backups?: () => OutboundAuditBackups | null
  /** A committed row of the team: the changed push and the attention refresh. */
  onCommit?: (teamId: string) => void
}

/** One `(rule, destination)` group of unacknowledged violations (D10). */
export interface OutboundViolationGroup {
  rule: string
  destination: string
  count: number
  /** The newest violation's call: the item's link target and latest session. */
  latestCallId: string
  latestSessionId: string
  latestCallAt: string
}

/** D10's acknowledge: the prior result on a replay, a named refusal otherwise. */
export type OutboundAcknowledgeOutcome =
  | { ok: true; replayed: boolean }
  | { ok: false; reason: 'forbidden' | 'invalid' | 'not-found' | 'payload'; message: string }

/** The acknowledgement note's bound (the migration's column comment). */
export const ACKNOWLEDGEMENT_NOTE_MAX = 300

const parseMatches = (json: string): OutboundMatch[] => {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter(entry =>
      typeof entry === 'object' && entry !== null && 'rule' in entry) as OutboundMatch[] : []
  } catch {
    return []
  }
}

export class OutboundService {
  constructor(private readonly options: OutboundServiceOptions) {}

  /** One page of the view, rows newest first, with the range's counts (D9). */
  page(teamId: string, filters: OutboundAuditFilters, cursor?: string | null): OutboundAuditPage {
    const rows = this.options.store.page(
      {
        teamId,
        ...(filters.verdict !== undefined ? { verdict: filters.verdict } : {}),
        ...(filters.rule !== undefined ? { rule: filters.rule } : {}),
        ...(filters.sessionId !== undefined ? { sessionId: filters.sessionId } : {}),
        ...(filters.from !== undefined ? { from: filters.from } : {}),
        ...(filters.to !== undefined ? { to: filters.to } : {}),
      },
      50,
      cursor,
    )
    return {
      rows: rows.rows.map(row => this.viewRow(row)),
      counts: this.options.store.counts(teamId, filters.from, filters.to),
      cursor: rows.cursor,
      backups: this.options.backups?.() ?? null,
    }
  }

  /** One row enriched for the view: matches, outcome state, named session. */
  private viewRow(row: OutboundCallRow): OutboundAuditRow {
    const session = this.options.sessionOf(row.teamId, row.sessionId)
    const outcomes = this.options.store.outcomesOf(row.sessionId, row.toolUseId)
    const state = outcomeState({ outcomes, spawnLive: this.options.spawnLive(row.sessionId, row.spawnId) })
    const detail = outcomes.find(entry => entry.detail !== null)?.detail ?? undefined
    return {
      id: row.id,
      createdAt: row.createdAt,
      verdict: row.verdict,
      rule: row.rule,
      destination: row.destination,
      command: row.command,
      truncated: row.truncated,
      tool: row.tool,
      ...(row.mcpServer !== undefined ? { mcpServer: row.mcpServer } : {}),
      ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
      ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
      ...(row.profileId !== undefined ? { profileId: row.profileId } : {}),
      ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
      cwd: row.cwd,
      classifierVersion: row.classifierVersion,
      matches: parseMatches(row.matches),
      outcome: { state, ...(detail !== undefined ? { detail } : {}) },
      session: { id: row.sessionId, ...session },
    }
  }

  /**
   * The attention source's groups (D10): one per `(rule, destination)` with
   * unacknowledged violations, newest call first within a group.
   */
  violationGroups(teamId: string): OutboundViolationGroup[] {
    const groups = new Map<string, OutboundViolationGroup>()
    for (const row of this.options.store.unacknowledgedViolations(teamId)) {
      const key = `${row.rule}\u0000${row.destination}`
      const existing = groups.get(key)
      if (existing) {
        existing.count += 1
        continue
      }
      groups.set(key, {
        rule: row.rule, destination: row.destination, count: 1,
        latestCallId: row.id, latestSessionId: row.sessionId, latestCallAt: row.createdAt,
      })
    }
    return [...groups.values()]
  }

  /** The morning summary's `outbound` bucket counts over its window (D10). */
  windowCounts(teamId: string, from: string, to: string): { allowed: number; unknown: number; violations: number } {
    const counts = this.options.store.counts(teamId, from, to)
    const allowed = Object.values(counts.allowedPerRule).reduce((sum, n) => sum + n, 0)
    return { allowed, unknown: counts.unknown, violations: counts.violations }
  }

  /**
   * D10: the owner acknowledges one violation call, covering its
   * `(rule, destination)` group through that call. An agent caller is
   * refused first and nothing is written; then one transaction replays by
   * `(team_id, command_id)` — the same call and note return the prior
   * result, a different payload is refused naming the field — checks the
   * call is the team's (another team's reads as not found) and a violation,
   * and inserts one row. Acknowledged calls keep their rows and verdicts.
   */
  acknowledge(
    caller: OutboundCaller,
    input: { callId: string; commandId: string; note?: string },
  ): OutboundAcknowledgeOutcome {
    if (caller.kind !== 'human') {
      return {
        ok: false, reason: 'forbidden',
        message: 'Only the human (the owner) can acknowledge a violation, from the Audit tab. No agent tool can, and an agent call writes nothing.',
      }
    }
    const commandId = input.commandId.trim()
    if (commandId === '') {
      return { ok: false, reason: 'invalid', message: 'An acknowledgement needs a stable command id so a resend replays instead of repeating.' }
    }
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (note.length > ACKNOWLEDGEMENT_NOTE_MAX) {
      return { ok: false, reason: 'invalid', message: `The note is at most ${ACKNOWLEDGEMENT_NOTE_MAX} characters; nothing was written.` }
    }
    const teamId = caller.team.teamId
    const store = this.options.store
    const replay = (): OutboundAcknowledgeOutcome | null => {
      const recorded = store.acknowledgementByCommand(teamId, commandId)
      if (!recorded) return null
      if (recorded.throughCallId !== input.callId) {
        return { ok: false, reason: 'payload', message: `command_id ${commandId} was already used with a different callId; the recorded acknowledgement stands and nothing was written.` }
      }
      if ((recorded.note ?? '') !== note) {
        return { ok: false, reason: 'payload', message: `command_id ${commandId} was already used with a different note; the recorded acknowledgement stands and nothing was written.` }
      }
      return { ok: true, replayed: true }
    }
    let committed = false
    try {
      const outcome = store.exclusively((): OutboundAcknowledgeOutcome => {
        const prior = replay()
        if (prior) return prior
        const call = store.callById(input.callId)
        if (call === null || call.teamId !== teamId) {
          return { ok: false, reason: 'not-found', message: `Call not found in this team: ${input.callId}` }
        }
        if (call.verdict !== 'violation') {
          return { ok: false, reason: 'invalid', message: `Only a violation can be acknowledged; this call reads ${call.verdict}.` }
        }
        const inserted = store.insertAcknowledgement({
          id: `oba-${crypto.randomUUID()}`,
          teamId, commandId,
          rule: call.rule, destination: call.destination,
          throughCreatedAt: call.createdAt, throughCallId: call.id,
          ...(note !== '' ? { note } : {}),
          acknowledgedAt: new Date().toISOString(),
        })
        if (inserted === null) {
          // Lost the unique race (a same-command twin): resolve as its replay.
          return replay() ?? { ok: false, reason: 'payload', message: `command_id ${commandId} was already used; nothing was written.` }
        }
        committed = true
        return { ok: true, replayed: false }
      })
      if (committed) this.options.onCommit?.(teamId)
      return outcome
    } catch (error) {
      return { ok: false, reason: 'invalid', message: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * The store view the driver's observer writes through: every committed call
 * or outcome notifies the team's views (D9's `team-audit-changed` follows
 * committed rows). A no-op repeat (the `ON CONFLICT` dedupe) notifies
 * nothing. An outcome may land before its deferred call row (D3), so its
 * team is read back from the row when one exists; while it does not, the
 * call row's own commit notifies moments later.
 */
export function recordingStore(
  store: OutboundStore,
  onCommit: (teamId: string) => void,
): { insertCall(row: OutboundCallInsert): void; insertOutcome(row: OutboundOutcomeInsert): void } {
  return {
    insertCall: row => {
      if (store.insertCall(row)) onCommit(row.teamId)
    },
    insertOutcome: row => {
      if (!store.insertOutcome(row)) return
      const teamId = store.callByToolUse(row.sessionId, row.toolUseId)?.teamId ?? ''
      if (teamId !== '') onCommit(teamId)
    },
  }
}
