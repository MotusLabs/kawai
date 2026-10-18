// The history-page actions' pure bodies (chat-history-window D3/D5),
// extracted from chatStore.ts so the store keeps one-line actions. The
// request claim composes the wire message from the window start — one page
// in flight per session, only while older history exists. A reply folds the
// page alone (its older live events must not move `throughSequence`, or
// later live events would read as seen), drops ids the client already has,
// prepends, and marks the user's expansion. A reply whose `beforeId` no
// longer matches the window start — a snapshot moved it while the page flew
// — is dropped, resolving the claim so the next request starts from the new
// window. A stale reply drops the expansion: the caller re-attaches plain
// and the fresh snapshot rebuilds the recent window.
import type { ClientMessage, ServerMessage } from '@shared/types'
import { applyChatEvents, emptyTranscript, type ChatTranscript } from './chatTranscript'

type PageRequest = Extract<ClientMessage, { type: 'chat-history-page' }>
type PageReply = Extract<ServerMessage, { type: 'chat-history-page' }>

/**
 * Claim the next load-earlier request: true only for the first caller while
 * none is in flight and older history exists, with the wire request
 * composed from the window's start — send it exactly when non-null.
 */
export function claimHistoryPage(
  sessions: Record<string, ChatTranscript>,
  sessionId: string,
  throughId?: string
): { sessions: Record<string, ChatTranscript>; request: PageRequest } | null {
  const current = sessions[sessionId]
  if (!current || current.historyLoading || !current.historyHasOlder || current.historyStartId === null) return null
  return {
    sessions: { ...sessions, [sessionId]: { ...current, historyLoading: true } },
    request: {
      type: 'chat-history-page',
      sessionId,
      beforeId: current.historyStartId,
      ...(throughId !== undefined ? { throughId } : {}),
    },
  }
}

export type HistoryPageOutcome = {
  kind: 'applied' | 'stale' | 'dropped'
  transcript: ChatTranscript
}

/** The transcript adopt for one page reply; `stale` tells the caller to re-attach plain. */
export function foldHistoryPage(current: ChatTranscript, message: PageReply): HistoryPageOutcome {
  if (message.stale === true) {
    // The server no longer holds the client's oldest event (chat-history-
    // window D2): the expansion is lost once — drop it and re-attach
    // plain, so the fresh snapshot rebuilds the recent window.
    return { kind: 'stale', transcript: { ...current, historyLoading: false, historyExpanded: false } }
  }
  if (message.beforeId !== current.historyStartId) {
    // The window moved while the page was in flight (a reopen's snapshot):
    // prepending would leave a gap, so drop the page and release the claim.
    return { kind: 'dropped', transcript: { ...current, historyLoading: false } }
  }
  const folded = applyChatEvents(emptyTranscript(), message.events).events
  const fresh = folded.filter(event => !current.seen.has(event.id))
  const seen = new Set(current.seen)
  for (const event of fresh) seen.add(event.id)
  return {
    kind: 'applied',
    transcript: {
      ...current,
      events: [...fresh, ...current.events],
      seen,
      historyHasOlder: message.hasOlder,
      historyStartId: fresh[0]?.id ?? current.historyStartId,
      historyLoading: false,
      historyExpanded: true,
    },
  }
}

/**
 * Strand-clear every in-flight page (the socket died; a fresh attach
 * reloads anyway). Null when nothing was in flight, so the store can
 * return its state unchanged.
 */
export function withoutHistoryLoading(
  sessions: Record<string, ChatTranscript>
): Record<string, ChatTranscript> | null {
  let changed = false
  const next: Record<string, ChatTranscript> = {}
  for (const [sessionId, transcript] of Object.entries(sessions)) {
    if (transcript.historyLoading) {
      next[sessionId] = { ...transcript, historyLoading: false }
      changed = true
    } else {
      next[sessionId] = transcript
    }
  }
  return changed ? next : null
}
