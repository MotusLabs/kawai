// Assembles `ProcessMetrics` (team-process-metrics D4): one load over the
// window and its baseline, two contexts, every family's observations, then
// per metric its value, `n`, sufficiency, baseline (the same computation over
// the preceding window of equal length), drill-down ids, its fixed breakdown,
// and — when a slice is asked — rows by that slice on the metric's own side,
// or `notSliceable`. Identical inputs give identical results. `MetricsReader`
// caches a read per (team, window, slice) for 30 s so the tab and a tool call
// in the same moment share one computation; a `fresh` read (the tab's
// Refresh, a report submission) recomputes and replaces the cached entry.
// `readAt` caches a read at a fixed window end per (team, window, slice,
// end) for 30 s, so the pages of one agent drill walk share a computation.
import type { Database } from 'bun:sqlite'
import {
  unknownToolMeasurement, type ToolMeasurementStatus,
  COVERAGE_CAVEAT, METRIC_DEFS, MIN_SAMPLE, USAGE_CAVEAT, WINDOW_MS, sliceAllowed,
  type MetricDef, type MetricSlice, type MetricValue, type MetricWindow, type ProcessMetrics,
} from '../../shared/processMetrics'
import { readToolDrill } from './toolDrill'
import { toolWindow, decorateToolMetric, type ToolWindow } from './toolMetrics'
import { capacityObservations } from './capacity'
import { flowObservations } from './flow'
import { metricsContext, type MetricsContext } from './metricsContext'
import { loadMetricsInputs, type MetricsInputs } from './metricsQuery'
import { overheadObservations } from './overhead'
import { coverageObservations, qualityObservations } from './quality'
import { StartResolver, aggregate, rows, sliceKey, type Observation } from './slices'

export const METRICS_CACHE_MS = 30_000

export function observations(ctx: MetricsContext,toolData=toolWindow(ctx)): Map<string, Observation[]> {
  const byMetric = new Map<string, Observation[]>()
  for (const o of [
    ...flowObservations(ctx), ...qualityObservations(ctx), ...coverageObservations(ctx),
    ...overheadObservations(ctx), ...capacityObservations(ctx), ...toolData.observations,
  ]) byMetric.set(o.metric, [...(byMetric.get(o.metric) ?? []), o])
  return byMetric
}

function metricValue(def: MetricDef, current: Observation[], baseline: Observation[], slice: MetricSlice | null, inputs: MetricsInputs,currentTools:ToolWindow,baselineTools:ToolWindow): MetricValue {
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
  return decorateToolMetric(def,value,currentTools,baselineTools)
}

export function computeMetrics(inputs: MetricsInputs, window: MetricWindow, slice: MetricSlice | null, computedAt: number): ProcessMetrics {
  const span = WINDOW_MS[window]
  const resolver = new StartResolver(inputs.starts)
  const currentCtx=metricsContext(inputs,inputs.end-span,inputs.end,resolver),baselineCtx=metricsContext(inputs,inputs.end-2*span,inputs.end-span,resolver)
  const currentTools=toolWindow(currentCtx),baselineTools=toolWindow(baselineCtx)
  const current = observations(currentCtx,currentTools)
  const baseline = observations(baselineCtx,baselineTools)
  return {
    toolMeasurement:inputs.toolMeasurement??unknownToolMeasurement(),
    teamId: inputs.teamId, window, slice,
    periodStart: new Date(inputs.end - span).toISOString(),
    periodEnd: new Date(inputs.end).toISOString(),
    baselineStart: new Date(inputs.end - 2 * span).toISOString(),
    computedAt: new Date(computedAt).toISOString(),
    minSample: MIN_SAMPLE,
    metrics: METRIC_DEFS.map(def => metricValue(def, current.get(def.id) ?? [], baseline.get(def.id) ?? [], slice, inputs,currentTools,baselineTools)),
    usageCaveat: USAGE_CAVEAT,
    coverageCaveat: COVERAGE_CAVEAT,
  }
}

/** Loads and computes one team's metrics for a window ending at `end`. */
export function readMetrics(db: Database, teamId: string, window: MetricWindow, slice: MetricSlice | null, end: number,
  resolveProvider?: (profileId: string, teamId: string) => string): ProcessMetrics {
  return computeMetrics(loadMetricsInputs(db, teamId, end - 2 * WINDOW_MS[window], end, resolveProvider), window, slice, end)
}

export class MetricsReader {
  private readonly cache = new Map<string, { at: number; metrics: ProcessMetrics }>()
  /** Reads at a fixed window end (bounded-metrics-reads D3), keyed by that end. */
  private readonly atEnd = new Map<string, { at: number; metrics: ProcessMetrics }>()

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly resolveProvider?: (profileId: string, teamId: string) => string,
    private readonly toolStatus:()=>ToolMeasurementStatus=unknownToolMeasurement,
  ) {}

  /** The reader's clock, so callers bound an `end` by the same now. */
  clock(): number {
    return this.now()
  }

  toolDrill(teamId:string,window:MetricWindow,slice:MetricSlice|null,pageSize:number,cursor:string|null,end=this.now()) {
    return readToolDrill(this.db,teamId,window,slice,pageSize,cursor,end)
  }

  private evict(at: number) {
    for (const cache of [this.cache, this.atEnd]) for (const [k, v] of cache) if (at - v.at >= METRICS_CACHE_MS) cache.delete(k)
  }

  private compute(teamId: string, window: MetricWindow, slice: MetricSlice | null, end: number, at: number): ProcessMetrics {
    const metrics = readMetrics(this.db, teamId, window, slice, end, this.resolveProvider)
    this.atEnd.set(JSON.stringify([teamId, window, slice, end]), { at, metrics })
    return metrics
  }

  /** The metrics of the window ending at `end`, shared for 30 s by every read at that end. */
  readAt(teamId: string, window: MetricWindow, slice: MetricSlice | null, end: number): ProcessMetrics {
    const at = this.now()
    const hit = this.atEnd.get(JSON.stringify([teamId, window, slice, end]))
    if (hit && at - hit.at < METRICS_CACHE_MS) return {...hit.metrics,toolMeasurement:this.toolStatus()}
    this.evict(at)
    return {...this.compute(teamId, window, slice, end, at),toolMeasurement:this.toolStatus()}
  }

  read(teamId: string, window: MetricWindow, slice: MetricSlice | null, options: { fresh?: boolean } = {}): ProcessMetrics {
    const key = JSON.stringify([teamId, window, slice])
    const at = this.now()
    const hit = this.cache.get(key)
    if (hit && !options.fresh && at - hit.at < METRICS_CACHE_MS) return {...hit.metrics,toolMeasurement:this.toolStatus()}
    this.evict(at)
    // A miss reads at now through the end cache; `fresh` bypasses both caches.
    const cached = options.fresh ? undefined : this.atEnd.get(JSON.stringify([teamId, window, slice, at]))
    const metrics = cached && at - cached.at < METRICS_CACHE_MS ? cached.metrics : this.compute(teamId, window, slice, at, at)
    this.cache.set(key, { at, metrics })
    return {...metrics,toolMeasurement:this.toolStatus()}
  }
}
