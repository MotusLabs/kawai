import { afterEach, describe, expect, jest, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ChatActivity, ChatCommandState, ChatEvent, ChatPendingRequest, ChatWireFrame } from '@shared/chat'
import type { ClientMessage, ServerMessage, Session } from '@shared/types'
import ChatRequests from '../components/chat/ChatRequests'
import ChatMessages from '../components/chat/ChatMessages'
import ChatDebugPanel from '../components/chat/ChatDebugPanel'
import ChatView from '../components/chat/ChatView'
import ChatActivityRow from '../components/chat/ChatActivityRow'
import { closedDebugView, useChatDebugStore, type ChatDebugView } from '../stores/chatDebugStore'
import { emptyTranscript, useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'

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
    expect(block.props.className).toContain('font-mono')
    expect(textOf(block)).toContain('Command output')
    // Markdown renders (bold), inside the monospace container.
    expect(renderer.root.findByType('strong').children).toEqual(['12%'])
    renderer.unmount()
  })

  test('assistant text renders headings, tables and strikethrough as elements', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'assistant_text', id: 'a', sequence: 0, at: 'now', turnId: 't', messageId: 'm',
        text: '## Heading\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~' },
    ]} />)
    expect(renderer.root.findByType('h2').children).toEqual(['Heading'])
    expect(renderer.root.findByType('table')).toBeTruthy()
    expect(renderer.root.findByType('del').children).toEqual(['gone'])
    renderer.unmount()
  })

  test('user messages keep markdown syntax literal', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'user_message', id: 'u', sequence: 0, at: 'now', turnId: 't', text: '**not bold**' },
    ]} />)
    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('**not bold**')
    expect(renderer.root.findAllByType('strong')).toHaveLength(0)
    renderer.unmount()
  })
})

