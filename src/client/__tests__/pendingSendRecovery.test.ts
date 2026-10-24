// The connection-level consumer of pending contextual-send answers and
// recovery (plan-workspace §6.3, B1 / rev-6 B1-R1+R2): answers settle only
// through the REAL message router (createMessageRouter — the same dispatcher
// App subscribes for its lifetime), and disconnect/reconnect recovery runs
// through the REAL connection-status and draft stores with NO surface
// mounted — a role switch, a closed Plans tab, or a closed full-screen view
// must never strand an unanswered original. Every restore is recovery of
// unconfirmed text, never a resend, and each original keeps its own captured
// scope (never concatenated with another entry's).
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ServerMessage } from '@shared/types'
import { createMessageRouter } from '../protocol/messageRouter'
import type { MessageRouterDeps } from '../protocol/types'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { pendingContextSends, usePlanWorkspaceScopeStore, type CapturedWorkspaceScope } from '../stores/planWorkspaceScopeStore'
import type { MutableRefObject } from 'react'

const scope = (planId: string): CapturedWorkspaceScope => ({
  envelope: {
    teamId: 't', planId,
    version: { kind: 'revision', revision: 1, contentHash: `hash-${planId}` },
  },
  planTitle: `Plan ${planId}`,
  capturedAt: '2026-10-25T09:00:00.000Z',
})

const emptyRef = <T,>(): MutableRefObject<T> => ({ current: undefined as unknown as T })
const deps: MessageRouterDeps = {
  getConnectionEpoch: () => 1,
  sendClient: () => {},
  setTransientError: () => {},
  clearTransientError: () => {},
  openSessionFormPrefilled: () => {},
  setPendingHibernatingSession: () => {},
  pendingKills: { current: new Map() },
  pendingHibernateSelection: emptyRef(),
  pendingWakeSelection: emptyRef(),
  pendingWorktreeLaunch: emptyRef(),
  pendingChangeLaunch: emptyRef(),
}
const route = (message: ServerMessage) => createMessageRouter(deps)(message)

const setConnected = (status: 'connected' | 'disconnected') =>
  useSessionStore.getState().setConnectionState(status, null, 1)

const draftOf = (sessionId: string) => useChatStore.getState().drafts[sessionId] ?? ''
const scopeOf = (sessionId: string) => usePlanWorkspaceScopeStore.getState().scopes[sessionId]

beforeEach(() => {
  pendingContextSends.clear()
  usePlanWorkspaceScopeStore.setState({ scopes: {}, attempts: {} })
  useChatStore.setState({ sessions: {}, drafts: {}, pendingReveal: null })
  setConnected('connected')
})

describe('pendingSendRecovery: disconnect recovery through the connection consumer', () => {
  test('a drop restores each session\'s oldest unanswered send into its empty draft; originals keep their own scopes', () => {
    pendingContextSends.set('req-1', { sessionId: 's-a', text: 'first', scope: scope('p1') })
    pendingContextSends.set('req-2', { sessionId: 's-a', text: 'second', scope: scope('p2') })
    pendingContextSends.set('req-3', { sessionId: 's-b', text: 'other chat', scope: scope('p3') })
    setConnected('disconnected')
    // One entry per session, each with its OWN text and scope; the second
    // s-a original is retained, never concatenated into the draft.
    expect(draftOf('s-a')).toBe('first')
    expect(scopeOf('s-a')?.envelope.planId).toBe('p1')
    expect(draftOf('s-b')).toBe('other chat')
    expect([...pendingContextSends.keys()]).toEqual(['req-2'])
  })

  test('a reconnect neither resends nor duplicates; emptying the composer recovers the next original in turn', () => {
    pendingContextSends.set('req-1', { sessionId: 's-a', text: 'first', scope: scope('p1') })
    pendingContextSends.set('req-2', { sessionId: 's-a', text: 'second', scope: scope('p2') })
    setConnected('disconnected')
    expect(draftOf('s-a')).toBe('first')
    // Reconnect: the draft is occupied, so nothing changes and nothing resends.
    setConnected('connected')
    expect(draftOf('s-a')).toBe('first')
    expect([...pendingContextSends.keys()]).toEqual(['req-2'])
    // Back to disconnected, the human reads and empties the restored text:
    // the next original recovers in turn, with its own scope.
    setConnected('disconnected')
    useChatStore.getState().setDraft('s-a', '')
    expect(draftOf('s-a')).toBe('second')
    expect(scopeOf('s-a')?.envelope.planId).toBe('p2')
    expect(pendingContextSends.size).toBe(0)
  })

  test('a drop with occupied drafts restores nothing; emptying later still recovers, disconnected', () => {
    pendingContextSends.set('req-1', { sessionId: 's-a', text: 'unconfirmed', scope: scope('p1') })
    useChatStore.getState().setDraft('s-a', 'the human was typing')
    setConnected('disconnected')
    // The draft was occupied at the drop: nothing restores, nothing deletes.
    expect(draftOf('s-a')).toBe('the human was typing')
    expect([...pendingContextSends.keys()]).toEqual(['req-1'])
    // Emptying while disconnected (the drop already happened) recovers.
    useChatStore.getState().setDraft('s-a', '')
    expect(draftOf('s-a')).toBe('unconfirmed')
    expect(scopeOf('s-a')?.envelope.planId).toBe('p1')
  })

  test('a reconnect drains a retained original into an empty draft — recovery, never a resend', () => {
    // Pinned at the trigger level (B1-R1's "drain remaining pendings on
    // reconnect with empty draft"): a retained original whose draft is empty
    // at the connected transition restores, keeping unconfirmed text visible
    // instead of stranded. The entry is planted while already disconnected —
    // this pins the trigger contract itself, not a production submit path.
    setConnected('disconnected')
    pendingContextSends.set('req-1', { sessionId: 's-a', text: 'kept', scope: scope('p1') })
    expect(draftOf('s-a')).toBe('')
    setConnected('connected')
    expect(draftOf('s-a')).toBe('kept')
    expect(scopeOf('s-a')?.envelope.planId).toBe('p1')
    expect(pendingContextSends.size).toBe(0)
  })
})

