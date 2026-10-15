// The Messages view (team-message-threads 5.2–5.3, team-workspace-pages
// 5.4): the team's delivered and pending mail grouped by thread — one
// collapsible row per thread showing its newest message and whole-thread
// count (`threadSizes`), expanding in place to the loaded messages — plus a
// thread detail that shows each message's reply relation, current recipient,
// the task revision it carried at delivery, and its append-only history,
// with the human's composer under both. Search runs on the server over the
// whole history (`text`, D7); Expand all / Collapse all act on every loaded
// thread. Host-agnostic — it drives the wire protocol itself and reads the
// stores the host feeds — so the Team page, the chat side panel, and the
// task embed can all mount it.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageEvent, MessageQueryFilters, MessageState, SessionDirectoryEntry, TeamMessage, ThreadEntry } from '@shared/team'
import type { SendClientMessage } from '@shared/types'
import { participantName, resolveParticipant, type LiveParticipant } from '@shared/participants'
import MessageRow from './MessageRow'
import TeamMessageComposer, { type ComposerMode, type RecipientOption } from './TeamMessageComposer'
import { useTeamMessageStore, type MessageView } from '../../stores/teamMessageStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'

/** Delivery states a list can be narrowed to; absent keeps everything. */
const STATES: MessageState[] = [
  'queued', 'claimed', 'spawning', 'awaiting-request', 'delivered',
  'dead', 'uncertain', 'cancelled', 'discarded', 'parked', 'forwarded',
]

/** Search keystrokes debounce this long before the server round-trip. */
const SEARCH_DEBOUNCE_MS = 300

/** Stable empty list so absent view state never re-renders (getSnapshot caching). */
const NONE_EXPANDED: string[] = []

