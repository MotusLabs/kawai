// One task in full (team-tasks 7.2, task-assignment 5.4): current direction
// and acceptance with the revision history behind it, the append-only
// journal, subtasks, and the task's messages, plus the human's controls —
// amend (a new revision), add a note, and set any status including
// reopening. The human may do all of this whoever created the task, even a
// killed agent. Controls disable while disconnected.
// Assignment (task-assignment): the outstanding assignment with its target,
// role, state, and claimed agent, the assignment history, and **Assign /
// send task** — dispatching over an outstanding assignment first makes the
// human choose **notify** or **stop** (the dialog shows what stands).
// Its Messages section (team-message-threads D7) is the same rows the
// Messages view draws — named participants, killed ones marked `(gone)` —
// with a link into that message's thread. Task *participants* below keep the
// older label, per the design's directory scope note.
import { useEffect, useState } from 'react'
import type { Session, SendClientMessage } from '@shared/types'
import { TASK_STATUSES, type TaskStatus } from '@shared/teamTasks'
import { useTeamTaskStore, type TaskAction, type TaskView } from '../../stores/teamTaskStore'
import MessageRow from './MessageRow'
import { TaskPreviewView, TaskTargetSelect, type AssignTargetKind } from './taskAssignFields'
import { useTeamGroups } from './useTeamGroups'
import { assignmentLabel } from './TeamTasksPanel'
import { actorLabel, journalAuthorLabel, sessionLabel } from './teamTaskLabels'

interface DetailAssignForm {
  kind: AssignTargetKind
  id: string
  instruction: string
  /** Armed when the first dispatch is sent; reused by every retry of it. */
  requestKey: string | null
  /** The payload the key was armed for; an edit re-keys the retry. */
  sent?: string
  preview: boolean
}

const emptyAssignForm = (): DetailAssignForm => ({ kind: '', id: '', instruction: '', requestKey: null, preview: false })

