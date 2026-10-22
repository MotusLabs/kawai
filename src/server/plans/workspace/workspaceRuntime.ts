// The workspace snapshot's runtime and passive-health composition
// (plan-workspace 3.1 and 3.2, design D2/D3/D5). Every input is already
// held: the supervision loader's derived outcomes, the linked tasks'
// outstanding assignments and results, the conversation roles' bindings, and
// the manager's in-memory context and provider-usage facts. Nothing here
// starts, restores, attaches to, sends to, or refreshes any session or usage
// source (INVARIANT P) — the readings are the same values the chat snapshot
// and the usage bar already display, read through read-only accessors.
import type { PlanContent } from '../../../shared/plans'
import type { ChangeSupervision } from '../../../shared/planSupervision'
import type { ChatUsageReport } from '../../../shared/chat'
import type {
  WorkspaceAgentReading,
  WorkspaceContextReading,
  WorkspaceQuotaReading,
} from '../../../shared/planWorkspace'
import {
  workspaceRuntime,
  type WorkspaceHolderHistory,
  type WorkspaceHolderView,
  type WorkspaceLinkedTaskInput,
  type WorkspaceRuntimeView,
} from '../../../shared/planWorkspaceRuntime'
import { hostLoginProvider, type MergedProvider } from '../../chat/catalogMerge'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import { AssignmentStore, outstandingOf } from '../../team/assignmentStore'
import type { TaskStatus, TeamTaskAssignment } from '../../../shared/teamTasks'
import { TaskResultStore } from '../../team/taskResultStore'
import type { SupervisionReads } from '../supervision/supervisionRead'
import { readPlanSupervision, supervisedRevision } from '../supervision/supervisionRead'

/** The stores one composition reads over; the execution module's read bundle. */
export interface WorkspaceRuntimeDeps {
  reads: SupervisionReads
}

/** Mail states whose instruction is still waiting on staffing (the supervision's own set). */
const STAFFING_STATES = new Set(['queued', 'spawning', 'awaiting-request'])

/**
 * The linked tasks' composer-facing facts: the outstanding assignment, the
 * claimants of superseded and failed assignments (history), and the
 * outstanding result's submitter and verdict (history with no readings).
 */
function linkedTaskInputs(
  assignments: AssignmentStore,
  results: TaskResultStore,
  tasks: ReadonlyArray<{ id: string; title: string; status: TaskStatus; planChange: string }>,
): WorkspaceLinkedTaskInput[] {
  return tasks.map(task => {
    const rows = assignments.listByTask(task.id)
    const outstanding = outstandingOf(rows)
    const result = results.outstanding(task.id)
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      planChange: task.planChange,
      assignment: outstanding === null ? null : {
        targetKind: outstanding.targetKind,
        targetId: outstanding.targetId,
        claimedBy: outstanding.claimedBy,
        handoffKind: outstanding.handoffKind ?? null,
        // outstandingOf never returns failed or superseded rows.
        state: outstanding.state as 'queued' | 'claimed' | 'delivered' | 'parked' | 'forwarded' | 'uncertain',
      },
      result: result === null ? null : {
        submitter: result.submittedBy.sessionId ?? '',
        accepted: result.acceptedAt !== null,
        reviewVerdict: result.acceptedAt === null ? (results.findingsFor(result.id).at(-1)?.verdict ?? null) : null,
      },
      priorClaimants: rows
        .filter(row => row !== outstanding && row.claimedBy !== null && (row.supersededBy !== null || row.state === 'failed'))
        .map(row => ({ sessionId: row.claimedBy!, handoffKind: row.handoffKind ?? null })),
      // The composer fills the unclaimed instruction's blocker; null here.
      waitingReason: null,
    }
  })
}

/** The mailbox blocker of an unclaimed instruction, read the way supervision reads it. */
function staffingBlocker(reads: SupervisionReads, assignment: TeamTaskAssignment): string | null {
  if (assignment.messageId === null || !STAFFING_STATES.has(assignment.state)) return null
  return reads.runtime.blocker(assignment.messageId)
}

