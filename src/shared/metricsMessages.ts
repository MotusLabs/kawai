// The Metrics tab's wire messages (team-process-metrics design D5), unioned
// into ServerMessage and ClientMessage in `types.ts`. A request names the
// team's directory (`teamPath`), resolved by the shared team-scope resolver;
// the snapshot echoes it beside `teamId`. Values are computed at read time:
// a snapshot is sent on open, on refresh (a fresh computation), and on every
// report or decision commit — never on mail changes, so the tab shows its
// `computedAt` and offers Refresh. One subscription per connection and team
// path; a later open replaces its window and slice. The snapshot also
// carries the team's newest reports plus every older report still holding a
// proposal the human can act on (with each proposal's derived state),
// per-window freshness, and the window's unproposed version changes. Any
// other report is read by id: `process-report-open` subscribes the connection
// to it, answered (and re-sent on every commit) by `process-report-detail`,
// with `report: null` when the team has no such report. The
// human's proposal commands (team-process-metrics D6) carry a command key and
// answer `process-proposal-result`; a committed one re-sends the snapshots.
import type { MetricSlice, MetricWindow, ProcessMetrics } from './processMetrics'
import type { ProcessReport, ProposalDecision, ProposalLinkEvent, ReportFreshness, VersionChange } from './processReports'

export type MetricsServerMessage = {
  type: 'process-metrics-snapshot'
  teamPath: string
  teamId: string
  window: MetricWindow
  slice: MetricSlice | null
  computedAt: string
  metrics: ProcessMetrics
  /**
   * The newest `REPORTS_IN_SNAPSHOT` reports, then every older one holding an
   * undecided proposal or an accepted one without a link; newest first.
   */
  reports: ProcessReport[]
  freshness: ReportFreshness[]
  /** Version changes in the subscribed window that no accepted proposal's current link names. */
  unproposed: VersionChange[]
} | {
  type: 'process-report-detail'
  teamPath: string
  teamId: string
  reportId: string
  /** Null when the team has no report with this id. */
  report: ProcessReport | null
} | {
  type: 'process-proposal-result'
  teamPath: string
  commandId: string
  kind: 'decide' | 'link'
  /** True when the command key had already committed and its stored outcome was returned. */
  replayed?: boolean
  decision?: ProposalDecision
  link?: ProposalLinkEvent
  error?: string
}

export const REPORTS_IN_SNAPSHOT = 20

export type MetricsClientMessage =
  | { type: 'process-metrics-open' | 'process-metrics-refresh'; teamPath: string; window: MetricWindow; slice: MetricSlice | null }
  | { type: 'process-metrics-close'; teamPath: string }
  /** Read one report by id and keep receiving it after commits, until closed. */
  | { type: 'process-report-open' | 'process-report-close'; teamPath: string; reportId: string }
  | { type: 'process-proposal-decide'; teamPath: string; proposalId: string; decision: 'accepted' | 'rejected'; reason?: string | null; commandId: string }
  /** `changeStartId: null` unlinks. */
  | { type: 'process-proposal-link'; teamPath: string; proposalId: string; changeStartId: string | null; commandId: string }
