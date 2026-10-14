// The team workspace's read model (team-workspace design D1): task rows,
// attention items, member rows, and the morning summary, projected from the
// stores that already own the facts — TaskStore summaries, the mailbox, the
// waiting-reason ledger, chat session records, and the group catalog. The
// workspace owns no tables; every function here is a pure projection, so the
// connection layer can recompute on the same triggers the mailbox and task
// views already use and diff before pushing.
import type { ChatPendingRequest } from '../../shared/chat'
import type {
  AttentionItem,
  MorningSummary,
  SummaryBucket,
  SummaryItem,
  TeamMemberRow,
  TeamMemberSession,
  TeamTaskRow,
  TeamWorkspaceSnapshot,
} from '../../shared/teamWorkspace'
import { attentionItemId } from '../../shared/teamWorkspace'
import { teamTaskStage } from '../../shared/teamTaskStage'
import type { TeamMessage, WaitingConstraint, WaitingReason } from '../../shared/team'
import type { TeamTaskSummary } from '../../shared/teamTasks'
import type { ChatSessionRecord } from '../db'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { GroupCatalog } from './groupCatalog'
import type { TeamIdentity } from './teamIdentity'

/**
 * The constraint kinds that make mail wait on capacity (team-waiting-reasons
 * D1's ordering names them the capacity band): the attention queue's
 * agent-owned staffing waits and the summary's capacity bucket both read
 * exactly these.
 */
