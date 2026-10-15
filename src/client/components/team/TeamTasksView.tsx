// The Tasks tab (team-tasks 7.1, task-assignment 5.2, team-workspace-pages
// 5.5): a search over title and current direction with marked matches — a
// matching subtask keeps its ancestors so the tree stays connected — a
// collapsible parent/subtask tree, the New task form (searchable worktree
// and OpenSpec-change pickers, plan and plan-change pickers listing only
// open plans' approved changes (durable-plans D9), an optional assignment
// with dispatch preview, **Create task** / **Create and assign** armed with
// one stable client request key whose draft lives in the store), and rows with status,
// creator, participants, the assignment target and state, and the result
// badge (task-results-handoffs). Rows come from authoritative server
// snapshots; actions disable while disconnected and refusals show inline.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { TeamTaskSummary } from '@shared/teamTasks'
import { useSessionStore } from '../../stores/sessionStore'
import { useTeamTaskStore, type TaskCreatePayload, type TaskView } from '../../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import TeamTaskDetail from './TeamTaskDetail'
import SearchablePicker from './SearchablePicker'
import { TaskPreviewView, TaskTargetSelect } from './taskAssignFields'
import { useTeamGroups } from '../chat/useTeamGroups'
import { openParticipantChat } from '../chat/openParticipant'
import { assignmentLabel } from './assignmentLabel'
import { actorLabel, sessionLabel } from './teamTaskLabels'
import { usePlanTargetsRefresh } from './usePlanTargetsRefresh'

