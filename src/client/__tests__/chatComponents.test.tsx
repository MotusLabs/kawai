import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ChatCommandState, ChatWireFrame } from '@shared/chat'
import type { ClientMessage, Session } from '@shared/types'
import ChatRequests from '../components/chat/ChatRequests'
import ChatMessages from '../components/chat/ChatMessages'
import ChatDebugPanel from '../components/chat/ChatDebugPanel'
import ChatView from '../components/chat/ChatView'
import { closedDebugView, useChatDebugStore, type ChatDebugView } from '../stores/chatDebugStore'
import { useChatStore } from '../stores/chatStore'

describe('chat components', () => {
  test('approval cards send allow and deny without hiding the pending request locally', () => {
    const sent: ClientMessage[] = []
    const renderer = TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={false} sendMessage={message => sent.push(message)}
      requests={[{ kind: 'approval', requestId: 'r', tool: 'Bash', input: { command: 'ls' }, at: 'now' }]} />)
    const buttons = renderer.root.findAllByType('button')
    act(() => { buttons[0]!.props.onClick(); buttons[1]!.props.onClick() })
    expect(sent).toEqual([
      { type: 'chat-approval', sessionId: 'chat-1', requestId: 'r', decision: 'allow' },
      { type: 'chat-approval', sessionId: 'chat-1', requestId: 'r', decision: 'deny' },
    ])
    expect(renderer.root.findAllByType('section')).toHaveLength(1)
    renderer.unmount()
  })

  test('question forms submit multiple selections and free text', () => {
    const sent: ClientMessage[] = []
    const renderer = TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={false} sendMessage={message => sent.push(message)}
      requests={[{ kind: 'question', requestId: 'q', at: 'now', questions: [{ question: 'Choose colors', header: 'Colors', multiSelect: true,
        options: [{ label: 'Blue' }, { label: 'Green' }] }] }]} />)
    expect(renderer.root.findByType('button').props.disabled).toBe(true)
    act(() => renderer.root.findAllByType('input')[0]!.props.onChange({ target: { checked: true } }))
    act(() => renderer.root.findAllByType('input')[1]!.props.onChange({ target: { checked: true } }))
    act(() => renderer.root.findAllByType('input')[2]!.props.onChange({ target: { value: 'and purple' } }))
    act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
    expect(sent).toEqual([{ type: 'chat-answer', sessionId: 'chat-1', requestId: 'q', answers: {
      'Choose colors': { options: ['Blue', 'Green'], text: 'and purple' },
    } }])
    renderer.unmount()
  })

  test('assistant markdown and tool activity render without executing raw HTML', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'assistant_text', id: 'a', sequence: 0, at: 'now', turnId: 't', messageId: 'm', text: '**Hello** <script>bad()</script>' },
      { type: 'tool_call', id: 'b', sequence: 0, at: 'now', turnId: 't', toolCallId: 'tool-1', tool: 'Read', input: { path: 'file.ts' } },
    ]} />)
    expect(renderer.root.findByType('strong').children).toEqual(['Hello'])
    expect(renderer.root.findAllByType('script')).toHaveLength(0)
    expect(renderer.root.findByType('summary').children).toEqual(['Tool: ', 'Read'])
    renderer.unmount()
  })

  test('command output renders as a muted markdown block', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'command_output', id: 'c', sequence: 0, at: 'now', turnId: 't', text: 'Context usage: **12%** of the window.' },
    ]} />)
    const block = renderer.root.findByProps({ 'data-testid': 'chat-command-output' })
    expect(block.props.className).toContain('text-secondary')
    expect(textOf(block)).toContain('Command output')
    // Markdown renders (bold), inside the monospace container.
    expect(renderer.root.findByType('strong').children).toEqual(['12%'])
    expect(block.children.some(child => typeof child === 'object' && String(child.props.className).includes('font-mono'))).toBe(true)
    renderer.unmount()
  })
})

const chatSession = { id: 'chat-1', name: 'Chat', projectPath: '/tmp/project', status: 'waiting', kind: 'chat' } as unknown as Session
const wireFrame = (seq: number, raw: string, dir: ChatWireFrame['dir'] = 'in'): ChatWireFrame => ({ seq, at: '2026-10-05T12:00:00.000Z', dir, raw })
const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
const buttonNamed = (root: ReactTestInstance, name: string) =>
  root.findAllByType('button').find(button => textOf(button) === name)!

