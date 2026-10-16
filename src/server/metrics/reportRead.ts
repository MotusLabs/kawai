// The process report read model (team-process-metrics D6): stored reports
// with each proposal's derived state — link candidates (the target's version
// changes after the decision whose hash qualifies: ≠ the decision hash for a
// change, = the revert hash for a revert), the proposals sharing its linked
// change, and its outcome once implemented — plus per-window freshness and
// the unproposed version changes of a window. Computed at read time; nothing
// here is stored.
import type { Database } from 'bun:sqlite'
import { METRIC_WINDOWS, WINDOW_MS, type MetricWindow } from '../../shared/processMetrics'
import type { ProcessProposal, ProcessReport, ReportFreshness, VersionChange } from '../../shared/processReports'
import type { StoredProposal, StoredReport } from './reportStore'
import { loadTargetStarts, targetKey, versionChanges, type TargetStart } from './versionChanges'
import { proposalOutcome } from './reportOutcomes'

const HOUR_MS = 60 * 60 * 1000

export interface ReportReadContext {
  db: Database
  teamId: string
  /** Every target's starts, loaded once per read. */
  starts: Map<string, TargetStart[]>
  /** Every proposal of the team, for shared-link detection. */
  proposals: StoredProposal[]
  now: number
}

export function reportReadContext(db: Database, teamId: string, proposals: StoredProposal[], now: number): ReportReadContext {
  return { db, teamId, starts: loadTargetStarts(db, teamId), proposals, now }
}

export function changesOf(context: ReportReadContext, kind: StoredProposal['targetKind'], target: string): VersionChange[] {
  return versionChanges(kind, target, context.starts.get(targetKey(kind, target)) ?? [])
}

/** Version changes a link may name now: accepted proposals only. */
/** One version change of one target, as a link names it; null without a link. */
function linkedChangeKey(proposal: StoredProposal): string | null {
  return proposal.link ? `${targetKey(proposal.targetKind, proposal.target)}@${proposal.link.changeStartId}` : null
}

export function linkCandidates(context: ReportReadContext, proposal: StoredProposal): VersionChange[] {
  const decision = proposal.decision
  if (decision?.decision !== 'accepted') return []
  return changesOf(context, proposal.targetKind, proposal.target).filter(change => change.at > decision.decidedAt
    && (proposal.kind === 'revert' ? change.hash === proposal.revertToHash : change.hash !== decision.targetHashAtDecision))
}

export function readProposal(context: ReportReadContext, proposal: StoredProposal): ProcessProposal {
  const link = proposal.link
  const sharedWith = link
    ? context.proposals.filter(other => other.id !== proposal.id && other.decision?.decision === 'accepted'
      && linkedChangeKey(other) === linkedChangeKey(proposal)).map(other => other.id)
    : []
  return {
    id: proposal.id, reportId: proposal.reportId, kind: proposal.kind, targetKind: proposal.targetKind, target: proposal.target,
    edit: proposal.edit, rationale: proposal.rationale, expected: proposal.expected, revertToHash: proposal.revertToHash,
    decision: proposal.decision, link, linkHistory: proposal.linkHistory, sharedWith,
    candidates: linkCandidates(context, proposal),
    ...(link && proposal.decision?.decision === 'accepted' ? { outcome: proposalOutcome(context, proposal, link) } : {}),
  }
}

export function readReport(context: ReportReadContext, report: StoredReport): ProcessReport {
  return { ...report, proposals: report.proposals.map(proposal => readProposal(context, proposal)) }
}

/** The newest report per window and its age in hours at `now`. */
export function reportFreshness(reports: readonly StoredReport[], now: number): ReportFreshness[] {
  return METRIC_WINDOWS.map(window => {
    const latest = reports.filter(report => report.window === window).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return latest
      ? { window, latestReportId: latest.id, latestAt: latest.createdAt, ageHours: Math.round(((now - Date.parse(latest.createdAt)) / HOUR_MS) * 10) / 10 }
      : { window, latestReportId: null, latestAt: null, ageHours: null }
  })
}

/** Version changes in the window ending at `now` that no accepted proposal's current link names. */
export function unproposedChanges(context: ReportReadContext, window: MetricWindow): VersionChange[] {
  const from = new Date(context.now - WINDOW_MS[window]).toISOString()
  const to = new Date(context.now).toISOString()
  const linked = new Set(context.proposals
    .filter(proposal => proposal.decision?.decision === 'accepted')
    .map(linkedChangeKey))
  const out: VersionChange[] = []
  for (const key of context.starts.keys()) {
    const [kind, ...rest] = key.split(':')
    for (const change of changesOf(context, kind as StoredProposal['targetKind'], rest.join(':'))) {
      if (change.at >= from && change.at < to && !linked.has(`${key}@${change.startId}`)) out.push(change)
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.target.localeCompare(b.target))
}
