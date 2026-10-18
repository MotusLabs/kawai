// Capacity metrics (team-process-metrics D4): limit tax per profile — hours
// in the window routing treated the profile as cooling (the router's own
// timeline, `coolingTimeline`, clipped to the window) plus hours messages
// spent parked (from `parked` to the next closing event, else the window's
// end, clipped), the parked hours charged to the holder's profile — and
// tokens: every recorded turn ended in the window by group and profile (a
// coordinator's task-less turns count here only), and tokens per task first
// done in the window from all its recorded turns, whoever spent them, owned
// by the task's owner and marked partial when the task predates the usage
// horizon (retention, or the team's first recorded turn). Tokens sum all
// four counts. Pure.
import type { ChatTurnUsage } from '../../shared/chat'
import { coolingMsWithin, coolingTimeline, relevantEvents } from '../team/routing/limitEvents'
import { taskOwner, type MetricsContext } from './metricsContext'
import { PARK_END_KINDS, type MetricMessageEvent } from './metricsQuery'
import type { Observation } from './slices'

const HOUR_MS = 3_600_000
const PARK_ENDS = new Set<string>(PARK_END_KINDS)

export const tokenCount = (usage: ChatTurnUsage) =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens

function holderProfile(ctx: MetricsContext, holder: string | null, at: string): string {
  if (!holder) return 'unknown'
  return ctx.resolver.latestStart(holder, at)?.profileId ?? ctx.inputs.sessionProfiles.get(holder) ?? 'unknown'
}

function parkObservations(ctx: MetricsContext): Observation[] {
  const out: Observation[] = []
  const byMessage = new Map<string, MetricMessageEvent[]>()
  for (const event of ctx.inputs.messageEvents) byMessage.set(event.messageId, [...(byMessage.get(event.messageId) ?? []), event])
  for (const [messageId, events] of byMessage) {
    events.forEach((event, index) => {
      if (event.kind !== 'parked') return
      const closing = events.slice(index + 1).find(next => PARK_ENDS.has(next.kind) || next.kind === 'parked')
      const start = Math.max(Date.parse(event.at), ctx.fromMs)
      const end = Math.min(closing ? Date.parse(closing.at) : ctx.toMs, ctx.toMs)
      if (end <= start) return
      const holder = event.prevClaimedBy ?? ctx.inputs.messages.get(messageId)?.claimedBy ?? null
      out.push({ metric: 'limit_tax_hours', value: (end - start) / HOUR_MS, key: holderProfile(ctx, holder, event.at), message: messageId })
    })
  }
  return out
}

export function capacityObservations(ctx: MetricsContext): Observation[] {
  const out: Observation[] = []
  // The timeline follows the routing rule (providers-and-workers D8): each
  // profile's relevant events are its own plus its provider's
  // provider-scoped ones, so a provider cooldown shows in the tax of every
  // profile it covers — a sibling with no events of its own included.
  const pool = [...ctx.inputs.limitEvents.values()].flat()
  const profiles = new Set([...ctx.inputs.limitEvents.keys(), ...ctx.inputs.providerIds.keys()])
  for (const profile of profiles) {
    const merged = relevantEvents(pool, profile, ctx.inputs.providerIds.get(profile) ?? profile)
    const ms = coolingMsWithin(coolingTimeline(merged), ctx.fromMs, ctx.toMs)
    if (ms > 0) out.push({ metric: 'limit_tax_hours', value: ms / HOUR_MS, key: profile })
  }
  out.push(...parkObservations(ctx))

  const tokensByTask = new Map<string, number>()
  for (const row of ctx.inputs.usage) {
    if (row.endedAt >= ctx.to) continue
    const tokens = tokenCount(row.usage)
    if (row.taskId) tokensByTask.set(row.taskId, (tokensByTask.get(row.taskId) ?? 0) + tokens)
    if (row.endedAt < ctx.from || row.teamId !== ctx.inputs.teamId) continue
    out.push({
      metric: 'tokens_total', value: tokens, key: `${row.groupId ?? 'no group'} · ${row.profileId ?? 'default'}`,
      attribution: ctx.resolver.byStartId(row.startId), task: row.taskId ?? undefined,
    })
  }
  for (const taskId of ctx.doneInWindow) {
    const owner = taskOwner(ctx, taskId)
    out.push({
      metric: 'tokens_per_task', value: tokensByTask.get(taskId) ?? 0, attribution: owner.attribution, later: owner.later,
      task: taskId, partial: Date.parse(ctx.inputs.tasks.get(taskId)!.createdAt) < ctx.inputs.usageHorizon,
    })
  }
  return out
}
