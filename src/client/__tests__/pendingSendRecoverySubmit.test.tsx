// Production-host regressions for pending contextual-send recovery
// (plan-workspace §6.3, B1): the REAL ChatSurface/ChatComposer submit stamps
// its entry live (eligible: false) — so the composer's own post-submit clear
// never pulls it back — while a retained recovery-eligible original surfaces
// through that same clear, and a production-stamped send survives unmount,
// drop, reconnect, and a connected consume. Answers settle through the real
// message router and drops/reconnects through the real connection-status
// store; map plants are used only for the retained original, whose
// eligibility is the post-drop state a production stamp cannot reach without
// a real socket (the stamp itself is asserted on the real submit's entry).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, ServerMessage, Session } from '@shared/types'
import type { WorkspaceContextVersion } from '@shared/planWorkspace'
import ChatSurface from '../components/chat/ChatSurface'
import { createMessageRouter } from '../protocol/messageRouter'
import type { MessageRouterDeps } from '../protocol/types'
import { pendingContextSends, usePlanWorkspaceScopeStore, type CapturedWorkspaceScope } from '../stores/planWorkspaceScopeStore'
import { useChatStore } from '../stores/chatStore'
import { useChatDebugStore } from '../stores/chatDebugStore'
import { useSessionStore } from '../stores/sessionStore'
import type { MutableRefObject } from 'react'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useChatStore.setState({ sessions: {}, drafts: {}, pendingReveal: null })
  useChatDebugStore.setState({ views: {} })
  usePlanWorkspaceScopeStore.setState({ scopes: {}, attempts: {} })
  pendingContextSends.clear()
})

const makeSession = (id: string) =>
  ({
    id, name: id, projectPath: '/repo', status: 'waiting', kind: 'chat',
    approvalPolicy: 'manual',
  }) as unknown as Session

const version = (revision: number): WorkspaceContextVersion =>
  ({ kind: 'revision', revision, contentHash: `hash-${revision}-0123456789` })

const scope = (planId: string, revision: number): CapturedWorkspaceScope => ({
  envelope: { teamId: 't', planId, version: version(revision) },
  planTitle: `Plan ${planId}`, capturedAt: '2026-10-25T09:00:00.000Z',
})

type SnapshotMessage = Parameters<ReturnType<typeof useChatStore.getState>['snapshot']>[0]
const snapshotMessage = (): SnapshotMessage =>
  ({
    type: 'chat-snapshot' as const, sessionId: 'chat-a', profileId: 'default', status: 'waiting' as const,
    throughSequence: 0, events: [], pendingRequests: [],
    commands: { status: 'unavailable' as const, commands: [] }, activity: null,
    contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
  })

const emptyRef = <T,>(): MutableRefObject<T> => ({ current: undefined as unknown as T })
const routerDeps: MessageRouterDeps = {
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
const route = (message: ServerMessage) => createMessageRouter(routerDeps)(message)

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

describe('pending contextual sends through the real surface submit (B1)', () => {
  let sent: ClientMessage[]

  const render = () => {
    act(() => { useChatStore.getState().snapshot(snapshotMessage()) })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ChatSurface session={makeSession('chat-a')} sendMessage={message => { sent.push(message) }}
          connectionStatus="connected" connectionEpoch={1}
          onSubmitContext={() => scope('p2', 3)} />)
      renderers.push(renderer)
    })
    return renderer
  }
  const type = (value: string) =>
    act(() => { renderers[0]!.root.findByType('textarea').props.onChange({ target: { value } }) })
  const submit = () =>
    act(() => { renderers[0]!.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
  const chatSend = () =>
    sent.find((message): message is Extract<ClientMessage, { type: 'chat-send' }> => message.type === 'chat-send')!

  beforeEach(() => { sent = [] })

  test('a real submit stamps its entry live; the post-submit clear never pulls it back (PROBE C)', () => {
    render()
    type('scoped text')
    submit()
    const requestId = chatSend().requestId!
    const entry = pendingContextSends.get(requestId)!
    // The production submit registered the entry with its exact text and
    // captured scope, stamped LIVE: the composer's own post-submit clear ran
    // while the entry was pending and restored nothing.
    expect(entry).toMatchObject({ sessionId: 'chat-a', text: 'scoped text', eligible: false })
    expect(entry.scope.envelope).toEqual({ teamId: 't', planId: 'p2', version: version(3) })
    expect(draftOf('chat-a')).toBe('')
    expect(pendingContextSends.size).toBe(1)
  })

  test('a submit-clear while connected surfaces the retained original, never the live send', () => {
    // A retained original (the post-drop state; planted because only a real
    // socket transition produces it) and then a real contextual submit: the
    // composer's clear reveals the RETAINED original with its own scope
    // while the just-sent live entry stays pending, then settles on its own
    // acceptance through the real router.
    pendingContextSends.set('req-old', { sessionId: 'chat-a', text: 'retained', scope: scope('p1', 1), eligible: true })
    render()
    type('just sent')
    submit()
    expect(draftOf('chat-a')).toBe('retained')
    expect(scopeOf('chat-a')?.envelope.planId).toBe('p1')
    const liveId = chatSend().requestId!
    expect(pendingContextSends.get(liveId)).toMatchObject({ text: 'just sent', eligible: false })
    expect(pendingContextSends.has('req-old')).toBe(false)
    route({ type: 'chat-send-result', sessionId: 'chat-a', requestId: liveId, accepted: true })
    expect(pendingContextSends.size).toBe(0)
    // The revealed retained text stays in the composer: recovery, never a resend.
    expect(draftOf('chat-a')).toBe('retained')
  })

  test('a production-stamped send survives unmount, drop, reconnect, and a connected consume', () => {
    const renderer = render()
    type('only send')
    submit()
    expect(pendingContextSends.size).toBe(1)
    // The surface is gone; recovery belongs to the connection consumer.
    act(() => { renderer.unmount() })
    setConnected('disconnected')
    expect(draftOf('chat-a')).toBe('only send')
    setConnected('connected')
    useChatStore.getState().setDraft('chat-a', '')
    expect(draftOf('chat-a')).toBe('')
    expect(pendingContextSends.size).toBe(0)
  })
})
