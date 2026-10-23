// Embedded-host lifecycle and parity tests for the shared chat surface
// (plan-workspace §6.1, advisory 396ee67b R2/R3 and the expansion scope).
// Pinned here: the host contract for local reset — a host with `subscribe`
// completes /clear /reset /new (created replacement archives the old chat,
// a creation failure leaves it untouched, the §6.4 seam observes the
// replacement) while a host WITHOUT a subscription is not lifecycle-capable
// and refuses the command visibly instead of half-creating; a true detach
// followed by a higher-epoch reopen resumes the user's expanded history;
// independent connections attach the same session independently at the
// same epoch; and the embedded host carries the ordinary strips — usage,
// notifications with the archived account-only filter, workers/background
// tasks, and the error banner — with the full-screen DOM order preserved.
// Wire-level and transfer guards stay in chatSurfaceHost.test.tsx and
// chatAttachment.test.ts; the full-screen strips in chatHeaderIntegration.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ComponentProps, ReactElement } from 'react'
import type { ChatNotification, ChatUsageReport, ClientMessage, ServerMessage, Session } from '@shared/types'
import ChatView from '../components/chat/ChatView'
import ChatSurface from '../components/chat/ChatSurface'
import { emptyTranscript, useChatStore } from '../stores/chatStore'

const makeSession = (id: string, overrides: Partial<Session> = {}) =>
  ({
    id, name: id, projectPath: '/tmp/project', status: 'waiting', kind: 'chat',
    approvalPolicy: 'manual', ...overrides,
  }) as unknown as Session

type SnapshotMessage = Parameters<ReturnType<typeof useChatStore.getState>['snapshot']>[0]
const snapshotMessage = (overrides: Partial<SnapshotMessage> = {}) =>
  ({
    type: 'chat-snapshot' as const, sessionId: 'chat-a', profileId: 'default', status: 'waiting' as const,
    throughSequence: 0, events: [], pendingRequests: [],
    commands: { status: 'unavailable' as const, commands: [] }, activity: null,
    contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    ...overrides,
  }) as SnapshotMessage

const userEvent = (id: string, text: string) =>
  ({ id, sequence: 0, at: '2026-10-23T09:00:00.000Z', turnId: `t-${id}`, type: 'user_message' as const, text })