describe('chat archive view', () => {
  // Loose holder so the confirm stub can replace `window` without matching
  // the full DOM Window type.
  const windowSlot = globalThis as { window?: unknown }
  const originalWindow = windowSlot.window
  let confirmResult = true
  const confirmCalls: string[] = []

  afterEach(() => {
    windowSlot.window = originalWindow
    useChatDebugStore.setState({ views: {} })
  })

  function renderArchiveView(session: Session) {
    confirmCalls.length = 0
    windowSlot.window = {
      confirm: (message?: string) => {
        confirmCalls.push(message ?? '')
        return confirmResult
      },
    }
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    return { sent, renderer }
  }

  test('archiving an idle chat sends chat-archive without confirmation', () => {
    const { sent, renderer } = renderArchiveView(chatSession)
    expect(confirmCalls).toHaveLength(0)
    act(() => { renderer.root.findByProps({ 'data-testid': 'chat-archive-button' }).props.onClick() })
    expect(confirmCalls).toHaveLength(0)
    expect(sent).toContainEqual({ type: 'chat-archive', sessionId: 'chat-1' })
    renderer.unmount()
  })

  test('archiving a working chat asks first and sends on confirmation', () => {
    const working = { ...chatSession, status: 'working' } as Session
    confirmResult = true
    const { sent, renderer } = renderArchiveView(working)
    act(() => { renderer.root.findByProps({ 'data-testid': 'chat-archive-button' }).props.onClick() })
    expect(confirmCalls).toHaveLength(1)
    expect(sent).toContainEqual({ type: 'chat-archive', sessionId: 'chat-1' })
    renderer.unmount()
  })

  test('declining the confirmation keeps the turn running', () => {
    const working = { ...chatSession, status: 'working' } as Session
    confirmResult = false
    const { sent, renderer } = renderArchiveView(working)
    act(() => { renderer.root.findByProps({ 'data-testid': 'chat-archive-button' }).props.onClick() })
    expect(confirmCalls).toHaveLength(1)
    expect(sent.filter(message => message.type === 'chat-archive')).toEqual([])
    renderer.unmount()
  })

  test('an archived chat renders read-only with a Restore bar', () => {
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const { sent, renderer } = renderArchiveView(archived)

    // Attach still requests a snapshot; no agent is started for it.
    expect(sent).toContainEqual({ type: 'chat-attach', sessionId: 'chat-1' })
    // Read-only: no composer, Stop, Archive button, or request actions.
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0)
    expect(renderer.root.findAllByType('form')).toHaveLength(0)
    expect(buttonNamed(renderer.root, 'Stop')).toBeUndefined()
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-archive-button' })).toHaveLength(0)
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-archived-bar' }))).toContain('Archived')
    expect(renderer.root.findByProps({ 'data-testid': 'chat-status' }).children).toContain('archived')
    // Kill stays available for archived chats.
    expect(buttonNamed(renderer.root, 'Kill session')).toBeTruthy()

    // Restore sends chat-restore.
    act(() => { buttonNamed(renderer.root, 'Restore').props.onClick() })
    expect(sent).toContainEqual({ type: 'chat-restore', sessionId: 'chat-1' })
    renderer.unmount()
  })
})