/** One provider-usage report as the workspace's quota reading (LC5's applicability split). */
export function quotaReadingOf(
  report: ChatUsageReport,
  provider: MergedProvider | null,
): { reading: WorkspaceQuotaReading; applicable: boolean } {
  // The widest reported window is the compact dot's pressure; a windowless
  // report keeps the status only (LC5.3: it never counts toward green).
  const widest = report.windows.slice().sort((a, b) => b.percentUsed - a.percentUsed)[0] ?? null
  const codexKeyed = report.windows.some(window => window.key.startsWith('codex:'))
  const source = report.source ?? 'pull' // absent on older reports; reads as pull (chat.ts)
  let composed: WorkspaceQuotaReading['source']
  let applicable: boolean
  if (source === 'push') {
    composed = 'profile'
    applicable = true
  } else if (source === 'provider' || codexKeyed) {
    composed = 'provider'
    applicable = true
  } else {
    // `report` and `pull` read the host CLI login: applicable only when the
    // provider IS the host login; otherwise the reading is that account's
    // allowance. A provider the catalog does not define routes nowhere
    // confirmable — unconfirmed, excluded (fail-safe).
    composed = 'account'
    applicable = hostLoginProvider(provider)
    if (applicable) composed = 'profile'
  }
  return {
    reading: {
      status: report.status === 'allowed' ? 'ok' : report.status,
      used: widest === null ? null : widest.percentUsed / 100,
      resetsAt: widest?.resetsAt ?? null,
      measuredAt: report.receivedAt,
      source: composed,
    },
    applicable,
  }
}

/** One session's passive readings, or its relevance with both readings unknown. */
function readingOf(manager: ChatSessionManager, sessionId: string): {
  context: WorkspaceContextReading | null
  quota: WorkspaceQuotaReading | null
  quotaApplicable: boolean
} {
  const usage = manager.contextReadingOf(sessionId)
  const context: WorkspaceContextReading | null = usage === null ? null : {
    used: usage.percentage / 100,
    measuredAt: usage.at,
  }
  const report = manager.providerUsageOf(manager.providerIdOf(sessionId))
  if (report === null) return { context, quota: null, quotaApplicable: false }
  const { reading, applicable } = quotaReadingOf(report, manager.providerDefinitionOf(sessionId))
  return { context, quota: reading, quotaApplicable: applicable }
}

/** The session ids whose readings the workspace exposes, with one relevance each (LC3's fixed classes). */
export function exposedSessions(
  manager: ChatSessionManager,
  teamId: string,
  inputs: { executionHolders: Iterable<string>; claimants: Iterable<string>; fixClaimants: Iterable<string> },
): Array<{ sessionId: string; relevance: WorkspaceAgentReading['relevance'] }> {
  const exposed = new Map<string, WorkspaceAgentReading['relevance']>()
  const add = (sessionId: string, relevance: WorkspaceAgentReading['relevance']) => {
    // The bound conversation roles win a tie: the session is exposed once.
    if (!exposed.has(sessionId) || (relevance !== 'holder' && exposed.get(sessionId) === 'holder')) {
      exposed.set(sessionId, relevance)
    }
  }
  for (const binding of manager.planWorkspace.bindings(teamId)) add(binding.sessionId, binding.role)
  for (const sessionId of inputs.executionHolders) add(sessionId, 'holder')
  for (const sessionId of inputs.claimants) add(sessionId, 'holder')
  for (const sessionId of inputs.fixClaimants) add(sessionId, 'holder')
  // Same-team only (INVARIANT P): a session without a record, or one that
  // moved teams, is never exposed.
  return [...exposed.entries()]
    .filter(([sessionId]) => manager.has(sessionId) && manager.teams.teamOf(sessionId)?.teamId === teamId)
    .map(([sessionId, relevance]) => ({ sessionId, relevance }))
}

