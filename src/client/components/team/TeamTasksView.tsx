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
import type { SendClientMessage } from '@shared/types'
import { filterTeamTaskRows, type TeamTaskRow } from '@shared/teamWorkspace'
import { useSessionStore } from '../../stores/sessionStore'
import { useTeamTaskStore, type TaskCreatePayload, type TaskView } from '../../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import TeamTaskDetail from './TeamTaskDetail'
import SearchablePicker from './SearchablePicker'
import { TaskPreviewView, TaskTargetSelect } from './taskAssignFields'
import { useTeamGroups } from '../chat/useTeamGroups'
import { openParticipantChat } from '../chat/openParticipant'
import TaskListFilters, { queryFromFilters } from './TaskListFilters'
import { TaskRow, buildTaskTree, filterTree } from './TaskTree'
import { usePlanTargetsRefresh } from './usePlanTargetsRefresh'

export default function TeamTasksView({ teamPath, projectPath, view, rows, sendMessage, connected, connectionEpoch = 0, onSelectedTask, onOpenThread, onCreateWorktree, onOpenMailbox, onOpenSession }: {
  teamPath: string
  projectPath: string
  view: TaskView
  /** The workspace read model's task rows (stage, accountable, wait); absent until its snapshot. */
  rows?: readonly TeamTaskRow[]
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
  // Filters apply to the read model's rows (stage, group, worktree, who must
  // act); closed tasks leave the default list but stay searchable (spec). A
  // task the read model has not described yet is kept rather than hidden.
  const filters = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.tasks.filters) ?? NO_FILTERS
  const rowsById = useMemo(() => new Map((rows ?? []).map(row => [row.id, row])), [rows])
  const visibleTasks = useMemo(() => {
    const query = queryFromFilters(filters)
    // The closed-task default needs no read model: done/cancelled rows stay
    // out unless a search is active or the Status filter names them.
    const hiddenClosed = (task: { status: string }) =>
      (task.status === 'done' || task.status === 'cancelled') && !searching && query.status !== task.status
    if (!rows) return view.tasks.filter(task => !hiddenClosed(task))
    const keep = new Set(filterTeamTaskRows([...rows], { ...query, ...(searching ? { includeClosed: true } : {}) }).map(row => row.id))
    return view.tasks.filter(task => keep.has(task.id) || (!rowsById.has(task.id) && !hiddenClosed(task)))
  }, [view.tasks, rows, rowsById, filters, searching])
  const tree = useMemo(() => filterTree(buildTaskTree(visibleTasks), search.trim()), [visibleTasks, search])

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
        {rows && <TaskListFilters teamPath={teamPath} rows={rows} filters={filters} />}
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
        {tree.length === 0 && view.tasks.length > 0 && <p className="text-sm text-secondary" data-testid="task-no-matches">
          {searching ? 'No tasks match the search' : 'No tasks match the filters'}
        </p>}
        {tree.map(node => <TaskRow key={node.task.id} node={node} needle={search.trim()} depth={0}
          sessions={sessions} rows={rowsById} collapsedParents={collapsedSet} searching={searching} onToggleParent={toggleParent} onSelect={select} />)}
      </div>
    </>}
  </div>
}

/** Stable empty list so absent view state never re-renders (getSnapshot caching). */
const NONE_COLLAPSED: string[] = []
const NO_FILTERS: Record<string, string | boolean> = {}
