// Chat transcripts are replaced on attach and advanced by ordered live events.
// Final assistant text replaces its streamed preview; request state is shared
// through server resolution events rather than optimistic local answers. The
// live-turn activity is a single current value (not an event): it is anchored
// on the client clock from the server's elapsedMs and cleared on turn end.
// Plan usage is per profile, not per session (the allowance is per account
// and provider): the snapshot's `usage` and chat-usage pushes land in one
// shared map, so every session of a profile renders the same bar.
import { create } from 'zustand'
import type {
  ChatActivity,
  ChatEvent,
  ChatPendingRequest,
  ChatUsageReport,
} from '@shared/chat'
import type { ServerMessage, SessionStatus } from '@shared/types'

/** The live activity plus its client-clock anchor (design D6). */
export interface ChatTranscriptActivity {
  value: ChatActivity
  /** Date.now() when the phase began; the row's timer ticks from this. */
  phaseStartedAt: number
}

export interface ChatTranscript {
  events: ChatEvent[]
  pendingRequests: ChatPendingRequest[]
  status: SessionStatus
  throughSequence: number
  seen: Set<string>
  activity: ChatTranscriptActivity | null
}

export const emptyTranscript = (): ChatTranscript => ({
  events: [], pendingRequests: [], status: 'waiting', throughSequence: 0, seen: new Set(), activity: null,
})

/** Anchor a server-reported activity on the client's clock (design D2). */
function anchorActivity(activity: ChatActivity): ChatTranscriptActivity {
  return { value: activity, phaseStartedAt: Date.now() - activity.elapsedMs }
}

export function applyChatEvents(state: ChatTranscript, incoming: ChatEvent[]): ChatTranscript {
  const next = { ...state, events: [...state.events], pendingRequests: [...state.pendingRequests], seen: new Set(state.seen), activity: state.activity }
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
  /** Latest plan-usage report per Claude profile (null = profile has none). */
  usage: Record<string, ChatUsageReport | null>
  apply: (sessionId: string, events: ChatEvent[]) => void
  snapshot: (message: Extract<ServerMessage, { type: 'chat-snapshot' }>) => void
  /** Adopt the latest server activity (chat-activity) or clear it (null). */
  setActivity: (sessionId: string, activity: ChatActivity | null) => void
  /** Adopt a profile's latest usage report (chat-usage / snapshot). */
  setUsage: (profileId: string, report: ChatUsageReport | null) => void
  remove: (sessionId: string) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  sessions: {},
  usage: {},
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
        activity: message.activity ? anchorActivity(message.activity) : null,
      },
    },
    // The snapshot's usage is authoritative for the profile at attach time.
    usage: { ...state.usage, [message.profileId]: message.usage },
  })),
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
  remove: sessionId => set(state => {
    const sessions = { ...state.sessions }
    delete sessions[sessionId]
    // Profile usage outlives one session: a sibling may still show the bar.
    return { sessions }
  }),
}))
