// One window's view of the loaded inputs (team-process-metrics D4): the
// window bounds, each task's first-ever `done` (over its whole history, so a
// task first done earlier never re-enters a later window), the tasks first
// done inside the window, and start lookups. The family modules compute the
// window and its baseline from the same load by building two contexts. Pure.
import type { MetricFinding, MetricResult, MetricStatusEvent, MetricsInputs } from './metricsQuery'
import { StartResolver, type Attribution } from './slices'

export interface MetricsContext {
  inputs: MetricsInputs
  fromMs: number
  toMs: number
  from: string
  to: string
  resolver: StartResolver
  /** Each loaded task's first transition to `done`. */
  firstDone: Map<string, MetricStatusEvent>
  /** Tasks of the team first done in [from, to), in first-done order. */
  doneInWindow: string[]
  /** Each task's results created before the window's end, oldest first. */
  resultsByTask: Map<string, MetricResult[]>
  /** Each result's findings created before the window's end, oldest first. */
  findingsByResult: Map<string, MetricFinding[]>
}

/** A task's author-side owner (D4): its first result's submitter's latest start then, `no result` without one. */
export interface TaskOwner {
  attribution: Attribution
  /** The attributions of its later results, for `mixed`. */
  later: Attribution[]
}

export const within = (at: string | null, ctx: { from: string; to: string }) => at !== null && at >= ctx.from && at < ctx.to

export function metricsContext(inputs: MetricsInputs, fromMs: number, toMs: number, resolver = new StartResolver(inputs.starts)): MetricsContext {
  const from = new Date(fromMs).toISOString()
  const to = new Date(toMs).toISOString()
  const firstDone = new Map<string, MetricStatusEvent>()
  for (const event of inputs.statusEvents) {
    if (event.toStatus === 'done' && !firstDone.has(event.taskId)) firstDone.set(event.taskId, event)
  }
  const doneInWindow = [...firstDone.values()]
    .filter(event => inputs.tasks.has(event.taskId) && event.at >= from && event.at < to)
    .map(event => event.taskId)
  const resultsByTask = new Map<string, MetricResult[]>()
  for (const result of inputs.results) {
    if (result.createdAt < to) resultsByTask.set(result.taskId, [...(resultsByTask.get(result.taskId) ?? []), result])
  }
  const findingsByResult = new Map<string, MetricFinding[]>()
  for (const finding of inputs.findings) {
    if (finding.createdAt < to) findingsByResult.set(finding.resultId, [...(findingsByResult.get(finding.resultId) ?? []), finding])
  }
  return { inputs, fromMs, toMs, from, to, resolver, firstDone, doneInWindow, resultsByTask, findingsByResult }
}

export function taskOwner(ctx: MetricsContext, taskId: string): TaskOwner {
  const [first, ...rest] = ctx.resultsByTask.get(taskId) ?? []
  if (!first) return { attribution: { kind: 'noResult' }, later: [] }
  return {
    attribution: ctx.resolver.latest(first.submitterSession || null, first.createdAt),
    later: rest.map(result => ctx.resolver.latest(result.submitterSession || null, result.createdAt)),
  }
}

/** Hours between two ISO times. */
export const hoursBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000
