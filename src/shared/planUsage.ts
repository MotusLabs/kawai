// Plan usage (plan-supervision design D14): the pure aggregation behind the
// plan usage read. It sums per-turn `chat_turn_usage` rows already scoped to
// one plan — its linked tasks plus its fix and correction tasks — by
// (group, profile) and by change, where each fix or correction task is its
// own row. Turns are row counts; steps are the sum of `num_turns`. Tokens
// only, never currency. What is not counted (task-less turns, Task subagent
// calls) is stated in `PLAN_USAGE_NOTES`, never estimated.
import type { ChatTurnUsage } from './chat'
import type { FixSourceKind } from './planDecisions'

export interface UsageTotals extends ChatTurnUsage {
  turns: number
  steps: number
}

/** One turn row with the plan link of its pinned task. */
export interface PlanUsageTurn {
  taskId: string
  groupId: string | null
  profileId: string | null
  usage: ChatTurnUsage
  numTurns: number
  /** The task's plan change; null for a fix or correction task without one. */
  change: string | null
  /** Set when the task is one of the plan's fix or correction tasks. */
  fix: { sourceKind: FixSourceKind } | null
}

export type PlanUsageBucket =
  | { kind: 'change'; change: string | null }
  | { kind: 'fix'; taskId: string; sourceKind: FixSourceKind }

export interface PlanUsageView {
  total: UsageTotals
  byGroupProfile: Array<{ group: string | null; profile: string | null } & UsageTotals>
  byChange: Array<PlanUsageBucket & UsageTotals>
  notes: string[]
}

export const PLAN_USAGE_NOTES = [
  'Turns with no task are not attributed to any plan.',
  'Task subagent and auxiliary calls are not counted, so subagent-heavy work is understated.',
]

export function emptyTotals(): UsageTotals {
  return { turns: 0, steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

function add(totals: UsageTotals, turn: PlanUsageTurn): void {
  totals.turns += 1
  totals.steps += turn.numTurns
  totals.inputTokens += turn.usage.inputTokens
  totals.outputTokens += turn.usage.outputTokens
  totals.cacheReadTokens += turn.usage.cacheReadTokens
  totals.cacheCreationTokens += turn.usage.cacheCreationTokens
}

const nullsLast = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b))

/**
 * Sum the plan's turns. `changeOrder` (the plan's change names) orders the
 * change rows; unlisted changes follow by name, then fix and correction
 * tasks by id.
 */
export function planUsage(turns: readonly PlanUsageTurn[], changeOrder: readonly string[] = []): PlanUsageView {
  const total = emptyTotals()
  const groups = new Map<string, { group: string | null; profile: string | null } & UsageTotals>()
  const buckets = new Map<string, PlanUsageBucket & UsageTotals>()
  for (const turn of turns) {
    add(total, turn)
    const groupKey = JSON.stringify([turn.groupId, turn.profileId])
    if (!groups.has(groupKey)) groups.set(groupKey, { group: turn.groupId, profile: turn.profileId, ...emptyTotals() })
    add(groups.get(groupKey)!, turn)
    const bucket: PlanUsageBucket = turn.fix
      ? { kind: 'fix', taskId: turn.taskId, sourceKind: turn.fix.sourceKind }
      : { kind: 'change', change: turn.change }
    const bucketKey = bucket.kind === 'fix' ? `fix:${bucket.taskId}` : `change:${JSON.stringify(bucket.change)}`
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, { ...bucket, ...emptyTotals() })
    add(buckets.get(bucketKey)!, turn)
  }
  const rank = (bucket: PlanUsageBucket): [number, number, string] => {
    if (bucket.kind === 'fix') return [2, 0, bucket.taskId]
    const index = bucket.change === null ? -1 : changeOrder.indexOf(bucket.change)
    return index >= 0 ? [0, index, ''] : [1, 0, bucket.change ?? '￿']
  }
  const byChange = [...buckets.values()].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)]
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2])
  })
  const byGroupProfile = [...groups.values()].sort((a, b) => nullsLast(a.group, b.group) || nullsLast(a.profile, b.profile))
  return { total, byGroupProfile, byChange, notes: PLAN_USAGE_NOTES }
}