export default function TeamMessagesView({ teamPath, view, sendMessage, connected, connectionEpoch = 0, sessions = [], directory = [], groups = [], onOpenSession, onThreadSelected }: {
  teamPath: string
  view: MessageView
  sendMessage: SendClientMessage
  connected: boolean
  /** Bumped by the host on reconnect; re-opens the subscription. */
  connectionEpoch?: number
  sessions?: ReadonlyArray<LiveParticipant>
  /** Filled by the snapshot; pass it only when rendering rows without one. */
  directory?: ReadonlyArray<SessionDirectoryEntry>
  /** The team's groups, for the composer's recipient picker. */
  groups?: ReadonlyArray<RecipientOption>
  onOpenSession?: (sessionId: string) => void
  /** Reports thread selection to the host (the Team page's URL, D3). */
  onThreadSelected?: (threadId: string | null) => void
}) {
  /** Which thread row the composer replies to; absent = the newest. */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  // A host's callback may be a fresh closure every render; the subscription
  // must depend only on what it is actually over, never on that identity.
  const send = useRef(sendMessage)
  send.current = sendMessage
  const threadReporter = useRef(onThreadSelected)
  threadReporter.current = onThreadSelected
  // The snapshot echoes its filters back as a fresh object, so identity would
  // re-open the subscription forever; the serialized form is the real key.
  const filtersKey = JSON.stringify(view.filters)
  useEffect(() => {
    if (!connected || !view.open) return
    const filters = JSON.parse(filtersKey) as MessageQueryFilters
    send.current({ type: 'team-messages-open', teamPath, filters })
    return () => send.current({ type: 'team-messages-close', teamPath })
  }, [teamPath, connected, connectionEpoch, view.open, filtersKey])
  const threadId = view.selectedThreadId
  useEffect(() => {
    if (!connected || !view.open || !threadId) return
    send.current({ type: 'team-thread-open', teamPath, threadId })
    return () => send.current({ type: 'team-thread-close', teamPath, threadId })
  }, [teamPath, connected, connectionEpoch, view.open, threadId])

  const store = useTeamMessageStore.getState()
  /** Only the keys the controls own; a host's base filters (a task) survive. */
  const filter = (patch: Partial<MessageQueryFilters>) =>
    store.setFilters(teamPath, { ...view.filters, ...patch })
  const loadMore = () => {
    if (!view.nextCursor) return
    store.beginMore(teamPath)
    send.current({ type: 'team-messages-open', teamPath, filters: view.filters, cursor: view.nextCursor })
  }
  const openThread = (target: string) => {
    store.select(teamPath, target)
    threadReporter.current?.(target)
  }
  const closeThread = () => {
    store.select(teamPath, null)
    threadReporter.current?.(null)
  }

  // Search (D7): the box holds the team's kept view state (D8) and the
  // server filter follows it debounced, so typing re-opens the narrowed list
  // once the pause lands rather than per keystroke.
  const search = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.messages.search ?? '')
  const [searchInput, setSearchInput] = useState(search)
  useEffect(() => { setSearchInput(search) }, [teamPath]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const text = search.trim()
    if (text === (useTeamMessageStore.getState().views[teamPath]?.filters.text ?? '')) return
    const timer = setTimeout(() => {
      const filters = { ...useTeamMessageStore.getState().views[teamPath]?.filters }
      if (text) filters.text = text
      else delete filters.text
      useTeamMessageStore.getState().setFilters(teamPath, filters)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search, teamPath])

  // Thread grouping (5.4): one row per thread with its newest loaded message
  // and its whole-thread count; the group order follows the newest message.
  const threads = useMemo(() => {
    const order: string[] = []
    const byThread = new Map<string, TeamMessage[]>()
    for (const row of view.messages) {
      const list = byThread.get(row.threadId)
      if (list) list.push(row)
      else { byThread.set(row.threadId, [row]); order.push(row.threadId) }
    }
    return order.map(id => {
      const rows = byThread.get(id)!
      return { threadId: id, newest: rows[0]!, rows, size: view.threadSizes[id] ?? rows.length }
    })
  }, [view.messages, view.threadSizes])
  const expandedIds = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.messages.expanded) ?? NONE_EXPANDED
  const expanded = useMemo(() => new Set(expandedIds), [expandedIds])
  const workspace = useTeamWorkspaceStore.getState()
  const toggleThread = (threadId: string) => workspace.toggleExpanded(teamPath, 'messages', threadId)

  const names = view.directory.length > 0 ? view.directory : directory
  const entries = view.thread ?? []
  const target = (replyTo ? entries.find(entry => entry.message.id === replyTo)?.message : undefined) ?? entries.at(-1)?.message
  const reply: ComposerMode | undefined = target && {
    kind: 'reply', inReplyTo: target.id, fromSession: target.fromSession, fromKind: target.fromKind,
    taskId: target.taskId, taskTitle: view.tasks.find(task => task.id === target.taskId)?.title ?? null,
    body: target.body,
  }

  return <div data-testid="team-messages" className="flex h-full min-h-0 flex-col">
    {!connected && <p role="status" className="p-3 text-secondary">Disconnected — reconnect to update messages.</p>}
    {view.loading && <p role="status" className="p-3">Loading messages…</p>}
    {view.error && <p role="alert" className="p-3 text-sm text-danger">{view.error}</p>}

    <div className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-sm">
      <input className="input max-w-48 flex-1" type="search" aria-label="Search messages"
        placeholder="Search messages" value={searchInput} disabled={!connected}
        onChange={event => {
          setSearchInput(event.target.value)
          useTeamWorkspaceStore.getState().setSearch(teamPath, 'messages', event.target.value)
        }} />
      <select className="input" aria-label="Filter by delivery state"
        value={typeof view.filters.state === 'string' ? view.filters.state : ''}
        onChange={event => filter({ state: event.target.value ? event.target.value as MessageState : undefined })}>
        <option value="">Any delivery state</option>
        {STATES.map(state => <option key={state} value={state}>{state}</option>)}
      </select>
      <select className="input" aria-label="Filter by priority"
        value={view.filters.priority ?? ''}
        onChange={event => filter({ priority: event.target.value ? event.target.value as 'normal' | 'urgent' : undefined })}>
        <option value="">Any priority</option>
        <option value="normal">normal</option>
        <option value="urgent">urgent</option>
      </select>
      <select className="input" aria-label="Filter by human involvement"
        value={view.filters.human === undefined ? '' : String(view.filters.human)}
        onChange={event => filter({ human: event.target.value === '' ? undefined : event.target.value === 'true' })}>
        <option value="">Agents and the human</option>
        <option value="true">To or from the human</option>
        <option value="false">Agent to agent</option>
      </select>
      <button type="button" className="btn" data-testid="messages-expand-all" disabled={threads.length === 0}
        onClick={() => workspace.setExpanded(teamPath, 'messages', threads.map(thread => thread.threadId))}>Expand all</button>
      <button type="button" className="btn" data-testid="messages-collapse-all" disabled={threads.length === 0}
        onClick={() => workspace.setExpanded(teamPath, 'messages', [])}>Collapse all</button>
    </div>

    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {view.selectedThreadId ? (
        <ThreadDetail teamPath={teamPath} view={view} sessions={sessions} names={names} onOpenSession={onOpenSession}
          onReply={setReplyTo} reply={reply} sendMessage={sendMessage} connected={connected} onBack={closeThread} />
      ) : <>
        {view.messages.length === 0 && !view.loading && <p className="text-sm text-secondary">No messages</p>}
        {threads.map(thread => <ThreadRow key={thread.threadId} thread={thread} expanded={expanded.has(thread.threadId)}
          sessions={sessions} names={names} onOpenSession={onOpenSession}
          onToggle={() => toggleThread(thread.threadId)} onOpenThread={() => openThread(thread.threadId)} />)}
        {view.nextCursor && <button className="btn" data-testid="messages-load-more" disabled={!connected || view.loadingMore}
          onClick={loadMore}>{view.loadingMore ? 'Loading more…' : 'Load more'}</button>}
        <TeamMessageComposer teamPath={teamPath} mode={{ kind: 'new' }} groups={groups} sessions={sessions}
          directory={names} tasks={view.tasks} view={view} sendMessage={sendMessage} connected={connected} />
      </>}
    </div>
  </div>
}

