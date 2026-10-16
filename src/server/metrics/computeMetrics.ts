// Assembles `ProcessMetrics` (team-process-metrics D4): one load over the
// window and its baseline, two contexts, every family's observations, then
// per metric its value, `n`, sufficiency, baseline (the same computation over
// the preceding window of equal length), drill-down ids, its fixed breakdown,
// and — when a slice is asked — rows by that slice on the metric's own side,
// or `notSliceable`. Identical inputs give identical results. `MetricsReader`
// caches a read per (team, window, slice) for 30 s so the tab and a tool call
// in the same moment share one computation; a `fresh` read (the tab's
// Refresh) recomputes and replaces the cached entry.
import type { Database } from 'bun:sqlite'
import {
  COVERAGE_CAVEAT, METRIC_DEFS, MIN_SAMPLE, USAGE_CAVEAT, WINDOW_MS, sliceAllowed,
  type MetricDef, type MetricSlice, type MetricValue, type MetricWindow, type ProcessMetrics,
} from '../../shared/processMetrics'
import { capacityObservations } from './capacity'
import { flowObservations } from './flow'
import { metricsContext, type MetricsContext } from './metricsContext'
import { loadMetricsInputs, type MetricsInputs } from './metricsQuery'
import { overheadObservations } from './overhead'
import { coverageObservations, qualityObservations } from './quality'
import { StartResolver, aggregate, rows, sliceKey, type Observation } from './slices'

export const METRICS_CACHE_MS = 30_000

function observations(ctx: MetricsContext): Map<string, Observation[]> {
  const byMetric = new Map<string, Observation[]>()
  for (const o of [
    ...flowObservations(ctx), ...qualityObservations(ctx), ...coverageObservations(ctx),
    ...overheadObservations(ctx), ...capacityObservations(ctx),
  ]) byMetric.set(o.metric, [...(byMetric.get(o.metric) ?? []), o])
  return byMetric
}

function metricValue(def: MetricDef, current: Observation[], baseline: Observation[], slice: MetricSlice | null, inputs: MetricsInputs): MetricValue {
  const manifests = inputs.manifests
  const now = aggregate(def, current)
  const before = aggregate(def, baseline)
  const value: MetricValue = {
    id: def.id, value: now.value, n: now.n, insufficient: now.insufficient,
    baseline: { value: before.value, n: before.n, insufficient: before.insufficient },
    approximate: now.approximate, partial: now.partial,
    drill: {
      tasks: now.tasks.map(id => ({ id, title: inputs.tasks.get(id)?.title ?? id })),
      messages: now.messages.map(id => ({ id, threadId: inputs.messages.get(id)?.threadId ?? id })),
    },
  }
  if (def.breakdown) value.breakdown = rows(def, current, baseline, o => o.key)
  if (slice) {
    if (!sliceAllowed(def, slice)) value.notSliceable = true
    else if (def.side === 'team') value.slices = rows(def, current, baseline, o => o.key)
    else {
      const keyOf = (o: Observation) => (o.attribution ? sliceKey(o.attribution, slice, manifests) : undefined)
      value.slices = rows(def, current, baseline, keyOf, def.side === 'author'
        ? (o, key) => (o.later ?? []).some(a => sliceKey(a, slice, manifests) !== key)
        : undefined)
    }
  }
  return value
}

export function computeMetrics(inputs: MetricsInputs, window: MetricWindow, slice: MetricSlice | null, computedAt: number): ProcessMetrics {
  const span = WINDOW_MS[window]
  const resolver = new StartResolver(inputs.starts)
  const current = observations(metricsContext(inputs, inputs.end - span, inputs.end, resolver))
  const baseline = observations(metricsContext(inputs, inputs.end - 2 * span, inputs.end - span, resolver))
  return {
    teamId: inputs.teamId, window, slice,
    periodStart: new Date(inputs.end - span).toISOString(),
    periodEnd: new Date(inputs.end).toISOString(),
    baselineStart: new Date(inputs.end - 2 * span).toISOString(),
    computedAt: new Date(computedAt).toISOString(),
    minSample: MIN_SAMPLE,
    metrics: METRIC_DEFS.map(def => metricValue(def, current.get(def.id) ?? [], baseline.get(def.id) ?? [], slice, inputs)),
    usageCaveat: USAGE_CAVEAT,
    coverageCaveat: COVERAGE_CAVEAT,
  }
}

/** Loads and computes one team's metrics for a window ending at `end`. */
export function readMetrics(db: Database, teamId: string, window: MetricWindow, slice: MetricSlice | null, end: number): ProcessMetrics {
  return computeMetrics(loadMetricsInputs(db, teamId, end - 2 * WINDOW_MS[window], end), window, slice, end)
}

export class MetricsReader {
  private readonly cache = new Map<string, { at: number; metrics: ProcessMetrics }>()

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  read(teamId: string, window: MetricWindow, slice: MetricSlice | null, options: { fresh?: boolean } = {}): ProcessMetrics {
    const key = JSON.stringify([teamId, window, slice])
    const at = this.now()
    const hit = this.cache.get(key)
    if (hit && !options.fresh && at - hit.at < METRICS_CACHE_MS) return hit.metrics
    for (const [k, v] of this.cache) if (at - v.at >= METRICS_CACHE_MS) this.cache.delete(k)
    const metrics = readMetrics(this.db, teamId, window, slice, at)
    this.cache.set(key, { at, metrics })
    return metrics
  }
}
