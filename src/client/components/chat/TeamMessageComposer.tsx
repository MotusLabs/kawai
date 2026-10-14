// The human's composer (team-message-threads 5.3): a new message to one of
// the team's groups or sessions, or a reply in a thread — which is always
// addressed to the message being replied to and inherits its task rather than
// asking again. Priority defaults to normal; choosing urgent is an interrupt,
// and the explanation of what that means is on the control, not in a tooltip.
// Refusals render inline and the whole form disables while disconnected.
import { useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { LiveParticipant } from '@shared/participants'
import type { SessionDirectoryEntry } from '@shared/team'
import { useTeamMessageStore, type MessageView } from '../../stores/teamMessageStore'
import ParticipantName from './ParticipantName'

export interface RecipientOption {
  id: string
  label: string
}

/** A task the new-message composer may attach to. */
export interface TaskOption {
  id: string
  title: string
}

/** What the composer is for: a fresh message, or a reply inside a thread. */
export type ComposerMode =
  | { kind: 'new' }
  | {
    kind: 'reply'
    /** The message being replied to; its sender is the recipient. */
    inReplyTo: string
    fromSession: string | null
    fromKind: 'agent' | 'human'
    /** The task the reply inherits; null = the parent worked under none. */
    taskId: string | null
    taskTitle: string | null
    body: string
  }

export default function TeamMessageComposer({ teamPath, mode, groups = [], sessions = [], directory = [], tasks = [], view, sendMessage, connected }: {
  teamPath: string
  mode: ComposerMode
  groups?: ReadonlyArray<RecipientOption>
  sessions?: ReadonlyArray<LiveParticipant>
  directory?: ReadonlyArray<SessionDirectoryEntry>
  tasks?: ReadonlyArray<TaskOption>
  view: MessageView
  sendMessage: SendClientMessage
  connected: boolean
}) {
  const [body, setBody] = useState('')
  const [to, setTo] = useState('')
  const [taskId, setTaskId] = useState('')
  const [urgent, setUrgent] = useState(false)
  const pending = Object.keys(view.pending).length > 0
  const disabled = !connected || pending || !body.trim()
  const send = () => {
    if (disabled) return
    const requestId = crypto.randomUUID()
    useTeamMessageStore.getState().beginSend(teamPath, requestId)
    sendMessage({
      type: 'team-message-send', teamPath, requestId, body: body.trim(),
      // A reply is addressed to its parent's sender and inherits its task;
      // only a new message names a recipient and a task of its own.
      ...(mode.kind === 'reply' ? { inReplyTo: mode.inReplyTo } : recipient(to)),
      ...(mode.kind === 'new' && taskId ? { taskId } : {}),
      ...(urgent ? { urgent: true } : {}),
    })
    setBody('')
    setUrgent(false)
  }
  return <form data-testid="message-composer" data-mode={mode.kind} className="mt-3 flex flex-col gap-2 border-t border-border pt-3"
    onSubmit={event => { event.preventDefault(); send() }}>
    {mode.kind === 'reply'
      ? <p className="text-chat-meta" data-testid="composer-reply-to">
        {'Reply to '}
        <ParticipantName sessionId={mode.fromSession} senderKind={mode.fromKind} sessions={sessions} directory={directory} />
        {': '}
        <span data-testid="composer-reply-body">{mode.body}</span>
      </p>
      : <select className="input text-chat-body" aria-label="Recipient" value={to} disabled={disabled}
        onChange={event => setTo(event.target.value)}>
        <option value="">Choose a recipient</option>
        {groups.length > 0 && <optgroup label="Groups">
          {groups.map(group => <option key={group.id} value={`group:${group.id}`}>{group.label}</option>)}
        </optgroup>}
        {sessions.length > 0 && <optgroup label="Sessions">
          {sessions.map(session => <option key={session.id} value={`session:${session.id}`}>{session.name}</option>)}
        </optgroup>}
      </select>}
    {mode.kind === 'reply'
      ? <p className="text-chat-meta text-secondary" data-testid="composer-task">
        {mode.taskId
          ? <>Task {mode.taskTitle ?? mode.taskId} — inherited from the message being replied to.</>
          : 'No task — the message being replied to worked under none.'}
      </p>
      : <select className="input text-chat-body" aria-label="Task" value={taskId} disabled={disabled}
        onChange={event => setTaskId(event.target.value)}>
        <option value="">No task</option>
        {tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select>}
    <textarea className="input min-h-16 text-chat-body" aria-label="Message body" placeholder="Message"
      value={body} disabled={disabled} onChange={event => setBody(event.target.value)} />
    <label className="flex items-center gap-2 text-chat-meta">
      <input type="checkbox" aria-label="Urgent" checked={urgent} disabled={disabled}
        onChange={event => setUrgent(event.target.checked)} />
      Urgent
    </label>
    <p className="text-chat-meta text-secondary" data-testid="urgent-explanation">
      Normal mail waits its turn. Urgent mail interrupts a recipient agent’s current turn
      once any pending approval resolves, or goes to the first idle member of a group.
    </p>
    {view.error && <p role="alert" className="text-chat-meta text-chat-danger" data-testid="composer-error">{view.error}</p>}
    <button className="btn btn-primary self-start" disabled={disabled}>
      {pending ? 'Sending…' : mode.kind === 'reply' ? 'Send reply' : 'Send message'}
    </button>
    {!connected && <p role="status" className="text-chat-meta text-secondary">Disconnected — reconnect to send.</p>}
  </form>
}

/** `group:devs` / `session:dev` on the wire as the addressed recipient. */
function recipient(to: string): { to?: { kind: 'group' | 'session'; id: string } } {
  const split = to.indexOf(':')
  const kind = to.slice(0, split)
  const id = to.slice(split + 1)
  if (split < 0 || !id || (kind !== 'group' && kind !== 'session')) return {}
  return { to: { kind, id } }
}
