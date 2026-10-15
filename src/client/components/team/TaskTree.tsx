// The Tasks tab's list pieces (team-workspace-pages 5.5, team-workspace D4):
// the parent/subtask forest with search that keeps ancestors, marked matches,
// and one row per task showing its status and — from the workspace read model
// when it has arrived — its workflow stage beside it, the accountable party,
// worktree, current waiting reason, and next action.
import type { Session } from '@shared/types'
import type { TeamTaskSummary } from '@shared/teamTasks'
import type { TeamTaskRow } from '@shared/teamWorkspace'
import { constraintLabel } from '../../utils/waitingLabels'
import { assignmentLabel } from './assignmentLabel'
import { stageLabel } from './taskStageLabels'
import { actorLabel, sessionLabel } from './teamTaskLabels'

/** One tree node: a task with the children whose parentId names it. */
export interface TaskNode {
  task: TeamTaskSummary
  children: TaskNode[]
}

/**
 * Build the roots-and-children forest; a task whose parent is absent from
 * the list (filtered out or gone) is a root itself, so no row disappears.
 */
export function buildTaskTree(tasks: TeamTaskSummary[]): TaskNode[] {
  const byParent = new Map<string, TeamTaskSummary[]>()
  const ids = new Set(tasks.map(task => task.id))
  const roots: TeamTaskSummary[] = []
  for (const task of tasks) {
    if (task.parentId && ids.has(task.parentId)) {
      const list = byParent.get(task.parentId) ?? []
      list.push(task)
      byParent.set(task.parentId, list)
    } else {
      roots.push(task)
    }
  }
  const nodeOf = (task: TeamTaskSummary): TaskNode => ({ task, children: (byParent.get(task.id) ?? []).map(nodeOf) })
  return roots.map(nodeOf)
}

/** Whether a task's title or current direction contains the needle (D6). */
function taskMatches(task: TeamTaskSummary, needle: string): boolean {
  if (!needle) return true
  const hay = `${task.title}\n${task.direction}`.toLowerCase()
  return hay.includes(needle.toLowerCase())
}

/** The search keeps a matching task's ancestors, so the tree stays connected. */
export function filterTree(nodes: TaskNode[], needle: string): TaskNode[] {
  if (!needle) return nodes
  const keep = (node: TaskNode): TaskNode | null => {
    const children = node.children.map(child => keep(child)).filter((child): child is TaskNode => child !== null)
    return children.length > 0 || taskMatches(node.task, needle) ? { task: node.task, children } : null
  }
  return nodes.map(keep).filter((node): node is TaskNode => node !== null)
}

/** Text with the needle's first occurrence marked (5.5). */
export function MarkedText({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<mark data-testid="task-match">{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>
}

/** Context kept around a marked match, in characters (5.5). */
const SNIPPET_CONTEXT = 24

/**
 * The direction line a row shows under a search: a snippet around the match —
 * so a match deep in the direction is shown and marked — falling back to the
 * first line when the search does not name this task (an ancestor kept for
 * its matching subtask).
 */
export function directionLine(direction: string, needle: string): { text: string; needle: string } {
  if (!needle) return { text: direction.split('\n')[0] ?? '', needle: '' }
  const at = direction.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return { text: direction.split('\n')[0] ?? '', needle: '' }
  const start = Math.max(0, at - SNIPPET_CONTEXT)
  const end = Math.min(direction.length, at + needle.length + SNIPPET_CONTEXT)
  return {
    text: `${start > 0 ? '…' : ''}${direction.slice(start, end)}${end < direction.length ? '…' : ''}`.replace(/\n/g, ' '),
    needle,
  }
}

const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/** Stage, accountable party, worktree, wait, and next action from the read model. */
function WorkflowLines({ row, sessions }: { row: TeamTaskRow; sessions: Session[] }) {
  return <>
    <p className="text-sm text-secondary" data-testid="task-workflow">
      {row.stage ? <>Stage: <span data-testid="task-stage">{stageLabel(row.stage)}</span></> : 'No stage (closed)'}
      {row.accountable && <> · accountable: <span data-testid="task-accountable">{row.accountable.label}</span></>}
      {row.worktree && <> · worktree <span title={row.worktree}>{basename(row.worktree)}</span></>}
    </p>
    {row.waitingReason && <p className="text-sm text-secondary" data-testid="task-waiting">
      Waiting: {constraintLabel(row.waitingReason.blocker, id => sessionLabel(id, sessions))}
    </p>}
    {row.nextAction && <p className="text-sm" data-testid="task-next-action">
      Next: {row.nextAction}{row.requiresHuman ? ' (needs you)' : ''}
    </p>}
  </>
}

/** One tree row with its nested subtasks; a collapsed parent hides them and states their count. */
export function TaskRow({ node, needle, depth, sessions, rows, collapsedParents, searching, onToggleParent, onSelect }: {
  node: TaskNode
  needle: string
  depth: number
  sessions: Session[]
  /** Workspace read-model rows by task id; absent until the first snapshot. */
  rows: ReadonlyMap<string, TeamTaskRow>
  collapsedParents: Set<string>
  searching: boolean
  onToggleParent: (taskId: string) => void
  onSelect: (taskId: string) => void
}) {
  const { task, children } = node
  const collapsed = !searching && children.length > 0 && collapsedParents.has(`parent:${task.id}`)
  return <>
    <article data-task-id={task.id} data-testid="task-row" className={`mb-2 border border-border p-2 ${depth > 0 ? 'ml-4' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <button className="text-left font-medium hover:underline" onClick={() => onSelect(task.id)}>
          <MarkedText text={task.title} needle={needle} />
        </button>
        {children.length > 0 && <button type="button" className="btn shrink-0" data-testid="task-parent-toggle"
          aria-expanded={!collapsed} onClick={() => onToggleParent(task.id)}>
          {collapsed ? `▸ ${children.length} subtask${children.length === 1 ? '' : 's'}` : '▾'}
        </button>}
      </div>
      <p className="text-sm text-secondary">
        <span data-testid="task-status">{task.status}</span> · created by {actorLabel(task.creator, sessions)}
        {task.parentId ? ' · subtask' : ''}
      </p>
      <p className="text-sm text-secondary" data-testid="task-direction-line">
        <MarkedText {...directionLine(task.direction, needle)} />
      </p>
      <p className="text-sm text-secondary" data-testid="task-participants">
        Participants: {task.participants.length > 0 ? task.participants.map(id => sessionLabel(id, sessions)).join(', ') : 'none yet'}
      </p>
      <p className="text-sm text-secondary" data-testid="task-assignment">{assignmentLabel(task.assignment, sessions)}</p>
      {rows.get(task.id) && <WorkflowLines row={rows.get(task.id)!} sessions={sessions} />}
      {task.outstandingResult && <p className="text-sm" data-testid="task-result-badge"
        data-state={task.outstandingResult.accepted ? 'accepted' : task.outstandingResult.needsReevaluation ? 'flagged' : 'submitted'}>
        {task.outstandingResult.accepted ? 'Result accepted' : task.outstandingResult.needsReevaluation ? 'Result needs re-evaluation' : 'Result submitted'}
      </p>}
    </article>
    {!collapsed && children.map(child => <TaskRow key={child.task.id} node={child} needle={needle} depth={depth + 1}
      sessions={sessions} rows={rows} collapsedParents={collapsedParents} searching={searching} onToggleParent={onToggleParent} onSelect={onSelect} />)}
  </>
}
