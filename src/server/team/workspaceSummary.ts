// The morning summary's projection (team-workspace D8, plan buckets from
// plan-supervision D13): the last 24 hours in durable buckets, split out of
// workspaceRead.ts so both files stay small. A finished turn with no
// submitted result sits only in its own bucket; the runtime-only capacity
// bucket states its bound. Items link to where the existing action lives,
// like the attention queue.
import type { ChatPendingRequest } from '../../shared/chat'
import type { TeamMessage, WaitingConstraint, WaitingReason } from '../../shared/team'
import type { MorningSummary, SummaryBucket, SummaryItem } from '../../shared/teamWorkspace'
import type { ChatSessionRecord } from '../db'
import { outboundSummaryItems } from './workspaceOutbound'
import { planSummaryItems, type PlanSummaryRows } from './planAttention'

/**
 * The constraint kinds that make mail wait on capacity (team-waiting-reasons
 * D1's ordering names them the capacity band): the attention queue's
 * agent-owned staffing waits and the summary's capacity bucket both read
 * exactly these.
 */
export const CAPACITY_CONSTRAINT_KINDS: ReadonlySet<WaitingConstraint['kind']> = new Set([
  'group-cap', 'profile-cap', 'team-spawn-cap', 'worktree-occupied',
])

/** A capacity constraint as one line; mirrors the client's label vocabulary. */
export function capacityConstraintLabel(constraint: WaitingConstraint): string {
  const counts = constraint.counts ? ` (${constraint.counts.live}/${constraint.counts.cap})` : ''
  switch (constraint.kind) {
    case 'group-cap': return `Group is at capacity${counts}`
    case 'profile-cap': return `Profile ${constraint.detail ?? ''} is at capacity${counts}`
    case 'team-spawn-cap': return `Team spawn cap reached${counts}`
    case 'worktree-occupied': return `Worktree ${constraint.detail ?? ''} is held${counts}`
    default: return `${constraint.kind}${counts}`
  }
}

/** What the morning summary reads (D8): durable rows plus the runtime ledger. */
export interface SummaryInput {
  /** Read time, ISO; the window is the 24 hours before it. */
  now: string
  sessions: Array<{ record: ChatSessionRecord; requests: ChatPendingRequest[] }>
  messages: TeamMessage[]
  /** One message's recorded events, oldest first (for the hold time). */
  messageEvents: (messageId: string) => Array<{ kind: string; createdAt: string }>
  waiting: Record<string, WaitingReason>
  /** Persisted turn-end rows of the team's task-bound sessions (D8). */
  turnEnds: Array<{ sessionId: string; taskId: string | null; at: string }>
  nameOf: (sessionId: string) => string
  /** Whether a result row exists for a session's task; such a turn is not "without a result". */
  hasResult: (sessionId: string, taskId: string | null) => boolean
  /** Outstanding results submitted in the window, each with its accepted state. */
  results: Array<{ resultId: string; taskId: string; taskTitle: string | null; submitter: string; accepted: boolean }>
  /** The audit records' row counts over the window (execution-safety-recovery D10). */
  outboundCounts: { allowed: number; unknown: number; violations: number }
  /** The window's durable plan rows (plan-supervision D13). */
  plans?: PlanSummaryRows
}

const bucket = (items: SummaryItem[], runtimeOnly = false): SummaryBucket =>
  runtimeOnly ? { items, runtimeOnly: true } : { items }

/**
 * The morning summary (task 4.3): a rolling 24-hour window ending at read
 * time (Q1/Q9). Capacity waits read the in-memory ledger only — after a
 * restart that bucket lists waits the running server has observed, which its
 * `runtimeOnly` label states; the other buckets read durable rows. A
 * finished turn with no submitted result never lands in a completion bucket
 * (E13): completed results come from result rows only.
 */
export function morningSummary(input: SummaryInput): MorningSummary {
  const { now, sessions, messages, messageEvents, waiting, turnEnds, nameOf, hasResult, results, outboundCounts } = input
  const since = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString()
  const inWindow = (at: string) => Date.parse(at) >= Date.parse(since)
  // The plan rows arrive pre-filtered to the window from their durable
  // tables (plan-supervision D13); without the manager seam they stay empty.
  const planItems = input.plans
    ? planSummaryItems(input.plans)
    : { landings: [], stops: [], stallAlerts: [], decisions: [], overrides: [] }

  const approvals = sessions.flatMap(({ record, requests }) =>
    requests.flatMap(request => {
      if (request.kind !== 'approval' || !inWindow(request.at)) return []
      return [{
        id: `approval:${record.sessionId}:${request.requestId}`,
        label: `${record.name}: ${request.tool}`,
        link: { kind: 'chat' as const, id: record.sessionId },
      }]
    })
  )

  // An uncertain delivery stays listed while it is still uncertain; a retried
  // or delivered row leaves (E13). The hold event names when it turned
  // uncertain, and keeps the bucket to the window.
  const uncertainDeliveries = messages
    .filter(message => message.state === 'uncertain')
    .filter(message => {
      const held = messageEvents(message.id)
        .filter(event => event.kind === 'held-uncertain')
        .map(event => event.createdAt)
        .filter(inWindow)
      return held.length > 0
    })
    .map(message => ({
      id: `uncertain-delivery:${message.id}`,
      label: `Delivery uncertain${message.reason ? `: ${message.reason}` : ''}`,
      link: { kind: 'message' as const, id: message.id },
    }))

  const capacityWaits = Object.entries(waiting)
    .filter(([, reason]) => CAPACITY_CONSTRAINT_KINDS.has(reason.blocker.kind))
    .map(([messageId, reason]) => ({
      id: `staffing-wait:${messageId}`,
      label: capacityConstraintLabel(reason.blocker),
      link: { kind: 'message' as const, id: messageId },
    }))

  const withoutResult = new Map<string, { name: string; taskId: string | null; count: number }>()
  for (const end of turnEnds) {
    if (!inWindow(end.at) || hasResult(end.sessionId, end.taskId)) continue
    const existing = withoutResult.get(end.sessionId)
    if (existing) existing.count += 1
    else withoutResult.set(end.sessionId, { name: nameOf(end.sessionId), taskId: end.taskId, count: 1 })
  }
  const finishedTurnsWithoutResult = [...withoutResult.entries()].map(([sessionId, fact]) => ({
    id: `finished-turn:${sessionId}`,
    label: `${fact.name}: ${fact.count} turn${fact.count === 1 ? '' : 's'} finished with no result`,
    link: { kind: 'chat' as const, id: sessionId },
  }))

  // Submitted, not accepted: each result states which (D8, Q5).
  const completedResults = results.map(result => ({
    id: `result:${result.resultId}`,
    label: `${result.taskTitle ?? result.taskId}: result by ${result.submitter} — ${result.accepted ? 'accepted' : 'awaiting acceptance'}`,
    link: { kind: 'task' as const, id: result.taskId },
  }))

  // The audit records' row counts (execution-safety-recovery D10; workspaceOutbound.ts).
  const outbound = outboundSummaryItems(outboundCounts)

  return {
    since,
    completedResults: bucket(completedResults),
    capacityWaits: bucket(capacityWaits, true),
    approvals: bucket(approvals),
    uncertainDeliveries: bucket(uncertainDeliveries),
    finishedTurnsWithoutResult: bucket(finishedTurnsWithoutResult),
    outbound: bucket(outbound),
    landings: bucket(planItems.landings),
    stops: bucket(planItems.stops),
    stallAlerts: bucket(planItems.stallAlerts),
    decisions: bucket(planItems.decisions),
    overrides: bucket(planItems.overrides),
  }
}
