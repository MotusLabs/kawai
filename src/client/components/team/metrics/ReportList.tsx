// The Metrics tab's reports (team-process-metrics D6): the latest report per
// window and its age (a missed report shows as a long age), then the newest
// reports — window, author, time, summary, and how many proposals await a
// decision or a link — each opening its detail at
// `#/team/<key>/metrics/<window>/<report id>`.
import { METRIC_WINDOWS } from '@shared/processMetrics'
import type { ProcessReport, ReportFreshness } from '@shared/processReports'
import { ageLabel, timeLabel, type NameOf } from './reportLabels'

export function ReportFreshnessLine({ freshness }: { freshness: readonly ReportFreshness[] }) {
  const byWindow = new Map(freshness.map(row => [row.window, row]))
  return <p className="text-sm" data-testid="report-freshness">
    Latest reports: {METRIC_WINDOWS.map((window, index) => <span key={window} data-testid={`report-freshness-${window}`}>
      {index > 0 && ' · '}{window} {ageLabel(byWindow.get(window)?.ageHours ?? null)}
    </span>)}
  </p>
}

export const proposalCounts = (report: ProcessReport) => ({
  undecided: report.proposals.filter(p => !p.decision).length,
  unlinked: report.proposals.filter(p => p.decision?.decision === 'accepted' && !p.link).length,
})

export default function ReportList({ reports, freshness, nameOf, onOpenReport }: {
  reports: readonly ProcessReport[]
  freshness: readonly ReportFreshness[]
  nameOf: NameOf
  onOpenReport: (reportId: string) => void
}) {
  return <div data-testid="report-list">
    <ReportFreshnessLine freshness={freshness} />
    {reports.length === 0 && <p className="mt-1 text-sm text-secondary">No process reports yet.</p>}
    <ul className="mt-1 flex flex-col gap-1">
      {reports.map(report => {
        const { undecided, unlinked } = proposalCounts(report)
        return <li key={report.id} className="border border-border p-2" data-testid="report-row" data-report={report.id}>
          <button type="button" className="text-left font-medium hover:underline" onClick={() => onOpenReport(report.id)}>
            {report.window} report by {nameOf(report.authorSession)} · {timeLabel(report.createdAt)}
          </button>
          <p className="line-clamp-2 whitespace-pre-wrap text-sm">{report.summary}</p>
          <p className="text-chat-meta text-secondary">
            {report.proposals.length} proposal{report.proposals.length === 1 ? '' : 's'}
            {undecided > 0 && ` · ${undecided} awaiting a decision`}
            {unlinked > 0 && ` · ${unlinked} accepted without a link`}
          </p>
        </li>
      })}
    </ul>
  </div>
}
