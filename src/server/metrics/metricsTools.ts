// The `team_metrics` tool on the per-session `kawai-team` MCP server
// (team-process-metrics D5): read-only, bound to the calling session's team —
// a team argument is never accepted, so another team's numbers cannot be
// asked for — and returning exactly what the Metrics tab computes (the same
// `MetricsReader`, so a tab read and a tool call in one moment share a
// computation) plus the usage caveat. No tool changes a metric definition,
// guard pairing, or sample threshold; those are constants.
import { z } from 'zod'
import { METRIC_WINDOWS, isMetricWindow, type MetricSlice, type ProcessMetrics } from '../../shared/processMetrics'
import type { MetricsReader } from './computeMetrics'

export const METRICS_TOOL_NAMES = ['team_metrics'] as const

// Window and slice are checked by the handler so a refusal names what is allowed.
export const metricsSchemas = {
  team_metrics: z.object({
    window: z.string(),
    slice: z.object({ kind: z.string(), file: z.string().optional() }).optional(),
  }),
}

export const metricsDescriptions: Record<(typeof METRICS_TOOL_NAMES)[number], string> = {
  team_metrics: `Read your team's development-process metrics for a window (${METRIC_WINDOWS.join(', ')}) ending now: flow, quality, coverage, overhead, and capacity, each with its value, sample size n, insufficient-sample flag (n below 10), the preceding window as baseline, its paired guard metric, and the task and message ids behind it. Optional slice {kind: group | profile | groupFileHash | memoryFile, file?} splits each metric by the agent start on its own side; a metric whose side does not support the slice is marked notSliceable. Read-only.`,
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
  const { window, slice } = metricsSchemas.team_metrics.parse(input)
  if (!isMetricWindow(window)) throw new Error(`Unknown window "${window}". Allowed windows: ${METRIC_WINDOWS.join(', ')}.`)
  const teamId = deps.teamOf(sessionId)
  if (!teamId) throw new Error('This session belongs to no team yet, so there are no team metrics to read.')
  return deps.reader.read(teamId, window, parseSlice(slice))
}

export function metricsHandlers(deps: MetricsToolDeps, sessionId: string) {
  return {
    team_metrics: async (input: unknown) => readTeamMetrics(deps, sessionId, input),
  }
}
