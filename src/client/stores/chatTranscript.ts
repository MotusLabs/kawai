// The transcript model behind the chat store (moved here from chatStore.ts
// so the store's history-page actions could live beside it without crossing
// the 500-line rule): a transcript is replaced on attach and advanced by
// ordered live events. Final assistant text replaces its streamed preview —
// one entry per text block, keeping the block's first time; request state is
// shared through server resolution events rather than optimistic local
// answers. Each transcript also carries the recent-history window's client
// state (chat-history-window D2/D3): the server's `historyHasOlder` and
// window `historyStartId`, the one in-flight page claim, and the in-memory
// `historyExpanded` mark of what the user loaded this page load.
import type {
  ChatActivity,
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatPendingRequest,
  ChatWorker,
  ChatBackgroundTask,
} from '@shared/chat'
import { earliestTime } from '@shared/chatTime'
import type { SessionStatus } from '@shared/types'

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
  /** Older history exists above the window (chat-history-window D2); absent on older servers reads false. */
  historyHasOlder: boolean
  /** A page request is in flight; the load-earlier control and reveals claim it. */
  historyLoading: boolean
  /** The window's first event id: pages resume here, reconnects widen from here. */
  historyStartId: string | null
  /**
   * The user loaded earlier history in this page load (design D3): memory
   * only, never sent to the server, gone after a reload — a reopen of the
   * chat resumes from the oldest loaded turn until then.
   */
  historyExpanded: boolean
}

export const emptyTranscript = (): ChatTranscript => ({
  events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
  commands: { status: 'unavailable', commands: [] }, seen: new Set(), activity: null, contextUsage: null,
  model: null, workers: [], backgroundTasks: [], notifications: [],
  historyHasOlder: false, historyLoading: false, historyStartId: null, historyExpanded: false,
})

/** Anchor a server-reported activity on the client's clock (design D2). */
export function anchorActivity(activity: ChatActivity): ChatTranscriptActivity {
  return { value: activity, phaseStartedAt: Date.now() - activity.elapsedMs }
}

/** Anchor a roster's elapsed times on the client's clock (workers D2). */
export function anchorWorkers(workers: ChatWorker[]): ChatTranscriptWorker[] {
  return workers.map(({ elapsedMs, ...row }) => ({
    ...row,
    startedAt: Date.now() - elapsedMs,
  }))
}

/** A notice's per-tab close key: a changed text is a different notice. */
export function accountCloseKey(notice: ChatNotification): string {
  return `${notice.key}:${notice.text}`
}

/** Drop the account notices this tab closed; agent notices pass through. */
export function visibleNotifications(
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
      // One entry per text block (chat-transcript-layout D5): merge only into
      // the newest entry of this message when nothing followed it, so text
      // after a tool call becomes its own entry in order. The entry keeps its
      // earliest valid time (D2) so the clock never moves while it streams.
      const index = next.events.length - 1
      const previous = next.events[index]
      const merges = previous !== undefined &&
        (previous.type === 'assistant_text' || previous.type === 'assistant_delta') &&
        previous.messageId === event.messageId && previous.turnId === event.turnId
      const previousText = !merges ? '' : previous.type === 'assistant_text' ? previous.text : previous.delta
      const text = event.type === 'assistant_text' ? event.text : previousText + event.delta
      const at = merges ? earliestTime(previous.at, event.at) : event.at
      const normalized: ChatEvent = { ...event, type: 'assistant_text', text, at }
      if (merges) next.events[index] = normalized
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
