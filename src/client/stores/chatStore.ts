// Chat transcripts are replaced on attach and advanced by ordered live events;
// the transcript model itself (its shape, `emptyTranscript`, and the live
// event fold) lives in `chatTranscript.ts`, and the history-page actions'
// bodies in `chatHistoryPages.ts` (chat-history-window D3) — this store keeps
// the per-session state maps and one-line actions.
// Final assistant text replaces its streamed preview — one entry per text
// block, keeping the block's first time; request state is shared
// through server resolution events rather than optimistic local answers. The
// live-turn activity is a single current value (not an event): it is anchored
// on the client clock from the server's elapsedMs and cleared on turn end.
// The context-usage reading is another such current value: replaced by
// snapshots and coalesced pushes, never sequenced into the transcript.
// The worker roster is a level value too (workers design D2): snapshots and
// chat-workers pushes replace it wholesale, each row's elapsed anchored on
// the client clock so its timer ticks between publishes.
// Plan usage is per profile, not per session (the allowance is per account
// and provider): the snapshot's `usage` and chat-usage pushes land in one
// shared map, so every session of a profile renders the same bar.
// Notifications are another replaced current value (notification strip
// design D6): the snapshot and chat-notifications pushes own the list, agent
// notices close through the server, and account notices close per browser
// tab only — a hidden one returns when its text (the day count) changes.
// Unsubmitted composer drafts are client-only state, keyed by session.
// A search result asks the chat view to reveal one transcript row through
// `pendingReveal` (chat-session-search D5); the view consumes it.
import { create } from 'zustand'
import type {
  ChatActivity,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatPendingRequest,
  ChatUsageReport,
  ChatWorker,
  ChatBackgroundTask,
} from '@shared/chat'
import type { ClientMessage, SendClientMessage, ServerMessage, SessionStatus } from '@shared/types'
import {
  accountCloseKey,
  anchorActivity,
  anchorWorkers,
  applyChatEvents,
  emptyTranscript,
  visibleNotifications,
  type ChatTranscript,
  type ChatTranscriptActivity,
  type ChatTranscriptWorker,
} from './chatTranscript'
import { claimHistoryPage, foldHistoryPage, withoutHistoryLoading } from './chatHistoryPages'

export { accountCloseKey, anchorActivity, anchorWorkers, applyChatEvents, emptyTranscript, visibleNotifications }
export type { ChatTranscript, ChatTranscriptActivity, ChatTranscriptWorker }

/** A worker's expanded body: in flight, delivered, or reported missing. */
/** A background task's output tail (background tasks D3): latest reply, or a fetch marker. */
export type ChatTaskOutput =
  | { status: 'fetching' }
  | { status: 'ok'; output: string; truncated: boolean }
  | { status: 'unavailable' }

export type ChatWorkerBody =
  | { status: 'fetching' }
  | { status: 'ok'; events: ChatEvent[] }
  | { status: 'unavailable' }