describe('chat debug view', () => {
  afterEach(() => useChatDebugStore.setState({ views: {} }))

  function renderView(connectionEpoch = 0) {
    const sent: ClientMessage[] = []
    const props = {
      session: chatSession, sendMessage: (message: ClientMessage) => { sent.push(message) },
      connectionStatus: 'connected' as const, connectionEpoch, error: null, onClose: () => {}, onKill: () => {},
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatView {...props} />) })
    return { sent, renderer, props }
  }
  const debugMessages = (sent: ClientMessage[]) => sent.filter(message => message.type.startsWith('chat-debug'))

  test('the Debug toggle opens and closes the panel and its subscription', () => {
    const { sent, renderer } = renderView()
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(0)
    expect(debugMessages(sent)).toEqual([])
    act(() => buttonNamed(renderer.root, 'Debug').props.onClick())
    expect(buttonNamed(renderer.root, 'Debug').props['aria-pressed']).toBe(true)
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(1)
    expect(debugMessages(sent)).toEqual([{ type: 'chat-debug-open', sessionId: 'chat-1' }])
    act(() => buttonNamed(renderer.root, 'Debug').props.onClick())
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(0)
    expect(debugMessages(sent)).toEqual([
      { type: 'chat-debug-open', sessionId: 'chat-1' }, { type: 'chat-debug-close', sessionId: 'chat-1' },
    ])
    // The conversation stays mounted throughout.
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-transcript' })).toHaveLength(1)
    renderer.unmount()
  })

  test('a reconnect re-opens the debug subscription and awaits a fresh page', () => {
    const { sent, renderer, props } = renderView()
    act(() => buttonNamed(renderer.root, 'Debug').props.onClick())
    act(() => { useChatDebugStore.getState().apply({ type: 'chat-debug-frames', sessionId: 'chat-1', frames: [], page: true, hasOlder: false }) })
    expect(useChatDebugStore.getState().views['chat-1']!.awaitingOpen).toBe(false)
    act(() => renderer.update(<ChatView {...props} connectionEpoch={1} />))
    expect(debugMessages(sent)).toEqual([
      { type: 'chat-debug-open', sessionId: 'chat-1' },
      { type: 'chat-debug-close', sessionId: 'chat-1' },
      { type: 'chat-debug-open', sessionId: 'chat-1' },
    ])
    expect(useChatDebugStore.getState().views['chat-1']!.awaitingOpen).toBe(true)
    renderer.unmount()
  })

  function renderPanel(view: ChatDebugView) {
    const sent: ClientMessage[] = []
    let closed = 0
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatDebugPanel sessionId="chat-1" view={view} connected
        sendMessage={message => { sent.push(message) }} onClose={() => { closed += 1 }} />)
    })
    return { sent, renderer, closed: () => closed }
  }
  const openView = (frames: ChatWireFrame[], hasOlder = false): ChatDebugView => ({ ...closedDebugView(), open: true, frames, hasOlder })

  test('rows show direction, seq, and type; a row expands to pretty JSON', () => {
    const { renderer } = renderPanel(openView([
      wireFrame(1, '{"event":"spawn","command":"claude"}', 'lifecycle'),
      wireFrame(2, '{"type":"control_request","request":{"subtype":"can_use_tool"}}'),
    ]))
    const row = renderer.root.findByProps({ 'data-frame-seq': 2 })
    expect(textOf(row)).toContain('← Claude')
    expect(textOf(row)).toContain('#2')
    expect(textOf(row)).toContain('control_request · can_use_tool')
    expect(row.findAllByType('pre')).toHaveLength(0)
    act(() => row.findAllByType('button')[0]!.props.onClick())
    expect(row.findByType('pre').children.join('')).toBe(JSON.stringify(JSON.parse('{"type":"control_request","request":{"subtype":"can_use_tool"}}'), null, 2))
    act(() => row.findAllByType('button')[0]!.props.onClick())
    expect(row.findAllByType('pre')).toHaveLength(0)
    renderer.unmount()
  })

  test('Copy copies the raw line exactly as exchanged', () => {
    const raw = '{"type":"user",  "message":{"content":"hi"}}'
    const { renderer } = renderPanel(openView([wireFrame(1, raw, 'out')]))
    const row = renderer.root.findByProps({ 'data-frame-seq': 1 })
    act(() => row.findAllByType('button')[0]!.props.onClick())
    const originalDocument = globalThis.document
    const copied: string[] = []
    const textarea = { value: '', style: {}, focus: () => {}, select: () => {} }
    globalThis.document = {
      createElement: () => textarea,
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand: () => { copied.push(textarea.value); return true },
    } as unknown as Document
    try {
      act(() => buttonNamed(row, 'Copy').props.onClick())
    } finally {
      globalThis.document = originalDocument
    }
    expect(copied).toEqual([raw])
    renderer.unmount()
  })

  test('Load older requests the page before the oldest loaded frame', () => {
    useChatDebugStore.getState().beginOpen('chat-1')
    const { sent, renderer } = renderPanel(openView([wireFrame(7, '{}'), wireFrame(8, '{}')], true))
    act(() => buttonNamed(renderer.root, 'Load older').props.onClick())
    expect(sent).toEqual([{ type: 'chat-debug-page', sessionId: 'chat-1', beforeSeq: 7 }])
    expect(useChatDebugStore.getState().views['chat-1']!.loadingOlder).toBe(true)
    renderer.unmount()
  })

  test('empty and loading states, and Close', () => {
    const empty = renderPanel(openView([]))
    expect(textOf(empty.renderer.root)).toContain('No protocol traffic recorded for this session yet.')
    act(() => buttonNamed(empty.renderer.root, 'Close').props.onClick())
    expect(empty.closed()).toBe(1)
    empty.renderer.unmount()
    const loading = renderPanel({ ...openView([]), awaitingOpen: true })
    expect(textOf(loading.renderer.root)).toContain('Loading…')
    expect(loading.renderer.root.findAllByType('button').map(textOf)).not.toContain('Load older')
    loading.renderer.unmount()
  })
})

