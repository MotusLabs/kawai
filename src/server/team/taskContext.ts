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
// one; an unowned task's context keeps exactly the old shape.
import type { ChatPeerTaskContext } from '../../shared/teamTasks'
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
  }
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
    ...(task.journal.length > 0
      ? [JOURNAL_LINES[version], ...task.journal.map(entry => `- ${entry.createdAt} ${entry.author}: ${entry.text}`)]
      : []),
    '[Message]',
  ]
  return lines.join('\n')
}
