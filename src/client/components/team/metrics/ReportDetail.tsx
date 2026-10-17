// One process report (team-process-metrics D6): who wrote it for which
// window and period, its summary, the frozen metric snapshot it was written
// against (collapsed; Kawai computed it at submission), and its proposals.
import { useState } from 'react'
import { METRIC_DEF_BY_ID } from '@shared/processMetrics'
import type { ProcessReport } from '@shared/processReports'
import type { SendClientMessage } from '@shared/types'
import { formatValue, insufficientLabel } from './metricFormat'
import ProposalCard from './ProposalCard'
import { timeLabel, type NameOf } from './reportLabels'

export default function ReportDetail({ teamPath, report, sendMessage, connected, nameOf, onBack }: {
  teamPath: string
  report: ProcessReport
  sendMessage: SendClientMessage
  connected: boolean
  nameOf: NameOf
  onBack: () => void
}) {
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  return <section className="flex flex-col gap-2" data-testid="report-detail" data-report={report.id}>
    <button type="button" className="self-start text-sm hover:underline" onClick={onBack}>← All reports</button>
    <h3 className="font-medium">{report.window} report by {nameOf(report.authorSession)} · {timeLabel(report.createdAt)}</h3>
    <p className="text-chat-meta text-secondary">Period {timeLabel(report.periodStart)} – {timeLabel(report.periodEnd)}</p>
    <p className="whitespace-pre-wrap text-sm" data-testid="report-summary">{report.summary}</p>
    <div>
      <button type="button" className="text-left text-sm hover:underline" aria-expanded={snapshotOpen} data-testid="report-snapshot-toggle"
        onClick={() => setSnapshotOpen(open => !open)}>
        {snapshotOpen ? '▾' : '▸'} Snapshot computed by Kawai at {timeLabel(report.snapshot.computedAt)}
      </button>
      {snapshotOpen && <table className="mt-1 text-sm" data-testid="report-snapshot">
        <tbody>{report.snapshot.metrics.map(metric => {
          const def = METRIC_DEF_BY_ID.get(metric.id)
          return <tr key={metric.id}>
            <td className="pr-2">{def?.label ?? metric.id}</td>
            <td className="pr-2">{def ? formatValue(metric.value, def.unit) : metric.value ?? '—'}</td>
            <td className="whitespace-nowrap pr-2 text-secondary">n {metric.n}</td>
            <td className="text-secondary">{insufficientLabel(metric) ?? ''}</td>
          </tr>
        })}</tbody>
      </table>}
    </div>
    <h4 className="font-medium">Proposals</h4>
    {report.proposals.length === 0 && <p className="text-sm text-secondary">This report carries no proposals.</p>}
    <ol className="flex flex-col gap-2">
      {report.proposals.map((proposal, index) => <ProposalCard key={proposal.id} teamPath={teamPath} proposal={proposal} position={index + 1}
        sendMessage={sendMessage} connected={connected} nameOf={nameOf} />)}
    </ol>
  </section>
}
