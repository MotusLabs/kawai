// Process reports, decisions, and implementation links (team-process-metrics
// D6) — the one service the agent tools and the human's WS commands share.
// Submit: the caller's current group must set `canReportProcess`; the window
// bounds what may be proposed; groups, metrics, and revert hashes are checked
// (a revert hash must have been recorded for that target at its own
// granularity); Kawai computes the snapshot and period and inserts the report
// with its proposals in one transaction — any refusal writes nothing. Decide
// is the human's alone, once per proposal, through the command protocol, and
// records the target's latest hash. Links name one qualifying version change
// after the decision; the human links, replaces, and unlinks by command key,
// a reporting agent only links an accepted proposal that has no link yet.
// Every commit announces itself through `onCommit` so the tab re-reads.
import type { Database } from 'bun:sqlite'
import { METRIC_WINDOWS, isMetricId, isMetricWindow, type MetricWindow } from '../../shared/processMetrics'
import {
  WINDOW_PROPOSAL_KINDS, WINDOW_RULES,
  type ExpectedEffect, type ProcessProposal, type ProcessReport, type ProposalActor, type ProposalDecision,
  type ProposalLinkEvent, type ReportFreshness, type VersionChange,
} from '../../shared/processReports'
import type { GroupDefinition } from '../team/groupFile'
import type { MetricsReader } from './computeMetrics'
import { changesOf, readProposal, readReport, reportFreshness, reportReadContext, unproposedChanges } from './reportRead'
import { ReportStore, type ProposalInsert, type StoredProposal } from './reportStore'
import { latestHash, targetStarts } from './versionChanges'

/** An agent caller as its current files define it, read at each call. */
export interface ReportCaller {
  teamId: string
  sessionId: string
  group: GroupDefinition | undefined
  /** The team's defined group ids, for proposal targets. */
  groupIds: ReadonlySet<string>
}

export interface ProposalInput {
  kind: string
  target_kind: string
  target: string
  edit: string
  rationale: string
  expected: Array<{ metric: string; direction: string }>
  revert_to_hash?: string | null
}

export interface ReportSubmitInput {
  window: string
  summary: string
  proposals?: ProposalInput[]
}

export interface ReportList {
  reports: ProcessReport[]
  freshness: ReportFreshness[]
}

export interface DecideInput {
  proposalId: string
  decision: 'accepted' | 'rejected'
  reason?: string | null
  commandId: string
}

export interface LinkInput {
  proposalId: string
  /** Null unlinks (human only). */
  changeStartId: string | null
  commandId: string
}

export interface CommandResult<T> {
  replay: boolean
  outcome: T
}

const HUMAN: ProposalActor = { kind: 'human', sessionId: null }
const MEMORY_FILE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/

export class ProcessReportService {
  readonly store: ReportStore

  constructor(
    private readonly db: Database,
    private readonly reader: MetricsReader,
    private readonly options: { now?: () => number; onCommit?: (teamId: string) => void } = {},
  ) {
    this.store = new ReportStore(db)
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }

  submit(caller: ReportCaller, input: ReportSubmitInput): ProcessReport {
    if (caller.group?.canReportProcess !== true) {
      throw new Error('Your group cannot submit process reports (its group file does not set canReportProcess: true). Nothing was written.')
    }
    if (!isMetricWindow(input.window)) throw new Error(`Unknown window "${input.window}". Allowed windows: ${METRIC_WINDOWS.join(', ')}.`)
    const window = input.window
    if (!input.summary.trim()) throw new Error('A report needs a summary.')
    const proposals = (input.proposals ?? []).map((proposal, index) => this.parseProposal(caller, window, proposal, index + 1))
    // The snapshot and period are Kawai's: computed now, never taken from arguments.
    const snapshot = this.reader.read(caller.teamId, window, null, { fresh: true })
    const stored = this.store.insertReport({
      teamId: caller.teamId, authorSession: caller.sessionId, window, periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd, summary: input.summary.trim(), snapshot, proposals,
    }, new Date(this.now()).toISOString())
    this.options.onCommit?.(caller.teamId)
    return this.report(caller.teamId, stored.id)!
  }

