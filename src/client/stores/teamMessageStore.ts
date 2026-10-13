// Per-chat Messages views (team-message-threads 5.2): the filtered, paged
// list, the selected thread with its append-only history, and the recorded
// identity of the participants those rows name. A snapshot is authoritative
// for the page it answers — the first page replaces, a cursor page appends —
// and a change push is unfiltered, so the store applies the view's own
// filters and drops rows that have just left them. Closed views ignore late
// pushes.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type {
  MessageCursor,
  MessageQueryFilters,
  SessionDirectoryEntry,
  TeamMessage,
  ThreadEntry,
} from '@shared/team'
import { matchesMessageFilters } from '@shared/team'

export interface MessageView {
  open: boolean
  /** A first page is in flight. */
  loading: boolean
  /** A cursor page is in flight; its snapshot appends rather than replaces. */
  loadingMore: boolean
  teamId: string | null
  filters: MessageQueryFilters
  /** Newest first, the order the pages arrive in. */
  messages: TeamMessage[]
  nextCursor: MessageCursor | null
  /** The thread shown in detail; null = just the list. */
  selectedThreadId: string | null
  /** The selected thread's rows and their history, oldest first. */
  thread: ThreadEntry[] | null
  /** Last known identity of killed participants named by these rows. */
  directory: SessionDirectoryEntry[]
  /** In-flight human sends by request id, for the composer's pending state. */
  pending: Record<string, 'send'>
  /** The last refusal's message, until the next action or selection. */
  error: string | null
}

export const closedMessageView = (): MessageView => ({
  open: false, loading: false, loadingMore: false, teamId: null, filters: {},
  messages: [], nextCursor: null, selectedThreadId: null, thread: null, directory: [],
  pending: {}, error: null,
})

interface MessageState {
  views: Record<string, MessageView>
  open: (sessionId: string, filters?: MessageQueryFilters) => void
  close: (sessionId: string) => void
  setFilters: (sessionId: string, filters: MessageQueryFilters) => void
  /** The component is asking for the next page; its snapshot appends. */
  beginMore: (sessionId: string) => void
  select: (sessionId: string, threadId: string | null) => void
  /** A human send is on the wire; the result settles it. */
  beginSend: (sessionId: string, requestId: string) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'team-messages-snapshot' }>) => void
  applyPush: (message: Extract<ServerMessage, { type: 'team-messages' }>) => void
  applyThread: (message: Extract<ServerMessage, { type: 'team-thread' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'team-message-send-result' }>) => void
}

const update = (state: MessageState, sessionId: string, patch: Partial<MessageView>) => {
  const view = state.views[sessionId]
  if (!view?.open) return state
  return { views: { ...state.views, [sessionId]: { ...view, ...patch } } }
}

/**
 * Fold one push into the page: an in-filter row replaces or lands in
 * creation order, a row that has left the filter is dropped. Order of the
 * rows already on the page is never disturbed.
 */
function mergePush(list: TeamMessage[], incoming: TeamMessage[], filters: MessageQueryFilters): TeamMessage[] {
  const next = [...list]
  for (const row of incoming) {
    const index = next.findIndex(known => known.id === row.id)
    if (!matchesMessageFilters(filters, row)) {
      if (index >= 0) next.splice(index, 1)
      continue
    }
    if (index >= 0) {
      next[index] = row
      continue
    }
    const at = next.findIndex(known => known.createdAt < row.createdAt)
    if (at < 0) next.push(row)
    else next.splice(at, 0, row)
  }
  return next
}

export const useTeamMessageStore = create<MessageState>(set => ({
  views: {},
  open: (sessionId, filters) => set(state => {
    const view = state.views[sessionId] ?? closedMessageView()
    return {
      views: { ...state.views, [sessionId]: {
        ...view, open: true, loading: !view.open,
        ...(filters ? { filters, messages: [], nextCursor: null, loadingMore: false } : {}),
      } },
    }
  }),
  close: sessionId => set(state => {
    const views = { ...state.views }
    delete views[sessionId]
    return { views }
  }),
  setFilters: (sessionId, filters) => set(state => update(state, sessionId, {
    filters, messages: [], nextCursor: null, loading: true, loadingMore: false, error: null,
  })),
  beginMore: sessionId => set(state => update(state, sessionId, { loadingMore: true })),
  beginSend: (sessionId, requestId) => set(state => {
    const view = state.views[sessionId]
    if (!view?.open) return state
    return update(state, sessionId, {
      pending: { ...view.pending, [requestId]: 'send' as const }, error: null,
    })
  }),
  select: (sessionId, threadId) => set(state => update(state, sessionId, {
    selectedThreadId: threadId, error: null,
    thread: state.views[sessionId]?.selectedThreadId === threadId ? state.views[sessionId]!.thread : null,
  })),
  applySnapshot: message => set(state => {
    const view = state.views[message.sessionId]
    if (!view?.open) return state
    const append = view.loadingMore
    const rows = append
      ? [...view.messages, ...message.messages.filter(row => !view.messages.some(known => known.id === row.id))]
      : message.messages
    return update(state, message.sessionId, {
      loading: false, loadingMore: false, teamId: message.teamId,
      filters: message.filters, messages: rows, nextCursor: message.nextCursor,
      directory: message.directory,
    })
  }),
  applyPush: message => set(state => {
    const view = state.views[message.sessionId]
    if (!view?.open) return state
    return update(state, message.sessionId, {
      messages: mergePush(view.messages, message.messages, view.filters),
    })
  }),
  applyThread: message => set(state => {
    const view = state.views[message.sessionId]
    if (!view?.open || view.selectedThreadId !== message.threadId) return state
    return update(state, message.sessionId, { thread: message.entries, directory: message.directory })
  }),
  applyResult: message => set(state => {
    const view = state.views[message.sessionId]
    if (!view?.open) return state
    const pending = { ...view.pending }
    delete pending[message.requestId]
    return update(state, message.sessionId, { pending, error: message.error ?? null })
  }),
}))
