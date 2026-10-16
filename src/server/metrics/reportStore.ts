// Process report storage (team-process-metrics D6): reports inserted with
// their proposals in one transaction, one final decision per proposal, the
// append-only link history whose latest non-unlink event is the current link,
// and the command protocol every human decide/link command runs through —
// look the key up; the same payload returns the stored outcome and writes
// nothing; a different payload is refused naming its first differing field;
// otherwise apply and record the outcome, all in one transaction. The store
// reads and writes only: version changes, candidates, and outcomes are
// derived elsewhere at read time.
import type { Database } from 'bun:sqlite'
import type { MetricWindow, ProcessMetrics } from '../../shared/processMetrics'
import type {
  ExpectedEffect, LinkAction, ProposalActor, ProposalDecision, ProposalKind, ProposalLink, ProposalLinkEvent, ProposalTargetKind,
} from '../../shared/processReports'

export interface ProposalInsert {
  kind: ProposalKind
  targetKind: ProposalTargetKind
  target: string
  edit: string
  rationale: string
  expected: ExpectedEffect[]
  revertToHash: string | null
}

export interface ReportInsert {
  teamId: string
  authorSession: string
  window: MetricWindow
  periodStart: string
  periodEnd: string
  summary: string
  snapshot: ProcessMetrics
  proposals: ProposalInsert[]
}

export interface StoredProposal extends ProposalInsert {
  id: string
  reportId: string
  teamId: string
  decision: ProposalDecision | null
  linkHistory: ProposalLinkEvent[]
  link: ProposalLink | null
}

export interface StoredReport {
  id: string
  teamId: string
  authorSession: string
  window: MetricWindow
  periodStart: string
  periodEnd: string
  summary: string
  snapshot: ProcessMetrics
  createdAt: string
  proposals: StoredProposal[]
}

export interface LinkChange {
  startId: string
  hash: string | null
  at: string
}

export type CommandKind = 'decide' | 'link'

/** A command payload: field name → value, compared field by field on replay. */
export type CommandPayload = Record<string, string | null>

type Row = Record<string, unknown>
const str = (value: unknown) => (value === null || value === undefined ? null : String(value))

/** The latest link event, unless it is an unlink. */
export function currentLink(history: readonly ProposalLinkEvent[]): ProposalLink | null {
  const last = history.at(-1)
  if (!last || last.action === 'unlink' || !last.changeStartId || !last.changeAt) return null
  return { changeStartId: last.changeStartId, changeHash: last.changeHash, changeAt: last.changeAt, actor: last.actor, at: last.at }
}

/** The first field whose value differs between a stored payload and a new one, else null. */
export function firstDifferingField(stored: CommandPayload, next: CommandPayload): string | null {
  for (const key of new Set([...Object.keys(next), ...Object.keys(stored)])) {
    if ((stored[key] ?? null) !== (next[key] ?? null)) return key
  }
  return null
}

export class ReportStore {
  constructor(private readonly db: Database) {}

