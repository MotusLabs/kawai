// The Messages view (team-message-threads 5.2): one filterable, paged list of
// the team's delivered and pending mail, and a thread detail that shows each
// message's reply relation, current recipient, the task revision it carried
// at delivery, and its append-only history. Host-agnostic — it drives the wire
// protocol itself and reads the store the host feeds — so the chat side panel
// and the task embed can both mount it. The composer is a separate concern.
import { useEffect, useRef } from 'react'
import type { MessageQueryFilters, MessageState, SessionDirectoryEntry, TeamMessage, ThreadEntry } from '@shared/team'
import type { SendClientMessage } from '@shared/types'
import type { LiveParticipant } from '@shared/participants'
import ParticipantName from './ParticipantName'
import { useTeamMessageStore, type MessageView } from '../../stores/teamMessageStore'

/** Delivery states a list can be narrowed to; absent keeps everything. */
const STATES: MessageState[] = [
  'queued', 'claimed', 'spawning', 'awaiting-request', 'delivered',
  'dead', 'uncertain', 'cancelled', 'discarded', 'parked', 'forwarded',
]

export default function TeamMessagesView({ sessionId, view, sendMessage, connected, connectionEpoch = 0, sessions = [], directory = [], onOpenSession, onClose }: {
  sessionId: string
  view: MessageView
  sendMessage: SendClientMessage
  connected: boolean
  /** Bumped by the host on reconnect; re-opens the subscription. */
  connectionEpoch?: number
  sessions?: ReadonlyArray<LiveParticipant>
  /** Filled by the snapshot; pass it only when rendering rows without one. */
  directory?: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
  /** Omitted by hosts (a task embed) that own no close control. */
  onClose?: () => void
}) {
  // A host's callback may be a fresh closure every render; the subscription
  // must depend only on what it is actually over, never on that identity.
  const send = useRef(sendMessage)
  send.current = sendMessage
  // The snapshot echoes its filters back as a fresh object, so identity would
  // re-open the subscription forever; the serialized form is the real key.
  const filtersKey = JSON.stringify(view.filters)
  useEffect(() => {
    if (!connected || !view.open) return
    const filters = JSON.parse(filtersKey) as MessageQueryFilters
    send.current({ type: 'team-messages-open', sessionId, filters })
    return () => send.current({ type: 'team-messages-close', sessionId })
  }, [sessionId, connected, connectionEpoch, view.open, filtersKey])
  const threadId = view.selectedThreadId
  useEffect(() => {
    if (!connected || !view.open || !threadId) return
    send.current({ type: 'team-thread-open', sessionId, threadId })
    return () => send.current({ type: 'team-thread-close', sessionId, threadId })
  }, [sessionId, connected, connectionEpoch, view.open, threadId])

  const store = useTeamMessageStore.getState()
  /** Only the keys the controls own; a host's base filters (a task) survive. */
  const filter = (patch: Partial<MessageQueryFilters>) =>
    store.setFilters(sessionId, { ...view.filters, ...patch })
  const loadMore = () => {
    if (!view.nextCursor) return
    store.beginMore(sessionId)
    send.current({ type: 'team-messages-open', sessionId, filters: view.filters, cursor: view.nextCursor })
  }
  const names = view.directory.length > 0 ? view.directory : directory

  return <aside data-testid="team-messages" className="flex min-h-0 w-full flex-col border-l border-border md:w-[28rem]">
    <header className="flex items-center justify-between border-b border-border p-3">
      <h3>Team messages</h3>
      {onClose && <button className="btn" onClick={onClose}>Close messages</button>}
    </header>
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update messages.</p>}
    {view.loading && <p role="status" className="p-3">Loading messages…</p>}
    {view.error && <p role="alert" className="border-b border-border p-3 text-chat-meta text-chat-danger">{view.error}</p>}

    <div className="flex flex-wrap gap-2 border-b border-border p-3 text-chat-meta">
      <select className="input text-chat-body" aria-label="Filter by delivery state"
        value={typeof view.filters.state === 'string' ? view.filters.state : ''}
        onChange={event => filter({ state: event.target.value ? event.target.value as MessageState : undefined })}>
        <option value="">Any delivery state</option>
        {STATES.map(state => <option key={state} value={state}>{state}</option>)}
      </select>
      <select className="input text-chat-body" aria-label="Filter by priority"
        value={view.filters.priority ?? ''}
        onChange={event => filter({ priority: event.target.value ? event.target.value as 'normal' | 'urgent' : undefined })}>
        <option value="">Any priority</option>
        <option value="normal">normal</option>
        <option value="urgent">urgent</option>
      </select>
      <select className="input text-chat-body" aria-label="Filter by human involvement"
        value={view.filters.human === undefined ? '' : String(view.filters.human)}
        onChange={event => filter({ human: event.target.value === '' ? undefined : event.target.value === 'true' })}>
        <option value="">Agents and the human</option>
        <option value="true">To or from the human</option>
        <option value="false">Agent to agent</option>
      </select>
    </div>

    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {view.selectedThreadId ? (
        <ThreadDetail sessionId={sessionId} view={view} sessions={sessions} names={names} onOpenSession={onOpenSession} />
      ) : <>
        {view.messages.length === 0 && !view.loading && <p className="text-chat-meta text-secondary">No messages</p>}
        {view.messages.map(row => <article key={row.id} data-message-id={row.id} data-testid="message-row" className="mb-2 border border-border p-2">
          <MessageRow row={row} sessions={sessions} names={names} onOpenSession={onOpenSession} />
          <button className="btn mt-1 text-chat-meta" data-testid="message-open-thread"
            onClick={() => useTeamMessageStore.getState().select(sessionId, row.threadId)}>Open thread</button>
        </article>)}
        {view.nextCursor && <button className="btn" data-testid="messages-load-more" disabled={!connected || view.loadingMore}
          onClick={loadMore}>{view.loadingMore ? 'Loading more…' : 'Load more'}</button>}
      </>}
    </div>
  </aside>
}