describe('ChatSurface host lifecycle', () => {
  let sent: ClientMessage[]
  let sendMessage: (message: ClientMessage) => void
  let listeners: Array<(message: ServerMessage) => void>
  let created: Array<[string, string]> // [newSessionId, previousSessionId] from onResetCreated
  let renderer: TestRenderer.ReactTestRenderer | null = null

  beforeEach(() => {
    sent = []
    sendMessage = (message) => { sent.push(message) }
    listeners = []
    created = []
    useChatStore.setState({ sessions: {}, drafts: {}, pendingReveal: null })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    useChatStore.setState({ sessions: {}, drafts: {}, pendingReveal: null })
  })

  const subscribe = (listener: (message: ServerMessage) => void) => {
    listeners.push(listener)
    return () => { listeners = listeners.filter(kept => kept !== listener) }
  }
  const deliver = (message: ServerMessage) => act(() => { for (const listener of listeners) listener(message) })
  const type = (value: string) =>
    act(() => { renderer!.root.findByType('textarea').props.onChange({ target: { value } }) })
  const submit = () =>
    act(() => { renderer!.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
  const of = (type: string) => sent.filter(message => message.type === type)

  const newChatCreated = (id: string): ServerMessage => ({
    type: 'session-created',
    session: {
      id, name: 'New chat', kind: 'chat', projectPath: '/tmp/project',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    } as unknown as Session,
  })

  function mountSurface(session: Session, extra: Partial<ComponentProps<typeof ChatSurface>> = {}) {
    act(() => {
      renderer = TestRenderer.create(
        <div data-testid="host">
          <ChatSurface session={session} sendMessage={sendMessage} connectionStatus="connected"
            connectionEpoch={1} onResetCreated={(next, previous) => { created.push([next, previous]) }}
            {...extra} />
        </div>
      )
    })
  }

  test('a lifecycle-capable embedded host completes /clear: create, hand over, archive', () => {
    act(() => { useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a' })) })
    mountSurface(makeSession('chat-a'), { subscribe })
    type('/clear')
    submit()
    expect(of('session-create')).toEqual([{
      type: 'session-create', projectPath: '/tmp/project', kind: 'chat', claudeProfileId: 'default',
      approvalPolicy: 'manual',
    }])
    expect(of('chat-archive')).toEqual([])
    deliver(newChatCreated('chat-new'))
    // The §6.4 seam saw the replacement before the old chat archived.
    expect(created).toEqual([['chat-new', 'chat-a']])
    expect(of('chat-archive')).toEqual([{ type: 'chat-archive', sessionId: 'chat-a' }])
  })

  test('a creation failure leaves the embedded host lifecycle untouched', () => {
    act(() => { useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a' })) })
    mountSurface(makeSession('chat-a'), { subscribe })
    type('/reset')
    submit()
    deliver({ type: 'error', message: 'Claude Agent SDK is unavailable.' })
    expect(of('chat-archive')).toEqual([])
    // The failure also cancels the pending archive for later creations.
    deliver(newChatCreated('chat-late'))
    expect(of('chat-archive')).toEqual([])
    expect(created).toEqual([])
  })

  test('a host without a subscription refuses a local reset visibly and keeps the text', () => {
    act(() => { useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a' })) })
    mountSurface(makeSession('chat-a'))
    type('/new fresh name')
    submit()
    // Nothing was created, nothing was sent as a chat message.
    expect(of('session-create')).toEqual([])
    expect(of('chat-send')).toEqual([])
    const refusal = renderer!.root.findByProps({ 'data-testid': 'chat-reset-unsupported' })
    expect(refusal.props.role).toBe('alert')
    // The composer cleared its draft on submit; the surface put the command
    // back so the refusal keeps the user's text editable.
    expect(renderer!.root.findByType('textarea').props.value).toBe('/new fresh name')
    // A lifecycle-capable remount clears the stale refusal with the session change.
    act(() => renderer!.unmount())
    renderer = null
    listeners = []
    mountSurface(makeSession('chat-a'), { subscribe })
    expect(renderer!.root.findAllByProps({ 'data-testid': 'chat-reset-unsupported' })).toHaveLength(0)
    type('ordinary message')
    submit()
    expect(of('chat-send')).toEqual([{ type: 'chat-send', sessionId: 'chat-a', text: 'ordinary message' }])
  })
})

describe('ChatSurface attach lifecycle', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    useChatStore.setState({ sessions: {}, pendingReveal: null })
  })

  /** One microtask tick: a scheduled detach fires ahead of the await resume. */
  const flushDetach = () => new Promise<void>(resolve => queueMicrotask(resolve))

  /** Marks the held transcript as the user's expanded history (D3). */
  const seedExpandedHistory = (expanded: boolean) => {
    const existing = useChatStore.getState().sessions['chat-a']
    useChatStore.setState({ sessions: {
      'chat-a': {
        ...(existing ?? emptyTranscript()),
        historyHasOlder: true, historyStartId: 'u1', historyExpanded: expanded,
      },
    } })
  }

  test('a true detach followed by a higher-epoch reopen resumes the expanded history', async () => {
    const sent: ClientMessage[] = []
    const sendMessage = (message: ClientMessage) => { sent.push(message) }
    const attaches = () =>
      sent.filter((message): message is Extract<ClientMessage, { type: 'chat-attach' }> => message.type === 'chat-attach')
    const detaches = () => sent.filter(message => message.type === 'chat-detach')
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', events: [userEvent('u1', 'held')], historyHasOlder: true, historyStartId: 'u1',
      }))
    })
    const host = (epoch: number): ReactElement => (
      <div data-testid="host">
        <ChatSurface session={makeSession('chat-a')} sendMessage={sendMessage}
          connectionStatus="connected" connectionEpoch={epoch} />
      </div>
    )
    act(() => { renderer = TestRenderer.create(host(1)) })
    expect(attaches()).toEqual([{ type: 'chat-attach', sessionId: 'chat-a' }])
    // The host closes for real: the last release detaches one microtask later.
    act(() => renderer!.unmount())
    renderer = null
    await flushDetach()
    expect(detaches()).toEqual([{ type: 'chat-detach', sessionId: 'chat-a' }])
    // The user had expanded history before closing; a reopen at a higher
    // epoch is a fresh subscription that resumes the loaded window.
    seedExpandedHistory(true)
    act(() => { renderer = TestRenderer.create(host(4)) })
    expect(attaches()).toEqual([
      { type: 'chat-attach', sessionId: 'chat-a' },
      { type: 'chat-attach', sessionId: 'chat-a', historyFrom: 'u1' },
    ])
  })

  test('independent connections attach the same session independently at one epoch', async () => {
    const one: ClientMessage[] = []
    const two: ClientMessage[] = []
    const sendMessageOne = (message: ClientMessage) => { one.push(message) }
    const sendMessageTwo = (message: ClientMessage) => { two.push(message) }
    const attachesOf = (sent: ClientMessage[]) =>
      sent.filter((message): message is Extract<ClientMessage, { type: 'chat-attach' }> => message.type === 'chat-attach')
    const detachesOf = (sent: ClientMessage[]) => sent.filter(message => message.type === 'chat-detach')
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a', events: [userEvent('u1', 'held')] }))
    })
    // Two pages, two registries (two sendMessage identities), one session,
    // one epoch: each connection attaches for itself.
    act(() => {
      renderer = TestRenderer.create(<>
        <div data-testid="host-one">
          <ChatSurface session={makeSession('chat-a')} sendMessage={sendMessageOne}
            connectionStatus="connected" connectionEpoch={1} />
        </div>
        <div data-testid="host-two">
          <ChatSurface session={makeSession('chat-a')} sendMessage={sendMessageTwo}
            connectionStatus="connected" connectionEpoch={1} />
        </div>
      </>)
    })
    expect(attachesOf(one)).toEqual([{ type: 'chat-attach', sessionId: 'chat-a' }])
    expect(attachesOf(two)).toEqual([{ type: 'chat-attach', sessionId: 'chat-a' }])
    // Connection one's host closes: its wire detaches; connection two keeps
    // its own subscription — no cross-connection suppression either way.
    act(() => {
      renderer!.update(<div data-testid="host-two">
        <ChatSurface session={makeSession('chat-a')} sendMessage={sendMessageTwo}
          connectionStatus="connected" connectionEpoch={1} />
      </div>)
    })
    await flushDetach()
    expect(detachesOf(one)).toEqual([{ type: 'chat-detach', sessionId: 'chat-a' }])
    expect(detachesOf(two)).toEqual([])
    expect(attachesOf(two)).toHaveLength(1)
  })
})