  insertReport(input: ReportInsert, now = new Date().toISOString()): StoredReport {
    const id = crypto.randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO process_reports (id, team_id, author_session, window, period_start, period_end, summary, snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.teamId, input.authorSession, input.window, input.periodStart,
        input.periodEnd, input.summary, JSON.stringify(input.snapshot), now)
      const insert = this.db.prepare(`INSERT INTO process_proposals (id, report_id, team_id, position, kind, target_kind, target, edit,
        rationale, expected, revert_to_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      input.proposals.forEach((proposal, position) => {
        insert.run(crypto.randomUUID(), id, input.teamId, position, proposal.kind, proposal.targetKind, proposal.target, proposal.edit,
          proposal.rationale, JSON.stringify(proposal.expected), proposal.revertToHash)
      })
    })()
    return this.report(input.teamId, id)!
  }

  /** The team's reports, newest first. */
  reports(teamId: string): StoredReport[] {
    const rows = this.db.prepare('SELECT * FROM process_reports WHERE team_id = ? ORDER BY created_at DESC, rowid DESC').all(teamId) as Row[]
    const proposals = this.proposals(teamId)
    return rows.map(row => this.toReport(row, proposals))
  }

  report(teamId: string, id: string): StoredReport | null {
    const row = this.db.prepare('SELECT * FROM process_reports WHERE team_id = ? AND id = ?').get(teamId, id) as Row | null
    return row ? this.toReport(row, this.proposals(teamId, id)) : null
  }

  /** The team's proposals (or one report's), in report order. */
  proposals(teamId: string, reportId?: string): StoredProposal[] {
    const rows = (reportId === undefined
      ? this.db.prepare('SELECT * FROM process_proposals WHERE team_id = ? ORDER BY report_id, position').all(teamId)
      : this.db.prepare('SELECT * FROM process_proposals WHERE team_id = ? AND report_id = ? ORDER BY position').all(teamId, reportId)) as Row[]
    return rows.map(row => this.toProposal(row))
  }

  proposal(teamId: string, id: string): StoredProposal | null {
    const row = this.db.prepare('SELECT * FROM process_proposals WHERE team_id = ? AND id = ?').get(teamId, id) as Row | null
    return row ? this.toProposal(row) : null
  }

  /** Record the one decision; a decided proposal is refused. */
  decide(teamId: string, proposalId: string, decision: ProposalDecision): ProposalDecision {
    const existing = this.db.prepare('SELECT decision FROM process_proposal_decisions WHERE proposal_id = ?').get(proposalId) as Row | null
    if (existing) throw new Error(`Proposal ${proposalId} was already ${String(existing.decision)}; a decision is final.`)
    this.db.prepare(`INSERT INTO process_proposal_decisions (proposal_id, team_id, decision, reason, target_hash_at_decision, decided_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(proposalId, teamId, decision.decision, decision.reason, decision.targetHashAtDecision, decision.decidedAt)
    return decision
  }

  /** Append one link event; history is never rewritten. */
  appendLink(teamId: string, proposalId: string, action: LinkAction, change: LinkChange | null, actor: ProposalActor, at = new Date().toISOString()): ProposalLinkEvent {
    this.db.prepare(`INSERT INTO process_proposal_link_events (proposal_id, team_id, action, change_start_id, change_hash, change_at,
      actor_kind, actor_session, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(proposalId, teamId, action, change?.startId ?? null,
      change?.hash ?? null, change?.at ?? null, actor.kind, actor.sessionId, at)
    return { action, changeStartId: change?.startId ?? null, changeHash: change?.hash ?? null, changeAt: change?.at ?? null, actor, at }
  }

  /**
   * Run one keyed command: a stored key with the same payload returns its
   * outcome and writes nothing; with another payload it is refused naming
   * the first differing field; otherwise `apply` runs and its outcome is
   * recorded, in one transaction (a throwing `apply` writes nothing).
   */
  command<T>(teamId: string, commandId: string, kind: CommandKind, payload: CommandPayload, apply: () => T): { replay: boolean; outcome: T } {
    return this.db.transaction(() => {
      const stored = this.db.prepare('SELECT kind, payload, outcome FROM process_commands WHERE team_id = ? AND command_id = ?')
        .get(teamId, commandId) as Row | null
      if (stored) {
        const field = String(stored.kind) !== kind ? 'kind' : firstDifferingField(JSON.parse(String(stored.payload)) as CommandPayload, payload)
        if (field) throw new Error(`Command key ${commandId} was already used with a different ${field}.`)
        return { replay: true, outcome: JSON.parse(String(stored.outcome)) as T }
      }
      const outcome = apply()
      this.db.prepare('INSERT INTO process_commands (team_id, command_id, kind, payload, outcome, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(teamId, commandId, kind, JSON.stringify(payload), JSON.stringify(outcome), new Date().toISOString())
      return { replay: false, outcome }
    })()
  }

  private toReport(row: Row, proposals: StoredProposal[]): StoredReport {
    const id = String(row.id)
    return {
      id, teamId: String(row.team_id), authorSession: String(row.author_session), window: String(row.window) as MetricWindow,
      periodStart: String(row.period_start), periodEnd: String(row.period_end), summary: String(row.summary),
      snapshot: JSON.parse(String(row.snapshot)) as ProcessMetrics, createdAt: String(row.created_at),
      proposals: proposals.filter(proposal => proposal.reportId === id),
    }
  }

  private toProposal(row: Row): StoredProposal {
    const id = String(row.id)
    const decision = this.db.prepare('SELECT * FROM process_proposal_decisions WHERE proposal_id = ?').get(id) as Row | null
    const events = this.db.prepare('SELECT * FROM process_proposal_link_events WHERE proposal_id = ? ORDER BY id').all(id) as Row[]
    const linkHistory = events.map((event): ProposalLinkEvent => ({
      action: String(event.action) as LinkAction, changeStartId: str(event.change_start_id), changeHash: str(event.change_hash),
      changeAt: str(event.change_at), actor: { kind: String(event.actor_kind) as ProposalActor['kind'], sessionId: str(event.actor_session) },
      at: String(event.at),
    }))
    return {
      id, reportId: String(row.report_id), teamId: String(row.team_id), kind: String(row.kind) as ProposalKind,
      targetKind: String(row.target_kind) as ProposalTargetKind, target: String(row.target), edit: String(row.edit),
      rationale: String(row.rationale), expected: JSON.parse(String(row.expected)) as ExpectedEffect[], revertToHash: str(row.revert_to_hash),
      decision: decision ? {
        decision: String(decision.decision) as ProposalDecision['decision'], reason: str(decision.reason),
        targetHashAtDecision: str(decision.target_hash_at_decision), decidedAt: String(decision.decided_at),
      } : null,
      linkHistory, link: currentLink(linkHistory),
    }
  }
}
