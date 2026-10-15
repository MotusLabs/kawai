// ChatView + search reveal (chat-session-search D5): a pending reveal scrolls
// to its row instead of the bottom of the transcript; without one the view
// still sticks to the bottom.
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import ChatView from '../components/chat/ChatView'
import { useChatStore } from '../stores/chatStore'

const session = {
  id: 'chat-r', name: 'Reveal', projectPath: '/home/coder/kawai', status: 'waiting', kind: 'chat',
  approvalPolicy: 'manual',
} as unknown as Session

interface FakeNode {
  role: string
  scrolls: ScrollIntoViewOptions[]
  classes: Set<string>
  tagName: string
  open?: boolean
  scrollIntoView(options?: ScrollIntoViewOptions): void
  querySelector(selector: string): FakeNode | null
  classList: { add(token: string): void; remove(token: string): void }
  setSelectionRange(): void
  focus(): void
}

function fakeNode(role: string, row?: FakeNode): FakeNode {
  const node: FakeNode = {
    role, scrolls: [], classes: new Set(), tagName: 'ARTICLE',
    scrollIntoView: options => { node.scrolls.push(options ?? {}) },
    querySelector: () => row ?? null,
    classList: { add: token => { node.classes.add(token) }, remove: token => { node.classes.delete(token) } },
    setSelectionRange: () => {}, focus: () => {},
  }
  return node
}

function seedTranscript() {
  act(() => {
    useChatStore.getState().snapshot({
      type: 'chat-snapshot', sessionId: session.id, profileId: 'default', status: 'waiting', throughSequence: 0,
      events: [{ id: 'u1', sequence: 0, at: '2026-10-15T09:00:00.000Z', turnId: 't', type: 'user_message', text: 'hello' }],
      pendingRequests: [], commands: { status: 'unavailable', commands: [] }, activity: null,
      contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null,
    })
  })
}

function mount() {
  const row = fakeNode('row')
  const nodes: FakeNode[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <ChatView session={session} sendMessage={() => {}} connectionStatus="connected"
        connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />,
      {
        createNodeMock: element => {
          // The transcript scroller and the bottom sentinel are the two divs
          // the test cares about; everything else just needs to tolerate refs.
          const role = String(element.props.className ?? '').includes('overflow-y-auto') ? 'scroller' : 'node'
          const node = fakeNode(role, role === 'scroller' ? row : undefined)
          nodes.push(node)
          return node
        },
      }
    )
  })
  return { renderer, row, scrolledToEnd: () => nodes.some(node => node.role === 'node' && node.scrolls.some(s => s.block === 'end')) }
}

describe('ChatView search reveal', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    useChatStore.setState({ sessions: {}, pendingReveal: null })
  })
  afterEach(() => {
    jest.useRealTimers()
    useChatStore.setState({ sessions: {}, pendingReveal: null })
  })

  test('without a reveal the transcript sticks to the bottom', () => {
    seedTranscript()
    const { renderer, scrolledToEnd } = mount()
    expect(scrolledToEnd()).toBe(true)
    act(() => renderer.unmount())
  })

  test('a pending reveal scrolls to its row and the bottom stick yields', () => {
    seedTranscript()
    useChatStore.getState().requestReveal(session.id, 'u1')
    const { renderer, row, scrolledToEnd } = mount()
    expect(row.scrolls).toEqual([{ block: 'center' }])
    expect(row.classes.has('chat-reveal')).toBe(true)
    expect(scrolledToEnd()).toBe(false)
    expect(useChatStore.getState().pendingReveal).toBeNull()
    act(() => renderer.unmount())
  })

  test('a reveal waits for the transcript to arrive, then lands there', () => {
    useChatStore.getState().requestReveal(session.id, 'u1')
    const { renderer, row } = mount()
    expect(row.scrolls).toEqual([])
    expect(useChatStore.getState().pendingReveal).not.toBeNull()
    seedTranscript()
    expect(row.scrolls).toEqual([{ block: 'center' }])
    act(() => renderer.unmount())
  })
})
