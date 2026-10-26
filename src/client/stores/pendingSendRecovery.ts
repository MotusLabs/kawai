// Connection-level owner of pending contextual-send answers and recovery
// (plan-workspace §6.3, B1 / rev-6 B1-R1+R2, rev-8 eligibility): a
// contextual send settles only on its own terminal answer — the sender-only
// `chat-send-result` acceptance, or its correlated refusal (the echoed
// requestId + sessionId) — and a send whose connection has dropped is
// recovered into an empty draft. Both live here, at the ACTUAL connection
// consumers (the message router's chat/error handlers and the
// connection-status store), not in a mounted chat surface: a role switch, a
// closed Plans tab, or a closed full-screen view must never strand an
// unanswered original. Every restore is recovery of unconfirmed text, never
// a resend (D7: reconnect restores history, not sends). Live and recoverable
// are per-entry states: a just-sent entry is invisible to recovery until its
// connection drops, and after the drop it drains into whatever empty draft
// appears next, connected or not.
import type { ServerMessage } from '@shared/types'
import { useChatStore } from './chatStore'
import { useSessionStore, type ConnectionStatus } from './sessionStore'
import { pendingContextSends, pendingContextSendsFor, usePlanWorkspaceScopeStore } from './planWorkspaceScopeStore'

/**
 * Settles a pending contextual send from its terminal answer frame, called
 * from the router's `chat-send-result` and `error` handlers. The acceptance
 * deletes the entry; a correlated refusal deletes it and restores the
 * original text and captured scope into that session's draft — only while
 * the draft is empty (typing since means the human moved on; the error
 * itself still shows as today). A `user_message` event never settles a
 * pending send: it cannot be told from another host's message. The entry's
 * own sessionId is checked on every settlement, so a malformed or unrelated
 * answer never consumes another session's entry.
 */
export function consumeSendAnswer(message: ServerMessage): void {
  if (message.type === 'chat-send-result') {
    const pending = pendingContextSends.get(message.requestId)
    if (pending && pending.sessionId === message.sessionId) pendingContextSends.delete(message.requestId)
    return
  }
  if (message.type !== 'error' || message.requestId === undefined) return
  const pending = pendingContextSends.get(message.requestId)
  if (!pending || pending.sessionId !== message.sessionId) return
  pendingContextSends.delete(message.requestId)
  if ((useChatStore.getState().drafts[pending.sessionId] ?? '') === '') {
    useChatStore.getState().setDraft(pending.sessionId, pending.text)
    usePlanWorkspaceScopeStore.getState().setScope(pending.sessionId, pending.scope)
  }
}

/**
 * Recovers the oldest recovery-eligible send of one session into an empty
 * draft — recovery of unconfirmed text, never a resend. A live just-sent
 * entry (eligible: false) is invisible here: only a connection drop makes an
 * entry recoverable, which is what keeps the composer's post-submit clear
 * from ever pulling it back. One entry per call: the next trigger (a later
 * drop, reconnect, or the draft emptying again) recovers the next, so every
 * retained original has a real path without ever concatenating two entries'
 * texts or merging their captured scopes.
 */
function tryRecover(sessionId: string): boolean {
  const oldest = pendingContextSendsFor(sessionId).find(entry => entry.eligible)
  if (!oldest) return false
  if ((useChatStore.getState().drafts[sessionId] ?? '') !== '') return false
  pendingContextSends.delete(oldest.requestId)
  useChatStore.getState().setDraft(sessionId, oldest.text)
  usePlanWorkspaceScopeStore.getState().setScope(sessionId, oldest.scope)
  return true
}

/** Every session still holding an unanswered send, in insertion order. */
const sessionsWithPending = (): string[] =>
  [...new Set([...pendingContextSends.values()].map(pending => pending.sessionId))]

/**
 * A real connected→non-connected transition marks every outstanding entry
 * recovery-eligible BEFORE the recovery pass: the terminal answer was
 * connection-scoped, so from this drop on each retained original is
 * unconfirmed — whether or not a reconnect follows. Eligibility then
 * survives the reconnect.
 */
function markAllEligible(): void {
  for (const entry of pendingContextSends.values()) entry.eligible = true
}

/**
 * Offers every pending session one recovery (each keeps its own draft).
 * Runs on connection drops AND reconnects alike: after a close the terminal
 * answer was connection-scoped, and a reconnect does not restore it, so both
 * transitions are recovery opportunities.
 */
function recoverAcrossSessions(): void {
  for (const sessionId of sessionsWithPending()) tryRecover(sessionId)
}

// The connection consumer (B1-R2): the status store is written by the
// WebSocket hook for the app's lifetime, whether or not any chat surface is
// mounted. Module-level subscriptions, installed once at import; the first
// callback only records the baseline, so a page load never recovers.
let lastStatus: ConnectionStatus | undefined
useSessionStore.subscribe((state) => {
  const status = state.connectionStatus
  const previous = lastStatus
  lastStatus = status
  if (previous === undefined || status === previous) return
  if (previous === 'connected' && status !== 'connected') markAllEligible()
  if (previous === 'connected' || status === 'connected') recoverAcrossSessions()
})

// The draft-emptied trigger: ANY nonempty→empty transition — the human
// clearing a recovered text, or a composer's post-submit clear — may reveal
// the next eligible original, connected or not. A live just-sent entry is
// ineligible, so its own submit's clear can never pull it back; recovery
// writes drafts, never sends.
useChatStore.subscribe((state, previousState) => {
  if (pendingContextSends.size === 0) return
  for (const sessionId of sessionsWithPending()) {
    if ((state.drafts[sessionId] ?? '') === '' && (previousState.drafts[sessionId] ?? '') !== '') {
      tryRecover(sessionId)
    }
  }
})