const chatSession = { id: 'chat-1', name: 'Chat', projectPath: '/tmp/project', status: 'waiting', kind: 'chat' } as unknown as Session
const wireFrame = (seq: number, raw: string, dir: ChatWireFrame['dir'] = 'in'): ChatWireFrame => ({ seq, at: '2026-10-05T12:00:00.000Z', dir, raw })
const deltaFrame = (seq: number, dir: ChatWireFrame['dir'] = 'in'): ChatWireFrame =>
  wireFrame(seq, JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta' } }), dir)
const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
const buttonNamed = (root: ReactTestInstance, name: string) =>
  root.findAllByType('button').find(button => textOf(button) === name)!
/** Runs `run` with a stubbed document capturing every copied string. */
const withClipboard = (run: () => void): string[] => {
  const copied: string[] = []
  const originalDocument = globalThis.document
  const textarea = { value: '', style: {}, focus: () => {}, select: () => {} }
  globalThis.document = {
    createElement: () => textarea,
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => { copied.push(textarea.value); return true },
  } as unknown as Document
  try { run() } finally { globalThis.document = originalDocument }
  return copied
}

describe('chat approval policy', () => {
  afterEach(() => useChatDebugStore.setState({ views: {} }))

  function renderPolicyView(session: Session) {
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

  test('a manual session shows an unpressed toggle that switches to auto', () => {
    const { sent, renderer } = renderPolicyView(chatSession)
    const toggle = renderer.root.findByProps({ 'data-testid': 'chat-approval-policy' })
    expect(toggle.props['aria-pressed']).toBe(false)
    expect(toggle.props.className).not.toContain('btn-approval-on')
    act(() => { toggle.props.onClick() })
    expect(sent).toContainEqual({ type: 'chat-set-approval-policy', sessionId: 'chat-1', policy: 'auto' })
    renderer.unmount()
  })

  test('an auto session shows a pressed, amber toggle that switches back', () => {
    const auto = { ...chatSession, approvalPolicy: 'auto' } as Session
    const { sent, renderer } = renderPolicyView(auto)
    const toggle = renderer.root.findByProps({ 'data-testid': 'chat-approval-policy' })
    expect(toggle.props['aria-pressed']).toBe(true)
    expect(toggle.props.className).toContain('btn-approval-on')
    act(() => { toggle.props.onClick() })
    expect(sent).toContainEqual({ type: 'chat-set-approval-policy', sessionId: 'chat-1', policy: 'manual' })
    renderer.unmount()
  })

  test('an archived chat hides the approval-policy control', () => {
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const { renderer } = renderPolicyView(archived)
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-approval-policy' })).toHaveLength(0)
    renderer.unmount()
  })

  test('policy grants render as auto-approved; user decisions stay distinct', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'request_resolved', id: 'p', sequence: 0, at: 'now', requestId: 'r1', outcome: 'allowed', decidedBy: 'policy', tool: 'Bash' },
      { type: 'request_resolved', id: 'u', sequence: 1, at: 'now', requestId: 'r2', outcome: 'allowed', decidedBy: 'user' },
      { type: 'request_resolved', id: 'd', sequence: 2, at: 'now', requestId: 'r3', outcome: 'denied', decidedBy: 'user' },
      { type: 'request_resolved', id: 'c', sequence: 3, at: 'now', requestId: 'r4', outcome: 'cancelled' },
    ]} />)
    const paragraphTexts = renderer.root.findAllByType('p').map(node => textOf(node))
    expect(paragraphTexts).toContain('Auto-approved Bash')
    expect(paragraphTexts).toContain('Allowed by user')
    expect(paragraphTexts).toContain('Denied by user')
    expect(paragraphTexts).toContain('Request cancelled')
    renderer.unmount()
  })
})

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

  test('a run of frames renders as one collapsed group row with count and ranges', () => {
    const frames = Array.from({ length: 20 }, (_, index) => deltaFrame(index + 1))
    const { renderer } = renderPanel(openView(frames))
    const group = renderer.root.findByProps({ 'data-group-seq': 1 })
    const text = textOf(group)
    expect(text).toContain('← Claude')
    expect(text).toContain('#1–#20')
    expect(text).toContain('stream_event · content_block_delta')
    expect(text).toContain('×20')
    expect(group.findAllByType('button')[0]!.props['aria-expanded']).toBe(false)
    // Collapsed: no member rows are rendered.
    expect(group.findAllByProps({ 'data-frame-seq': 1 })).toHaveLength(0)
    renderer.unmount()
  })

  test('expanding a group lists member rows with pretty JSON and Copy all joins raw lines', () => {
    const frames = [
      wireFrame(1, JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: 1 } })),
      wireFrame(2, JSON.stringify({ type: 'system', subtype: 'thinking_tokens' })),
      wireFrame(3, JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: 3 } })),
    ]
    const { renderer } = renderPanel(openView(frames))
    const group = renderer.root.findByProps({ 'data-group-seq': 1 })
    // ×N counts the run's delta frames; absorbed thinking_tokens report on top.
    expect(textOf(group)).toContain('×2')
    expect(textOf(group)).toContain('+1 thinking_tokens')
    act(() => { group.findAllByType('button')[0]!.props.onClick() })
    expect(group.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    const members = frames.map((_, index) => group.findByProps({ 'data-frame-seq': index + 1 }))

    // A member expands to pretty JSON like an ungrouped row.
    act(() => { members[1]!.findAllByType('button')[0]!.props.onClick() })
    expect(members[1]!.findByType('pre').children.join('')).toBe(JSON.stringify(JSON.parse(frames[1]!.raw), null, 2))

    // A member copies its raw line; Copy all joins every member's raw line.
    let memberCopy: string[] = []
    let allCopy: string[] = []
    act(() => { memberCopy = withClipboard(() => buttonNamed(members[1]!, 'Copy').props.onClick()) })
    act(() => { allCopy = withClipboard(() => buttonNamed(group, 'Copy all').props.onClick()) })
    expect(memberCopy).toEqual([frames[1]!.raw])
    expect(allCopy).toEqual([frames.map(frame => frame.raw).join('\n')])
    renderer.unmount()
  })

  test('a group grows in place and stays expanded across live and older frames', () => {
    const { renderer } = renderPanel(openView([deltaFrame(1), deltaFrame(2)]))
    const group = renderer.root.findByProps({ 'data-group-seq': 1 })
    act(() => { group.findAllByType('button')[0]!.props.onClick() })
    const update = (frames: ChatWireFrame[]) => act(() => {
      renderer.update(<ChatDebugPanel sessionId="chat-1" view={openView(frames)} connected
        sendMessage={() => {}} onClose={() => {}} />)
    })

    // A live frame of the same type joins the expanded group; no new row.
    update([deltaFrame(1), deltaFrame(2), deltaFrame(3)])
    const grown = renderer.root.findByProps({ 'data-group-seq': 1 })
    expect(grown.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    expect(textOf(grown)).toContain('×3')
    expect(grown.findAllByProps({ 'data-frame-seq': 3 })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ 'data-group-seq': 1 })).toHaveLength(1)

    // An older page prepends members; the group stays expanded under a new first seq.
    update([deltaFrame(0), deltaFrame(1), deltaFrame(2), deltaFrame(3)])
    const older = renderer.root.findByProps({ 'data-group-seq': 0 })
    expect(older.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    expect(textOf(older)).toContain('×4')

    // A different-type live frame starts its own row instead of joining.
    update([deltaFrame(0), deltaFrame(1), deltaFrame(2), deltaFrame(3), wireFrame(4, '{"type":"result","subtype":"success"}')])
    expect(renderer.root.findAllByProps({ 'data-group-seq': 0 })).toHaveLength(1)
    expect(textOf(renderer.root.findByProps({ 'data-frame-seq': 4 }))).toContain('result · success')
    renderer.unmount()
  })

  test('an expanded lone frame keeps its JSON open when a live frame groups it', () => {
    const { renderer } = renderPanel(openView([deltaFrame(1)]))
    const row = renderer.root.findByProps({ 'data-frame-seq': 1 })
    act(() => { row.findAllByType('button')[0]!.props.onClick() })
    expect(row.findByType('pre')).toBeTruthy()
    // A matching live frame turns the run into a group; the frame the user
    // expanded must not vanish into a collapsed row.
    act(() => {
      renderer.update(<ChatDebugPanel sessionId="chat-1" view={openView([deltaFrame(1), deltaFrame(2)])} connected
        sendMessage={() => {}} onClose={() => {}} />)
    })
    const group = renderer.root.findByProps({ 'data-group-seq': 1 })
    expect(group.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    expect(group.findByProps({ 'data-frame-seq': 1 }).findAllByType('pre')).toHaveLength(1)
    // Collapsing the group folds the transferred JSON expansion away with it.
    act(() => { group.findAllByType('button')[0]!.props.onClick() })
    expect(group.findAllByType('button')[0]!.props['aria-expanded']).toBe(false)
    act(() => { group.findAllByType('button')[0]!.props.onClick() })
    expect(group.findByProps({ 'data-frame-seq': 1 }).findAllByType('pre')).toHaveLength(0)
    renderer.unmount()
  })

  test('an expanded group stays expanded after the frame cap trims its original members', () => {
    const { renderer } = renderPanel(openView([deltaFrame(10), deltaFrame(11)]))
    act(() => { renderer.root.findByProps({ 'data-group-seq': 10 }).findAllByType('button')[0]!.props.onClick() })
    const update = (frames: ChatWireFrame[]) => act(() => {
      renderer.update(<ChatDebugPanel sessionId="chat-1" view={openView(frames)} connected
        sendMessage={() => {}} onClose={() => {}} />)
    })
    // Live frames join the open group, then the 5000-frame cap trims the two
    // seqs that were members at toggle time — the group must stay expanded.
    update([deltaFrame(10), deltaFrame(11), deltaFrame(12), deltaFrame(13), deltaFrame(14)])
    update([deltaFrame(12), deltaFrame(13), deltaFrame(14)])
    const trimmed = renderer.root.findByProps({ 'data-group-seq': 12 })
    expect(trimmed.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    expect(textOf(trimmed)).toContain('#12–#14')
    expect(trimmed.findAllByProps({ 'data-frame-seq': 12 })).toHaveLength(1)
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

describe('/clear, /reset, /new', () => {
  afterEach(() => useChatStore.setState({ sessions: {} }))

  function renderClearable(session: Session = chatSession) {
    const sent: ClientMessage[] = []
    const listeners: Array<(message: ServerMessage) => void> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        subscribe={listener => { listeners.push(listener); return () => {} }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    const type = (value: string) =>
      act(() => { renderer.root.findByType('textarea').props.onChange({ target: { value } }) })
    const submit = () =>
      act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    const deliver = (message: ServerMessage) =>
      act(() => { for (const listener of listeners) listener(message) })
    return { sent, renderer, type, submit, deliver }
  }

  const newChatCreated = (id: string, name?: string): ServerMessage => ({
    type: 'session-created',
    session: {
      id, name: name ?? 'New chat', kind: 'chat', projectPath: '/tmp/project',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    },
  })

  test.each(['/clear', '/reset', '/new'])('%s creates a chat and archives the old one', (command) => {
    const h = renderClearable()
    h.type(command)
    h.submit()
    expect(h.sent.filter(message => message.type === 'session-create')).toEqual([{
      type: 'session-create', projectPath: '/tmp/project', kind: 'chat', claudeProfileId: 'default',
    }])
    // The command itself never reaches the agent, and the composer cleared.
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
    expect(h.renderer.root.findByType('textarea').props.value).toBe('')
    // The composer text is gone but nothing is archived yet.
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([])
    h.deliver(newChatCreated('chat-new'))
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([
      { type: 'chat-archive', sessionId: 'chat-1' },
    ])
    h.renderer.unmount()
  })

  test('/new with a name names the created chat', () => {
    const h = renderClearable()
    h.type('/new release notes')
    h.submit()
    expect(h.sent.filter(message => message.type === 'session-create')).toEqual([{
      type: 'session-create', projectPath: '/tmp/project', kind: 'chat',
      claudeProfileId: 'default', name: 'release notes',
    }])
    h.deliver(newChatCreated('chat-named', 'release notes'))
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([
      { type: 'chat-archive', sessionId: 'chat-1' },
    ])
    h.renderer.unmount()
  })

  test('a creation error leaves the previous chat untouched', () => {
    const h = renderClearable()
    h.type('/clear')
    h.submit()
    h.deliver({ type: 'error', message: 'Claude Agent SDK is unavailable.' })
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([])
    // The failure also cancels the pending archive for later creations.
    h.deliver(newChatCreated('chat-late'))
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([])
    h.renderer.unmount()
  })

  test('a session created in another project does not archive this chat', () => {
    const h = renderClearable()
    h.type('/clear')
    h.submit()
    h.deliver({
      type: 'session-created',
      session: {
        id: 'chat-elsewhere', name: 'Elsewhere', kind: 'chat', projectPath: '/other/project',
        status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
      },
    })
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([])
    h.renderer.unmount()
  })
})

describe('chat palette', () => {
  const classOf = (node: ReactTestInstance) => String(node.props.className ?? '')

  test('the chat view opts into the palette and errors use the danger token', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={chatSession} sendMessage={() => {}} connectionStatus="connected"
        connectionEpoch={0} error="Connection lost" onClose={() => {}} onKill={() => {}} />)
    })
    expect(classOf(renderer.root.findByProps({ 'data-testid': 'chat-view' })).split(' ')).toContain('chat-palette')
    const banner = renderer.root.findByProps({ role: 'alert' })
    expect(classOf(banner)).toContain('text-chat-danger')
    expect(classOf(banner)).not.toContain('red-400')
    renderer.unmount()

    const messages = TestRenderer.create(<ChatMessages events={[
      { type: 'error', id: 'e', sequence: 0, at: 'now', message: 'Agent crashed' },
    ] as ChatEvent[]} />)
    const error = messages.root.findByProps({ role: 'alert' })
    expect(classOf(error)).toContain('text-chat-danger')
    expect(classOf(error)).not.toContain('red-400')
    messages.unmount()
  })

  test('Debug panel direction labels use the palette tokens', () => {
    const frames = (['out', 'in', 'stderr', 'lifecycle'] as const).map((dir, index) => wireFrame(index + 1, '{"type":"x"}', dir))
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatDebugPanel sessionId="chat-1" view={{ ...closedDebugView(), open: true, frames }}
        connected sendMessage={() => {}} onClose={() => {}} />)
    })
    const labelClass = (seq: number) => classOf(renderer.root.findByProps({ 'data-frame-seq': seq }).findAllByType('span')[0]!)
    expect(labelClass(1)).toContain('text-chat-wire-out')
    expect(labelClass(2)).toContain('text-chat-wire-in')
    expect(labelClass(3)).toContain('text-chat-wire-stderr')
    expect(labelClass(4)).toContain('text-secondary')
    for (const seq of [1, 2, 3, 4]) expect(labelClass(seq)).not.toMatch(/(sky|emerald|amber)-400/)
    renderer.unmount()
  })
})

