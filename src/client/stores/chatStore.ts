// Chat transcripts are replaced on attach and advanced by ordered live events.
// Final assistant text replaces its streamed preview; request state is shared
// through server resolution events rather than optimistic local answers.
import { create } from 'zustand'
import type { ChatEvent, ChatPendingRequest } from '@shared/chat'
import type { ServerMessage, SessionStatus } from '@shared/types'

export interface ChatTranscript {
  events: ChatEvent[]
  pendingRequests: ChatPendingRequest[]
  status: SessionStatus
  throughSequence: number
  seen: Set<string>
}

export const emptyTranscript = (): ChatTranscript => ({
  events: [], pendingRequests: [], status: 'waiting', throughSequence: 0, seen: new Set(),
})

export function applyChatEvents(state: ChatTranscript, incoming: ChatEvent[]): ChatTranscript {
  const next = { ...state, events: [...state.events], pendingRequests: [...state.pendingRequests], seen: new Set(state.seen) }
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
    if (event.type === 'turn_completed' || event.type === 'turn_interrupted') next.status = 'waiting'
    if (next.pendingRequests.length > 0) next.status = 'permission'
    else if (event.type === 'request_resolved' && next.status === 'permission') next.status = 'working'
  }
  return next
}

interface ChatStore {
  sessions: Record<string, ChatTranscript>
  apply: (sessionId: string, events: ChatEvent[]) => void
  snapshot: (message: Extract<ServerMessage, { type: 'chat-snapshot' }>) => void
  remove: (sessionId: string) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  sessions: {},
  apply: (sessionId, events) => set(state => ({ sessions: {
    ...state.sessions, [sessionId]: applyChatEvents(state.sessions[sessionId] ?? emptyTranscript(), events),
  } })),
  snapshot: message => set(state => ({ sessions: {
    ...state.sessions,
    [message.sessionId]: {
      ...applyChatEvents(emptyTranscript(), message.events),
      pendingRequests: message.pendingRequests,
      status: message.status,
      throughSequence: message.throughSequence,
    },
  } })),
  remove: sessionId => set(state => {
    const sessions = { ...state.sessions }
    delete sessions[sessionId]
    return { sessions }
  }),
}))
