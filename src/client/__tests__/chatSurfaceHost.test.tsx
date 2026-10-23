// Embedded-host tests for the shared chat surface (plan-workspace §6.1).
// The host is the test-only embedded composition — a plain div carrying the
// palette classes around ChatSurface — demonstrating host capability the way
// F2's workspace panel will use it (no production Team/Plans wiring here).
// Pinned here: the surface drives the observable transcript/streaming/Stop
// path from an embedded host; two hosts of one session hold exactly one wire
// attach; the surviving host keeps live delivery and pages history; a
// same-commit full-screen↔embedded transfer sends no wire traffic and never
// resets the held events; a mount while offline attaches once on connect; a
// held online→offline→online transition re-attaches once with historyFrom;
// archived and approval behavior carries over whole-column. The full-screen
// regression guards stay in chatComponents/chatViewHistory/chatViewReveal.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ComponentProps, CSSProperties, ReactElement } from 'react'
import type { ClientMessage, Session } from '@shared/types'
import ChatView from '../components/chat/ChatView'
import ChatSurface from '../components/chat/ChatSurface'
import { useChatStore } from '../stores/chatStore'

const makeSession = (id: string, overrides: Partial<Session> = {}) =>
  ({
    id, name: id, projectPath: '/home/coder/kawai', status: 'waiting', kind: 'chat',
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
const assistantEvent = (id: string, text: string) =>
  ({ id, sequence: 1, at: '2026-10-23T09:00:01.000Z', turnId: `t-${id}`, messageId: `m-${id}`, type: 'assistant_text' as const, text })

/**
 * A test-only embedded host (plan-workspace §6.1): the host owns the root
 * element with the palette classes and the chat font size; the surface
 * renders the content column inside it.
 */
function EmbeddedHost({ label, children, ...surface }: { label: string } & ComponentProps<typeof ChatSurface>) {
  return <div className="chat-palette chat-root" style={{ '--chat-font-size': '15px' } as CSSProperties} data-testid={`host-${label}`}>
    <ChatSurface {...surface}>{children}</ChatSurface>
  </div>
}

describe('ChatSurface embedded hosts', () => {
  let sent: ClientMessage[]
  let sendMessage: (message: ClientMessage) => void
  let connectionStatus: 'connected' | 'connecting'
  let connectionEpoch: number
  let renderer: TestRenderer.ReactTestRenderer | null = null
  /** The AnchorScroller mock the transcript scroller ref receives. */
  let scroller: {
    scrollTop: number
    scrolls: Array<ScrollIntoViewOptions | undefined>
    getBoundingClientRect: () => DOMRect
    querySelector: () => { top: number; getBoundingClientRect: () => DOMRect; getAttribute: () => string } | null
    querySelectorAll: () => Array<{ top: number; getBoundingClientRect: () => DOMRect; getAttribute: () => string }>
    scrollIntoView: (options?: ScrollIntoViewOptions) => void
  } | null

  beforeEach(() => {
    sent = []
    sendMessage = (message) => { sent.push(message) }
    connectionStatus = 'connected'
    connectionEpoch = 1
    scroller = null
    useChatStore.setState({ sessions: {}, pendingReveal: null })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    useChatStore.setState({ sessions: {}, pendingReveal: null })
  })

  const props = (session: Session) => ({ session, sendMessage, connectionStatus, connectionEpoch })

  /**
   * Mount with a node mock for each transcript scroller (the history anchor
   * touches it during a load-earlier capture), like chatViewHistory does.
   */
  function mount(children: ReactElement) {
    const nodes: Array<{ scrolls: Array<ScrollIntoViewOptions | undefined> }> = []
    act(() => {
      renderer = TestRenderer.create(children, {
        createNodeMock: element => {
          if (String(element.props.className ?? '').includes('overflow-y-auto')) {
            const row = {
              top: 100,
              getBoundingClientRect: () => ({ top: row.top } as DOMRect),
              getAttribute: () => 'row-1',
            }
            scroller = {
              scrollTop: 1230,
              scrolls: [],
              getBoundingClientRect: () => ({ top: 0 } as DOMRect),
              querySelector: () => row,
              querySelectorAll: () => [row],
              scrollIntoView: (options?: ScrollIntoViewOptions) => { scroller!.scrolls.push(options) },
            }
            return scroller
          }
          const node = {
            scrolls: [] as Array<ScrollIntoViewOptions | undefined>,
            scrollIntoView: (options?: ScrollIntoViewOptions) => { node.scrolls.push(options) },
          }
          nodes.push(node)
          return node
        },
      })
    })
  }

  const attaches = () =>
    sent.filter((message): message is Extract<ClientMessage, { type: 'chat-attach' }> => message.type === 'chat-attach')
  const detaches = () => sent.filter(message => message.type === 'chat-detach')
  const text = (): string => {
    const collect = (value: unknown): string => {
      if (value == null || typeof value === 'boolean') return ''
      if (typeof value === 'string' || typeof value === 'number') return String(value)
      if (Array.isArray(value)) return value.map(collect).join('')
      const children = (value as { props?: { children?: unknown } }).props?.children
      return children === undefined ? '' : collect(children)
    }
    return renderer!.root.findAll(node => typeof node.type === 'string').map(node => collect(node.props.children)).join(' ')
  }

  test('an embedded host renders the transcript and streams live events', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', events: [userEvent('u1', 'held question')], activity: { phase: 'thinking', elapsedMs: 1000 },
      }))
    })
    mount(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    expect(text()).toContain('held question')
    // The live activity row follows the transcript while the agent works.
    expect(text()).toContain('Thinking')
    act(() => {
      useChatStore.getState().setActivity('chat-a', null)
      useChatStore.getState().apply('chat-a', [assistantEvent('a1', 'streamed answer')])
    })
    expect(text()).toContain('streamed answer')
    expect(text()).not.toContain('Thinking')
  })

  test('the embedded composer submits and Stops', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a' }))
    })
    mount(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    const input = renderer!.root.findByProps({ 'aria-label': 'Message Claude' })
    act(() => { input.props.onChange({ target: { value: '  hello surface  ', selectionStart: 16, selectionEnd: 16 } }) })
    act(() => { renderer!.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    expect(sent).toContainEqual({ type: 'chat-send', sessionId: 'chat-a', text: 'hello surface' })
    const stop = renderer!.root.findAll(node => node.type === 'button' && node.props.children === 'Stop')[0]!
    act(() => { stop.props.onClick() })
    expect(sent).toContainEqual({ type: 'chat-interrupt', sessionId: 'chat-a' })
  })

  test('two hosts of one session hold one attach; the survivor keeps delivery and pages history', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', events: [userEvent('u1', 'held')], historyHasOlder: true, historyStartId: 'u1',
      }))
    })
    mount(<>
      <EmbeddedHost label="a" {...props(makeSession('chat-a'))} />
      <EmbeddedHost label="b" {...props(makeSession('chat-a'))} />
    </>)
    expect(attaches()).toEqual([{ type: 'chat-attach', sessionId: 'chat-a' }])
    // Unmount one host: the survivor keeps the subscription (no detach).
    act(() => {
      renderer!.update(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    })
    expect(detaches()).toHaveLength(0)
    // The survivor still receives live delivery…
    act(() => {
      useChatStore.getState().apply('chat-a', [assistantEvent('a1', 'live to survivor')])
    })
    expect(text()).toContain('live to survivor')
    // …and pages history through its own surface wiring.
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'chat-load-earlier' }).props.onClick()
    })
    expect(sent).toContainEqual({ type: 'chat-history-page', sessionId: 'chat-a', beforeId: 'u1' })
    act(() => {
      useChatStore.getState().applyHistoryPage({
        type: 'chat-history-page', sessionId: 'chat-a', beforeId: 'u1',
        events: [userEvent('u0', 'older')], hasOlder: false,
      })
    })
    const transcript = useChatStore.getState().sessions['chat-a']!
    expect(transcript.events.map(event => event.id)).toEqual(['u0', 'u1', 'a1'])
  })

  test('a same-commit full-screen to embedded transfer sends no wire traffic and keeps events', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a', events: [userEvent('u1', 'held across hosts')],
      }))
    })
    const chatViewProps = {
      ...props(makeSession('chat-a')), error: null, onClose: () => {}, onKill: () => {},
    }
    mount(<ChatView {...chatViewProps} />)
    expect(attaches()).toEqual([{ type: 'chat-attach', sessionId: 'chat-a' }])
    act(() => {
      renderer!.update(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    })
    expect(detaches()).toHaveLength(0)
    expect(attaches()).toHaveLength(1)
    expect(text()).toContain('held across hosts')
  })

  test('a mount while offline attaches once when the connection arrives', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a', historyHasOlder: true, historyStartId: 'u1' }))
    })
    connectionStatus = 'connecting'
    connectionEpoch = 0
    mount(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    expect(attaches()).toHaveLength(0)
    connectionStatus = 'connected'
    connectionEpoch = 1
    act(() => {
      renderer!.update(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    })
    expect(attaches()).toEqual([{ type: 'chat-attach', sessionId: 'chat-a' }])
  })

  test('held online to offline to online re-attaches once with historyFrom and never detaches', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a', historyHasOlder: true, historyStartId: 'u1' }))
    })
    mount(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    expect(attaches()).toEqual([{ type: 'chat-attach', sessionId: 'chat-a' }])
    // The socket drops: the hold and the attached wire state survive.
    connectionStatus = 'connecting'
    connectionEpoch = 2
    act(() => {
      renderer!.update(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    })
    expect(detaches()).toHaveLength(0)
    expect(attaches()).toHaveLength(1)
    // Back online with a bumped epoch: exactly one reconnect attach that
    // resumes the held window.
    connectionStatus = 'connected'
    connectionEpoch = 3
    act(() => {
      renderer!.update(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    })
    expect(attaches()).toEqual([
      { type: 'chat-attach', sessionId: 'chat-a' },
      { type: 'chat-attach', sessionId: 'chat-a', historyFrom: 'u1' },
    ])
    expect(detaches()).toHaveLength(0)
  })

  test('a held reconnect with two hosts re-attaches exactly once', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a', historyHasOlder: true, historyStartId: 'u1' }))
    })
    const tree = (epoch: number) => {
      connectionEpoch = epoch
      return <>
        <EmbeddedHost label="a" {...props(makeSession('chat-a'))} />
        <EmbeddedHost label="b" {...props(makeSession('chat-a'))} />
      </>
    }
    mount(tree(1))
    expect(attaches()).toEqual([{ type: 'chat-attach', sessionId: 'chat-a' }])
    act(() => { renderer!.update(tree(2)) })
    expect(attaches()).toEqual([
      { type: 'chat-attach', sessionId: 'chat-a' },
      { type: 'chat-attach', sessionId: 'chat-a', historyFrom: 'u1' },
    ])
    expect(detaches()).toHaveLength(0)
  })

  test('a host unmounted while disconnected leaves the survivor one held reconnect', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a', historyHasOlder: true, historyStartId: 'u1' }))
    })
    const tree = () => <EmbeddedHost label="a" {...props(makeSession('chat-a'))} />
    const both = () => <>
      {tree()}
      <EmbeddedHost label="b" {...props(makeSession('chat-a'))} />
    </>
    mount(both())
    expect(attaches()).toHaveLength(1)
    // The socket drops; host b closes while offline. The survivor keeps its hold.
    connectionStatus = 'connecting'
    connectionEpoch = 2
    act(() => { renderer!.update(tree()) })
    expect(detaches()).toHaveLength(0)
    // Back online: exactly one reconnect attach for the survivor.
    connectionStatus = 'connected'
    connectionEpoch = 3
    act(() => { renderer!.update(tree()) })
    expect(attaches()).toEqual([
      { type: 'chat-attach', sessionId: 'chat-a' },
      { type: 'chat-attach', sessionId: 'chat-a', historyFrom: 'u1' },
    ])
    expect(detaches()).toHaveLength(0)
  })

  test('an archived session renders read-only with a working Restore bar', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({ sessionId: 'chat-a', events: [userEvent('u1', 'archived talk')] }))
    })
    mount(<EmbeddedHost label="a" {...props(makeSession('chat-a', { archivedAt: '2026-10-23T00:00:00.000Z' }))} />)
    expect(text()).toContain('archived talk')
    expect(renderer!.root.findAllByType('textarea')).toHaveLength(0)
    expect(renderer!.root.findAllByType('form')).toHaveLength(0)
    expect(renderer!.root.findByProps({ 'data-testid': 'chat-archived-bar' })).toBeDefined()
    const restore = renderer!.root.findAll(node => node.type === 'button' && node.props.children === 'Restore')[0]!
    act(() => { restore.props.onClick() })
    expect(sent).toContainEqual({ type: 'chat-restore', sessionId: 'chat-a' })
  })

  test('a pending approval renders in the embedded host and answers through the surface', () => {
    act(() => {
      useChatStore.getState().snapshot(snapshotMessage({
        sessionId: 'chat-a',
        pendingRequests: [{ kind: 'approval', requestId: 'r1', tool: 'Bash', input: { command: 'ls' }, at: '2026-10-23T09:00:00.000Z' }],
      }))
    })
    mount(<EmbeddedHost label="a" {...props(makeSession('chat-a'))} />)
    expect(text()).toContain('Approve Bash?')
    const allow = renderer!.root.findAll(node => node.type === 'button' && node.props.children === 'Allow')[0]!
    act(() => { allow.props.onClick() })
    expect(sent).toContainEqual({ type: 'chat-approval', sessionId: 'chat-a', requestId: 'r1', decision: 'allow' })
  })
})