  private parseProposal(caller: ReportCaller, window: MetricWindow, input: ProposalInput, position: number): ProposalInsert {
    const at = `Proposal ${position}`
    if (input.kind !== 'change' && input.kind !== 'revert') throw new Error(`${at}: kind must be change or revert, got "${input.kind}".`)
    if (!WINDOW_PROPOSAL_KINDS[window].includes(input.kind)) throw new Error(`${at}: ${WINDOW_RULES[window]} Nothing was written.`)
    if (input.target_kind !== 'group' && input.target_kind !== 'memory') {
      throw new Error(`${at}: target_kind must be group or memory, got "${input.target_kind}".`)
    }
    const target = input.target.trim()
    if (input.target_kind === 'group' && !caller.groupIds.has(target)) {
      throw new Error(`${at}: unknown group "${target}". Known groups: ${[...caller.groupIds].sort().join(', ') || 'none'}.`)
    }
    if (input.target_kind === 'memory' && (!MEMORY_FILE.test(target) || target.includes('\0'))) {
      throw new Error(`${at}: a memory target is one file name inside the shared memory directory, e.g. MEMORY.md.`)
    }
    if (!input.edit.trim()) throw new Error(`${at}: name the proposed edit.`)
    if (!input.rationale.trim()) throw new Error(`${at}: give a rationale.`)
    if (input.expected.length === 0) throw new Error(`${at}: name at least one expected effect (a metric and a direction).`)
    const expected = input.expected.map((effect): ExpectedEffect => {
      if (!isMetricId(effect.metric)) throw new Error(`${at}: unknown metric "${effect.metric}".`)
      if (effect.direction !== 'up' && effect.direction !== 'down') {
        throw new Error(`${at}: direction must be up or down, got "${effect.direction}".`)
      }
      return { metric: effect.metric, direction: effect.direction }
    })
    const revertToHash = input.revert_to_hash?.trim() || null
    if (input.kind === 'change' && revertToHash) throw new Error(`${at}: only a revert names revert_to_hash.`)
    if (input.kind === 'revert') {
      if (!revertToHash) throw new Error(`${at}: a revert names revert_to_hash, an earlier hash recorded for its target.`)
      const recorded = targetStarts(this.db, caller.teamId, input.target_kind, target).some(start => start.hash === revertToHash)
      if (!recorded) {
        const granularity = input.target_kind === 'group' ? `group file hash of ${target}` : `hash of memory file ${target}`
        throw new Error(`${at}: ${revertToHash} was never recorded as a ${granularity}.`)
      }
    }
    return { kind: input.kind, targetKind: input.target_kind, target, edit: input.edit.trim(), rationale: input.rationale.trim(), expected, revertToHash }
  }

  /** The team's reports newest first (at most `limit`), with per-window freshness. */
  list(teamId: string, limit?: number): ReportList {
    const stored = this.store.reports(teamId)
    const context = reportReadContext(this.db, teamId, this.store.proposals(teamId), this.now())
    const shown = limit === undefined ? stored : stored.slice(0, limit)
    return { reports: shown.map(report => readReport(context, report)), freshness: reportFreshness(stored, this.now()) }
  }

  report(teamId: string, id: string): ProcessReport | null {
    const stored = this.store.report(teamId, id)
    if (!stored) return null
    return readReport(reportReadContext(this.db, teamId, this.store.proposals(teamId), this.now()), stored)
  }

  /** Version changes in the window ending now that no accepted proposal's current link names. */
  unproposed(teamId: string, window: MetricWindow): VersionChange[] {
    return unproposedChanges(reportReadContext(this.db, teamId, this.store.proposals(teamId), this.now()), window)
  }

