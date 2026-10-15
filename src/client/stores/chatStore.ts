// Chat transcripts are replaced on attach and advanced by ordered live events.
// Final assistant text replaces its streamed preview; request state is shared
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
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatPendingRequest,
  ChatUsageReport,
  ChatWorker,
  ChatBackgroundTask,
} from '@shared/chat'
import type { SendClientMessage, ServerMessage, SessionStatus } from '@shared/types'

/** The live activity plus its client-clock anchor (design D6). */
export interface ChatTranscriptActivity {
  value: ChatActivity
  /** Date.now() when the phase began; the row's timer ticks from this. */
  phaseStartedAt: number
}

/** A roster row with its elapsed anchored on the client clock (D2). */
export interface ChatTranscriptWorker extends Omit<ChatWorker, 'elapsedMs'> {
  /** Date.now() - elapsedMs at adopt time; the row's timer ticks from this. */
  startedAt: number
}

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

export interface ChatTranscript {
  events: ChatEvent[]
  pendingRequests: ChatPendingRequest[]
  status: SessionStatus
  throughSequence: number
  /** The session's slash-command list; unavailable until an agent reports. */
  commands: ChatCommandState
  seen: Set<string>
  activity: ChatTranscriptActivity | null
  /** Latest context-usage reading; null before the first model request. */
  contextUsage: ChatContextUsage | null
  /** Model the agent last reported (init frame); null before the first turn. */
  model: string | null
  /** Latest worker roster (workers design D2): replaced, never merged. */
  workers: ChatTranscriptWorker[]
  /**
   * Latest background-task roster (background tasks D2): replaced wholesale.
   * Rows carry epoch startedAt/endedAt, so elapsed ticks client-side.
   */
  backgroundTasks: ChatBackgroundTask[]
  /** Active notices (notification strip design D6), closed account ones filtered. */
  notifications: ChatNotification[]
}

export const emptyTranscript = (): ChatTranscript => ({
  events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
  commands: { status: 'unavailable', commands: [] }, seen: new Set(), activity: null, contextUsage: null,
  model: null, workers: [], backgroundTasks: [], notifications: [],
})

/** Anchor a server-reported activity on the client's clock (design D2). */
function anchorActivity(activity: ChatActivity): ChatTranscriptActivity {
  return { value: activity, phaseStartedAt: Date.now() - activity.elapsedMs }
}

/** Anchor a roster's elapsed times on the client's clock (workers D2). */
function anchorWorkers(workers: ChatWorker[]): ChatTranscriptWorker[] {
  return workers.map(({ elapsedMs, ...row }) => ({
    ...row,
    startedAt: Date.now() - elapsedMs,
  }))
}

/** A notice's per-tab close key: a changed text is a different notice. */
function accountCloseKey(notice: ChatNotification): string {
  return `${notice.key}:${notice.text}`
}

/** Drop the account notices this tab closed; agent notices pass through. */
function visibleNotifications(
  closed: Set<string> | undefined,
  notifications: ChatNotification[]
): ChatNotification[] {
  if (!closed || closed.size === 0) return notifications
  return notifications.filter(
    (notice) => notice.source !== 'account' || !closed.has(accountCloseKey(notice))
  )
}

export function applyChatEvents(state: ChatTranscript, incoming: ChatEvent[]): ChatTranscript {
  const next = { ...state, events: [...state.events], pendingRequests: [...state.pendingRequests], seen: new Set(state.seen), activity: state.activity, contextUsage: state.contextUsage }
  for (const event of incoming) {
    if (next.seen.has(event.id) || (event.sequence > 0 && event.sequence <= next.throughSequence)) continue
    next.seen.add(event.id)
    next.throughSequence = Math.max(next.throughSequence, event.sequence)
    if (event.type === 'assistant_delta' || event.type === 'assistant_text') {
      const index = next.events.findIndex(candidate =>
        (candidate.type === 'assistant_text' || candidate.type === 'assistant_delta') &&
        candidate.messageId === event.messageId && candidate.turnId === event.turnId)
      const previous = next.events[index]
      const previousText = previous?.type === 'assistant_text' ? previous.text : previous?.type === 'assistant_delta' ? previous.delta : ''
      const text = event.type === 'assistant_text' ? event.text : previousText + event.delta
      const normalized: ChatEvent = { ...event, type: 'assistant_text', text }
      if (index >= 0) next.events[index] = normalized
      else next.events.push(normalized)
    } else {
      next.events.push(event)
    }
    if (event.type === 'approval_request') {
      next.pendingRequests.push({ kind: 'approval', requestId: event.requestId, tool: event.tool, input: event.input, at: event.at })
    }
    if (event.type === 'question_request') {
      next.pendingRequests.push({ kind: 'question', requestId: event.requestId, questions: event.questions, at: event.at })
    }
    if (event.type === 'request_resolved') {
      next.pendingRequests = next.pendingRequests.filter(request => request.requestId !== event.requestId)
    }
    if (event.type === 'turn_started') next.status = 'working'
    if (event.type === 'turn_completed' || event.type === 'turn_interrupted') {
      next.status = 'waiting'
      // Safety net for a lost chat-activity null: a ended turn shows no row.
      next.activity = null
    }
    if (next.pendingRequests.length > 0) next.status = 'permission'
    else if (event.type === 'request_resolved' && next.status === 'permission') next.status = 'working'
  }
  return next
}

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
      },
    },
    // The snapshot's usage is authoritative for the profile at attach time.
    usage: { ...state.usage, [message.profileId]: message.usage },
  })),
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
