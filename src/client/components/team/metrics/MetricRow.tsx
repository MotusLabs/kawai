// One metric of the Metrics tab (team-process-metrics D5): its value, `n`,
// baseline and delta, the insufficient-sample flag naming the threshold, the
// guard it is read beside, the approximate/partial/not-sliceable markers,
// the fixed breakdown and requested slice rows, and a drill-down listing the
// tasks (opening the Tasks tab) and messages (opening their thread).
import { METRIC_DEF_BY_ID, type MetricRow as MetricRowData, type MetricValue } from '@shared/processMetrics'
import { baselineLabel, formatDelta, formatValue, insufficientLabel } from './metricFormat'

function Rows({ title, rows, metric, testId }: { title: string; rows: MetricRowData[]; metric: MetricValue; testId: string }) {
  const def = METRIC_DEF_BY_ID.get(metric.id)!
  return <div className="mt-1" data-testid={testId}>
    <p className="text-chat-meta text-secondary">{title}</p>
    <table className="text-chat-meta">
      <tbody>{rows.map(row => <tr key={row.key} data-testid={`${testId}-row`} data-key={row.key}>
        <td className="pr-3">{row.key}</td>
        <td className="pr-3">{formatValue(row.value, def.unit)}</td>
        <td className="pr-3 text-secondary">n={row.n}</td>
        <td className="pr-3 text-secondary">{formatDelta(def, row, row.baseline) ?? baselineLabel(def, row.baseline)}</td>
        <td className="text-secondary">
          {[insufficientLabel(row), row.mixed ? `${row.mixed} mixed` : null].filter(Boolean).join(' · ')}
        </td>
      </tr>)}</tbody>
    </table>
  </div>
}

export default function MetricRow({ metric, guard, expanded, onToggleDrill, onOpenTask, onOpenThread }: {
  metric: MetricValue
  /** The guard metric's value in the same read, when this metric has one. */
  guard: MetricValue | null
  expanded: boolean
  onToggleDrill: () => void
  onOpenTask: (taskId: string) => void
  onOpenThread: (threadId: string) => void
}) {
  const def = METRIC_DEF_BY_ID.get(metric.id)!
  const guardDef = def.guard ? METRIC_DEF_BY_ID.get(def.guard)! : null
  const markers = [
    insufficientLabel(metric),
    metric.approximate ? 'approximate (backfilled done times)' : null,
    metric.partial ? 'partial (history predates usage records)' : null,
    metric.notSliceable ? 'not sliceable by this slice' : null,
  ].filter((marker): marker is string => marker !== null)
  const drillCount = metric.drill.tasks.length + metric.drill.messages.length
  return <li className="border-t border-border py-2" data-testid="metric-row" data-metric-id={metric.id}>
    <div className="flex flex-wrap items-baseline gap-x-3">
      <span className="font-medium">{def.label}</span>
      <span data-testid="metric-value">{formatValue(metric.value, def.unit)}</span>
      <span className="text-chat-meta text-secondary" data-testid="metric-n">n={metric.n}</span>
      <span className="text-chat-meta text-secondary" data-testid="metric-baseline">
        {formatDelta(def, metric, metric.baseline) ?? baselineLabel(def, metric.baseline)}
      </span>
    </div>
    {markers.length > 0 && <p className="text-chat-meta text-secondary" data-testid="metric-markers">{markers.join(' · ')}</p>}
    {guardDef && <p className="text-chat-meta text-secondary" data-testid="metric-guard">
      Guard: {guardDef.label} {guard ? `${formatValue(guard.value, guardDef.unit)} (n=${guard.n})` : '—'}
    </p>}
    {metric.breakdown && metric.breakdown.length > 0 && <Rows title={`By ${def.breakdown}`} rows={metric.breakdown} metric={metric} testId="metric-breakdown" />}
    {metric.slices && <Rows title="By slice" rows={metric.slices} metric={metric} testId="metric-slices" />}
    {drillCount > 0 && <div className="mt-1">
      <button type="button" className="text-chat-meta text-secondary hover:text-primary hover:underline" aria-expanded={expanded}
        data-testid="metric-drill-toggle" onClick={onToggleDrill}>
        {expanded ? 'Hide' : 'Show'} {metric.drill.tasks.length} tasks · {metric.drill.messages.length} messages
      </button>
      {expanded && <ul className="text-chat-meta" data-testid="metric-drill">
        {metric.drill.tasks.map(task => <li key={`t:${task.id}`}>
          <button type="button" className="hover:underline" data-testid="metric-drill-task" onClick={() => onOpenTask(task.id)}>Task {task.title}</button>
        </li>)}
        {metric.drill.messages.map(message => <li key={`m:${message.id}`}>
          <button type="button" className="hover:underline" data-testid="metric-drill-message" onClick={() => onOpenThread(message.threadId)}>
            Message {message.id.slice(0, 8)} · thread {message.threadId.slice(0, 8)}
          </button>
        </li>)}
      </ul>}
    </div>}
  </li>
}
