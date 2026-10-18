// ChatView + history window (chat-history-window D3): a reconnect of the
// same session resumes from the window start the client holds; opening a
// chat widens only what the user expanded in this page load; and whatever
// is shown never trims while live events append.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, Session } from '@shared/types'
import ChatView from '../components/chat/ChatView'
import { emptyTranscript, useChatStore } from '../stores/chatStore'

const makeSession = (id: string) =>
  ({
    id, name: id, projectPath: '/home/coder/kawai', status: 'waiting', kind: 'chat',
    approvalPolicy: 'manual',
  }) as unknown as Session

type SnapshotMessage = Parameters<ReturnType<typeof useChatStore.getState>['snapshot']>[0]
const snapshotMessage = (overrides: Partial<SnapshotMessage> = {}) =>
  // Snapshot literals in these tests only override the window fields.
  ({
    type: 'chat-snapshot' as const, sessionId: 'chat-a', profileId: 'default', status: 'waiting' as const,
    throughSequence: 0, events: [], pendingRequests: [],
    commands: { status: 'unavailable' as const, commands: [] }, activity: null,
    contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    ...overrides,
  }) as SnapshotMessage

describe('ChatView history window', () => {
  let sent: ClientMessage[]
  let sendMessage: (message: ClientMessage) => void
  let renderer: TestRenderer.ReactTestRenderer | null = null

  beforeEach(() => {
    sent = []
    sendMessage = (message) => { sent.push(message) }
    useChatStore.setState({ sessions: {}, pendingReveal: null })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    useChatStore.setState({ sessions: {}, pendingReveal: null })
  })

  function mount(session: Session, connectionEpoch = 0) {
    act(() => {
      renderer = TestRenderer.create(
        <ChatView session={session} sendMessage={sendMessage} connectionStatus="connected"
          connectionEpoch={connectionEpoch} error={null} onClose={() => {}} onKill={() => {}} />
      )
    })
  }

  function rerender(session: Session, connectionEpoch: number) {
    const current = renderer
    if (!current) throw new Error('not mounted')
    act(() => {
      current.update(
        <ChatView session={session} sendMessage={sendMessage} connectionStatus="connected"
          connectionEpoch={connectionEpoch} error={null} onClose={() => {}} onKill={() => {}} />
      )
    })
  }

  const lastAttach = (): Extract<ClientMessage, { type: 'chat-attach' }> | undefined =>
    sent.findLast((message): message is Extract<ClientMessage, { type: 'chat-attach' }> => message.type === 'chat-attach')

  test('a reconnect of the same session sends historyFrom from the held window', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', historyHasOlder: true, historyStartId: 'hist-a',
      }))
    })
    mount(makeSession('chat-a'))
    expect(lastAttach()).toEqual({ type: 'chat-attach', sessionId: 'chat-a' })
    rerender(makeSession('chat-a'), 1)
    expect(lastAttach()).toEqual({ type: 'chat-attach', sessionId: 'chat-a', historyFrom: 'hist-a' })
  })

  test('reopening an unexpanded chat sends no historyFrom', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', historyHasOlder: true, historyStartId: 'hist-a',
      }))
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-b', historyHasOlder: true, historyStartId: 'hist-b',
      }))
    })
    mount(makeSession('chat-a'))
    rerender(makeSession('chat-b'), 0)
    expect(lastAttach()).toEqual({ type: 'chat-attach', sessionId: 'chat-b' })
  })

  test('reopening an expanded chat resumes from the oldest loaded turn', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', historyHasOlder: true, historyStartId: 'hist-a',
      }))
      useChatStore.setState({
        sessions: {
          ...useChatStore.getState().sessions,
          'chat-b': {
            ...emptyTranscript(),
            historyHasOlder: true, historyStartId: 'hist-b', historyExpanded: true,
          },
        },
      })
    })
    mount(makeSession('chat-a'))
    rerender(makeSession('chat-b'), 0)
    expect(lastAttach()).toEqual({ type: 'chat-attach', sessionId: 'chat-b', historyFrom: 'hist-b' })
  })

  test('live events append while shown; nothing is trimmed from the top', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a',
        events: [
          { id: 'u1', sequence: 0, at: '2026-10-15T09:00:00.000Z', turnId: 't1', type: 'user_message', text: 'held' },
          { id: 'u2', sequence: 0, at: '2026-10-17T09:00:00.000Z', turnId: 't2', type: 'user_message', text: 'windowed' },
        ],
        historyHasOlder: true, historyStartId: 'u1',
      }))
    })
    mount(makeSession('chat-a'))
    act(() => {
      useChatStore.getState().apply('chat-a', [
        { id: 'u3', sequence: 1, at: '2026-10-18T09:00:00.000Z', turnId: 't3', type: 'user_message', text: 'newer' },
      ])
    })
    const transcript = useChatStore.getState().sessions['chat-a']!
    expect(transcript.events.map(event => event.id)).toEqual(['u1', 'u2', 'u3'])
  })
})