const CAPACITY_CONSTRAINT_KINDS: ReadonlySet<WaitingConstraint['kind']> = new Set([
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

/**
 * Members (task 2.2): one read-only row per group of the catalog — the role
 * description, never the prompt body (D7, Q3); every effective setting; each
 * layer's source file with the winner marked (2.1); and the live membership
 * with per-profile caps and live counts. Nothing here writes: prompt changes
 * affect future agent starts only.
 */
export function memberRows(
  catalog: GroupCatalog,
  records: ChatSessionRecord[],
  countsOf: (groupId: string) => Record<string, number>,
): TeamMemberRow[] {
  return [...catalog.groups.values()].map(({ group, sources }) => {
    const live = countsOf(group.id)
    const members: TeamMemberSession[] = records
      .filter(record => record.archivedAt == null && record.groupId === group.id)
      .map(record => ({
        sessionId: record.sessionId,
        name: record.name,
        spawned: record.spawned === true,
        profile: record.claudeProfileId ?? 'default',
        status: record.status,
        taskId: record.taskId ?? null,
      }))
    return {
      id: group.id,
      label: group.label,
      description: group.description,
      canCreateTasks: group.canCreateTasks,
      max: group.max,
      profiles: group.profiles.map(entry => ({
        profileId: entry.profileId,
        live: live[entry.profileId] ?? 0,
        ...(entry.cap !== undefined ? { cap: entry.cap } : {}),
      })),
      approval: group.approval,
      strategy: group.strategy,
      onLimit: group.onLimit.forwardTo !== undefined
        ? { parkIfResetWithinMs: group.onLimit.parkIfResetWithinMs, otherwise: group.onLimit.otherwise, forwardTo: group.onLimit.forwardTo }
        : { parkIfResetWithinMs: group.onLimit.parkIfResetWithinMs, otherwise: group.onLimit.otherwise },
      ...(group.effort !== undefined ? { effort: group.effort } : {}),
      warnings: [...group.warnings],
      sources: sources.map(({ file, layer, inEffect }) => ({ file, layer, inEffect })),
      members,
    }
  })
}

/** D11's next action for a row, derived from the assignment it already read. */
function taskNextAction(assignment: TeamTaskSummary['assignment']): string {
  if (!assignment) return 'Assign a dev'
  switch (assignment.state) {
    case 'queued': return 'Wait for capacity'
    case 'uncertain': return 'Retry or discard'
    default: return 'Wait for agent'
  }
}

/**
 * Task rows (task 3.2): title, status, D4's stage, the accountable session or
 * requested role, worktree, the instruction mail's waiting reason, and the
 * next action. A group assignment still queued names the requested role and
 * no session (the spec's fallback); a claimed one names the claimant.
 * `requiresHuman` marks rows some human-required attention item blocks, which
 * is what the awaiting-human filter keeps.
 */
export function taskRows(input: {
  summaries: TeamTaskSummary[]
  waiting: Record<string, WaitingReason>
  attention: AttentionItem[]
  nameOf: (sessionId: string) => string
}): TeamTaskRow[] {
  const { summaries, waiting, attention, nameOf } = input
  const humanBlocked = new Set(
    attention.filter(item => item.requiresHuman && item.impact.taskId).map(item => item.impact.taskId!)
  )
  return summaries.map(summary => {
    const assignment = summary.assignment
    const accountable = !assignment ? null
      : assignment.claimedBy ? { kind: 'session' as const, id: assignment.claimedBy, label: nameOf(assignment.claimedBy) }
      : assignment.targetKind === 'group'
        ? { kind: 'group' as const, id: assignment.targetId, label: assignment.role ?? assignment.targetId }
        : { kind: 'session' as const, id: assignment.targetId, label: nameOf(assignment.targetId) }
    return {
      id: summary.id,
      title: summary.title,
      status: summary.status,
      stage: teamTaskStage(summary, assignment),
      accountable,
      groupId: assignment?.targetKind === 'group' ? assignment.targetId : null,
      worktree: summary.worktree,
      waitingReason: assignment?.messageId ? waiting[assignment.messageId] ?? null : null,
      nextAction: taskNextAction(assignment),
      requiresHuman: humanBlocked.has(summary.id),
    }
  })
}

/** What one attention source reads (D5): pure facts, no manager references. */
export interface AttentionInput {
  /** Live sessions of the team with their pending requests. */
  sessions: Array<{ record: ChatSessionRecord; requests: ChatPendingRequest[] }>
  /** The team's unsettled mail (the mailbox view's own set). */
  messages: TeamMessage[]
  /** The waiting-reason ledger's current entries, keyed by message id. */
  waiting: Record<string, WaitingReason>
  taskTitle: (taskId: string) => string | null
  nameOf: (sessionId: string) => string
}

/** One attention source: a pure function over the input (D5's registry). */
export type AttentionSource = (input: AttentionInput) => AttentionItem[]

/** The task scope an item carries: the id, plus the title when it is known. */
const taskImpact = (taskId: string | null, taskTitle: (taskId: string) => string | null) => {
  if (!taskId) return {}
  const title = taskTitle(taskId)
  return title === null ? { taskId } : { taskId, taskTitle: title }
}

/** Pending approvals and questions of the team's live sessions (E05). */
const requestItems: AttentionSource = ({ sessions, taskTitle }) =>
  sessions.flatMap(({ record, requests }) =>
    requests.map(request => {
      const kind = request.kind === 'approval' ? 'approval' : 'question'
      const cause = request.kind === 'approval'
        ? `Approval requested: ${request.tool}`
        : `Question asked: ${request.questions[0]?.question ?? 'the agent needs an answer'}`
      return {
        id: attentionItemId(kind, `${record.sessionId}:${request.requestId}`),
        kind,
        cause,
        owner: { kind: 'session' as const, id: record.sessionId, label: record.name },
        impact: taskImpact(record.taskId ?? null, taskTitle),
        nextAction: request.kind === 'approval' ? 'Answer approval' : 'Answer question',
        link: { kind: 'chat' as const, id: record.sessionId },
        requiresHuman: true,
      }
    })
  )

/** Messages held as uncertain deliveries: only the human can retry or discard. */
const uncertainItems: AttentionSource = ({ messages, taskTitle }) =>
  messages
    .filter(message => message.state === 'uncertain')
    .map(message => {
      return {
        id: attentionItemId('uncertain-delivery', message.id),
        kind: 'uncertain-delivery' as const,
        cause: `Delivery uncertain${message.reason ? `: ${message.reason}` : ''}`,
        owner: message.fromSession
          ? { kind: 'session' as const, id: message.fromSession, label: message.fromSession }
          : { kind: 'human' as const, id: null, label: 'Human' },
        impact: {
          ...taskImpact(message.taskId, taskTitle),
          ...(message.toKind === 'group' && message.toId ? { groupId: message.toId } : {}),
        },
        nextAction: 'Retry or discard',
        link: { kind: 'message' as const, id: message.id },
        requiresHuman: true,
      }
    })

/** Mail waiting on capacity: agent-owned waits, not human blocking (E05). */
const staffingItems: AttentionSource = ({ messages, waiting, taskTitle }) => {
  const byId = new Map(messages.map(message => [message.id, message]))
  return Object.entries(waiting)
    .filter(([, reason]) => CAPACITY_CONSTRAINT_KINDS.has(reason.blocker.kind))
    .flatMap(([messageId, reason]) => {
      const message = byId.get(messageId)
      if (!message) return []
      return [{
        id: attentionItemId('staffing-wait', messageId),
        kind: 'staffing-wait' as const,
        cause: capacityConstraintLabel(reason.blocker),
        owner: message.toKind === 'group' && message.toId
          ? { kind: 'group' as const, id: message.toId, label: message.toId }
          : { kind: 'session' as const, id: message.toId, label: message.toId ?? '' },
        impact: taskImpact(message.taskId, taskTitle),
        nextAction: 'Wait for capacity',
        link: { kind: 'message' as const, id: messageId },
        requiresHuman: false,
      }]
    })
}

/**
 * The Phase 1 source registry (task 4.1). `pending-acceptance` joins with
 * `task-results-handoffs` (Phase 2 task 11.2) as one more entry; Wave C
 * sources (plan holds, stalls, Lead decision cards) add entries the same way
 * — an item of an unrecognized kind is data like any other and never dropped.
 */
export const ATTENTION_SOURCES: readonly AttentionSource[] = [requestItems, uncertainItems, staffingItems]

/** Every attention item the current state yields, in a stable order. */
export function attentionItems(
  input: AttentionInput,
  sources: readonly AttentionSource[] = ATTENTION_SOURCES,
): AttentionItem[] {
  return sources.flatMap(source => source(input)).sort((a, b) => a.id.localeCompare(b.id))
}

/** One turn-end fact the summary reads, pre-extracted from a transcript. */
export interface TurnEndFact {
  sessionId: string
  taskId: string | null
  at: string
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
  /** Persisted turn-end events of the team's task-bound sessions. */
  turnEnds: TurnEndFact[]
  nameOf: (sessionId: string) => string
  /**
   * Whether a result row exists for a session's task (task-results-handoffs).
   * Phase 1 has no result table, so the caller passes `() => false`; a turn
   * with a result never lands in the without-result bucket either way.
   */
  hasResult: (sessionId: string, taskId: string | null) => boolean
}

const bucket = (items: SummaryItem[], runtimeOnly = false): SummaryBucket =>
  runtimeOnly ? { items, runtimeOnly: true } : { items }

/**
 * The morning summary (task 4.3): a rolling 24-hour window ending at read
 * time (Q1/Q9). Capacity waits read the in-memory ledger only — after a
 * restart that bucket lists waits the running server has observed, which its
 * `runtimeOnly` label states; the other buckets read durable rows. A
 * finished turn with no submitted result never lands in a completion bucket
 * (E13): completed results are a Phase 2 bucket over `task-results-handoffs`
 * result rows, which do not exist yet, so it stays empty here.
 */
export function morningSummary(input: SummaryInput): MorningSummary {
  const { now, sessions, messages, messageEvents, waiting, turnEnds, nameOf, hasResult } = input
  const since = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString()
  const inWindow = (at: string) => Date.parse(at) >= Date.parse(since)

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

  return {
    since,
    // Phase 2 (task 11.2) fills this from result rows; nothing reads a result
    // table today, so an honest empty bucket is the whole Phase 1 story.
    completedResults: bucket([]),
    capacityWaits: bucket(capacityWaits, true),
    approvals: bucket(approvals),
    uncertainDeliveries: bucket(uncertainDeliveries),
    finishedTurnsWithoutResult: bucket(finishedTurnsWithoutResult),
  }
}

/**
 * The manager-facing read: one snapshot over everything the pure projections
 * above need. Held by the connection layer, which recomputes on the triggers
 * the mailbox and task views already use. Turn-end facts replay each task
 * bound session's transcript, so they are cached per session and invalidated
 * by `lastActivityAt` — turn-end events only append while the session is
 * active, and activity moves that stamp.
 */
export class WorkspaceRead {
  private readonly turnEndCache = new Map<string, { lastActivityAt: string; facts: TurnEndFact[] }>()

  constructor(private readonly manager: ChatSessionManager) {}

  snapshot(team: TeamIdentity): TeamWorkspaceSnapshot {
    const manager = this.manager
    const teamId = team.teamId
    const store = manager.tasks.store
    const summaries = store.list(teamId)
    const messages = manager.mailbox.store.listForTeam(teamId)
    const waiting = manager.waitingFor(teamId)
    const records = manager.teamRecords(teamId)
    const directory = manager.directory.list(teamId)
    const nameOf = (sessionId: string) =>
      records.find(record => record.sessionId === sessionId)?.name
      ?? directory.find(entry => entry.sessionId === sessionId)?.name
      ?? sessionId
    const taskTitle = (taskId: string) => store.get(taskId)?.title ?? null
    const sessions = records
      .filter(record => record.archivedAt == null)
      .map(record => ({ record, requests: manager.getPendingRequests(record.sessionId) }))
    const attention = attentionItems({ sessions, messages, waiting, taskTitle, nameOf })
    return {
      tasks: taskRows({ summaries, waiting, attention, nameOf }),
      attention,
      members: memberRows(manager.teams.catalogForTeam(team), records, groupId =>
        manager.groupProfileCounts(teamId, groupId)),
      summary: morningSummary({
        now: new Date().toISOString(),
        sessions,
        messages,
        messageEvents: messageId => manager.mailbox.store.eventsFor(messageId)
          .map(event => ({ kind: event.kind, createdAt: event.createdAt })),
        waiting,
        turnEnds: this.turnEnds(records),
        nameOf,
        // Phase 1 has no result rows; task 11.2 replaces this with the real read.
        hasResult: () => false,
      }),
      directory,
    }
  }

  private turnEnds(records: ChatSessionRecord[]): TurnEndFact[] {
    const facts: TurnEndFact[] = []
    for (const record of records) {
      if (!record.taskId) continue
      const cached = this.turnEndCache.get(record.sessionId)
      if (cached && cached.lastActivityAt === record.lastActivityAt) {
        facts.push(...cached.facts)
        continue
      }
      // `getHistory` replays the transcript synchronously; only task-bound
      // sessions reach here, and the cache holds across quiet recomputes.
      const ends = (this.manager.getHistory(record.sessionId)?.events ?? [])
        .filter(event => event.type === 'turn_completed')
        .map(event => ({ sessionId: record.sessionId, taskId: record.taskId!, at: event.at }))
      this.turnEndCache.set(record.sessionId, { lastActivityAt: record.lastActivityAt, facts: ends })
      facts.push(...ends)
    }
    return facts
  }
}
