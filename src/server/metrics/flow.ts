// Flow metrics (team-process-metrics D4): task lead time — creation to the
// first-ever `done`, for tasks first done in the window, in hours; marked
// approximate when that `done` is a backfilled row with no prior status — and
// mail wait — delivery minus the later of creation and the scheduled time,
// for mail delivered in the window, in minutes, normal and urgent apart.
// Percentiles are taken by the aggregator. Pure.
import { hoursBetween, within, type MetricsContext } from './metricsContext'
import type { Observation } from './slices'

export function flowObservations(ctx: MetricsContext): Observation[] {
  const out: Observation[] = []
  for (const taskId of ctx.doneInWindow) {
    const task = ctx.inputs.tasks.get(taskId)!
    const done = ctx.firstDone.get(taskId)!
    const value = hoursBetween(task.createdAt, done.at)
    const approximate = done.fromStatus === null
    for (const metric of ['lead_time_p50', 'lead_time_p90'] as const) out.push({ metric, value, task: taskId, approximate })
  }
  for (const message of ctx.inputs.messages.values()) {
    if (!within(message.deliveredAt, ctx)) continue
    const ready = message.deliverAt && message.deliverAt > message.createdAt ? message.deliverAt : message.createdAt
    const value = Math.max(0, (Date.parse(message.deliveredAt!) - Date.parse(ready)) / 60_000)
    const metrics = message.priority === 'urgent'
      ? ['mail_wait_urgent_p50', 'mail_wait_urgent_p90'] as const
      : ['mail_wait_normal_p50', 'mail_wait_normal_p90'] as const
    for (const metric of metrics) out.push({ metric, value, message: message.id })
  }
  return out
}