interface ChatStore {
  sessions: Record<string, ChatTranscript>
  /** Empty drafts have no key; never persisted or sent to the server. */
  drafts: Record<string, string>
  /** Latest plan-usage report per Claude profile (null = profile has none). */
  usage: Record<string, ChatUsageReport | null>
  /** Worker bodies per session and worker (workers design D5, on expand). */
  workerBodies: Record<string, Record<string, ChatWorkerBody>>
  /** Output tails per session and task (background tasks D3, on expand/poll). */
  taskOutputs: Record<string, Record<string, ChatTaskOutput>>
  /**
   * Account notices this browser tab closed (notification strip design D6),
   * keyed per session by `${key}:${text}`: a changed day count changes the
   * text and shows the notice again. Never sent to the server, dropped by a
   * reload.
   */
  closedAccountNotices: Record<string, Set<string>>
  /** Transcript row a search result asked to reveal; one at a time, consumed by ChatView. */
  pendingReveal: { sessionId: string; anchorId: string } | null
  requestReveal: (sessionId: string, anchorId: string) => void
  clearReveal: () => void
  apply: (sessionId: string, events: ChatEvent[]) => void
  snapshot: (message: Extract<ServerMessage, { type: 'chat-snapshot' }>) => void
  /**
   * Claim the next load-earlier request (chat-history-window D3): true only
   * for the first caller while none is in flight and older history exists,
   * with the wire request composed from the window's start — send it exactly
   * when non-null.
   */
  requestOlder: (
    sessionId: string,
    throughId?: string
  ) => Extract<ClientMessage, { type: 'chat-history-page' }> | null
  /**
   * Adopt a page reply (chat-history-window D3): the page is folded alone —
   * older live events must not move `throughSequence` — de-duplicated by
   * `seen`, and prepended. `historyExpanded` marks the user's expansion for
   * this page load. A `stale` reply drops the expansion and re-attaches
   * plain, so the fresh snapshot rebuilds the window.
   */
  applyHistoryPage: (
    message: Extract<ServerMessage, { type: 'chat-history-page' }>,
    send?: SendClientMessage
  ) => void
  /** Strand-clear every in-flight page (the socket died; a fresh attach reloads). */
  clearHistoryLoading: () => void
  /** Replace one session's command list (chat-commands push). */
  setCommands: (message: Extract<ServerMessage, { type: 'chat-commands' }>) => void
  /** Adopt the latest server activity (chat-activity) or clear it (null). */
  setActivity: (sessionId: string, activity: ChatActivity | null) => void
  /** Adopt the latest context reading (chat-context-usage push); null clears. */
  setContextUsage: (sessionId: string, usage: ChatContextUsage | null) => void
  /** Adopt the latest reported model (chat-model push); never clears. */
  setModel: (sessionId: string, model: string) => void
  /** Adopt a profile's latest usage report (chat-usage / snapshot). */
  setUsage: (profileId: string, report: ChatUsageReport | null) => void
  /** Adopt the latest roster (chat-workers push / snapshot). */
  setWorkers: (sessionId: string, workers: ChatWorker[]) => void
  /** Adopt the latest background-task roster (chat-background-tasks / snapshot). */
  setBackgroundTasks: (sessionId: string, tasks: ChatBackgroundTask[]) => void
  /** Adopt the latest notice list (chat-notifications push / snapshot). */
  setNotifications: (sessionId: string, notifications: ChatNotification[]) => void
  /** Adopt a worker-body reply (chat-worker-transcript). */
  setWorkerBody: (message: Extract<ServerMessage, { type: 'chat-worker-transcript' }>) => void
  /**
   * Close a notice (notification strip design D6): an agent notice is
   * dismissed on the server (every attached client loses it), an account
   * notice is hidden in this tab only until its text changes.
   */
  closeNotification: (
    sessionId: string,
    notice: ChatNotification,
    send: SendClientMessage
  ) => void
  /**
   * Mark a body as fetching; true only for the first request, so the caller
   * sends the wire request exactly once per worker.
   */
  requestWorkerBody: (sessionId: string, workerId: string) => boolean
  /** Roll back a fetching marker a dead socket stranded (request or reply lost). */
  resetWorkerBody: (sessionId: string, workerId: string) => void
  /** Adopt a tail reply (chat-task-output push). */
  setTaskOutput: (message: Extract<ServerMessage, { type: 'chat-task-output' }>) => void
  /** Claim the next tail fetch; false while one is already in flight. */
  requestTaskOutput: (sessionId: string, taskId: string) => boolean
  /** Drop a stranded fetch marker (a dead socket lost the reply). */
  resetTaskOutput: (sessionId: string, taskId: string) => void
  setDraft: (sessionId: string, text: string) => void
  remove: (sessionId: string) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  sessions: {},
  drafts: {},
  usage: {},
  workerBodies: {},
  taskOutputs: {},
  closedAccountNotices: {},
  pendingReveal: null,
  requestReveal: (sessionId, anchorId) => set({ pendingReveal: { sessionId, anchorId } }),
  clearReveal: () => set({ pendingReveal: null }),
  apply: (sessionId, events) => set(state => ({ sessions: {
    ...state.sessions, [sessionId]: applyChatEvents(state.sessions[sessionId] ?? emptyTranscript(), events),
  } })),
  snapshot: message => set(state => ({
    sessions: {
      ...state.sessions,
      [message.sessionId]: {
        ...applyChatEvents(emptyTranscript(), message.events),
        pendingRequests: message.pendingRequests,
        status: message.status,
        throughSequence: message.throughSequence,
        commands: message.commands,
        activity: message.activity ? anchorActivity(message.activity) : null,
        // Authoritative replace: a restart or unread session clears to null.
        contextUsage: message.contextUsage,
        // Authoritative at attach: the last reported model or null (design D3).
        model: message.model,
        // The roster is authoritative at attach time, live rows and settled
        // outcomes together (workers design D2).
        workers: anchorWorkers(message.workers),
        backgroundTasks: message.backgroundTasks,
        // The notice list is authoritative at attach time, minus whatever
        // this tab closed (notification strip design D6).
        notifications: visibleNotifications(
          state.closedAccountNotices[message.sessionId],
          message.notifications
        ),
        // The recent history window (chat-history-window D2/D3): the
        // snapshot owns the span and resolves any stranded page load. The
        // user's expansion survives it — a reconnect keeps what was loaded.
        historyHasOlder: message.historyHasOlder === true,
        historyStartId: message.historyStartId ?? null,
        historyLoading: false,
        historyExpanded: state.sessions[message.sessionId]?.historyExpanded === true,
      },
    },
    // The snapshot's usage is authoritative for the profile at attach time.
    usage: { ...state.usage, [message.profileId]: message.usage },
  })),
  requestOlder: (sessionId, throughId) => {
    let request: Extract<ClientMessage, { type: 'chat-history-page' }> | null = null
    set(state => {
      const claim = claimHistoryPage(state.sessions, sessionId, throughId)
      if (!claim) return state
      request = claim.request
      return { sessions: claim.sessions }
    })
    return request
  },
  applyHistoryPage: (message, send) => set(state => {
    const current = state.sessions[message.sessionId] ?? emptyTranscript()
    const outcome = foldHistoryPage(current, message)
    // The server no longer holds the client's oldest event: re-attach plain
    // so the fresh snapshot rebuilds the recent window (D2).
    if (outcome.kind === 'stale') send?.({ type: 'chat-attach', sessionId: message.sessionId })
    return { sessions: { ...state.sessions, [message.sessionId]: outcome.transcript } }
  }),
  clearHistoryLoading: () => set(state => {
    const sessions = withoutHistoryLoading(state.sessions)
    return sessions ? { sessions } : state
  }),
  setCommands: message => set(state => ({ sessions: {
    ...state.sessions,
    [message.sessionId]: {
      ...(state.sessions[message.sessionId] ?? emptyTranscript()),
      commands: message.state,
    },
  } })),
  setActivity: (sessionId, activity) => set(state => {
    const current = state.sessions[sessionId] ?? emptyTranscript()
    return { sessions: { ...state.sessions, [sessionId]: {
      ...current,
      activity: activity ? anchorActivity(activity) : null,
    } } }
  }),
  setUsage: (profileId, report) => set(state => ({
    usage: { ...state.usage, [profileId]: report },
  })),
  setContextUsage: (sessionId, usage) => set(state => {
    const current = state.sessions[sessionId] ?? emptyTranscript()
    return { sessions: { ...state.sessions, [sessionId]: {
      ...current,
      contextUsage: usage,
    } } }
  }),
  setModel: (sessionId, model) => set(state => {
    const current = state.sessions[sessionId] ?? emptyTranscript()
    return { sessions: { ...state.sessions, [sessionId]: {
      ...current,
      model,
    } } }
  }),
  setWorkers: (sessionId, workers) => set(state => {
    const current = state.sessions[sessionId] ?? emptyTranscript()
    return { sessions: { ...state.sessions, [sessionId]: {
      ...current,
      workers: anchorWorkers(workers),
    } } }
  }),
  setBackgroundTasks: (sessionId, tasks) => set(state => {
    const current = state.sessions[sessionId] ?? emptyTranscript()
    return { sessions: { ...state.sessions, [sessionId]: {
      ...current,
      backgroundTasks: tasks,
    } } }
  }),
  setNotifications: (sessionId, notifications) => set(state => {
    const current = state.sessions[sessionId] ?? emptyTranscript()
    return { sessions: { ...state.sessions, [sessionId]: {
      ...current,
      notifications: visibleNotifications(
        state.closedAccountNotices[sessionId],
        notifications
      ),
    } } }
  }),
  closeNotification: (sessionId, notice, send) => {
    if (notice.source === 'agent') {
      // Server-side dismissal: every attached client loses it when the
      // manager's push lands.
      send({ type: 'chat-dismiss-notification', sessionId, key: notice.key })
      return
    }
    set(state => {
      const current = state.sessions[sessionId]
      const key = accountCloseKey(notice)
      return {
        closedAccountNotices: {
          ...state.closedAccountNotices,
          [sessionId]: new Set(state.closedAccountNotices[sessionId] ?? []).add(key),
        },
        // Hide it right away: the visible list re-derives now, not only when
        // the next snapshot or push arrives.
        ...(current
          ? {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...current,
                  notifications: current.notifications.filter(
                    (candidate) =>
                      candidate.source !== 'account' || accountCloseKey(candidate) !== key
                  ),
                },
              },
            }
          : {}),
      }
    })
  },
  setWorkerBody: message => set(state => ({
    workerBodies: {
      ...state.workerBodies,
      [message.sessionId]: {
        ...state.workerBodies[message.sessionId],
        [message.workerId]: message.status === 'ok'
          ? { status: 'ok', events: message.events }
          : { status: 'unavailable' },
      },
    },
  })),
  requestWorkerBody: (sessionId, workerId) => {
    let first = false
    set(state => {
      const body = state.workerBodies[sessionId]?.[workerId]
      if (body !== undefined) return state
      first = true
      return { workerBodies: { ...state.workerBodies, [sessionId]: {
        ...state.workerBodies[sessionId],
        [workerId]: { status: 'fetching' },
      } } }
    })
    return first
  },
  resetWorkerBody: (sessionId, workerId) => set(state => {
    const bodies = state.workerBodies[sessionId]
    if (bodies?.[workerId]?.status !== 'fetching') return state
    const next = { ...bodies }
    delete next[workerId]
    return { workerBodies: { ...state.workerBodies, [sessionId]: next } }
  }),
  setTaskOutput: message => set(state => ({
    taskOutputs: {
      ...state.taskOutputs,
      [message.sessionId]: {
        ...state.taskOutputs[message.sessionId],
        [message.taskId]: message.state === 'ok'
          ? { status: 'ok', output: message.output ?? '', truncated: message.truncated === true }
          : { status: 'unavailable' },
      },
    },
  })),
  requestTaskOutput: (sessionId, taskId) => {
    let claimed = false
    set(state => {
      if (state.taskOutputs[sessionId]?.[taskId]?.status === 'fetching') return state
      claimed = true
      return { taskOutputs: { ...state.taskOutputs, [sessionId]: {
        ...state.taskOutputs[sessionId],
        [taskId]: { status: 'fetching' },
      } } }
    })
    return claimed
  },
  resetTaskOutput: (sessionId, taskId) => set(state => {
    const tails = state.taskOutputs[sessionId]
    if (tails?.[taskId]?.status !== 'fetching') return state
    const next = { ...tails }
    delete next[taskId]
    return { taskOutputs: { ...state.taskOutputs, [sessionId]: next } }
  }),
  setDraft: (sessionId, text) => set(state => {
    const drafts = { ...state.drafts }
    if (text === '') delete drafts[sessionId]
    else drafts[sessionId] = text
    return { drafts }
  }),
  remove: sessionId => set(state => {
    const sessions = { ...state.sessions }
    delete sessions[sessionId]
    // Profile usage outlives one session: a sibling may still show the bar.
    const drafts = { ...state.drafts }
    delete drafts[sessionId]
    const workerBodies = { ...state.workerBodies }
    delete workerBodies[sessionId]
    const taskOutputs = { ...state.taskOutputs }
    delete taskOutputs[sessionId]
    const closedAccountNotices = { ...state.closedAccountNotices }
    delete closedAccountNotices[sessionId]
    const pendingReveal = state.pendingReveal?.sessionId === sessionId ? null : state.pendingReveal
    return { sessions, drafts, workerBodies, taskOutputs, closedAccountNotices, pendingReveal }
  }),
}))
