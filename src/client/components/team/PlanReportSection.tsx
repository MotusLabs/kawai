// The supervision report of a plan's newest execution (plan-supervision
// D12, D15): outcome counts — never a percentage — partial delivery as
// "Landed N of M" with its blockers ("All M changes landed" never claims the
// success criteria), each stopped change with its reason label, the last
// round's evidence and its blocked dependents beside the next action, the
// failed and superseded integration candidates beside their change, a
// non-continue strategy impact disposition with its review, the Lead
// decisions overridden (M2), and each landed forward fix's override-to-
// landing time (M4). Per change it shows the derived outcome, its cause,
// meaningful progress apart from activity with client-ticked elapsed times,
// and any stall with its deadline. The section renders only what the detail
// carries; without the supervision module it renders nothing.
import type { Session } from '@shared/types'
import type { ChangeSupervision } from '@shared/planSupervision'
import { causeLabel, SUPERVISION_OUTCOMES, type SupervisionOutcome } from '@shared/planSupervision'
import type { PlanSupervisionView } from '@shared/planReport'
import { useTickingClock } from '../chat/chatElapsed'
import { sessionLabel } from '../chat/strategyLabels'

const OUTCOME_LABELS: Record<SupervisionOutcome, string> = {
  landed: 'Landed', running: 'Running', waiting: 'Waiting', stalled: 'Stalled',
  stopped: 'Stopped', cancelled: 'Cancelled', 'not-started': 'Not started',
}

