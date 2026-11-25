// The `team_metrics` tool on the per-session `kawai-team` MCP server
// (team-process-metrics D5): read-only, bound to the calling session's team —
// a team argument is never accepted, so another team's numbers cannot be
// asked for — and returning exactly what the Metrics tab computes (the same
// `MetricsReader`, so a tab read and a tool call in one moment share a
// computation) plus the usage caveat. No tool changes a metric definition,
// guard pairing, or sample threshold; those are constants. `team_metrics`
// returns a compact projection by default; `team_metrics_drill`
// (bounded-metrics-reads D2) pages one drill list of a live read or a stored
// report, so every entry a compact read shortens stays reachable.
import { z } from 'zod'
import { METRIC_WINDOWS, isMetricWindow, type MetricSlice, type ProcessMetrics } from '../../shared/processMetrics'
import { compactMetrics } from './metricsProjection'
import type { MetricsReader } from './computeMetrics'
import { DRILL_LISTS, TOOL_STREAK_METRICS, readDrillPage, type DrillPage, type DrillReports } from './metricsDrill'

export const METRICS_TOOL_NAMES = ['team_metrics', 'team_metrics_drill'] as const

const sliceSchema = z.object({ kind: z.string(), file: z.string().optional() })

// Window and slice are checked by the handler so a refusal names what is allowed.
export const metricsSchemas = {
  team_metrics: z.object({
    window: z.string(),
    detail:z.enum(['compact','full']).optional(),
    slice: sliceSchema.optional(),
  }),
  // Every argument is optional so the handler names what is missing or
  // allowed; unknown arguments are refused (strict), never stripped, so a
  // cursor sent with a stray field fails in both runtimes' validation.
  team_metrics_drill: z.strictObject({
    cursor: z.string().optional(),
    window: z.string().optional(),
    slice: sliceSchema.optional(),
    end: z.string().optional(),
    report_id: z.string().optional(),
    metric: z.string().optional(),
    list: z.string().optional(),
    limit: z.number().optional(),
  }),
}

export const metricsDescriptions: Record<(typeof METRICS_TOOL_NAMES)[number], string> = {
  team_metrics: `Read your team's development-process metrics for a window (${METRIC_WINDOWS.join(', ')}) ending now: flow, quality, coverage, overhead, and capacity, each with its value, sample size n, insufficient-sample flag (n below 10), the preceding window as baseline, its paired guard metric, and the task and message ids behind it. Optional slice {kind: group | profile | groupFileHash | memoryFile, file?} splits each metric by the agent start on its own side; a metric whose side does not support the slice is marked notSliceable. Optional detail compact (default) | full: compact stays below 32 KB, keeps every value, n, baseline, and flag, keeps at most 50 entries of each drill, breakdown, and slice list, marks each shortened list with <key>Total (e.g. messagesTotal) and the read with projectionTruncated: true; full returns every row. Page a shortened drill list with team_metrics_drill, passing this read's periodEnd as end. Read-only.`,
  team_metrics_drill: `Page one drill list of one metric, so every entry a compact team_metrics read shortened stays reachable. First page: {window, slice?, end?, metric, list, limit?} for a live window (end: an ISO instant no later than now, normally the compact read's periodEnd; default now), or {report_id, metric, list, limit?} for a stored report's frozen snapshot. list: ${DRILL_LISTS.join(' | ')} (toolStreaks only on ${TOOL_STREAK_METRICS.join(', ')}). limit: integer 1–200 (default 100) for tasks and messages, 1–50 (default 50) for toolStreaks. Each page returns {metric, list, total, entries, next, source}; tasks and messages come in id order. Continue with {cursor: next} alone until next is null: the cursor is bound to your team, the source, its window end, the metric, list, and limit, and for live tool streaks to the first page's high-water mark, so later activity never shifts pages. A report's toolStreaks pages hold only the stored entries, stated as reachable beside total. Unknown arguments are refused. Read-only.`,
}

/** What the tool needs from the server: the caller's team and the shared reader. */
export interface MetricsToolDeps {
  teamOf: (sessionId: string) => string | null
  reader: MetricsReader
}

const SLICE_KINDS = ['group', 'profile', 'groupFileHash', 'memoryFile'] as const

export function parseSlice(input: { kind: string; file?: string } | undefined): MetricSlice | null {
  if (!input) return null
  switch (input.kind) {
    case 'group': case 'profile': case 'groupFileHash': return { kind: input.kind }
    case 'memoryFile':
      if (!input.file?.trim()) throw new Error('A memoryFile slice needs file: the memory file path, e.g. MEMORY.md.')
      return { kind: 'memoryFile', file: input.file.trim() }
    default: throw new Error(`Unknown slice kind "${input.kind}". Allowed: ${SLICE_KINDS.join(', ')}.`)
  }
}

export function readTeamMetrics(deps: MetricsToolDeps, sessionId: string, input: unknown): ProcessMetrics {
  const { window, slice, detail } = metricsSchemas.team_metrics.parse(input)
  if (!isMetricWindow(window)) throw new Error(`Unknown window "${window}". Allowed windows: ${METRIC_WINDOWS.join(', ')}.`)
  const teamId = teamOf(deps, sessionId)
  const metrics=deps.reader.read(teamId, window, parseSlice(slice))
  return detail==='full'?metrics:compactMetrics(metrics)
}

function teamOf(deps: MetricsToolDeps, sessionId: string): string {
  const teamId = deps.teamOf(sessionId)
  if (!teamId) throw new Error('This session belongs to no team yet, so there are no team metrics to read.')
  return teamId
}

/** One `team_metrics_drill` page for the caller's team; report sources read `reports`. */
export function readTeamDrill(deps: MetricsToolDeps, sessionId: string, input: unknown, reports?: DrillReports): DrillPage {
  const parsed = metricsSchemas.team_metrics_drill.safeParse(input ?? {})
  if (!parsed.success) throw new Error(`Invalid team_metrics_drill arguments: ${z.prettifyError(parsed.error)}`)
  const { slice, ...request } = parsed.data
  const teamId = teamOf(deps, sessionId)
  return readDrillPage({ reader: deps.reader, reports }, teamId, { ...request, ...(slice ? { slice: parseSlice(slice) } : {}) })
}

export function metricsHandlers(deps: MetricsToolDeps, sessionId: string, reports?: DrillReports) {
  return {
    team_metrics: async (input: unknown) => readTeamMetrics(deps, sessionId, input),
    team_metrics_drill: async (input: unknown) => readTeamDrill(deps, sessionId, input, reports),
  }
}
