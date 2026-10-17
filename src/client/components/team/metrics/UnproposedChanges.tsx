// What the Metrics tab flags for the human (team-process-metrics D6): the
// window's version changes that no accepted proposal's current link names —
// the group or file, the previous and new hash, when, and the session whose
// start recorded it (kawai detects these, it never prevents them) — and the
// accepted proposals still waiting for a link, each opening its report.
import type { ProcessProposal, ProcessReport, VersionChange } from '@shared/processReports'
import { changeLabel, targetLabel, timeLabel, type NameOf } from './reportLabels'

export function UnproposedChanges({ changes, nameOf }: { changes: readonly VersionChange[]; nameOf: NameOf }) {
  if (changes.length === 0) return <p className="text-sm text-secondary" data-testid="unproposed-empty">Every version change in this window is linked to an accepted proposal.</p>
  return <ul className="flex flex-col gap-1" data-testid="unproposed-changes">
    {changes.map(change => <li key={`${change.targetKind}:${change.target}@${change.startId}`} className="text-sm" data-testid="unproposed-change">
      <span className="font-medium">{targetLabel(change.targetKind, change.target)}</span> {changeLabel(change)}
      <span className="text-secondary"> · first loaded by {nameOf(change.sessionId)} (start {change.startId})</span>
    </li>)}
  </ul>
}

export function needingLink(reports: readonly ProcessReport[]): Array<{ report: ProcessReport; proposal: ProcessProposal }> {
  return reports.flatMap(report => report.proposals
    .filter(proposal => proposal.decision?.decision === 'accepted' && !proposal.link)
    .map(proposal => ({ report, proposal })))
}

export function NeedsLink({ reports, onOpenReport }: { reports: readonly ProcessReport[]; onOpenReport: (reportId: string) => void }) {
  const rows = needingLink(reports)
  if (rows.length === 0) return <p className="text-sm text-secondary" data-testid="needs-link-empty">No accepted proposal is waiting for a link.</p>
  return <ul className="flex flex-col gap-1" data-testid="needs-link">
    {rows.map(({ report, proposal }) => <li key={proposal.id} className="text-sm" data-testid="needs-link-row">
      <button type="button" className="text-left hover:underline" onClick={() => onOpenReport(report.id)}>
        {proposal.kind === 'revert' ? 'Revert' : 'Change'} {targetLabel(proposal.targetKind, proposal.target)}
      </button>
      <span className="text-secondary"> · accepted {timeLabel(proposal.decision!.decidedAt)} · {proposal.candidates.length} candidate{proposal.candidates.length === 1 ? '' : 's'}</span>
    </li>)}
  </ul>
}
