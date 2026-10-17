// The owner's audit view wire types (execution-safety-recovery D9), shared
// by the server's outbound connections and the client's Audit tab. Every
// message names the team's directory (`teamPath`), resolved by the shared
// team-scope resolver; replies echo it beside `teamId`. The page is
// authoritative and re-requested whole after every `team-audit-changed`
// push, so a reconnect needs no deltas. The one human command,
// `team-audit-acknowledge`, carries a command id minted when its dialog
// opens, so a resend replays instead of repeating (D10).

/** A call's stored verdict (D4). */
export type OutboundVerdict = 'violation' | 'unknown-destination' | 'allowed'

/** A call's outcome state, derived at read time (D7). */
export type OutboundOutcomeState =
  | 'denied' | 'failed' | 'completed' | 'started-background' | 'pending' | 'outcome-unknown'

/** One judged segment as stored (the row's `matches` JSON, D6). */
export interface OutboundMatch {
  rule: string
  segment: string
  verdict: string
  destination: string
  /** Present on the trailing entry when the match list was cut to fit. */
  truncated?: boolean
}

/** One recorded call as the Audit tab lists it (D9 rows). */
export interface OutboundAuditRow {
  id: string
  createdAt: string
  verdict: string
  rule: string
  destination: string
  /** Withheld or redacted at write (D8); never a raw secret. */
  command: string
  truncated: boolean
  tool: string
  mcpServer?: string
  /** Subagent id; absent on the main thread. */
  agentId?: string
  groupId?: string
  profileId?: string
  taskId?: string
  cwd: string
  classifierVersion: number
  matches: OutboundMatch[]
  outcome: { state: OutboundOutcomeState; detail?: string }
  /**
   * The call's session, named server-side (`Name (gone)` from the durable
   * directory for a killed one); `clickable` only for a live or archived
   * session (D9).
   */
  session: { id: string; name: string; clickable: boolean }
}

/** The view's server filters (D9): verdict, rule, destination, session, and a time range. */
export interface OutboundAuditFilters {
  verdict?: string
  rule?: string
  destination?: string
  sessionId?: string
  /** Inclusive ISO stamp the range starts at. */
  from?: string
  /** Exclusive ISO stamp the range ends at. */
  to?: string
}

/** Header counts for the chosen time range (D9). */
export interface OutboundAuditCounts {
  /** Allowed sends per rule, e.g. `{ 'git-push': 106 }`. */
  allowedPerRule: Record<string, number>
  unknown: number
  violations: number
  /** Violations in the range no acknowledgement of their group covers (D10). */
  unacknowledgedViolations: number
}

/**
 * The backup status footer (database-safety: the newest backup per reason
 * with its size and integrity-check result, read-only; failures are shown,
 * never actionable here). Server-wide: one database serves every team.
 */
export interface OutboundAuditBackups {
  dir: string
  newest: Array<{ reason: string; name: string; bytes: number; checked: string }>
  failures: Array<{ reason: string; error: string; at: string }>
}

/** One page of the view: rows newest first, the range's counts, and the next-page cursor. */
export interface OutboundAuditPage {
  rows: OutboundAuditRow[]
  counts: OutboundAuditCounts
  /** Opaque cursor for `team-audit-more`; null at the end. */
  cursor: string | null
  backups: OutboundAuditBackups | null
}

export type OutboundAuditServerMessage =
  | {
      type: 'team-audit-page'
      teamPath: string
      teamId: string
      requestId: string
      page: OutboundAuditPage
      /** An open naming an unknown or other-team call id answers the default view with this notice (D10). */
      notice?: string
      /**
       * The filters actually applied, when the open named a call id and its
       * (rule, destination) group was resolved server-side — the store adopts
       * them, so a changed push re-requests the same group.
       */
      appliedFilters?: OutboundAuditFilters
    }
  // Every committed call, outcome, or acknowledgement of the team (D9):
  // replace semantics — the client re-requests its first page.
  | { type: 'team-audit-changed'; teamPath: string; teamId: string }
  | { type: 'team-audit-result'; teamPath: string; requestId: string; replayed?: boolean; error?: string }

export type OutboundAuditClientMessage =
  // Page requests carry a request id so a slow reply of a superseded
  // request (a filter change while one loads) never lands twice. An open
  // may name a call id (D10): its (rule, destination) group is resolved
  // server-side — an unknown or other-team id answers the default view
  // with a notice.
  | { type: 'team-audit-open'; teamPath: string; requestId: string; filters: OutboundAuditFilters; callId?: string }
  | { type: 'team-audit-more'; teamPath: string; requestId: string; filters: OutboundAuditFilters; cursor: string }
  | { type: 'team-audit-close'; teamPath: string }
  // The one edit (D10): acknowledges the call's (rule, destination) group
  // through that call, under a command id; an optional note rides along.
  | { type: 'team-audit-acknowledge'; teamPath: string; requestId: string; callId: string; commandId: string; note?: string }
