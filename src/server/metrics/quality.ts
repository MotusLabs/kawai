// Quality metrics (team-process-metrics D4) over submitted results and
// findings only: first-pass review yield (tasks whose first result received
// its first finding in the window; it passes when no finding on that result
// fails, so disagreeing reviewers fail it), finding fail rate (each finding
// submitted in the window once, under its own author's start), fix iterations
// (results per task first done in the window, minus one; tasks with no result
// count only in coverage), and reopen rate (transitions out of `done` or
// `cancelled` per transition into `done`, both in the window). First-pass
// yield and fix iterations are owned by the task's owner, with later results'
// starts carried for `mixed`. Pure.
import { taskOwner, within, type MetricsContext } from './metricsContext'
import type { Observation } from './slices'

const CLOSED = new Set(['done', 'cancelled'])

export function qualityObservations(ctx: MetricsContext): Observation[] {
  const out: Observation[] = []
  for (const [taskId, results] of ctx.resultsByTask) {
    if (!ctx.inputs.tasks.has(taskId)) continue
    const first = results[0]!
    const findings = ctx.findingsByResult.get(first.id) ?? []
    if (findings.length === 0 || !within(findings[0]!.createdAt, ctx)) continue
    const owner = taskOwner(ctx, taskId)
    out.push({
      metric: 'first_pass_yield', value: findings.some(f => f.verdict === 'fail') ? 0 : 1,
      attribution: owner.attribution, later: owner.later, task: taskId,
    })
  }
  for (const finding of ctx.inputs.findings) {
    if (!within(finding.createdAt, ctx) || !ctx.inputs.tasks.has(finding.taskId)) continue
    out.push({
      metric: 'finding_fail_rate', value: finding.verdict === 'fail' ? 1 : 0,
      attribution: ctx.resolver.latest(finding.authorSession || null, finding.createdAt), task: finding.taskId,
    })
  }
  for (const taskId of ctx.doneInWindow) {
    const results = ctx.resultsByTask.get(taskId) ?? []
    if (results.length === 0) continue
    const owner = taskOwner(ctx, taskId)
    out.push({ metric: 'fix_iterations', value: results.length - 1, attribution: owner.attribution, later: owner.later, task: taskId })
  }
  for (const event of ctx.inputs.statusEvents) {
    if (!within(event.at, ctx) || !ctx.inputs.tasks.has(event.taskId)) continue
    if (event.toStatus === 'done') out.push({ metric: 'reopen_rate', den: 1, task: event.taskId })
    if (event.fromStatus !== null && CLOSED.has(event.fromStatus) && !CLOSED.has(event.toStatus)) {
      out.push({ metric: 'reopen_rate', num: 1, task: event.taskId })
    }
  }
  return out
}

/** Coverage (D4): of tasks first done in the window, the share with a result, with findings on a result, and with an accepted result. */
export function coverageObservations(ctx: MetricsContext): Observation[] {
  const out: Observation[] = []
  for (const taskId of ctx.doneInWindow) {
    const results = ctx.resultsByTask.get(taskId) ?? []
    const reviewed = results.some(result => (ctx.findingsByResult.get(result.id) ?? []).length > 0)
    const accepted = results.some(result => result.acceptedAt !== null && result.acceptedAt < ctx.to)
    out.push({ metric: 'coverage_result', value: results.length > 0 ? 1 : 0, task: taskId })
    out.push({ metric: 'coverage_findings', value: reviewed ? 1 : 0, task: taskId })
    out.push({ metric: 'accepted_result_share', value: accepted ? 1 : 0, task: taskId })
  }
  return out
}