describe('chat font size', () => {
  const classOf = (node: ReactTestInstance) => String(node.props.className ?? '')
  const remSized = (node: ReactTestInstance) => /\btext-(xs|sm|base)\b/.test(classOf(node))

  afterEach(() => useSettingsStore.setState({ chatFontSize: 15 }))

  test('the chat root carries the chat font size and the composer uses chat sizing', () => {
    useSettingsStore.setState({ chatFontSize: 18 })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={chatSession} sendMessage={() => {}} connectionStatus="connected"
        connectionEpoch={0} error="Connection lost" onClose={() => {}} onKill={() => {}} />)
    })
    const root = renderer.root.findByProps({ 'data-testid': 'chat-view' })
    expect(classOf(root).split(' ')).toContain('chat-root')
    expect(root.props.style['--chat-font-size']).toBe('18px')
    const composer = renderer.root.findByProps({ 'aria-label': 'Message Claude' })
    expect(classOf(composer)).toContain('chat-composer')
    expect(classOf(composer)).toContain('text-chat-body')
    const header = renderer.root.findByType('header')
    expect(header.findAll(node => typeof node.type === 'string' && remSized(node))).toHaveLength(0)
    expect(classOf(renderer.root.findByProps({ role: 'alert' }))).toContain('text-chat-body')
    renderer.unmount()
  })

  test('transcript and request elements use em-based chat sizes, never rem sizes', () => {
    const events = [
      { type: 'user_message', id: 'u', sequence: 0, at: 'now', text: 'hi' },
      { type: 'assistant_text', id: 'a', sequence: 1, at: 'now', text: '# Title\n\nbody' },
      { type: 'tool_call', id: 't', sequence: 2, at: 'now', tool: 'Read', input: {} },
      { type: 'tool_result', id: 'r', sequence: 3, at: 'now', output: 'ok', isError: false },
      { type: 'notice', id: 'n', sequence: 4, at: 'now', text: 'note' },
      { type: 'turn_completed', id: 'c', sequence: 5, at: 'now', subtype: 'success' },
    ] as unknown as ChatEvent[]
    const messages = TestRenderer.create(<ChatMessages events={events} />)
    const transcript = messages.root.findByProps({ 'data-testid': 'chat-transcript' })
    expect(transcript.findAll(node => typeof node.type === 'string' && remSized(node))).toHaveLength(0)
    const user = messages.root.findByProps({ 'data-chat-role': 'user' })
    expect(classOf(user.findAllByType('div')[0]!)).toContain('text-chat-meta')
    expect(classOf(user.findByType('p'))).toContain('text-chat-body')
    messages.unmount()

    const requests = TestRenderer.create(<ChatRequests sessionId="chat-1" sendMessage={() => {}} disabled={false} requests={[
      { kind: 'approval', requestId: 'p', tool: 'Bash', input: { command: 'ls' } },
      { kind: 'question', requestId: 'q', questions: [{ question: 'Pick?', header: 'Pick', multiSelect: false,
        options: [{ label: 'A', description: 'first' }] }] },
    ] as never} />)
    const container = requests.root.findByProps({ 'data-testid': 'chat-requests' })
    expect(container.findAll(node => typeof node.type === 'string' && remSized(node))).toHaveLength(0)
    requests.unmount()
  })
})

