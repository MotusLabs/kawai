// The team's tasks beside a chat (team-tasks 7.1): a list with title,
// status, creator, and participants, and a New task form (optional parent,
// worktree, and linked OpenSpec change). Selecting a task shows its detail.
// Rows come from authoritative server snapshots; actions disable while
// disconnected and refusals show inline.
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import { useSessionStore } from '../../stores/sessionStore'
import { useTeamTaskStore, type TaskView } from '../../stores/teamTaskStore'
import TeamTaskDetail from './TeamTaskDetail'
import { actorLabel, sessionLabel } from './teamTaskLabels'

export default function TeamTasksPanel({ sessionId, view, sendMessage, connected, onClose }: {
  sessionId: string; view: TaskView; sendMessage: SendClientMessage; connected: boolean; onClose: () => void
}) {
  const sessions = useSessionStore(state => state.sessions)
  const [draft, setDraft] = useState({ title: '', direction: '', acceptance: '', parentId: '', worktree: '', openspecChange: '' })
  const busy = Object.keys(view.pending).length > 0
  const create = () => {
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().begin(sessionId, requestId, 'create')
    sendMessage({
      type: 'team-task-create', sessionId, requestId, title: draft.title.trim(), direction: draft.direction.trim(),
      ...(draft.acceptance.trim() ? { acceptance: draft.acceptance.trim() } : {}),
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      ...(draft.worktree.trim() ? { worktree: draft.worktree.trim() } : {}),
      ...(draft.openspecChange.trim() ? { openspecChange: draft.openspecChange.trim() } : {}),
    })
    setDraft({ title: '', direction: '', acceptance: '', parentId: '', worktree: '', openspecChange: '' })
  }
  const field = (key: keyof typeof draft) => ({
    value: draft[key], disabled: !connected,
    onChange: (event: { target: { value: string } }) => setDraft(current => ({ ...current, [key]: event.target.value })),
  })
  return <aside data-testid="team-tasks" className="flex min-h-0 w-full flex-col border-l border-border md:w-[28rem]">
    <header className="flex items-center justify-between border-b border-border p-3"><h3>Team tasks</h3>
      <button className="btn" onClick={onClose}>Close tasks</button></header>
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update tasks.</p>}
    {view.loading && <p role="status" className="p-3">Loading tasks…</p>}
    {view.error && <p role="alert" className="border-b border-border p-3 text-chat-meta text-chat-danger">{view.error}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {view.selectedTaskId ? (
        <TeamTaskDetail sessionId={sessionId} view={view} sendMessage={sendMessage} connected={connected} sessions={sessions} />
      ) : <>
        <details className="mb-4 border border-border p-2" data-testid="task-create">
          <summary className="cursor-pointer font-medium">New task</summary>
          <form className="mt-2 flex flex-col gap-2" onSubmit={event => { event.preventDefault(); create() }}>
            <input className="input text-chat-body" aria-label="Task title" placeholder="Title" {...field('title')} />
            <textarea className="input min-h-16 text-chat-body" aria-label="Task direction" placeholder="Direction" {...field('direction')} />
            <textarea className="input min-h-12 text-chat-body" aria-label="Acceptance criteria" placeholder="Acceptance criteria (optional)" {...field('acceptance')} />
            <select className="input text-chat-body" aria-label="Parent task" {...field('parentId')}>
              <option value="">No parent task</option>
              {view.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select>
            <input className="input text-chat-body" aria-label="Target worktree" placeholder="Target worktree path (optional)" {...field('worktree')} />
            <input className="input text-chat-body" aria-label="Linked OpenSpec change" placeholder="Linked OpenSpec change (optional)" {...field('openspecChange')} />
            <button className="btn btn-primary self-start" disabled={!connected || busy || !draft.title.trim() || !draft.direction.trim()}>Create task</button>
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
        </article>)}
      </>}
    </div>
  </aside>
}