  private proposalOf(teamId: string, proposalId: string): StoredProposal {
    const proposal = this.store.proposal(teamId, proposalId)
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`)
    return proposal
  }

  private readProposal(teamId: string, proposalId: string): ProcessProposal {
    const context = reportReadContext(this.db, teamId, this.store.proposals(teamId), this.now())
    return readProposal(context, this.proposalOf(teamId, proposalId))
  }

  /** The human's one decision on a proposal, by command key. */
  decide(teamId: string, input: DecideInput): CommandResult<ProposalDecision> {
    const reason = input.reason?.trim() || null
    const result = this.store.command(teamId, input.commandId, 'decide', { proposal: input.proposalId, decision: input.decision, reason }, () => {
      const proposal = this.proposalOf(teamId, input.proposalId)
      const hash = latestHash(targetStarts(this.db, teamId, proposal.targetKind, proposal.target)) ?? null
      return this.store.decide(teamId, proposal.id, {
        decision: input.decision, reason, targetHashAtDecision: hash, decidedAt: new Date(this.now()).toISOString(),
      })
    })
    if (!result.replay) this.options.onCommit?.(teamId)
    return result
  }

  /** The version change a link may name, or a refusal saying why not. */
  private candidate(teamId: string, proposal: StoredProposal, changeStartId: string): VersionChange {
    const decision = proposal.decision
    if (decision?.decision !== 'accepted') throw new Error(`Proposal ${proposal.id} is not accepted; only an accepted proposal is linked.`)
    const context = reportReadContext(this.db, teamId, [], this.now())
    const change = changesOf(context, proposal.targetKind, proposal.target).find(c => c.startId === changeStartId)
    const label = proposal.targetKind === 'group' ? `group ${proposal.target}` : `memory file ${proposal.target}`
    if (!change) throw new Error(`Start ${changeStartId} is not a version change of ${label}.`)
    if (change.at <= decision.decidedAt) throw new Error(`That version change of ${label} happened before the decision.`)
    if (proposal.kind === 'revert' && change.hash !== proposal.revertToHash) {
      throw new Error(`A revert links only to a change back to ${proposal.revertToHash}; that change loaded ${change.hash ?? 'no file'}.`)
    }
    if (proposal.kind === 'change' && change.hash === decision.targetHashAtDecision) {
      throw new Error(`That version change loaded the hash at decision (${change.hash ?? 'no file'}), so it does not implement a change.`)
    }
    return change
  }

  /** The human's link, replace, or unlink (null), by command key. */
  linkByHuman(teamId: string, input: LinkInput): CommandResult<ProposalLinkEvent> {
    const result = this.store.command(teamId, input.commandId, 'link', { proposal: input.proposalId, 'version change': input.changeStartId }, () => {
      const proposal = this.proposalOf(teamId, input.proposalId)
      if (input.changeStartId === null) {
        if (!proposal.link) throw new Error(`Proposal ${proposal.id} has no link to remove.`)
        return this.store.appendLink(teamId, proposal.id, 'unlink', null, HUMAN, new Date(this.now()).toISOString())
      }
      const change = this.candidate(teamId, proposal, input.changeStartId)
      return this.store.appendLink(teamId, proposal.id, proposal.link ? 'replace' : 'link',
        { startId: change.startId, hash: change.hash, at: change.at }, HUMAN, new Date(this.now()).toISOString())
    })
    if (!result.replay) this.options.onCommit?.(teamId)
    return result
  }

  /** A reporting agent's link: accepted, no current link, candidate only; never a replace or unlink. */
  linkByAgent(caller: ReportCaller, proposalId: string, changeStartId: string): ProcessProposal {
    if (caller.group?.canReportProcess !== true) {
      throw new Error('Your group cannot link proposals (its group file does not set canReportProcess: true).')
    }
    this.store.command(caller.teamId, `agent:${crypto.randomUUID()}`, 'link', { proposal: proposalId, 'version change': changeStartId }, () => {
      const proposal = this.proposalOf(caller.teamId, proposalId)
      if (proposal.link) throw new Error(`Proposal ${proposalId} is already linked; only the human replaces or removes a link.`)
      const change = this.candidate(caller.teamId, proposal, changeStartId)
      return this.store.appendLink(caller.teamId, proposal.id, 'link', { startId: change.startId, hash: change.hash, at: change.at },
        { kind: 'agent', sessionId: caller.sessionId }, new Date(this.now()).toISOString())
    })
    this.options.onCommit?.(caller.teamId)
    return this.readProposal(caller.teamId, proposalId)
  }
}
