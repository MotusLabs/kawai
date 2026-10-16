// One family of the Metrics tab (team-process-metrics D5): a collapsible
// section of its metrics in definition order, with the caveat that bounds
// the family (usage for capacity, coverage for quality and coverage).
import { METRIC_DEFS, type MetricFamily as Family, type MetricId, type MetricValue } from '@shared/processMetrics'
import MetricRow from './MetricRow'

const FAMILY_LABELS: Record<Family, string> = {
  flow: 'Flow', quality: 'Quality', coverage: 'Coverage', overhead: 'Overhead', capacity: 'Capacity',
}

export default function MetricFamily({ family, metrics, caveat, collapsed, expanded, onToggleCollapsed, onToggleDrill, onOpenTask, onOpenThread }: {
  family: Family
  metrics: ReadonlyMap<MetricId, MetricValue>
  caveat: string | null
  collapsed: boolean
  /** Metric ids whose drill-down is open. */
  expanded: readonly string[]
  onToggleCollapsed: () => void
  onToggleDrill: (id: MetricId) => void
  onOpenTask: (taskId: string) => void
  onOpenThread: (threadId: string) => void
}) {
  const defs = METRIC_DEFS.filter(def => def.family === family && metrics.has(def.id))
  return <section className="border border-border p-3" data-testid="metric-family" data-family={family}>
    <h3>
      <button type="button" className="font-medium hover:underline" aria-expanded={!collapsed}
        data-testid="metric-family-toggle" onClick={onToggleCollapsed}>
        {collapsed ? '▸' : '▾'} {FAMILY_LABELS[family]} <span className="text-secondary">({defs.length})</span>
      </button>
    </h3>
    {!collapsed && <>
      <ul>{defs.map(def => <MetricRow key={def.id} metric={metrics.get(def.id)!}
        guard={def.guard ? metrics.get(def.guard) ?? null : null}
        expanded={expanded.includes(def.id)} onToggleDrill={() => onToggleDrill(def.id)}
        onOpenTask={onOpenTask} onOpenThread={onOpenThread} />)}</ul>
      {caveat && <p className="mt-1 text-chat-meta text-secondary" data-testid="metric-caveat">{caveat}</p>}
    </>}
  </section>
}
