// The Team page's Metrics tab (team-process-metrics D5). The URL names the
// window (`#/team/<key>/metrics/<window>`; `resolveMetricsWindow` adopts the
// team's last window, 7d the first time, when it names none). The slice, the
// memory-file name, collapsed families, and open drill-downs are per-team
// tab state in `teamWorkspaceStore`. The view owns its subscription: one
// open per window and slice (a cached server read), Refresh recomputes, and
// close ends it. Every control disables while disconnected. The report
// sections (D6) sit above the families; a location naming a report
// (`metrics/<window>/<report id>`) shows that report in their place.
import { useEffect, useMemo, useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import {
  COVERAGE_CAVEAT, METRIC_FAMILIES, METRIC_WINDOWS, SLICE_KINDS, isMetricWindow,
  type MetricFamily as Family, type MetricId, type MetricSlice, type MetricValue, type MetricWindow,
} from '@shared/processMetrics'
import { useMetricsStore, type MetricsView as MetricsViewData } from '../../../stores/metricsStore'
import { emptyTabViewState, useTeamWorkspaceStore } from '../../../stores/teamWorkspaceStore'
import MetricFamily from './MetricFamily'
import MetricsReports from './MetricsReports'
import type { NameOf } from './reportLabels'

export const DEFAULT_METRICS_WINDOW: MetricWindow = '7d'

type SliceKind = (typeof SLICE_KINDS)[number]
const SLICE_LABELS: Record<SliceKind, string> = {
  group: 'Group', profile: 'Profile', groupFileHash: 'Group file version', memoryFile: 'Memory file version',
}

/** The slice the stored filters name; a memory-file slice without a file requests none yet. */
export function sliceOf(filters: Record<string, string | boolean>): MetricSlice | null {
  const kind = filters.slice
  if (kind === 'memoryFile') {
    const file = typeof filters.sliceFile === 'string' ? filters.sliceFile.trim() : ''
    return file ? { kind: 'memoryFile', file } : null
  }
  return kind === 'group' || kind === 'profile' || kind === 'groupFileHash' ? { kind } : null
}

/**
 * The page's location → window step (run by TeamWorkspaceView after its own
 * notice effect): a valid window is remembered as the team's; none adopts the
 * remembered one (7d the first time) by replacing the entry, with a notice
 * when the URL named something else.
 */
export function resolveMetricsWindow(teamKey: string, locationWindow: string | undefined, navigate: (window: MetricWindow) => void): void {
  const store = useTeamWorkspaceStore.getState()
  if (isMetricWindow(locationWindow)) {
    store.setFilters(teamKey, 'metrics', { window: locationWindow })
    return
  }
  const stored = store.views[teamKey]?.tabs.metrics.filters.window
  const fallback = isMetricWindow(stored) ? stored : DEFAULT_METRICS_WINDOW
  if (locationWindow !== undefined) store.setNotice(teamKey, `Unknown metrics window ${locationWindow}; showing ${fallback}`)
  navigate(fallback)
}

export default function MetricsView({
  teamPath, view, locationWindow, reportId, sendMessage, connected, connectionEpoch, nameOf, onWindow, onOpenReport, onOpenTask, onOpenThread,
}: {
  teamPath: string
  view: MetricsViewData | undefined
  /** The location's raw window segment. */
  locationWindow: string | undefined
  /** The location's report id, when it names one. */
  reportId: string | undefined
  nameOf: NameOf
  onOpenReport: (reportId: string | null) => void
  sendMessage: SendClientMessage
  connected: boolean
  connectionEpoch: number
  onWindow: (window: MetricWindow, options?: { replace?: boolean }) => void
  onOpenTask: (taskId: string) => void
  onOpenThread: (threadId: string) => void
}) {
  const tab = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.metrics) ?? emptyTabViewState()
  const chosen = isMetricWindow(locationWindow) ? locationWindow : null
  const slice = sliceOf(tab.filters)
  const sliceKey = JSON.stringify(slice)
  const sliceKind = typeof tab.filters.slice === 'string' ? tab.filters.slice : ''
  const [fileDraft, setFileDraft] = useState(typeof tab.filters.sliceFile === 'string' ? tab.filters.sliceFile : '')

  useEffect(() => {
    if (!connected || !chosen) return
    const requested = JSON.parse(sliceKey) as MetricSlice | null
    useMetricsStore.getState().request(teamPath, { window: chosen, slice: requested })
    sendMessage({ type: 'process-metrics-open', teamPath, window: chosen, slice: requested })
    return () => {
      sendMessage({ type: 'process-metrics-close', teamPath })
      useMetricsStore.getState().close(teamPath)
    }
  }, [teamPath, connected, connectionEpoch, chosen, sliceKey, sendMessage])

  const refresh = () => {
    if (!chosen) return
    useMetricsStore.getState().request(teamPath, { window: chosen, slice })
    sendMessage({ type: 'process-metrics-refresh', teamPath, window: chosen, slice })
  }
  const setSlice = (kind: string) => useTeamWorkspaceStore.getState().setFilters(teamPath, 'metrics', { slice: kind || undefined })
  const applyFile = () => useTeamWorkspaceStore.getState().setFilters(teamPath, 'metrics', { sliceFile: fileDraft.trim() || undefined })

  const snapshot = view?.metrics ?? null
  const byId = useMemo(
    () => new Map<MetricId, MetricValue>((snapshot?.metrics ?? []).map(metric => [metric.id, metric])),
    [snapshot],
  )
  const caveatOf = (family: Family) => family === 'capacity'
    ? snapshot?.usageCaveat ?? null
    : family === 'quality' || family === 'coverage' ? snapshot?.coverageCaveat ?? COVERAGE_CAVEAT : null
  const store = useTeamWorkspaceStore.getState()

  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3" data-testid="metrics-view">
    <div className="flex flex-wrap items-center gap-2" data-testid="metrics-controls">
      <div role="radiogroup" aria-label="Metrics window" className="flex gap-1">
        {METRIC_WINDOWS.map(option => <button key={option} type="button" role="radio" aria-checked={chosen === option}
          className={`btn text-sm ${chosen === option ? 'btn-primary' : ''}`} disabled={!connected}
          data-testid={`metrics-window-${option}`} onClick={() => onWindow(option)}>{option}</button>)}
      </div>
      <label className="text-sm">
        Slice{' '}
        <select value={sliceKind} disabled={!connected} data-testid="metrics-slice"
          className="border border-border bg-base" onChange={event => setSlice(event.target.value)}>
          <option value="">None</option>
          {SLICE_KINDS.map(kind => <option key={kind} value={kind}>{SLICE_LABELS[kind]}</option>)}
        </select>
      </label>
      {sliceKind === 'memoryFile' && <form className="flex items-center gap-1" onSubmit={event => { event.preventDefault(); applyFile() }}>
        <input value={fileDraft} disabled={!connected} placeholder="MEMORY.md" aria-label="Memory file"
          className="border border-border bg-base px-1 text-sm" data-testid="metrics-slice-file"
          onChange={event => setFileDraft(event.target.value)} />
        <button type="submit" className="btn text-sm" disabled={!connected}>Apply</button>
      </form>}
      <button type="button" className="btn text-sm" disabled={!connected || !chosen} data-testid="metrics-refresh" onClick={refresh}>Refresh</button>
      <span className="text-chat-meta text-secondary" data-testid="metrics-computed-at">
        {view?.loading ? 'Loading…' : snapshot ? `Computed ${new Date(snapshot.computedAt).toLocaleString()}` : ''}
      </span>
    </div>
    {sliceKind === 'memoryFile' && !slice && <p className="mt-1 text-chat-meta text-secondary" data-testid="metrics-slice-hint">
      Name a memory file to slice by its version.
    </p>}
    {snapshot && <p className="mt-1 text-chat-meta text-secondary" data-testid="metrics-period">
      {snapshot.window} window {new Date(snapshot.periodStart).toLocaleString()} – {new Date(snapshot.periodEnd).toLocaleString()};
      baseline from {new Date(snapshot.baselineStart).toLocaleString()}. Values with n &lt; {snapshot.minSample} are flagged insufficient.
    </p>}
    {!snapshot && !view?.loading && <p className="mt-2 text-sm text-secondary" data-testid="metrics-empty">
      {connected ? 'No metrics loaded.' : 'Disconnected — reconnect to load metrics.'}
    </p>}
    {view && (snapshot || reportId !== undefined) && <div className="mt-2">
      <MetricsReports teamPath={teamPath} view={view} reportId={reportId} collapsed={tab.collapsedSections}
        onToggleSection={id => store.toggleSectionCollapsed(teamPath, 'metrics', id)}
        sendMessage={sendMessage} connected={connected} connectionEpoch={connectionEpoch} nameOf={nameOf} onOpenReport={onOpenReport} />
    </div>}
    {snapshot && reportId === undefined && <div className="mt-2 flex flex-col gap-2">
      {METRIC_FAMILIES.map(family => <MetricFamily key={family} family={family} metrics={byId} caveat={caveatOf(family)}
        collapsed={tab.collapsedSections.includes(family)} expanded={tab.expanded}
        onToggleCollapsed={() => store.toggleSectionCollapsed(teamPath, 'metrics', family)}
        onToggleDrill={id => store.toggleExpanded(teamPath, 'metrics', id)}
        onOpenTask={onOpenTask} onOpenThread={onOpenThread} />)}
    </div>}
  </div>
}