describe('ChatSurface host parity', () => {
  let sent: ClientMessage[]
  let sendMessage: (message: ClientMessage) => void
  let renderer: TestRenderer.ReactTestRenderer | null = null

  beforeEach(() => {
    sent = []
    sendMessage = (message) => { sent.push(message) }
    useChatStore.setState({ sessions: {}, usage: {}, closedAccountNotices: {}, pendingReveal: null })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    useChatStore.setState({ sessions: {}, usage: {}, closedAccountNotices: {}, pendingReveal: null })
  })

  const notice = (source: 'agent' | 'account', key: string): ChatNotification => ({
    key, source, severity: 'warning', priority: 'high', text: `${source} notice`, receivedAt: '2026-10-23T09:00:00.000Z',
  })
  const usage: ChatUsageReport = {
    status: 'allowed', receivedAt: '2026-10-23T09:00:00.000Z',
    windows: [{ key: 'five_hour', label: '5-hour window', percentUsed: 22, resetsAt: '2026-10-23T12:00:00.000Z' }],
  } as ChatUsageReport

  const seed = (overrides: Partial<Session> = {}, notifications?: ChatNotification[]) => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', events: [userEvent('u1', 'held')],
        workers: [{ workerId: 'w1', agentType: 'Explore', description: 'scanning', status: 'running', live: true, elapsedMs: 1000 }],
        ...(notifications !== undefined ? { notifications } : {}),
      }))
    })
    act(() => { useChatStore.getState().setUsage('default', usage) })
    return makeSession('chat-a', overrides)
  }

  const byId = (id: string) => renderer!.root.findAllByProps({ 'data-testid': id })
  const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
    typeof node === 'string' ? node : (node.children ?? []).map(textOf).join('')

  test('an embedded host renders the usage bar, notifications, workers and error banner', () => {
    const session = seed({}, [notice('agent', 'agent-1')])
    act(() => {
      renderer = TestRenderer.create(
        <div data-testid="host">
          <ChatSurface session={session} sendMessage={sendMessage}
            connectionStatus="connected" connectionEpoch={1} error="connection lost" />
        </div>
      )
    })
    // The strips stack above the transcript inside the host, with the error
    // banner between them and the column.
    const order = renderer!.root.findAll(node => typeof node.type === 'string' &&
      ['chat-usage', 'chat-notifications', 'chat-workers-strip', 'chat-transcript']
        .includes(node.props['data-testid'])).map(node => node.props['data-testid'])
    expect(order).toEqual(['chat-usage', 'chat-notifications', 'chat-workers-strip', 'chat-transcript'])
    const alert = renderer!.root.findByProps({ role: 'alert' })
    expect(textOf(alert)).toContain('connection lost')
    // Agent notices dismiss server-side through the surface's sendMessage.
    act(() => byId('chat-notification-close')[0]!.props.onClick())
    expect(sent).toContainEqual({ type: 'chat-dismiss-notification', sessionId: 'chat-a', key: 'agent-1' })
  })

  test('an archived embedded host filters to account notices and hides the workers strip', () => {
    const session = seed({ archivedAt: '2026-10-23T10:00:00.000Z' },
      [notice('agent', 'agent-1'), notice('account', 'login-expiry')])
    act(() => {
      renderer = TestRenderer.create(
        <div data-testid="host">
          <ChatSurface session={session} sendMessage={sendMessage}
            connectionStatus="connected" connectionEpoch={1} />
        </div>
      )
    })
    const texts = byId('chat-notification').map(textOf).join(' ')
    expect(texts).toContain('account notice')
    expect(texts).not.toContain('agent notice')
    expect(byId('chat-workers-strip')).toHaveLength(0)
    expect(byId('chat-usage')).toHaveLength(1)
  })

  test('two hosts of one session share the per-session draft last-write-wins', () => {
    const session = seed()
    act(() => {
      renderer = TestRenderer.create(<>
        <div data-testid="host-one">
          <ChatSurface session={session} sendMessage={sendMessage}
            connectionStatus="connected" connectionEpoch={1} />
        </div>
        <div data-testid="host-two">
          <ChatSurface session={session} sendMessage={sendMessage}
            connectionStatus="connected" connectionEpoch={1} />
        </div>
      </>)
    })
    const inputs = renderer!.root.findAllByType('textarea')
    expect(inputs).toHaveLength(2)
    // Typing in one host is visible in the other: the draft is per session.
    act(() => { inputs[0]!.props.onChange({ target: { value: 'shared draft text' } }) })
    expect(inputs[1]!.props.value).toBe('shared draft text')
    // A submit in the other host clears it for both.
    act(() => {
      inputs[1]!.props.onChange({ target: { value: 'shared draft text', selectionStart: 17, selectionEnd: 17 } })
    })
    const forms = renderer!.root.findAllByType('form')
    expect(forms).toHaveLength(2)
    act(() => { forms[1]!.props.onSubmit({ preventDefault: () => {} }) })
    expect(useChatStore.getState().drafts['chat-a']).toBeUndefined()
    expect(renderer!.root.findAllByType('textarea').map(node => node.props.value)).toEqual(['', ''])
    expect(sent.filter(message => message.type === 'chat-send'))
      .toEqual([{ type: 'chat-send', sessionId: 'chat-a', text: 'shared draft text' }])
  })

  test('the full-screen wrapper keeps its DOM order across the moved surface', () => {
    const session = seed({}, [notice('agent', 'agent-1')])
    act(() => {
      useChatStore.getState().setContextUsage('chat-a', {
        usedTokens: 42_000, thresholdTokens: 167_000, percentage: 25.1, at: '2026-10-23T09:00:00.000Z',
      })
    })
    act(() => {
      renderer = TestRenderer.create(<ChatView session={session} sendMessage={sendMessage}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    const order = renderer!.root.findAll(node => typeof node.type === 'string' &&
      ['chat-context-meter', 'chat-usage', 'chat-notifications', 'chat-transcript']
        .includes(node.props['data-testid'])).map(node => node.props['data-testid'])
    expect(order).toEqual(['chat-context-meter', 'chat-usage', 'chat-notifications', 'chat-transcript'])
  })
})



