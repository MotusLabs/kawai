// ChatView + history window (chat-history-window D3): a reconnect of the
// same session resumes from the window start the client holds; opening a
// chat widens only what the user expanded in this page load; and whatever
// is shown never trims while live events append. The anchor wiring of the
// load-earlier button (D4) is pinned at this level too: which ChatView
// argument reaches the hook decides whether a dropped page after a live
// append still lets the next append stick.
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

  /**
   * Mount with node mocks (chat-history-window D4): the transcript scroller
   * gets the AnchorScroller surface the history anchor touches — a fake
   * `[data-anchor-id]` row whose rect top the test controls — and every
   * other node records its scrollIntoView calls, so a test can count the
   * bottom sticks (the sentinel's scrollIntoView is the stick).
   */
  function mountWithScroller(session: Session) {
    const row = {
      top: 100,
      getBoundingClientRect: () => ({ top: row.top } as DOMRect),
      getAttribute: () => 'row-1',
    }
    // One shared object, so the test's handle IS the node the scroller ref
    // receives (a spread copy would fork scrollTop).
    const scroller = {
      scrollTop: 1230,
      scrolls: [] as ScrollIntoViewOptions[],
      scrollIntoView: (options?: ScrollIntoViewOptions) => { scroller.scrolls.push(options ?? {}) },
      getBoundingClientRect: () => ({ top: 0 } as DOMRect),
      querySelector: () => row,
      querySelectorAll: () => [row],
    }
    const nodes: Array<{ scrolls: ScrollIntoViewOptions[] }> = [scroller]
    act(() => {
      renderer = TestRenderer.create(
        <ChatView session={session} sendMessage={sendMessage} connectionStatus="connected"
          connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />,
        {
          createNodeMock: element => {
            if (String(element.props.className ?? '').includes('overflow-y-auto')) return scroller
            const node = {
              scrolls: [] as ScrollIntoViewOptions[],
              scrollIntoView: (options?: ScrollIntoViewOptions) => { node.scrolls.push(options ?? {}) },
            }
            nodes.push(node)
            return node
          },
        }
      )
    })
    const stickCount = () =>
      nodes.reduce((total, node) => total + node.scrolls.filter(options => options.block === 'end').length, 0)
    const loadEarlier = () => {
      act(() => {
        renderer!.root.findByProps({ 'data-testid': 'chat-load-earlier' }).props.onClick()
      })
    }
    return { scroller, row, stickCount, loadEarlier }
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

  const heldEvent = { id: 'u1', sequence: 0, at: '2026-10-15T09:00:00.000Z', turnId: 't1', type: 'user_message' as const, text: 'held' }
  const olderEvent = { id: 'u0', sequence: 0, at: '2026-10-14T09:00:00.000Z', turnId: 't0', type: 'user_message' as const, text: 'older' }
  const liveEvent = (id: string, sequence: number) =>
    ({ id, sequence, at: '2026-10-18T09:00:00.000Z', turnId: `t-${id}`, type: 'user_message' as const, text: `live ${id}` })

  test('a live append during a page load followed by a dropped page keeps the next append stuck to the bottom', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', events: [heldEvent], historyHasOlder: true, historyStartId: 'u1',
      }))
    })
    const { stickCount, loadEarlier } = mountWithScroller(makeSession('chat-a'))
    const initial = stickCount()
    loadEarlier()
    // A live append lands while the page flies: it sticks as usual.
    act(() => {
      useChatStore.getState().apply('chat-a', [liveEvent('u2', 1)])
    })
    expect(stickCount()).toBe(initial + 1)
    // The page resolves dropped — its beforeId no longer matches the window
    // start — so nothing prepends and the transcript's first event id is
    // unchanged: the stick skip stays disarmed.
    act(() => {
      useChatStore.getState().applyHistoryPage({
        type: 'chat-history-page', sessionId: 'chat-a', beforeId: 'drifted', events: [olderEvent], hasOlder: true,
      })
    })
    expect(useChatStore.getState().sessions['chat-a']!.events.map(event => event.id)).toEqual(['u1', 'u2'])
    expect(stickCount()).toBe(initial + 1)
    // So the next live append sticks to the bottom: a fresh bottom stick.
    act(() => {
      useChatStore.getState().apply('chat-a', [liveEvent('u3', 2)])
    })
    expect(stickCount()).toBe(initial + 2)
  })

  test('a real prepend restores the anchor and skips one stick', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', events: [heldEvent], historyHasOlder: true, historyStartId: 'u1',
      }))
    })
    const { scroller, row, stickCount, loadEarlier } = mountWithScroller(makeSession('chat-a'))
    const initial = stickCount()
    loadEarlier()
    // The page prepends above the pinned row, pushing it 520px further down.
    act(() => { row.top = 620 })
    act(() => {
      useChatStore.getState().applyHistoryPage({
        type: 'chat-history-page', sessionId: 'chat-a', beforeId: 'u1', events: [olderEvent], hasOlder: false,
      })
    })
    // The row is put back to its on-screen offset: 620 - 0 + 1230 - 100.
    expect(scroller.scrollTop).toBe(1750)
    // The prepend itself added no bottom stick: the one skip was spent on it.
    expect(stickCount()).toBe(initial)
    // And the next live append sticks again.
    act(() => {
      useChatStore.getState().apply('chat-a', [liveEvent('u2', 1)])
    })
    expect(stickCount()).toBe(initial + 1)
  })
})
