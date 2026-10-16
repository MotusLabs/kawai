// The Metrics tab's report sections (team-process-metrics D6), above the
// metric families: Reports (freshness and the newest reports), Needs a link,
// and Unproposed changes in the chosen window — each collapsible, collapsed
// state kept per team with the families'. A location naming a report shows
// that report alone, with All reports as Back.
import type { ReactNode } from 'react'
import type { SendClientMessage } from '@shared/types'
import { REPORTS_IN_SNAPSHOT } from '@shared/metricsMessages'
import type { MetricsView } from '../../../stores/metricsStore'
import ReportDetail from './ReportDetail'
import ReportList from './ReportList'
import { NeedsLink, UnproposedChanges, needingLink } from './UnproposedChanges'
import type { NameOf } from './reportLabels'

function Section({ id, title, count, collapsed, onToggle, children }: {
  id: string; title: string; count: number; collapsed: boolean; onToggle: () => void; children: ReactNode
}) {
  return <section className="border border-border p-3" data-testid={`metrics-section-${id}`}>
    <h3>
      <button type="button" className="font-medium hover:underline" aria-expanded={!collapsed} onClick={onToggle}>
        {collapsed ? '▸' : '▾'} {title} <span className="text-secondary">({count})</span>
      </button>
    </h3>
    {!collapsed && <div className="mt-1">{children}</div>}
  </section>
}

export default function MetricsReports({ teamPath, view, reportId, collapsed, onToggleSection, sendMessage, connected, nameOf, onOpenReport }: {
  teamPath: string
  view: MetricsView
  reportId: string | undefined
  collapsed: readonly string[]
  onToggleSection: (id: string) => void
  sendMessage: SendClientMessage
  connected: boolean
  nameOf: NameOf
  onOpenReport: (reportId: string | null) => void
}) {
  if (reportId !== undefined) {
    const report = view.reports.find(row => row.id === reportId)
    if (report) {
      return <ReportDetail teamPath={teamPath} report={report} sendMessage={sendMessage} connected={connected} nameOf={nameOf}
        onBack={() => onOpenReport(null)} />
    }
    if (view.metrics) {
      return <div className="flex flex-col gap-1" data-testid="report-missing">
        <p className="text-sm">Report {reportId} is not among the team's newest {REPORTS_IN_SNAPSHOT} reports.</p>
        <button type="button" className="self-start text-sm hover:underline" onClick={() => onOpenReport(null)}>← All reports</button>
      </div>
    }
    return null
  }
  const toggle = (id: string) => () => onToggleSection(id)
  return <div className="flex flex-col gap-2" data-testid="metrics-reports">
    <Section id="reports" title="Reports" count={view.reports.length} collapsed={collapsed.includes('reports')} onToggle={toggle('reports')}>
      <ReportList reports={view.reports} freshness={view.freshness} nameOf={nameOf} onOpenReport={onOpenReport} />
    </Section>
    <Section id="needs-link" title="Needs a link" count={needingLink(view.reports).length} collapsed={collapsed.includes('needs-link')} onToggle={toggle('needs-link')}>
      <NeedsLink reports={view.reports} onOpenReport={onOpenReport} />
    </Section>
    <Section id="unproposed" title="Unproposed changes" count={view.unproposed.length} collapsed={collapsed.includes('unproposed')} onToggle={toggle('unproposed')}>
      <UnproposedChanges changes={view.unproposed} nameOf={nameOf} />
    </Section>
  </div>
}