/** The snapshot's two §3 sections, composed together (one read pass over the same facts). */
export interface WorkspaceRuntimeSections {
  runtime: WorkspaceRuntimeView | null
  health: WorkspaceAgentReading[]
}

/** Fill the session names the pure shaping leaves null (only the directory knows them). */
function fillNames(
  manager: ChatSessionManager,
  teamId: string,
  holders: WorkspaceHolderView[],
  history: WorkspaceHolderHistory[],
  health: WorkspaceAgentReading[],
): void {
  const nameOf = (sessionId: string): string | null => manager.directory.get(teamId, sessionId)?.name ?? null
  for (const holder of holders) {
    if (holder.holder.kind === 'session') holder.holder.name = nameOf(holder.holder.sessionId)
    if (holder.holder.kind === 'session-unclaimed') holder.holder.name = nameOf(holder.holder.sessionId)
  }
  for (const entry of history) entry.name = nameOf(entry.sessionId)
  for (const agent of health) agent.name = nameOf(agent.sessionId)
}

/**
 * The runtime projection and the passive readings of one plan's workspace
 * (3.1, 3.2): one read pass over the supervision loader, the linked tasks,
 * and the manager's held facts. `displayed` null (a plan with neither
 * revision nor draft) composes nothing — the snapshot omits both sections.
 */
export function composeWorkspaceSections(
  deps: WorkspaceRuntimeDeps,
  manager: ChatSessionManager,
  teamId: string,
  planId: string,
  opts: { displayed: PlanContent | null; now: Date },
): WorkspaceRuntimeSections {
  if (opts.displayed === null) return { runtime: null, health: [] }
  const reads = deps.reads
  const assignments = new AssignmentStore(reads.db, reads.mail)
  try {
    const results = new TaskResultStore(reads.db)
    const linked = reads.plans.linkedTasks(planId)
    const tasks = linkedTaskInputs(assignments, results, linked).map(task => ({
      ...task,
      // The waiting reason rides the unclaimed instruction (B7): the same
      // blocker the staffing wait reads, or null while nothing is waiting.
      waitingReason: task.assignment !== null && task.assignment.claimedBy === null
        ? staffingBlocker(reads, outstandingOf(assignments.listByTask(task.id))!)
        : null,
    }))
    const { execution, revision } = supervisedRevision(reads, teamId, planId)
    const supervision = new Map<string, ChangeSupervision>(
      readPlanSupervision(reads, teamId, planId, opts.now).map(supervised => [supervised.change, supervised]),
    )
    const runtime = workspaceRuntime({
      displayed: opts.displayed,
      execution: execution === null || revision === null ? null : { executionId: execution.id, revision: execution.revision, content: revision.content },
      supervision,
      tasks,
    })
    const fixClaimants = reads.decisions.fixTasksOfPlan(teamId, planId)
      .map(fix => outstandingOf(assignments.listByTask(fix.taskId))?.claimedBy ?? null)
      .filter((sessionId): sessionId is string => sessionId !== null)
    const exposed = exposedSessions(manager, teamId, {
      executionHolders: [...supervision.values()].map(supervised => supervised.holder?.session).filter((id): id is string => id !== undefined && id !== null),
      claimants: tasks.flatMap(task => (task.assignment?.claimedBy !== null && task.assignment?.claimedBy !== undefined ? [task.assignment.claimedBy] : [])),
      fixClaimants,
    })
    const health: WorkspaceAgentReading[] = exposed.map(({ sessionId, relevance }) => ({
      sessionId,
      name: null,
      relevance,
      ...readingOf(manager, sessionId),
    }))
    fillNames(manager, teamId, runtime.changes.flatMap(change => change.holders), runtime.changes.flatMap(change => change.history), health)
    return { runtime, health }
  } finally {
    assignments.close()
  }
}
