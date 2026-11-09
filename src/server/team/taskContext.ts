// The task section of a delivered peer message (team-tasks design D3). Built
// at delivery, never at send time, so the recipient sees the latest revision
// and journal even when the task was amended while the mail waited. The
// journal is bounded — the last five entries, each truncated — to keep peer
// turns small; `task_get` pages the rest and `task_journal_read` returns any
// entry whole. The header's journal line is versioned
// (bounded-log-reads-and-task-get D7): generation 1 is the legacy wording,
// kept byte-exact so recorded envelopes still parse, and generation 2 the
// bounded one; every other line is shared. A task linked to a plan
// change (durable-plans D9) adds `plan` with the plan's approved revision at
// delivery; a task a running execution owns adds `execution` with the
// revision it runs (plan-execution D7), which may differ from the approved
// one; an unowned task's context keeps exactly the old shape. Every new
// context carries the current revision's identity and contract
// (implementation-contract D7): the header shows the identity and the
// rendered clauses and globs, or says the task has no contract; a context
// recorded before contracts has neither and formats as it did. A task with
// structured findings adds one line naming its blocking and disputed ids
// (review-findings-ledger D10); a task without keeps the old shape.
import type { ChatPeerTaskContext } from '../../shared/teamTasks'
import { renderContract } from '../../shared/implementationContract'
import { blocking, pendingDisputes } from '../../shared/findingsLedger'
import type { PlanStore } from '../plans/planStore'
import { NULL_OWNERSHIP, type ExecutionOwnership } from '../plans/execution/executionOwnership'
import type { TaskStore } from './taskStore'

export const TASK_CONTEXT_JOURNAL_ENTRIES = 5
export const TASK_CONTEXT_ENTRY_CHARS = 500

export function buildTaskContext(store: TaskStore, taskId: string | null, plans?: PlanStore, ownership?: ExecutionOwnership): ChatPeerTaskContext | null {
  if (!taskId) return null
  const task = store.get(taskId)
  if (!task) return null
  const plan = task.planId && task.planChange ? plans?.get(task.planId) : null
  const owned = (ownership ?? NULL_OWNERSHIP).ownerOfTask(taskId)
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    revision: task.revision,
    direction: task.direction,
    acceptance: task.acceptance,
    openspecChange: task.openspecChange,
    worktree: task.worktree,
    journal: store.journal(task.id, TASK_CONTEXT_JOURNAL_ENTRIES).map(entry => ({
      author: entry.author.sessionId ?? entry.author.kind,
      text: entry.text.length > TASK_CONTEXT_ENTRY_CHARS ? `${entry.text.slice(0, TASK_CONTEXT_ENTRY_CHARS)}…` : entry.text,
      createdAt: entry.createdAt,
    })),
    ...(plan && task.planChange ? { plan: { id: plan.id, title: plan.title, revision: plan.currentApprovedRevision, change: task.planChange } } : {}),
    ...(owned ? { execution: { id: owned.executionId, revision: owned.revision } } : {}),
    ...(task.identity ? { contract: { identity: task.identity, contract: task.contract ?? null } } : {}),
    ...findingsOf(store, task.id),
  }
}

/** The ledger's blocking and disputed ids (review-findings-ledger D10); nothing while the task has no structured findings, so older contexts keep their shape. */
function findingsOf(store: TaskStore, taskId: string): Pick<ChatPeerTaskContext, 'findings'> {
  const rows = store.ledger(taskId)
  if (rows.length === 0) return {}
  return { findings: { blocking: blocking(rows).map(row => row.id), disputed: pendingDisputes(rows).map(row => row.id) } }
}

/** `Findings: 2 blocking (F1, F3), 1 disputed (F4)`. */
function findingsLine(findings: NonNullable<ChatPeerTaskContext['findings']>): string {
  const part = (ids: string[], label: string) => `${ids.length} ${label}${ids.length > 0 ? ` (${ids.join(', ')})` : ''}`
  return `Findings: ${part(findings.blocking, 'blocking')}, ${part(findings.disputed, 'disputed')} — task_get has the ledger`
}

/** The header's contract lines: the identity, then the clauses and globs under their part headings. */
function contractLines(context: NonNullable<ChatPeerTaskContext['contract']>): string[] {
  if (!context.contract) return [`Contract: none — revision identity ${context.identity}; this task has no implementation contract.`]
  // The rendered section without its `## Implementation contract` heading and blank line.
  const parts = renderContract(context.contract).trimEnd().split('\n').slice(2)
  return [`Implementation contract ${context.identity} (cite clauses as ${context.identity} › <id>):`, ...parts]
}

export type TaskHeaderVersion = 1 | 2
/** The generation new task envelopes carry. */
export const TASK_HEADER_VERSION: TaskHeaderVersion = 2

const JOURNAL_LINES: Record<TaskHeaderVersion, string> = {
  1: 'Latest journal entries (task_get has the full journal):',
  2: 'Latest journal entries (task_get pages the journal with journal_before and journal_limit; task_journal_read returns any entry whole):',
}

/**
 * The readable task header of one generation, written above the body.
 * Deterministic from the context and the version, so the parser can strip
 * exactly this text back off.
 */
export function formatTaskHeader(task: ChatPeerTaskContext, version: TaskHeaderVersion = TASK_HEADER_VERSION): string {
  if (!Object.hasOwn(JOURNAL_LINES, version)) throw new Error(`Unknown task header version: ${String(version)}`)
  const lines = [
    `[Task ${task.id}: ${task.title}] status ${task.status}, revision ${task.revision}`,
    ...(task.worktree ? [`Worktree: ${task.worktree}`] : []),
    ...(task.plan ? [`Plan: ${task.plan.title} (revision ${task.plan.revision ?? 'none'}), change ${task.plan.change}`] : []),
    ...(task.execution ? [`Execution: ${task.execution.id} running plan revision ${task.execution.revision}`] : []),
    ...(task.openspecChange
      ? [`Linked OpenSpec change: ${task.openspecChange}. Its proposal, design, and tasks are the authoritative direction; the text below summarizes them.`]
      : []),
    'Direction:',
    task.direction,
    ...(task.acceptance ? ['Acceptance criteria:', task.acceptance] : []),
    ...(task.contract ? contractLines(task.contract) : []),
    ...(task.findings ? [findingsLine(task.findings)] : []),
    ...(task.journal.length > 0
      ? [JOURNAL_LINES[version], ...task.journal.map(entry => `- ${entry.createdAt} ${entry.author}: ${entry.text}`)]
      : []),
    '[Message]',
  ]
  return lines.join('\n')
}