export default function TeamTaskDetail({ sessionId, projectPath, view, sendMessage, connected, sessions, onOpenThread, onOpenSession }: {
  sessionId: string; projectPath: string; view: TaskView; sendMessage: SendClientMessage; connected: boolean; sessions: Session[]
  /** Open this message's thread in the Messages view; omitted = no link. */
  onOpenThread?: (threadId: string) => void
  /** Open a message participant's chat; omitted = names only. */
  onOpenSession?: (sessionId: string) => void
}) {
  const detail = view.detail
  const task = detail?.task
  const { groups } = useTeamGroups(connected, projectPath)
  const [direction, setDirection] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [note, setNote] = useState('')
  const [form, setForm] = useState<DetailAssignForm>(emptyAssignForm)
  const [choice, setChoice] = useState<'notify' | 'stop'>('notify')
  const [choosing, setChoosing] = useState(false)
  // A new revision (ours or anyone's) resets the amend form to it.
  useEffect(() => {
    setDirection(task?.direction ?? '')
    setAcceptance(task?.acceptance ?? '')
  }, [task?.id, task?.revision, task?.direction, task?.acceptance])
  const back = () => useTeamTaskStore.getState().select(sessionId, null)
  if (!detail || !task) {
    return <div><button className="btn mb-3" onClick={back}>All tasks</button><p role="status">Loading task…</p></div>
  }
  const disabled = !connected || Object.keys(view.pending).length > 0
  const act = (action: TaskAction, message: Record<string, unknown>) => {
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().begin(sessionId, requestId, action)
    sendMessage({ sessionId, requestId, taskId: task.id, ...message } as Parameters<SendClientMessage>[0])
  }
  const closed = task.status === 'done' || task.status === 'cancelled'
  const statusLabel = (status: TaskStatus) => (status === 'open' && closed ? 'Reopen' : `Mark ${status}`)
  const amended = direction.trim() !== task.direction || acceptance.trim() !== (task.acceptance ?? '')
  const outstanding = task.assignment
  const outstandingLabel = (row: NonNullable<typeof outstanding>) =>
    `${row.targetKind === 'group' ? `group ${row.targetId}` : sessionLabel(row.targetId, sessions)} · ${row.state}` +
    (row.claimedBy ? ` · claimed by ${sessionLabel(row.claimedBy, sessions)}` : '')

  const previewAssign = () => {
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().beginPreview(sessionId, requestId)
    setForm(current => ({ ...current, preview: true }))
    sendMessage({
      type: 'team-task-preview', sessionId, requestId, taskId: task.id,
      target: { kind: form.kind as 'group' | 'session', id: form.id },
    })
  }
  /** Dispatch: over an outstanding assignment the choice is explicit (D7). */
  const sendAssign = (handling?: 'notify' | 'stop') => {
    if (form.kind === '' || !form.id) return
    const payload = `${form.kind}:${form.id}:${form.instruction}`
    // Reuse the key while the form still asks for the same dispatch; an edit
    // is a new intent (the refused one wrote nothing, so re-keying is safe).
    const requestKey = form.requestKey && form.sent === payload ? form.requestKey : crypto.randomUUID()
    setForm(current => ({ ...current, requestKey, sent: payload }))
    act('assign', {
      type: 'team-task-assign', requestKey,
      target: { kind: form.kind, id: form.id }, instruction: form.instruction,
      ...(handling ? { handling } : {}),
    })
  }
  const assignDisabled = !connected || disabled || form.kind === '' || !form.id || !form.instruction.trim()

  return <div data-testid="task-detail" data-task-id={task.id}>
    <button className="btn mb-3" onClick={back}>All tasks</button>
    <h4 className="font-medium">{task.title}</h4>
    <p className="text-chat-meta text-secondary"><span data-testid="task-detail-status">{task.status}</span> · revision {task.revision} · created by <span data-testid="task-creator">{actorLabel(task.creator, sessions)}</span></p>
    {task.parentId && <p className="text-chat-meta">Subtask of <button className="hover:underline" onClick={() => useTeamTaskStore.getState().select(sessionId, task.parentId)}>
      {view.tasks.find(row => row.id === task.parentId)?.title ?? task.parentId}</button></p>}
    {task.worktree && <p className="break-all text-chat-meta">Worktree: {task.worktree}</p>}
    {task.openspecChange && <p className="text-chat-meta">Linked OpenSpec change <code>{task.openspecChange}</code> — its proposal, design, and tasks are the authoritative direction.</p>}

    <section aria-label="Assignment" className="mt-3" data-testid="task-assignment-section">
      <h5 className="font-medium">Assignment</h5>
      {outstanding
        ? <p className="text-chat-meta" data-testid="task-outstanding-assignment">
            Outstanding: {outstandingLabel(outstanding)} · role {outstanding.role ?? 'none'}
          </p>
        : <p className="text-chat-meta text-secondary" data-testid="task-outstanding-assignment">Unassigned</p>}
      {!choosing ? <>
        <div className="mt-2 flex flex-col gap-2" data-testid="task-assign-form">
          <TaskTargetSelect testId="task-detail-target" kind={form.kind} id={form.id}
            onKind={kind => setForm(current => ({ ...current, kind, id: '' }))} onId={id => setForm(current => ({ ...current, id }))}
            groups={groups} sessions={sessions.filter(session => session.kind === 'chat')} disabled={!connected} />
          <textarea className="input min-h-12 text-chat-body" aria-label="Assignment instruction" placeholder="Instruction"
            value={form.instruction} disabled={!connected} onChange={event => setForm(current => ({ ...current, instruction: event.target.value }))} />
          <p className="text-chat-meta text-secondary">Group dispatch selects one eligible member of the group.</p>
          <div className="flex gap-2">
            <button type="button" className="btn text-chat-meta" disabled={assignDisabled || Object.keys(view.previewPending).length > 0}
              onClick={previewAssign} data-testid="task-detail-preview-button">Preview</button>
            <button type="button" className="btn btn-primary" disabled={assignDisabled}
              onClick={() => (outstanding ? setChoosing(true) : sendAssign())} data-testid="task-assign-send">Assign / send task</button>
            {form.requestKey && view.error && !outstanding && <button type="button" className="btn text-chat-meta" disabled={assignDisabled}
              onClick={() => sendAssign()} data-testid="task-retry-assign">Retry assignment</button>}
          </div>
        </div>
        {form.preview && view.preview && <TaskPreviewView preview={view.preview} />}
      </> : <div className="mt-2 border border-border p-2" data-testid="task-reassign-choice">
        <p className="text-chat-meta">This task already has an outstanding assignment: {outstanding ? outstandingLabel(outstanding) : ''}.</p>
        <p className="text-chat-meta text-secondary">Choose how to handle it — neither choice kills or archives anyone.</p>
        <label className="mt-1 block text-chat-meta"><input type="radio" checked={choice === 'notify'} onChange={() => setChoice('notify')} />
          Notify — send the previous assignee a note; their delivered work is untouched</label>
        <label className="block text-chat-meta"><input type="radio" checked={choice === 'stop'} onChange={() => setChoice('stop')} />
          Stop — also cancel the instruction while it is still queued</label>
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => { setChoosing(false); sendAssign(choice) }}
            data-testid="task-reassign-confirm">Reassign ({choice})</button>
          <button type="button" className="btn" onClick={() => setChoosing(false)}>Cancel</button>
        </div>
      </div>}
      {detail.assignments.length > 0 && <details className="mt-2 text-chat-meta" data-testid="task-assignment-history">
        <summary>Assignment history ({detail.assignments.length})</summary>
        {detail.assignments.map(row => <p key={row.id} data-assignment-id={row.id} className="mt-1 border-l-2 border-border pl-2">
          {new Date(row.createdAt).toLocaleString()} · {row.targetKind === 'group' ? `group ${row.targetId}` : sessionLabel(row.targetId, sessions)} · {row.state}
          {row.claimedBy ? ` · claimed by ${sessionLabel(row.claimedBy, sessions)}` : ''}
          {row.reason ? ` · ${row.reason}` : ''}
        </p>)}
      </details>}
    </section>

    <section aria-label="Direction" className="mt-3">
      <h5 className="font-medium">Direction</h5>
      <p className="whitespace-pre-wrap text-chat-body" data-testid="task-direction">{task.direction}</p>
      {task.acceptance && <><h5 className="mt-2 font-medium">Acceptance criteria</h5>
        <p className="whitespace-pre-wrap text-chat-body" data-testid="task-acceptance">{task.acceptance}</p></>}
      <details className="mt-2 text-chat-meta" data-testid="task-revisions"><summary>Revision history ({detail.revisions.length})</summary>
        {detail.revisions.map(revision => <div key={revision.revision} data-revision={revision.revision} className="mt-2 border-l-2 border-border pl-2">
          <p className="text-secondary">Revision {revision.revision} · {actorLabel(revision.author, sessions)} · {new Date(revision.createdAt).toLocaleString()}</p>
          <p className="whitespace-pre-wrap">{revision.direction}</p>
          {revision.acceptance && <p className="whitespace-pre-wrap text-secondary">Acceptance: {revision.acceptance}</p>}
        </div>)}
      </details>
      <form className="mt-2 flex flex-col gap-2" data-testid="task-amend" onSubmit={event => {
        event.preventDefault()
        act('amend', { type: 'team-task-amend', direction: direction.trim(), acceptance: acceptance.trim() })
      }}>
        <textarea className="input min-h-16 text-chat-body" aria-label="Amend direction" value={direction} disabled={!connected} onChange={event => setDirection(event.target.value)} />
        <textarea className="input min-h-12 text-chat-body" aria-label="Amend acceptance criteria" value={acceptance} disabled={!connected} onChange={event => setAcceptance(event.target.value)} />
        <button className="btn self-start" disabled={disabled || !amended || !direction.trim()}>Save as revision {task.revision + 1}</button>
      </form>
    </section>

    <section aria-label="Status" className="mt-3 flex flex-wrap gap-2">
      {TASK_STATUSES.filter(status => status !== task.status).map(status =>
        <button key={status} className="btn text-chat-meta" disabled={disabled} onClick={() => act('status', { type: 'team-task-status', status })}>{statusLabel(status)}</button>)}
    </section>

    <section aria-label="Journal" className="mt-3">
      <h5 className="font-medium">Journal</h5>
      {detail.journal.length === 0 && <p className="text-chat-meta text-secondary">No notes yet</p>}
      {detail.journal.map(entry => <article key={entry.id} className="mt-2 border-l-2 border-border pl-2">
        <p className="text-chat-meta text-secondary">{journalAuthorLabel(entry.author, sessions)} · {new Date(entry.createdAt).toLocaleString()}</p>
        <p className="whitespace-pre-wrap text-chat-body">{entry.text}</p>
      </article>)}
      <form className="mt-2 flex gap-2" onSubmit={event => {
        event.preventDefault()
        act('note', { type: 'team-task-note', text: note.trim() })
        setNote('')
      }}>
        <input className="input flex-1 text-chat-body" aria-label="Journal note" placeholder="Add a note" value={note} disabled={!connected} onChange={event => setNote(event.target.value)} />
        <button className="btn" disabled={disabled || !note.trim()}>Add note</button>
      </form>
    </section>

    <section aria-label="Subtasks" className="mt-3">
      <h5 className="font-medium">Subtasks</h5>
      {detail.subtasks.length === 0 && <p className="text-chat-meta text-secondary">No subtasks</p>}
      {detail.subtasks.map(child => <p key={child.id} className="text-chat-meta">
        <button className="hover:underline" onClick={() => useTeamTaskStore.getState().select(sessionId, child.id)}>{child.title}</button> · {child.status} · {assignmentLabel(child.assignment, sessions)}
      </p>)}
    </section>

    <section aria-label="Messages" className="mt-3">
      <h5 className="font-medium">Messages</h5>
      {detail.messages.length === 0 && <p className="text-chat-meta text-secondary">No messages</p>}
      {detail.messages.map(message => <article key={message.id} data-message-id={message.id} data-testid="message-row" className="mt-2 border border-border p-2">
        <MessageRow row={message} sessions={sessions} names={view.directory} onOpenSession={onOpenSession} />
        {onOpenThread && <button className="btn mt-1 text-chat-meta" data-testid="message-open-thread"
          onClick={() => onOpenThread(message.threadId)}>Open thread</button>}
      </article>)}
    </section>

    <p className="mt-3 text-chat-meta text-secondary">Participants: {task.participants.length > 0 ? task.participants.map(id => sessionLabel(id, sessions)).join(', ') : 'none yet'}</p>
  </div>
}