describe('pendingSendRecovery: settlement through the real router', () => {
  test('the acceptance frame drops the entry; a user_message frame never settles anything', () => {
    pendingContextSends.set('req-1', { sessionId: 's-a', text: 'hello', scope: scope('p1') })
    route({ type: 'chat-events', sessionId: 's-a', events: [
      { id: 'u1', sequence: 1, at: '2026-10-25T09:00:00.000Z', turnId: 't1', type: 'user_message', text: 'hello' },
    ] })
    expect(pendingContextSends.size).toBe(1)
    route({ type: 'chat-send-result', sessionId: 's-a', requestId: 'req-1', accepted: true })
    expect(pendingContextSends.size).toBe(0)
    expect(draftOf('s-a')).toBe('')
  })

  test('a correlated refusal restores text and scope into an empty draft; the error still surfaces', () => {
    const transientErrors: string[] = []
    const surfaceDeps = { ...deps, setTransientError: (message: string) => { transientErrors.push(message) } }
    pendingContextSends.set('req-1', { sessionId: 's-a', text: 'hello', scope: scope('p1') })
    createMessageRouter(surfaceDeps)({
      type: 'error', message: 'Workspace context is stale: revision has moved on.',
      requestId: 'req-1', sessionId: 's-a',
    })
    expect(draftOf('s-a')).toBe('hello')
    expect(scopeOf('s-a')?.envelope.planId).toBe('p1')
    expect(pendingContextSends.size).toBe(0)
    // The refusal shows as today (B1 never suppresses the error).
    expect(transientErrors).toEqual(['Workspace context is stale: revision has moved on.'])
  })

  test('a refusal cannot overwrite a draft the human typed since; a foreign answer never consumes', () => {
    pendingContextSends.set('req-1', { sessionId: 's-a', text: 'hello', scope: scope('p1') })
    useChatStore.getState().setDraft('s-a', 'newer human text')
    route({ type: 'error', message: 'stale', requestId: 'req-1', sessionId: 's-a' })
    expect(draftOf('s-a')).toBe('newer human text')
    expect(pendingContextSends.size).toBe(0)
    // A correctly-addressed answer for another session's entry never consumes it.
    pendingContextSends.set('req-2', { sessionId: 's-a', text: 'again', scope: scope('p1') })
    route({ type: 'chat-send-result', sessionId: 's-b', requestId: 'req-2', accepted: true })
    route({ type: 'error', message: 'late', requestId: 'req-2', sessionId: 's-b' })
    expect(pendingContextSends.size).toBe(1)
  })

  test('a late terminal answer after disconnect recovery is ignored — recovery was the settlement', () => {
    pendingContextSends.set('req-1', { sessionId: 's-a', text: 'hello', scope: scope('p1') })
    setConnected('disconnected')
    expect(draftOf('s-a')).toBe('hello')
    route({ type: 'error', message: 'late', requestId: 'req-1', sessionId: 's-a' })
    expect(draftOf('s-a')).toBe('hello')
    expect(scopeOf('s-a')?.envelope.planId).toBe('p1')
  })
})