/** A duration for humans: whole hours above one, else minutes. */
const formatDuration = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes} min`
  return `${Math.round(minutes / 60)} h`
}

const ago = (at: string, now: number): string => `${formatDuration(now - Date.parse(at))} ago`

export default function PlanReportSection({ view: supervision, sessions, onOpenImpactReview }: {
  view: PlanSupervisionView
  sessions: Session[]
  /** Opens the strategy impact review of the report's non-continue disposition (D12). */
  onOpenImpactReview?: (revision: number) => void
}) {
  const now = useTickingClock(true)
  const { report, changes } = supervision
  return <section className="mt-3" data-testid="plan-report-section" aria-labelledby="plan-report-heading">
    <h3 id="plan-report-heading" className="text-chat-meta font-medium">Report</h3>
    <p className="text-chat-meta" data-testid="plan-report-delivery">{report.delivery}</p>
    <p className="text-chat-meta text-secondary" data-testid="plan-report-counts">
      {SUPERVISION_OUTCOMES.filter(outcome => report.counts[outcome] > 0)
        .map(outcome => `${OUTCOME_LABELS[outcome]} ${report.counts[outcome]}`).join(' · ') || 'No changes'}
    </p>
    {report.blockers.length > 0 && report.landed < report.total
      && <p className="text-chat-meta text-secondary" data-testid="plan-report-blockers">Blocked by {report.blockers.join(', ')}</p>}
    {report.stops.map(stop => <div key={stop.change} className="mt-1 border border-border p-2" data-testid="plan-report-stop">
      <p className="text-chat-body"><span className="font-medium">{stop.change}</span> — stopped: {stop.label}</p>
      {stop.detail?.message && <p className="text-chat-meta text-secondary">{stop.detail.message}</p>}
      {stop.evidence && <p className="text-chat-meta text-secondary" data-testid="plan-report-stop-evidence">
        last round {stop.evidence.number}
        {stop.evidence.failing.length > 0 && ` · failing: ${stop.evidence.failing.map(check => check.name).join(', ')}`}
        {stop.evidence.flaky.length > 0 && ` · flaky: ${stop.evidence.flaky.join(', ')}`}
        {stop.evidence.verdict !== null && ` · review ${stop.evidence.verdict}`}
        {stop.evidence.findingsSummary ? ` · ${stop.evidence.findingsSummary}` : ''}
      </p>}
      {stop.blocked.length > 0 && <p className="text-chat-meta text-secondary" data-testid="plan-report-stop-blocked">
        Blocked dependents: {stop.blocked.join(', ')}</p>}
      <p className="text-chat-meta">Next action: {stop.nextAction}</p>
    </div>)}
    {report.candidates.map(entry => <div key={entry.change} className="mt-1" data-testid="plan-report-candidates">
      <p className="text-chat-meta">{entry.change} candidates</p>
      <ul className="text-chat-meta text-secondary">
        {entry.candidates.map(candidate => <li key={candidate.id}>
          #{candidate.seq} {candidate.state} · {candidate.commitSha.slice(0, 8)}
          {(candidate.outside ?? []).length > 0 && ` · ${candidate.outside!.length} outside commit(s)`}
        </li>)}
      </ul>
    </div>)}
    {report.disposition && <p className="mt-1 text-chat-meta" data-testid="plan-report-disposition">
      Strategy impact review of revision {report.disposition.strategyRevision}: {report.disposition.disposition}
      {onOpenImpactReview && <> · <button type="button" className="link" onClick={() => onOpenImpactReview(report.disposition!.strategyRevision)}>Open review</button></>}
    </p>}
    <p className="mt-1 text-chat-meta" data-testid="plan-report-overrides">{report.overrides.line}</p>
    {report.fixDurations.length > 0 && <ul className="text-chat-meta" data-testid="plan-report-fix-durations">
      {report.fixDurations.map(fix => <li key={fix.decisionId}>
        Forward fix landed {formatDuration(fix.durationMs)} after the override
        {fix.unverified ? ' — a landing was not tree-verified' : ''}
      </li>)}
    </ul>}
    <ul className="mt-2 space-y-2">
      {changes.map(change => <ChangeSupervisionRow key={change.change} row={change} now={now} sessions={sessions} />)}
    </ul>
    <div className="mt-2">
      <p className="text-chat-meta font-medium text-secondary">Success criteria</p>
      <p className="text-chat-meta text-secondary">For you to judge — this report never claims they are met.</p>
      <ul className="list-disc pl-5 text-chat-body">{report.successCriteria.map((rule, index) => <li key={index}>{rule}</li>)}</ul>
    </div>
  </section>
}

function ChangeSupervisionRow({ row, now, sessions }: { row: ChangeSupervision; now: number; sessions: Session[] }) {
  return <li className="border border-border p-2" data-testid={`plan-supervision-${row.change}`}>
    <p className="text-chat-body">
      <span className="font-medium">{row.change}</span>
      {' · '}{OUTCOME_LABELS[row.outcome]}
      {row.stage !== null ? ` · stage ${row.stage}` : ''}
      {row.holder ? ` · held by ${sessionLabel(row.holder.session, sessions)}${row.holder.profile ? ` (${row.holder.profile})` : ''}` : ''}
    </p>
    <p className="text-chat-meta text-secondary" data-testid={`plan-supervision-cause-${row.change}`}>{causeLabel(row.cause)}</p>
    {row.alsoApplying.map((wait, index) => <p key={index} className="text-chat-meta text-secondary">
      also applying: {causeLabel(wait)}</p>)}
    <p className="text-chat-meta" data-testid={`plan-supervision-progress-${row.change}`}>
      {row.progress ? `Progress ${ago(row.progress.at, now)} (${row.progress.kind.replace('-', ' ')})` : 'No progress yet'}
      {row.activity ? ` · activity ${ago(row.activity.at, now)} (${row.activity.kind.replace('-', ' ')})` : ''}
    </p>
    {row.stall && <p className="text-chat-meta text-chat-danger" data-testid={`plan-supervision-stall-${row.change}`}>
      {row.stall.kind === 'no-progress'
        ? `Stalled: no progress — deadline ${new Date(row.stall.deadlineAt).toLocaleTimeString()}${row.stall.idle ? ', holder idle' : ''}`
        : `Stalled: repeating failure — ${row.stall.signature}`}
    </p>}
    {row.landing && <p className="text-chat-meta text-secondary">
      landed{row.landing.treeVerified ? '' : ' — tree not verified'}
      {row.landing.postCi !== null && row.landing.postCi.length > 0 ? ` · base CI: ${row.landing.postCi.map(check => `${check.name}=${check.conclusion}`).join(', ')}` : ''}
    </p>}
  </li>
}