describe('slash-command menu', () => {
  const READY_COMMANDS: ChatCommandState = {
    status: 'ready',
    commands: [
      { name: 'clear', description: 'Start a new session', argumentHint: '[name]', aliases: ['reset', 'new'], source: 'builtin' },
      { name: 'context', description: 'Show context usage', aliases: ['ctx'], source: 'builtin' },
      { name: 'compact', description: 'Compact the conversation', aliases: [], source: 'builtin' },
      { name: 'openspec-explore', description: 'Explore ideas', aliases: [], source: 'project' },
      { name: 'my-skill', description: 'A personal skill', aliases: [], source: 'user' },
    ],
  }

  afterEach(() => useChatStore.setState({ sessions: {} }))

  function renderComposer(commands: ChatCommandState, session: Session = chatSession) {
    useChatStore.getState().setCommands({ type: 'chat-commands', sessionId: session.id, state: commands })
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    const type = (value: string) =>
      act(() => { renderer.root.findByType('textarea').props.onChange({ target: { value } }) })
    const key = (keyName: string) =>
      act(() => { renderer.root.findByType('textarea').props.onKeyDown({
        key: keyName, preventDefault: () => {}, currentTarget: { form: { requestSubmit: () => submit() } } }) })
    const submit = () =>
      act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    return { sent, renderer, type, key, submit }
  }

  test('opens on a bare slash, filters, and stays closed otherwise', () => {
    const h = renderComposer(READY_COMMANDS)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.type('/')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(1)
    h.type('/co')
    const menu = h.renderer.root.findByProps({ 'data-testid': 'slash-command-menu' })
    expect(menu.findAllByProps({ role: 'option' }).map(option => option.props['data-command-name']))
      .toEqual(['context', 'compact'])
    h.type('/context arg') // args started: the menu closes
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.renderer.unmount()
  })

  test('shows loading while the list is not ready, and nothing when unavailable', () => {
    const loading = renderComposer({ status: 'loading', commands: [] })
    loading.type('/')
    expect(loading.renderer.root.findByProps({ 'data-testid': 'slash-command-loading' })).toBeDefined()
    loading.renderer.unmount()
    const unavailable = renderComposer({ status: 'unavailable', commands: [] })
    unavailable.type('/')
    expect(unavailable.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    unavailable.renderer.unmount()
  })

  test('keyboard: Up/Down move, Enter inserts with the hint, nothing is sent', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/c')
    h.key('ArrowDown') // clear -> context
    h.key('ArrowDown') // context -> compact
    h.key('ArrowUp')   // compact -> context
    h.key('Enter')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('/context ')
    // The argument hint shows for a command that has one…
    h.type('/clear ')
    expect(h.renderer.root.findByProps({ 'data-testid': 'command-argument-hint' }).children)
      .toEqual(['/', 'clear', ' ', '[name]'])
    // …and typing arguments replaces it.
    h.type('/clear demo')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'command-argument-hint' })).toHaveLength(0)
    // No message went to the agent while choosing.
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
    h.renderer.unmount()
  })

  test('Tab also chooses; Escape closes without changing the text', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/com')
    h.key('Tab')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('/compact ')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.type('/c')
    h.key('Escape')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('/c')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.renderer.unmount()
  })

  test('Enter without matches is not captured: the typed command submits', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/zzz')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(1)
    h.submit()
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([
      { type: 'chat-send', sessionId: 'chat-1', text: '/zzz' },
    ])
    h.renderer.unmount()
  })

  test('pointer selection chooses on click; project and user commands are tagged', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/')
    const options = h.renderer.root.findByProps({ 'data-testid': 'slash-command-menu' })
      .findAllByProps({ role: 'option' })
    const explore = options.find(option => option.props['data-command-name'] === 'openspec-explore')!
    expect(explore.findByProps({ 'data-testid': 'command-source-tag' }).children).toEqual(['project'])
    const skill = options.find(option => option.props['data-command-name'] === 'my-skill')!
    expect(skill.findByProps({ 'data-testid': 'command-source-tag' }).children).toEqual(['user'])
    act(() => { explore.props.onClick() })
    expect(h.renderer.root.findByType('textarea').props.value).toBe('/openspec-explore ')
    h.renderer.unmount()
  })

  test('archived chats have no composer and no menu', () => {
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const h = renderComposer(READY_COMMANDS, archived)
    expect(h.renderer.root.findAllByType('textarea')).toHaveLength(0)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.renderer.unmount()
  })
})
