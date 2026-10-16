// The Metrics tab's wire messages (team-process-metrics design D5), unioned
// into ServerMessage and ClientMessage in `types.ts`. A request names the
// team's directory (`teamPath`), resolved by the shared team-scope resolver;
// the snapshot echoes it beside `teamId`. Values are computed at read time:
// a snapshot is sent on open, on refresh (a fresh computation), and on every
// report or decision commit — never on mail changes, so the tab shows its
// `computedAt` and offers Refresh. One subscription per connection and team
// path; a later open replaces its window and slice.
import type { MetricSlice, MetricWindow, ProcessMetrics } from './processMetrics'

export type MetricsServerMessage = {
  type: 'process-metrics-snapshot'
  teamPath: string
  teamId: string
  window: MetricWindow
  slice: MetricSlice | null
  computedAt: string
  metrics: ProcessMetrics
}

export type MetricsClientMessage =
  | { type: 'process-metrics-open' | 'process-metrics-refresh'; teamPath: string; window: MetricWindow; slice: MetricSlice | null }
  | { type: 'process-metrics-close'; teamPath: string }