/** One thread's collapsed row: newest message, count, and inline expansion. */
function ThreadRow({ thread, expanded, sessions, names, onOpenSession, onToggle, onOpenThread }: {
  thread: { threadId: string; newest: TeamMessage; rows: TeamMessage[]; size: number }
  expanded: boolean
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
  onToggle: () => void
  onOpenThread: () => void
}) {
  return <article data-testid="thread-row" data-thread-id={thread.threadId} data-size={thread.size}
    className="mb-2 border border-border p-2">
    <div className="flex items-center justify-between gap-2">
      <button type="button" className="btn text-sm" data-testid="thread-toggle" aria-expanded={expanded}
        onClick={onToggle}>{expanded ? 'Collapse thread' : 'Expand thread'}</button>
      <p className="text-sm text-secondary" data-testid="thread-count">
        {thread.size === 1 ? '1 message' : `${thread.size} messages`}
        {thread.size !== thread.rows.length ? ` · ${thread.rows.length} loaded` : ''}
      </p>
    </div>
    {expanded
      ? // Oldest first, the order the messages happened in.
        [...thread.rows].reverse().map(row => <div key={row.id} data-testid="message-row" data-message-id={row.id} className="mt-2 border-t border-border pt-2">
          <MessageRow row={row} sessions={sessions} names={names} onOpenSession={onOpenSession} clamp />
        </div>)
      : <div data-testid="message-row" data-message-id={thread.newest.id} className="mt-2">
        <MessageRow row={thread.newest} sessions={sessions} names={names} onOpenSession={onOpenSession} clamp />
      </div>}
    <button className="btn mt-2 text-sm" data-testid="message-open-thread" onClick={onOpenThread}>Open thread</button>
  </article>
}