/** Sender → current recipient, delivery-state and priority badges, body. */
function MessageRow({ row, sessions, names, onOpenSession }: {
  row: TeamMessage
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
}) {
  return <>
    <p className="text-chat-meta text-secondary">
      <ParticipantName sessionId={row.fromSession} senderKind={row.fromKind} sessions={sessions} directory={names} onOpen={onOpenSession} />
      {' → '}
      <Recipient row={row} sessions={sessions} names={names} onOpenSession={onOpenSession} />
    </p>
    <p className="text-chat-meta text-secondary">
      <span data-testid="message-state">{row.state}</span>
      {' · '}
      <span data-testid="message-priority">{row.priority}</span>
      {' · '}
      <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
      {row.possibleDuplicate && <span data-testid="message-possible-duplicate"> · possible duplicate</span>}
    </p>
    <p className="whitespace-pre-wrap text-chat-body" data-testid="message-body">{row.body}</p>
    {row.taskRevision !== null && <p className="text-chat-meta text-secondary" data-testid="message-task-revision">
      Task revision {row.taskRevision}
    </p>}
    {row.reason && <p className="text-chat-meta text-secondary" data-testid="message-reason">{row.reason}</p>}
  </>
}

/** Where the row goes now — a group, a named session, or the human. */
function Recipient({ row, sessions, names, onOpenSession }: {
  row: TeamMessage
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
}) {
  if (row.toKind === 'human') return <span data-testid="message-to">Human</span>
  if (row.toKind === 'group') return <span data-testid="message-to">group {row.toId}</span>
  return <span data-testid="message-to">
    <ParticipantName sessionId={row.toId} sessions={sessions} directory={names} onOpen={onOpenSession} />
  </span>
}

/**
 * One thread oldest first: each message's reply relation and history, and the
 * task revision its delivery carried. Re-sent whole when the thread moves, so
 * this is always the complete history, never a delta.
 */
function ThreadDetail({ sessionId, view, sessions, names, onOpenSession }: {
  sessionId: string
  view: MessageView
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
}) {
  const entries = view.thread ?? []
  const bodyOf = (id: string) => entries.find(entry => entry.message.id === id)?.message.body
  return <div data-testid="thread-detail" data-thread-id={view.selectedThreadId}>
    <button className="btn mb-3" data-testid="thread-back"
      onClick={() => useTeamMessageStore.getState().select(sessionId, null)}>All messages</button>
    {view.thread === null && <p role="status">Loading thread…</p>}
    {entries.map(entry => <ThreadRow key={entry.message.id} entry={entry}
      replyTo={entry.message.inReplyTo ? bodyOf(entry.message.inReplyTo) : undefined}
      sessions={sessions} names={names} onOpenSession={onOpenSession} />)}
  </div>
}

function ThreadRow({ entry, replyTo, sessions, names, onOpenSession }: {
  entry: ThreadEntry
  replyTo?: string
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
}) {
  const row = entry.message
  return <article data-message-id={row.id} data-testid="thread-entry" data-hop={row.hop} className="mb-3 border-l-2 border-border pl-2">
    <MessageRow row={row} sessions={sessions} names={names} onOpenSession={onOpenSession} />
    {row.inReplyTo && <p className="text-chat-meta" data-testid="message-reply-to">
      In reply to {replyTo ?? row.inReplyTo}
    </p>}
    <details className="mt-1 text-chat-meta" data-testid="message-events">
      <summary>History ({entry.events.length})</summary>
      {entry.events.map(event => <div key={event.seq} data-seq={event.seq} data-kind={event.kind} className="mt-1 border-l-2 border-border pl-2">
        <p className="text-secondary">
          {event.kind} · {event.actor} · {new Date(event.createdAt).toLocaleString()}
          {event.prevState ? ` · was ${event.prevState}` : ''}
          {event.prevClaimedBy ? ` · claimed by ${event.prevClaimedBy}` : ''}
        </p>
        {event.reason && <p className="text-secondary">{event.reason}</p>}
        {event.prevReason && <p className="text-secondary">was: {event.prevReason}</p>}
      </div>)}
    </details>
  </article>
}
