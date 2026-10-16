// Overhead metrics (team-process-metrics D4): each sender group's share of
// the team's mail sent in the window (the human counts as `human`), task mail
// per task first done in the window by sender group (every message of those
// tasks sent before the window's end, whenever), and friction — messages
// parked, forwarded, held uncertain, or dead-lettered in the window — in total
// and per done task, broken down by event kind with the messages behind each.
// Denominator-only observations (one per done task) count in every row. Pure.
import { within, type MetricsContext } from './metricsContext'
import type { MetricMessage } from './metricsQuery'
import type { Observation } from './slices'

export const FRICTION_KINDS = ['parked', 'forwarded', 'held-uncertain', 'dead-lettered'] as const
const FRICTION = new Set<string>(FRICTION_KINDS)

export function senderGroup(message: MetricMessage): string {
  if (message.fromKind !== 'agent') return message.fromKind
  return message.fromGroup ?? 'no group'
}

export function overheadObservations(ctx: MetricsContext): Observation[] {
  const out: Observation[] = []
  const done = new Set(ctx.doneInWindow)
  for (const message of ctx.inputs.messages.values()) {
    const group = senderGroup(message)
    const attribution = { kind: 'sender', group } as const
    if (within(message.createdAt, ctx)) {
      out.push({ metric: 'mail_share', num: 1, den: 1, key: group, attribution, message: message.id })
    }
    if (message.taskId && done.has(message.taskId) && message.createdAt < ctx.to) {
      out.push({ metric: 'task_mail_per_task', num: 1, key: group, attribution, message: message.id, task: message.taskId })
    }
  }
  for (const taskId of ctx.doneInWindow) {
    out.push({ metric: 'task_mail_per_task', den: 1, task: taskId })
    out.push({ metric: 'friction_per_task', den: 1, task: taskId })
  }
  for (const event of ctx.inputs.messageEvents) {
    if (!FRICTION.has(event.kind) || !within(event.at, ctx)) continue
    out.push({ metric: 'friction_total', value: 1, key: event.kind, message: event.messageId })
    out.push({ metric: 'friction_per_task', num: 1, key: event.kind, message: event.messageId })
  }
  return out
}