/**
 * One thread oldest first: each message's reply relation and history, and the
 * task revision its delivery carried. Re-sent whole when the thread moves, so
 * this is always the complete history, never a delta.
 */
function ThreadDetail({ teamPath, view, sessions, names, onOpenSession, onReply, reply, sendMessage, connected, onBack }: {
  teamPath: string
  view: MessageView
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
  onReply: (messageId: string) => void
  reply: ComposerMode | undefined
  sendMessage: SendClientMessage
  connected: boolean
  onBack: () => void
}) {
  const entries = view.thread ?? []
  const bodyOf = (id: string) => entries.find(entry => entry.message.id === id)?.message.body
  return <div data-testid="thread-detail" data-thread-id={view.selectedThreadId}>
    <button className="btn mb-3" data-testid="thread-back" onClick={onBack}>All messages</button>
    {view.thread === null && <p role="status">Loading thread…</p>}
    {view.thread !== null && entries.length === 0 && <p role="status" data-testid="thread-not-found">Thread not found.</p>}
    {entries.map(entry => <ThreadRowDetail key={entry.message.id} entry={entry} sessions={sessions} names={names} onOpenSession={onOpenSession}
      parentBody={entry.message.inReplyTo ? bodyOf(entry.message.inReplyTo) : undefined} onReply={onReply} />)}
    {reply && <TeamMessageComposer teamPath={teamPath} mode={reply} sessions={sessions} directory={names}
      view={view} sendMessage={sendMessage} connected={connected} />}
  </div>
}

function ThreadRowDetail({ entry, parentBody, sessions, names, onOpenSession, onReply }: {
  entry: ThreadEntry
  parentBody?: string
  sessions: ReadonlyArray<LiveParticipant>
  names: ReadonlyArray<SessionDirectoryEntry>
  onOpenSession?: (sessionId: string) => void
  onReply: (messageId: string) => void
}) {
  const row = entry.message
  return <article data-message-id={row.id} data-testid="thread-entry" data-hop={row.hop} className="mb-3 border-l-2 border-border pl-2">
    <MessageRow row={row} sessions={sessions} names={names} onOpenSession={onOpenSession} />
    {row.inReplyTo && <p className="text-sm text-secondary" data-testid="message-reply-to">
      In reply to {parentBody ?? row.inReplyTo}
    </p>}
    <button className="btn mt-1 text-sm" data-testid="message-reply"
      onClick={() => onReply(row.id)}>Reply</button>
    <details className="mt-1 text-sm text-secondary" data-testid="message-events">
      <summary>History ({entry.events.length})</summary>
      {entry.events.map(event => <div key={event.seq} data-seq={event.seq} data-kind={event.kind} className="mt-1 border-l-2 border-border pl-2">
        <p className="text-secondary">
          {event.kind} · {actorLabel(event, sessions, names)} · {new Date(event.createdAt).toLocaleString()}
          {event.prevState ? ` · was ${event.prevState}` : ''}
          {event.prevClaimedBy ? ` · claimed by ${event.prevClaimedBy}` : ''}
        </p>
        {event.reason && <p className="text-secondary">{event.reason}</p>}
        {event.prevReason && <p className="text-secondary">was: {event.prevReason}</p>}
      </div>)}
    </details>
  </article>
}

/** An agent actor reads as its participant name (live or `(gone)`); anything unknown reads as `system`. */
function actorLabel(event: MessageEvent, sessions: ReadonlyArray<LiveParticipant>, names: ReadonlyArray<SessionDirectoryEntry>): string {
  if (event.actor === 'human') return 'human'
  if (event.actor === 'agent' && event.actorSession) return participantName(resolveParticipant(event.actorSession, sessions, names))
  return 'system'
}
