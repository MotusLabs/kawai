// SDK-free process-metrics model (team-process-metrics design D4/D5) shared by
// the server core, the `team_metrics` tool, report snapshots, and the Metrics
// tab. Every metric is defined once here — family, unit, attribution side,
// role, guard, aggregation, and natural breakdown — and no surface or tool
// can change a definition, a guard pairing, or the sample threshold. Values
// are computed at read time and never stored (report snapshots freeze one).

export const METRIC_WINDOWS = ['1d', '3d', '7d'] as const
export type MetricWindow = (typeof METRIC_WINDOWS)[number]

const DAY_MS = 24 * 60 * 60 * 1000
export const WINDOW_MS: Record<MetricWindow, number> = { '1d': DAY_MS, '3d': 3 * DAY_MS, '7d': 7 * DAY_MS }

/** Below this `n` a value is flagged insufficient. */
export const MIN_SAMPLE = 10

export type MetricFamily = 'flow' | 'quality' | 'coverage' | 'overhead' | 'capacity'
export const METRIC_FAMILIES: readonly MetricFamily[] = ['flow', 'quality', 'coverage', 'overhead', 'capacity']

/** Whose work a metric measures (D4): slicing is allowed only on that side. */
export type MetricSide = 'author' | 'reviewer' | 'sender' | 'turn' | 'team'

export type MetricUnit = 'hours' | 'minutes' | 'share' | 'count' | 'tokens'

/**
 * How observations become a value: `p50`/`p90` nearest-rank percentiles,
 * `mean`, `sum`, `ratio` (Σ numerators / Σ denominators, `n` = Σ
 * denominators), and `shareOfTotal` (a breakdown row's count over the whole
 * count; the unbroken value is null, as no single group's share stands for
 * the team).
 */
export type MetricAggregation = 'p50' | 'p90' | 'mean' | 'sum' | 'ratio' | 'shareOfTotal'

/** A fixed per-metric breakdown shown whatever slice is chosen. */
export type MetricBreakdown = 'senderGroup' | 'frictionKind' | 'profile' | 'groupProfile'

/** `efficiency` metrics always carry a guard; `guard` metrics are someone's guard; `context` metrics neither. */
export type MetricRole = 'efficiency' | 'guard' | 'context'

export const METRIC_IDS = [
  'lead_time_p50', 'lead_time_p90',
  'mail_wait_normal_p50', 'mail_wait_normal_p90', 'mail_wait_urgent_p50', 'mail_wait_urgent_p90',
  'first_pass_yield', 'finding_fail_rate', 'fix_iterations', 'reopen_rate',
  'coverage_result', 'coverage_findings', 'accepted_result_share',
  'mail_share', 'task_mail_per_task', 'friction_total', 'friction_per_task',
  'limit_tax_hours', 'tokens_total', 'tokens_per_task',
] as const
export type MetricId = (typeof METRIC_IDS)[number]

export interface MetricDef {
  id: MetricId
  label: string
  family: MetricFamily
  unit: MetricUnit
  side: MetricSide
  role: MetricRole
  guard: MetricId | null
  aggregation: MetricAggregation
  breakdown: MetricBreakdown | null
  /** Which way is better, for reading a baseline delta; null when neither. */
  higherIsBetter: boolean | null
}

const def = (d: MetricDef): MetricDef => d

