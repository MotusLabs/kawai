// The team's tasks beside a chat (team-tasks 7.1, task-assignment 5.2): a
// list with title, status, creator, participants, and the assignment target
// and state (or Unassigned), plus the New task form — searchable worktree
// and OpenSpec-change pickers, an optional assignment section (group or
// session plus the initial instruction; group dispatch selects one eligible
// member), an on-demand dispatch preview, and **Create task** /
// **Create and assign** armed with one stable client request key. The form
// draft and the key live in the store, so a refusal keeps every field and
// **Retry assignment** reuses the existing task. Rows come from
// authoritative server snapshots; actions disable while disconnected and
// refusals show inline.
import { useEffect, useRef } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { TeamTaskAssignment } from '@shared/teamTasks'
import { useSessionStore } from '../../stores/sessionStore'
import { useTeamTaskStore, type TaskCreatePayload, type TaskView } from '../../stores/teamTaskStore'
import TeamTaskDetail from './TeamTaskDetail'
import SearchablePicker from './SearchablePicker'
import { TaskPreviewView, TaskTargetSelect } from './taskAssignFields'
import { useTeamGroups } from './useTeamGroups'
import { openParticipantChat } from './openParticipant'
import { actorLabel, sessionLabel } from './teamTaskLabels'

export default function TeamTasksPanel({ sessionId, projectPath, view, sendMessage, connected, onClose, onOpenThread, onCreateWorktree }: {
  sessionId: string; projectPath: string; view: TaskView; sendMessage: SendClientMessage; connected: boolean; onClose: () => void
  /** Handed to a task's messages: open that message's thread (5.4). */
  onOpenThread?: (threadId: string) => void
  /** Opens the existing worktree-creation flow; the pickers refresh on return. */
  onCreateWorktree?: () => void
}) {
  const sessions = useSessionStore(state => state.sessions)
  const { groups } = useTeamGroups(connected, projectPath)
  const draft = view.draft
  const flow = view.flow
  const busy = Object.keys(view.pending).length > 0
  const setDraft = (patch: Partial<typeof draft>) => useTeamTaskStore.getState().setDraft(sessionId, patch)
  // The change list narrows to the roots the server validates for the chosen
  // worktree, so every request carries the draft's current worktree and the
  // panel re-requests whenever it moves.
  const requestTargets = () => {
    const worktree = useTeamTaskStore.getState().views[sessionId]?.draft.worktree.trim()
    useTeamTaskStore.getState().beginTargets(sessionId)
    sendMessage({ type: 'team-task-targets', sessionId, requestId: crypto.randomUUID(), ...(worktree ? { worktree } : {}) })
  }
  // StrictMode fires an effect twice on mount with identical deps; the
  // per-signature ref keeps the request single. A disconnect clears the
  // signature so a reconnect refreshes the pickers' data once (the pickers
  // also re-request on focus, on demand).
  const requestedTargets = useRef('')
  useEffect(() => {
    if (!connected) { requestedTargets.current = ''; return }
    const signature = `${sessionId}\0${draft.worktree}`
    if (requestedTargets.current === signature) return
    requestedTargets.current = signature
    requestTargets()
  }, [connected, sessionId, draft.worktree]) // eslint-disable-line react-hooks/exhaustive-deps
  // A reconnect drops the waiters for results lost with the connection: the
  // armed flow keeps its key, the dispatch effect re-sends the assign leg
  // under it, and a human resubmit of the create reuses it — either way the
  // server replays instead of duplicating (spec: reconnect resubmission).
  const wasConnected = useRef(connected)
  useEffect(() => {
    if (wasConnected.current === false && connected) useTeamTaskStore.getState().reconnected(sessionId)
    wasConnected.current = connected
  }, [connected, sessionId])
  const preview = () => {
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().beginPreview(sessionId, requestId)
    sendMessage({
      type: 'team-task-preview', sessionId, requestId,
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
    }
    const changed = flow?.sentCreatePayload &&
      JSON.stringify(flow.sentCreatePayload) !== JSON.stringify(payload)
    if (!flow || flow.mode !== mode || flow.taskId || changed) {
      useTeamTaskStore.getState().armFlow(sessionId, mode)
    }
    const armed = useTeamTaskStore.getState().views[sessionId]!.flow!
    useTeamTaskStore.getState().flowSendCreate(sessionId, payload)
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().begin(sessionId, requestId, assign ? 'create-assign' : 'create')
    sendMessage({
      type: 'team-task-create', sessionId, requestId, requestKey: armed.requestKey,
      title: draft.title.trim(), direction: draft.direction.trim(),
      ...(draft.acceptance.trim() ? { acceptance: draft.acceptance.trim() } : {}),
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      ...(draft.worktree.trim() ? { worktree: draft.worktree.trim() } : {}),
      ...(draft.openspecChange.trim() ? { openspecChange: draft.openspecChange.trim() } : {}),
    })
  }
  // The dispatch leg of an armed create-and-assign flow: sent as soon as the
  // create leg committed (and re-sent after a reconnect or a cleared retry
  // under the same key, so the server replays instead of duplicating).
  useEffect(() => {
    if (!flow || flow.mode !== 'create-and-assign' || !flow.taskId || flow.assignFailed || busy) return
    const payload = { kind: draft.targetKind as 'group' | 'session', id: draft.targetId }
    useTeamTaskStore.getState().flowSendAssign(sessionId, { targetKind: payload.kind, targetId: payload.id, instruction: draft.instruction })
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().begin(sessionId, requestId, 'assign')
    sendMessage({
      type: 'team-task-assign', sessionId, requestId, taskId: flow.taskId, requestKey: flow.requestKey,
      target: payload, instruction: draft.instruction,
    })
  }, [flow?.taskId, flow?.assignFailed, busy]) // eslint-disable-line react-hooks/exhaustive-deps
  const retryAssign = () => {
    if (!flow?.taskId) return
    useTeamTaskStore.getState().retryAssign(sessionId)
  }
  const targetReady = draft.targetKind !== '' && draft.targetId !== ''
  const createCommitted = flow?.taskId != null
  return <aside data-testid="team-tasks" className="flex min-h-0 w-full flex-col border-l border-border md:w-[28rem]">
    <header className="flex items-center justify-between border-b border-border p-3"><h3>Team tasks</h3>
      <button className="btn" onClick={onClose}>Close tasks</button></header>
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update tasks.</p>}
    {view.loading && <p role="status" className="p-3">Loading tasks…</p>}
    {view.error && <p role="alert" className="border-b border-border p-3 text-chat-meta text-chat-danger">{view.error}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {view.selectedTaskId ? (
        <TeamTaskDetail sessionId={sessionId} projectPath={projectPath} view={view} sendMessage={sendMessage} connected={connected} sessions={sessions}
          onOpenThread={onOpenThread} onOpenSession={openParticipantChat} />
      ) : <>
        <details className="mb-4 border border-border p-2" data-testid="task-create">
          <summary className="cursor-pointer font-medium">New task</summary>
          <form className="mt-2 flex flex-col gap-2" onSubmit={event => { event.preventDefault(); create(draft.targetKind !== '' && draft.instruction.trim() !== '') }}>
            <input className="input text-chat-body" aria-label="Task title" placeholder="Title" value={draft.title}
              disabled={!connected} onChange={event => setDraft({ title: event.target.value })} />
            <textarea className="input min-h-16 text-chat-body" aria-label="Task direction" placeholder="Direction" value={draft.direction}
              disabled={!connected} onChange={event => setDraft({ direction: event.target.value })} />
            <textarea className="input min-h-12 text-chat-body" aria-label="Acceptance criteria" placeholder="Acceptance criteria (optional)" value={draft.acceptance}
              disabled={!connected} onChange={event => setDraft({ acceptance: event.target.value })} />
            <select className="input text-chat-body" aria-label="Parent task" value={draft.parentId}
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
            <fieldset className="flex flex-col gap-2 border-t border-border pt-2" data-testid="task-assign-section">
              <legend className="text-chat-meta">Assignment (optional)</legend>
              <TaskTargetSelect testId="task-assign-target" kind={draft.targetKind} id={draft.targetId}
                onKind={kind => setDraft({ targetKind: kind })} onId={id => setDraft({ targetId: id })}
                groups={groups} sessions={sessions.filter(session => session.kind === 'chat')} disabled={!connected} />
              <textarea className="input min-h-12 text-chat-body" aria-label="Assignment instruction" placeholder="Initial instruction"
                value={draft.instruction} disabled={!connected}
                onChange={event => setDraft({ instruction: event.target.value })} />
              <p className="text-chat-meta text-secondary">Group dispatch selects one eligible member of the group.</p>
              <button type="button" className="btn self-start text-chat-meta" disabled={!connected || !targetReady || Object.keys(view.previewPending).length > 0}
                onClick={preview} data-testid="task-assign-preview-button">Preview dispatch</button>
              {view.preview && <TaskPreviewView preview={view.preview} />}
            </fieldset>
            {createCommitted && flow?.mode === 'create-and-assign'
              ? <button type="button" className="btn btn-primary self-start" disabled={!connected || busy || !flow.assignFailed || !draft.instruction.trim()}
                onClick={retryAssign} data-testid="task-retry-assign">Retry assignment</button>
              : <>
                <button type="submit" className="btn self-start" disabled={!connected || busy || !draft.title.trim() || !draft.direction.trim()}
                  data-testid="task-create-button">Create task</button>
                <button type="button" className="btn btn-primary self-start" disabled={!connected || busy || !draft.title.trim() || !draft.direction.trim() || !targetReady || !draft.instruction.trim()}
                  onClick={() => create(true)} data-testid="task-create-assign-button">Create and assign</button>
              </>}
          </form>
        </details>
        {view.tasks.length === 0 && !view.loading && <p className="text-chat-meta text-secondary">No tasks yet</p>}
        {view.tasks.map(task => <article key={task.id} data-task-id={task.id} className="mb-2 border border-border p-2">
          <button className="text-left font-medium hover:underline" onClick={() => useTeamTaskStore.getState().select(sessionId, task.id)}>{task.title}</button>
          <p className="text-chat-meta text-secondary">
            <span data-testid="task-status">{task.status}</span> · created by {actorLabel(task.creator, sessions)}
            {task.parentId ? ' · subtask' : ''}
          </p>
          <p className="text-chat-meta text-secondary" data-testid="task-participants">
            Participants: {task.participants.length > 0 ? task.participants.map(id => sessionLabel(id, sessions)).join(', ') : 'none yet'}
          </p>
          <p className="text-chat-meta text-secondary" data-testid="task-assignment">{assignmentLabel(task.assignment, sessions)}</p>
        </article>)}
      </>}
    </div>
  </aside>
}

/** A list row's assignment line: target and state, or Unassigned (5.5). */
export function assignmentLabel(assignment: TeamTaskAssignment | null, sessions: Session[]): string {
  if (!assignment) return 'Unassigned'
  const target = assignment.targetKind === 'group'
    ? `group ${assignment.targetId}`
    : sessionLabel(assignment.targetId, sessions)
  const owner = assignment.claimedBy ? ` (claimed by ${sessionLabel(assignment.claimedBy, sessions)})` : ''
  return `Assigned: ${target} · ${assignment.state}${owner}`
}
