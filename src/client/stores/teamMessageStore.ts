// Per-team Messages views (team-message-threads 5.2): the filtered, paged
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
  /**
   * Whole-thread counts for every thread on a loaded page, whatever the
   * filters (team-workspace-pages D7); a collapsed thread row states its size
   * without loading the thread. Merged across pages, never reset by a push.
   */
  threadSizes: Record<string, number>
  nextCursor: MessageCursor | null
  /** The thread shown in detail; null = just the list. */
  selectedThreadId: string | null
  /** The selected thread's rows and their history, oldest first. */
  thread: ThreadEntry[] | null
  /** Last known identity of killed participants named by these rows. */
  directory: SessionDirectoryEntry[]
  /** The team's tasks, for the composer's optional task picker. */
  tasks: { id: string; title: string }[]
  /** In-flight human sends by request id, for the composer's pending state. */
  pending: Record<string, 'send'>
  /** The last refusal's message, until the next action or selection. */
  error: string | null
}

export const closedMessageView = (): MessageView => ({
  open: false, loading: false, loadingMore: false, teamId: null, filters: {},
  messages: [], threadSizes: {}, nextCursor: null, selectedThreadId: null, thread: null, directory: [],
  tasks: [], pending: {}, error: null,
})

interface MessageState {
  views: Record<string, MessageView>
  open: (teamKey: string, filters?: MessageQueryFilters) => void
  close: (teamKey: string) => void
  /**
   * Move a view to the chat's new team key (team-workspace-pages D2): a key
   * changes when workspace discovery first places the chat in a repository.
   * A view already open under the new key wins; the old one is dropped.
   */
  rekey: (from: string, to: string) => void
  setFilters: (teamKey: string, filters: MessageQueryFilters) => void
  /** The component is asking for the next page; its snapshot appends. */
  beginMore: (teamKey: string) => void
  select: (teamKey: string, threadId: string | null) => void
  /** A human send is on the wire; the result settles it. */
  beginSend: (teamKey: string, requestId: string) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'team-messages-snapshot' }>) => void
  applyPush: (message: Extract<ServerMessage, { type: 'team-messages' }>) => void
  applyThread: (message: Extract<ServerMessage, { type: 'team-thread' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'team-message-send-result' }>) => void
}

const update = (state: MessageState, teamKey: string, patch: Partial<MessageView>) => {
  const view = state.views[teamKey]
  if (!view?.open) return state
  return { views: { ...state.views, [teamKey]: { ...view, ...patch } } }
}

/**
 * Fold one push into the page: an in-filter row replaces or lands in
 * creation order, a row that has left the filter is dropped. Order of the
 * rows already on the page is never disturbed.
 */
function mergePush(
  list: TeamMessage[],
  incoming: TeamMessage[],
  filters: MessageQueryFilters,
  directory: SessionDirectoryEntry[],
): TeamMessage[] {
  const next = [...list]
  // A text search also matches participant names: the team directory holds
  // every recorded session's name, the same table the server's search reads.
  const labelOf = (sessionId: string) => directory.find(entry => entry.sessionId === sessionId)?.name
  for (const row of incoming) {
    const index = next.findIndex(known => known.id === row.id)
    if (!matchesMessageFilters(filters, row, labelOf)) {
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
  open: (teamKey, filters) => set(state => {
    const view = state.views[teamKey] ?? closedMessageView()
    return {
      views: { ...state.views, [teamKey]: {
        ...view, open: true, loading: !view.open,
        ...(filters ? { filters, messages: [], nextCursor: null, loadingMore: false } : {}),
      } },
    }
  }),
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
  close: teamKey => set(state => {
    const views = { ...state.views }
    delete views[teamKey]
    return { views }
  }),
  setFilters: (teamKey, filters) => set(state => update(state, teamKey, {
    filters, messages: [], threadSizes: {}, nextCursor: null, loading: true, loadingMore: false, error: null,
  })),
  beginMore: teamKey => set(state => update(state, teamKey, { loadingMore: true })),
  beginSend: (teamKey, requestId) => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    return update(state, teamKey, {
      pending: { ...view.pending, [requestId]: 'send' as const }, error: null,
    })
  }),
  select: (teamKey, threadId) => set(state => update(state, teamKey, {
    selectedThreadId: threadId, error: null,
    thread: state.views[teamKey]?.selectedThreadId === threadId ? state.views[teamKey]!.thread : null,
  })),
  applySnapshot: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    const append = view.loadingMore
    const rows = append
      ? [...view.messages, ...message.messages.filter(row => !view.messages.some(known => known.id === row.id))]
      : message.messages
    return update(state, message.teamPath, {
      loading: false, loadingMore: false, teamId: message.teamId,
      filters: message.filters, messages: rows, nextCursor: message.nextCursor,
      threadSizes: append ? { ...view.threadSizes, ...message.threadSizes } : message.threadSizes,
      directory: message.directory, tasks: message.tasks,
    })
  }),
  applyPush: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    return update(state, message.teamPath, {
      messages: mergePush(view.messages, message.messages, view.filters, message.directory),
      directory: message.directory,
    })
  }),
  applyThread: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open || view.selectedThreadId !== message.threadId) return state
    return update(state, message.teamPath, { thread: message.entries, directory: message.directory })
  }),
  applyResult: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    const pending = { ...view.pending }
    delete pending[message.requestId]
    return update(state, message.teamPath, { pending, error: message.error ?? null })
  }),
}))