export const METRIC_DEFS: readonly MetricDef[] = [
  def({ id: 'lead_time_p50', label: 'Task lead time (p50)', family: 'flow', unit: 'hours', side: 'team', role: 'efficiency', guard: 'accepted_result_share', aggregation: 'p50', breakdown: null, higherIsBetter: false }),
  def({ id: 'lead_time_p90', label: 'Task lead time (p90)', family: 'flow', unit: 'hours', side: 'team', role: 'efficiency', guard: 'accepted_result_share', aggregation: 'p90', breakdown: null, higherIsBetter: false }),
  def({ id: 'mail_wait_normal_p50', label: 'Mail wait, normal (p50)', family: 'flow', unit: 'minutes', side: 'team', role: 'context', guard: null, aggregation: 'p50', breakdown: null, higherIsBetter: false }),
  def({ id: 'mail_wait_normal_p90', label: 'Mail wait, normal (p90)', family: 'flow', unit: 'minutes', side: 'team', role: 'context', guard: null, aggregation: 'p90', breakdown: null, higherIsBetter: false }),
  def({ id: 'mail_wait_urgent_p50', label: 'Mail wait, urgent (p50)', family: 'flow', unit: 'minutes', side: 'team', role: 'context', guard: null, aggregation: 'p50', breakdown: null, higherIsBetter: false }),
  def({ id: 'mail_wait_urgent_p90', label: 'Mail wait, urgent (p90)', family: 'flow', unit: 'minutes', side: 'team', role: 'context', guard: null, aggregation: 'p90', breakdown: null, higherIsBetter: false }),
  def({ id: 'first_pass_yield', label: 'First-pass review yield', family: 'quality', unit: 'share', side: 'author', role: 'guard', guard: null, aggregation: 'mean', breakdown: null, higherIsBetter: true }),
  def({ id: 'finding_fail_rate', label: 'Finding fail rate', family: 'quality', unit: 'share', side: 'reviewer', role: 'efficiency', guard: 'reopen_rate', aggregation: 'mean', breakdown: null, higherIsBetter: false }),
  def({ id: 'fix_iterations', label: 'Fix iterations per task', family: 'quality', unit: 'count', side: 'author', role: 'efficiency', guard: 'reopen_rate', aggregation: 'mean', breakdown: null, higherIsBetter: false }),
  def({ id: 'reopen_rate', label: 'Reopen rate', family: 'quality', unit: 'share', side: 'team', role: 'guard', guard: null, aggregation: 'ratio', breakdown: null, higherIsBetter: false }),
  def({ id: 'coverage_result', label: 'Done tasks with a result', family: 'coverage', unit: 'share', side: 'team', role: 'context', guard: null, aggregation: 'mean', breakdown: null, higherIsBetter: true }),
  def({ id: 'coverage_findings', label: 'Done tasks with findings', family: 'coverage', unit: 'share', side: 'team', role: 'context', guard: null, aggregation: 'mean', breakdown: null, higherIsBetter: true }),
  def({ id: 'accepted_result_share', label: 'Done tasks with an accepted result', family: 'coverage', unit: 'share', side: 'team', role: 'guard', guard: null, aggregation: 'mean', breakdown: null, higherIsBetter: true }),
  def({ id: 'mail_share', label: 'Mail share by sender group', family: 'overhead', unit: 'share', side: 'sender', role: 'efficiency', guard: 'reopen_rate', aggregation: 'shareOfTotal', breakdown: 'senderGroup', higherIsBetter: null }),
  def({ id: 'task_mail_per_task', label: 'Task mail per done task', family: 'overhead', unit: 'count', side: 'sender', role: 'efficiency', guard: 'reopen_rate', aggregation: 'ratio', breakdown: 'senderGroup', higherIsBetter: false }),
  def({ id: 'friction_total', label: 'Friction events', family: 'overhead', unit: 'count', side: 'team', role: 'context', guard: null, aggregation: 'sum', breakdown: 'frictionKind', higherIsBetter: false }),
  def({ id: 'friction_per_task', label: 'Friction per done task', family: 'overhead', unit: 'count', side: 'team', role: 'efficiency', guard: 'reopen_rate', aggregation: 'ratio', breakdown: 'frictionKind', higherIsBetter: false }),
  def({ id: 'limit_tax_hours', label: 'Limit tax (cooling + parked hours)', family: 'capacity', unit: 'hours', side: 'team', role: 'context', guard: null, aggregation: 'sum', breakdown: 'profile', higherIsBetter: false }),
  def({ id: 'tokens_total', label: 'Tokens', family: 'capacity', unit: 'tokens', side: 'turn', role: 'context', guard: null, aggregation: 'sum', breakdown: 'groupProfile', higherIsBetter: null }),
  def({ id: 'tokens_per_task', label: 'Tokens per done task', family: 'capacity', unit: 'tokens', side: 'author', role: 'efficiency', guard: 'first_pass_yield', aggregation: 'mean', breakdown: null, higherIsBetter: false }),
]