/** One tree node: a task with the children whose parentId names it. */
interface TaskNode {
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

export default function TeamTasksView({ teamPath, projectPath, view, sendMessage, connected, connectionEpoch = 0, onSelectedTask, onOpenThread, onCreateWorktree, onOpenMailbox, onOpenSession }: {
  teamPath: string
  projectPath: string
  view: TaskView
  sendMessage: SendClientMessage
  connected: boolean
  /** Bumps on every reconnect, so the form's plan subscription is re-sent. */
  connectionEpoch?: number
  /** Reports selection moves to the host (the Team page's URL, D3). */
  onSelectedTask?: (taskId: string | null) => void
  /** Open this message's thread in the Messages tab. */
  onOpenThread?: (threadId: string) => void
  /** Opens the existing worktree-creation flow; the pickers refresh on return. */
  onCreateWorktree?: () => void
  /** Opens the team mailbox, where an uncertain revision notice is resolved. */
  onOpenMailbox?: () => void
  /** Open a participant's chat; the Team page passes the navigator's opener. */
  onOpenSession?: (sessionId: string) => void
}) {
  const sessions = useSessionStore(state => state.sessions)
  const { groups } = useTeamGroups(connected, projectPath)
  const draft = view.draft
  const flow = view.flow
  const busy = Object.keys(view.pending).length > 0
  const setDraft = (patch: Partial<typeof draft>) => useTeamTaskStore.getState().setDraft(teamPath, patch)
  const select = (taskId: string | null) => {
    useTeamTaskStore.getState().select(teamPath, taskId)
    onSelectedTask?.(taskId)
  }
  // Selections the store makes on its own — the created task auto-opens its
  // detail — reach the URL too (D3), without echoing the mount's initial
  // value (a reload's URL-driven selection already names itself).
  const reportedSelection = useRef<string | null>(view.selectedTaskId)
  useEffect(() => {
    if (reportedSelection.current === view.selectedTaskId) return
    reportedSelection.current = view.selectedTaskId
    onSelectedTask?.(view.selectedTaskId)
  }, [view.selectedTaskId]) // eslint-disable-line react-hooks/exhaustive-deps
  // Search and tree collapse are the team's kept view state (D8). Parents
  // render expanded by default; a collapsed one is recorded by name.
  const search = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.tasks.search) ?? ''
  const collapsedParents = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.tasks.collapsedSections) ?? NONE_COLLAPSED
  const collapsedSet = useMemo(() => new Set(collapsedParents), [collapsedParents])
  // While a search is active it overrides a parent's collapsed state: a
  // matching subtask is shown under its parent (5.5).
  const searching = search.trim() !== ''
  const toggleParent = (taskId: string) => useTeamWorkspaceStore.getState().toggleSectionCollapsed(teamPath, 'tasks', `parent:${taskId}`)
  const tree = useMemo(() => filterTree(buildTaskTree(view.tasks), search.trim()), [view.tasks, search])

  // The change list narrows to the roots the server validates for the chosen
  // worktree, so every request carries the draft's current worktree and the
  // view re-requests whenever it moves.
  const requestTargets = () => {
    const worktree = useTeamTaskStore.getState().views[teamPath]?.draft.worktree.trim()
    useTeamTaskStore.getState().beginTargets(teamPath)
    sendMessage({ type: 'team-task-targets', teamPath, requestId: crypto.randomUUID(), ...(worktree ? { worktree } : {}) })
  }
  // StrictMode fires an effect twice on mount with identical deps; the
  // per-signature ref keeps the request single. A disconnect clears the
  // signature so a reconnect refreshes the pickers' data once (the pickers
  // also re-request on focus, on demand).
  const requestedTargets = useRef('')
  useEffect(() => {
    if (!connected) { requestedTargets.current = ''; return }
    const signature = `${teamPath}\0${draft.worktree}`
    if (requestedTargets.current === signature) return
    requestedTargets.current = signature
    requestTargets()
  }, [connected, teamPath, draft.worktree]) // eslint-disable-line react-hooks/exhaustive-deps
  // While the New task form is open, a plan push (an approval, a close)
  // re-requests the targets so the plan pickers follow it. The form stays an
  // uncontrolled <details> that remounts closed whenever a detail replaces
  // the list; that unmount fires no toggle, so the flag resets with it.
  const [formOpen, setFormOpen] = useState(false)
  useEffect(() => { if (view.selectedTaskId) setFormOpen(false) }, [view.selectedTaskId])
  usePlanTargetsRefresh(teamPath, formOpen && !view.selectedTaskId, connected, connectionEpoch, sendMessage, requestTargets)
  // A reconnect drops the waiters for results lost with the connection: the
  // armed flow keeps its key, the dispatch effect re-sends the assign leg
  // under it, and a human resubmit of the create reuses it — either way the
  // server replays instead of duplicating (spec: reconnect resubmission).
  const wasConnected = useRef(connected)
  useEffect(() => {
    if (wasConnected.current === false && connected) useTeamTaskStore.getState().reconnected(teamPath)
    wasConnected.current = connected
  }, [connected, teamPath])
  const preview = () => {
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().beginPreview(teamPath, requestId)
    sendMessage({
      type: 'team-task-preview', teamPath, requestId,
      ...(draft.worktree.trim() ? { worktree: draft.worktree.trim() } : {}),
      target: { kind: draft.targetKind as 'group' | 'session', id: draft.targetId },
    })
  }
  const create = (assign: boolean) => {
    // One request key per intent (task-assignment D4), minted when the
    // action is first armed and reused by every retry of it: a refusal left
    // the flow armed, so clicking again replays instead of re-arming. The
    // busy guard makes a double click a single request; a same-key replay
    // would be safe besides.
    if (busy) return
    const mode = assign ? 'create-and-assign' : 'create'
    // An edit after a lost result is a changed intent: the armed key would
    // be refused for a different payload, so re-arm a fresh one. An
    // unchanged resubmit keeps the key and the server replays.
    const payload: TaskCreatePayload = {
      title: draft.title.trim(), direction: draft.direction.trim(),
      acceptance: draft.acceptance.trim() || null, parentId: draft.parentId || null,
      worktree: draft.worktree.trim() || null, openspecChange: draft.openspecChange.trim() || null,
      planId: draft.planId || null, planChange: draft.planId ? draft.planChange || null : null,
    }
    const changed = flow?.sentCreatePayload &&
      JSON.stringify(flow.sentCreatePayload) !== JSON.stringify(payload)
    if (!flow || flow.mode !== mode || flow.taskId || changed) {
      useTeamTaskStore.getState().armFlow(teamPath, mode)
    }
    const armed = useTeamTaskStore.getState().views[teamPath]!.flow!
    useTeamTaskStore.getState().flowSendCreate(teamPath, payload)
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().begin(teamPath, requestId, assign ? 'create-assign' : 'create')
    sendMessage({
      type: 'team-task-create', teamPath, requestId, requestKey: armed.requestKey,
      title: draft.title.trim(), direction: draft.direction.trim(),
      ...(draft.acceptance.trim() ? { acceptance: draft.acceptance.trim() } : {}),
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      ...(draft.worktree.trim() ? { worktree: draft.worktree.trim() } : {}),
      ...(draft.openspecChange.trim() ? { openspecChange: draft.openspecChange.trim() } : {}),
      ...(payload.planId ? { planId: payload.planId, ...(payload.planChange ? { planChange: payload.planChange } : {}) } : {}),
    })
  }
  // The dispatch leg of an armed create-and-assign flow: sent as soon as the
  // create leg committed (and re-sent after a reconnect or a cleared retry
  // under the same key, so the server replays instead of duplicating).
  useEffect(() => {
    if (!flow || flow.mode !== 'create-and-assign' || !flow.taskId || flow.assignFailed || busy) return
    const payload = { kind: draft.targetKind as 'group' | 'session', id: draft.targetId }
    useTeamTaskStore.getState().flowSendAssign(teamPath, { targetKind: payload.kind, targetId: payload.id, instruction: draft.instruction })
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().begin(teamPath, requestId, 'assign')
    sendMessage({
      type: 'team-task-assign', teamPath, requestId, taskId: flow.taskId, requestKey: flow.requestKey,
      target: payload, instruction: draft.instruction,
    })
  }, [flow?.taskId, flow?.assignFailed, busy]) // eslint-disable-line react-hooks/exhaustive-deps
  const retryAssign = () => {
    if (!flow?.taskId) return
    useTeamTaskStore.getState().retryAssign(teamPath)
  }
  const targetReady = draft.targetKind !== '' && draft.targetId !== ''
  // A plan link names both halves; a chosen plan waits for its change.
  const planIncomplete = draft.planId !== '' && draft.planChange === ''
  const createCommitted = flow?.taskId != null
  return <div data-testid="team-tasks" className="flex h-full min-h-0 flex-col">
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update tasks.</p>}
    {view.loading && <p role="status" className="p-3">Loading tasks…</p>}
    {view.error && <p role="alert" className="border-b border-border p-3 text-sm text-danger">{view.error}</p>}
    {view.selectedTaskId ? (
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <TeamTaskDetail teamPath={teamPath} projectPath={projectPath} view={view} sendMessage={sendMessage} connected={connected} sessions={sessions}
          onBack={() => select(null)} onNavigate={select} onOpenThread={onOpenThread} onOpenSession={onOpenSession ?? openParticipantChat} onOpenMailbox={onOpenMailbox} />
      </div>
    ) : <>
      <div className="border-b border-border p-3">
        <input className="input" type="search" aria-label="Search tasks" placeholder="Search title and direction"
          value={search} onChange={event => useTeamWorkspaceStore.getState().setSearch(teamPath, 'tasks', event.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <details className="mb-4 border border-border p-2" data-testid="task-create"
          onToggle={event => setFormOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer font-medium">New task</summary>
          <form className="mt-2 flex flex-col gap-2" onSubmit={event => { event.preventDefault(); create(draft.targetKind !== '' && draft.instruction.trim() !== '') }}>
            <input className="input" aria-label="Task title" placeholder="Title" value={draft.title}
              disabled={!connected} onChange={event => setDraft({ title: event.target.value })} />
            <textarea className="input min-h-16" aria-label="Task direction" placeholder="Direction" value={draft.direction}
              disabled={!connected} onChange={event => setDraft({ direction: event.target.value })} />
            <textarea className="input min-h-12" aria-label="Acceptance criteria" placeholder="Acceptance criteria (optional)" value={draft.acceptance}
              disabled={!connected} onChange={event => setDraft({ acceptance: event.target.value })} />
            <select className="input" aria-label="Parent task" value={draft.parentId}
              disabled={!connected} onChange={event => setDraft({ parentId: event.target.value })}>
              <option value="">No parent task</option>
              {view.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select>
            <SearchablePicker testId="task-worktree-picker" ariaLabel="Target worktree" placeholder="Target worktree (optional)"
              value={draft.worktree} onChange={value => setDraft({ worktree: value })} disabled={!connected}
              loading={view.targetsLoading} refresh={requestTargets}
              {...(onCreateWorktree ? { onCreateWorktree, createLabel: 'Create a worktree…' } : {})}
              options={(view.targets?.worktrees ?? []).map(entry => ({
                value: entry.root, label: entry.root, ...(entry.branch !== undefined ? { hint: `branch: ${entry.branch}` } : {}),
              }))} />
            <SearchablePicker testId="task-change-picker" ariaLabel="Linked OpenSpec change" placeholder="Linked OpenSpec change (optional)"
              value={draft.openspecChange} onChange={value => setDraft({ openspecChange: value })} disabled={!connected}
              loading={view.targetsLoading} refresh={requestTargets}
              options={(view.targets?.changes ?? []).map(change => ({
                value: change.name, label: change.name, hint: change.locations.join(' and '),
              }))} />
            {/* Plan link (durable-plans D9): only open plans' approved changes are offered. */}
            <select className="input" aria-label="Plan" data-testid="task-plan-picker" value={draft.planId}
              disabled={!connected} onFocus={requestTargets} onChange={event => setDraft({ planId: event.target.value, planChange: '' })}>
              <option value="">No plan</option>
              {(view.targets?.plans ?? []).map(plan => <option key={plan.id} value={plan.id}>{plan.title} (revision {plan.revision})</option>)}
            </select>
            {draft.planId && <select className="input" aria-label="Plan change" data-testid="task-plan-change-picker" value={draft.planChange}
              disabled={!connected} onChange={event => setDraft({ planChange: event.target.value })}>
              <option value="">Choose a change of the plan</option>
              {(view.targets?.plans?.find(plan => plan.id === draft.planId)?.changes ?? []).map(change => <option key={change} value={change}>{change}</option>)}
            </select>}
            <fieldset className="flex flex-col gap-2 border-t border-border pt-2" data-testid="task-assign-section">
              <legend>Assignment (optional)</legend>
              <TaskTargetSelect testId="task-assign-target" kind={draft.targetKind} id={draft.targetId}
                onKind={kind => setDraft({ targetKind: kind })} onId={id => setDraft({ targetId: id })}
                groups={groups} sessions={sessions.filter(session => session.kind === 'chat')} disabled={!connected} />
              <textarea className="input min-h-12" aria-label="Assignment instruction" placeholder="Initial instruction"
                value={draft.instruction} disabled={!connected}
                onChange={event => setDraft({ instruction: event.target.value })} />
              <p className="text-sm text-secondary">Group dispatch selects one eligible member of the group.</p>
              <button type="button" className="btn self-start" disabled={!connected || !targetReady || Object.keys(view.previewPending).length > 0}
                onClick={preview} data-testid="task-assign-preview-button">Preview dispatch</button>
              {view.preview && <TaskPreviewView preview={view.preview} />}
            </fieldset>
            {createCommitted && flow?.mode === 'create-and-assign'
              ? <button type="button" className="btn btn-primary self-start" disabled={!connected || busy || !flow.assignFailed || !draft.instruction.trim()}
                onClick={retryAssign} data-testid="task-retry-assign">Retry assignment</button>
              : <>
                <button type="submit" className="btn self-start" disabled={!connected || busy || !draft.title.trim() || !draft.direction.trim() || planIncomplete}
                  data-testid="task-create-button">Create task</button>
                <button type="button" className="btn btn-primary self-start" disabled={!connected || busy || !draft.title.trim() || !draft.direction.trim() || planIncomplete || !targetReady || !draft.instruction.trim()}
                  onClick={() => create(true)} data-testid="task-create-assign-button">Create and assign</button>
              </>}
          </form>
        </details>
        {view.tasks.length === 0 && !view.loading && <p className="text-sm text-secondary">No tasks yet</p>}
        {tree.length === 0 && view.tasks.length > 0 && <p className="text-sm text-secondary" data-testid="task-no-matches">No tasks match the search</p>}
        {tree.map(node => <TaskRow key={node.task.id} node={node} needle={search.trim()} depth={0}
          sessions={sessions} collapsedParents={collapsedSet} searching={searching} onToggleParent={toggleParent} onSelect={select} />)}
      </div>
    </>}
  </div>
}

/** Stable empty list so absent view state never re-renders (getSnapshot caching). */
const NONE_COLLAPSED: string[] = []

/** One tree row with its nested subtasks; a collapsed parent hides them and states their count. */
function TaskRow({ node, needle, depth, sessions, collapsedParents, searching, onToggleParent, onSelect }: {
  node: TaskNode
  needle: string
  depth: number
  sessions: Session[]
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
      {task.outstandingResult && <p className="text-sm" data-testid="task-result-badge"
        data-state={task.outstandingResult.accepted ? 'accepted' : task.outstandingResult.needsReevaluation ? 'flagged' : 'submitted'}>
        {task.outstandingResult.accepted ? 'Result accepted' : task.outstandingResult.needsReevaluation ? 'Result needs re-evaluation' : 'Result submitted'}
      </p>}
    </article>
    {!collapsed && children.map(child => <TaskRow key={child.task.id} node={child} needle={needle} depth={depth + 1}
      sessions={sessions} collapsedParents={collapsedParents} searching={searching} onToggleParent={onToggleParent} onSelect={onSelect} />)}
  </>
}