describe('chat activity row', () => {
  function renderRow(activity: ChatActivity, phaseStartedAt = Date.now()) {
    let renderer!: TestRenderer.ReactTestRenderer
    // act so the interval effect is registered before timers advance.
    act(() => {
      renderer = TestRenderer.create(
        <ChatActivityRow activity={activity} phaseStartedAt={phaseStartedAt} />
      )
    })
    const row = renderer.root.findByProps({ 'data-testid': 'chat-activity' })
    return { renderer, row, text: textOf(row) }
  }

  test('each phase renders its label', () => {
    const cases: Array<[ChatActivity, string]> = [
      [{ phase: 'requesting', elapsedMs: 0 }, 'Waiting for model…'],
      [{ phase: 'thinking', elapsedMs: 0 }, 'Thinking…'],
      [{ phase: 'preparing_tool', elapsedMs: 0, tool: 'Edit' }, 'Writing Edit input…'],
      [{ phase: 'running_tools', elapsedMs: 0, tool: 'Bash', count: 1 }, 'Running Bash…'],
      [{ phase: 'running_tools', elapsedMs: 0, tool: 'Bash', count: 3 }, 'Running 3 tools…'],
      [{ phase: 'retrying', elapsedMs: 0, attempt: 2, maxRetries: 10, errorStatus: 504 }, 'Retrying (2/10, 504)…'],
      [{ phase: 'retrying', elapsedMs: 0, attempt: 1, maxRetries: 1 }, 'Retrying (1/1)…'],
    ]
    for (const [activity, label] of cases) {
      const { renderer, row, text } = renderRow(activity)
      expect(row.props['data-phase']).toBe(activity.phase)
      expect(text).toContain(label)
      renderer.unmount()
    }
  })

  test('the elapsed time ticks once per second on the client clock', async () => {
    jest.useFakeTimers()
    try {
      const { renderer, row } = renderRow({ phase: 'thinking', elapsedMs: 0 }, Date.now())
      const elapsed = () => textOf(row.findByProps({ 'data-testid': 'chat-activity-elapsed' }))
      expect(elapsed()).toBe('0s')
      await act(async () => { jest.advanceTimersByTime(2_000) })
      expect(elapsed()).toBe('2s')
      await act(async () => { jest.advanceTimersByTime(59_000) })
      expect(elapsed()).toBe('1m 01s')
      renderer.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  test('ChatView hides the row for responding phases, pending requests, and archived chats', () => {
    const seed = (activity: ChatActivity | null, pendingRequests: ChatPendingRequest[] = []) => {
      useChatStore.setState({ sessions: { 'chat-1': { ...emptyTranscript(), activity: activity
        ? { value: activity, phaseStartedAt: Date.now() - activity.elapsedMs }
        : null, pendingRequests } } })
    }
    const render = (session: Session) => {
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(<ChatView
          session={session}
          sendMessage={() => {}}
          connectionStatus="connected" connectionEpoch={0} error={null}
          onClose={() => {}} onKill={() => {}} />)
      })
      return renderer
    }
    const rows = (renderer: TestRenderer.ReactTestRenderer) =>
      renderer.root.findAllByProps({ 'data-testid': 'chat-activity' })

    // Positive control: an in-flight thinking turn shows the row.
    seed({ phase: 'thinking', elapsedMs: 4_000 })
    let renderer = render(chatSession)
    expect(rows(renderer)).toHaveLength(1)
    renderer.unmount()

    // Streaming text is its own visible progress (design D4).
    seed({ phase: 'responding', elapsedMs: 1_000 })
    renderer = render(chatSession)
    expect(rows(renderer)).toHaveLength(0)
    renderer.unmount()

    // A pending approval owns the footer.
    seed({ phase: 'running_tools', elapsedMs: 1_000, tool: 'Bash', count: 1 }, [
      { kind: 'approval', requestId: 'r', tool: 'Bash', input: {}, at: 'now' },
    ])
    renderer = render(chatSession)
    expect(rows(renderer)).toHaveLength(0)
    renderer.unmount()

    // Archived chats are read-only.
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    seed({ phase: 'thinking', elapsedMs: 4_000 })
    renderer = render(archived)
    expect(rows(renderer)).toHaveLength(0)
    renderer.unmount()
    useChatStore.setState({ sessions: {} })
  })
})