export const METRIC_DEF_BY_ID: ReadonlyMap<MetricId, MetricDef> = new Map(METRIC_DEFS.map(d => [d.id, d]))

export function isMetricId(value: unknown): value is MetricId {
  return typeof value === 'string' && (METRIC_IDS as readonly string[]).includes(value)
}

export function isMetricWindow(value: unknown): value is MetricWindow {
  return typeof value === 'string' && (METRIC_WINDOWS as readonly string[]).includes(value)
}

/** What a metric can be sliced by: the agent start's group, profile, group file hash, or one memory file's hash. */
export type MetricSlice =
  | { kind: 'group' }
  | { kind: 'profile' }
  | { kind: 'groupFileHash' }
  | { kind: 'memoryFile'; file: string }

export const SLICE_KINDS = ['group', 'profile', 'groupFileHash', 'memoryFile'] as const

/** Which slices a side supports (D4): sender mail slices by group only; team metrics by none, limit tax by profile. */
export function sliceAllowed(metric: MetricDef, slice: MetricSlice): boolean {
  switch (metric.side) {
    case 'author': case 'reviewer': case 'turn': return true
    case 'sender': return slice.kind === 'group'
    case 'team': return metric.id === 'limit_tax_hours' && slice.kind === 'profile'
  }
}

export function sliceLabel(slice: MetricSlice | null): string {
  if (!slice) return 'none'
  return slice.kind === 'memoryFile' ? `memory file ${slice.file}` : slice.kind
}

/** Slice keys that are not a recorded value. */
export const UNRECORDED_SLICE = 'unrecorded'
export const NO_RESULT_SLICE = 'no result'

export interface MetricStat {
  value: number | null
  n: number
  insufficient: boolean
}

export interface MetricRow extends MetricStat {
  key: string
  baseline: MetricStat
  /** Author side: owned tasks with a later result from a start whose slice value differs. */
  mixed?: number
}

export interface MetricDrillTask {
  id: string
  title: string
}

export interface MetricDrillMessage {
  id: string
  threadId: string
}

export interface MetricValue extends MetricStat {
  id: MetricId
  baseline: MetricStat
  /** Some inputs came from backfilled transitions (lead time from approximate `done` times). */
  approximate: boolean
  /** Some cohort history predates usage retention, so token values are incomplete. */
  partial: boolean
  /** The tasks and messages behind the value, for drill-down: each opens its task or its message's thread. */
  drill: { tasks: MetricDrillTask[]; messages: MetricDrillMessage[] }
  breakdown?: MetricRow[]
  /** Present when a slice was requested and the metric supports it. */
  slices?: MetricRow[]
  /** A slice was requested that this metric's side does not support. */
  notSliceable?: boolean
}

export interface ProcessMetrics {
  teamId: string
  window: MetricWindow
  slice: MetricSlice | null
  periodStart: string
  periodEnd: string
  baselineStart: string
  computedAt: string
  minSample: number
  metrics: MetricValue[]
  usageCaveat: string
  coverageCaveat: string
}

export const USAGE_CAVEAT = 'Token counts cover completed chat turns only: usage spent by Task subagents and by turns that never completed is not counted. Tokens only, never currency.'
export const COVERAGE_CAVEAT = 'Quality metrics count submitted results and findings only; work reviewed only by mail is not counted.'

/** Nearest-rank percentile of `values` (unsorted); null when empty. */
export function nearestRank(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]!
}
