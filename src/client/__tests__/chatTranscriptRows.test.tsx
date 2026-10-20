// Transcript layout fixtures (chat-transcript-layout D1–D3): message rows carry
// author and local time beside one shared body alignment, asides keep to the
// body column, stable keys keep stateful rows across streaming, and a mixed
// transcript keeps every value and control the transcript showed before.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ChatBackgroundTask, ChatEvent, ChatWorker } from '@shared/chat'
import type { Session } from '@shared/types'
import ChatMessages from '../components/chat/ChatMessages'
import ChatView from '../components/chat/ChatView'
import { useChatStore } from '../stores/chatStore'

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const byTestId = (root: ReactTestInstance, id: string) => root.findAllByProps({ 'data-testid': id })
const classOf = (node: ReactTestInstance): string => String(node.props.className ?? '')

const SESSION = 'chat-rows-1'
const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`
const user = (id: string, turnId: string, text: string, time = at(0)): ChatEvent =>
  ({ id, sequence: 0, at: time, type: 'user_message', turnId, text })
const assistant = (id: string, turnId: string, messageId: string, text: string, time = at(1)): ChatEvent =>
  ({ id, sequence: 0, at: time, type: 'assistant_text', turnId, messageId, text })
const peer = (overrides: Partial<Extract<ChatEvent, { type: 'peer_message' }>> = {}): ChatEvent => ({
  type: 'peer_message', id: 'peer-1', sequence: 0, at: at(2), turnId: 'turn-peer', messageId: 'm1',
  senderSession: 'chat-live', senderGroup: 'devs', priority: 'urgent', originPath: '/repo/.worktrees/a',
  tags: ['review', 'review'], threadId: 'm1', body: 'Please review', possibleDuplicate: false, ...overrides,
})
const live: Session[] = [{
  id: 'chat-live', name: 'Export button', projectPath: '/repo', status: 'waiting', lastActivity: '', createdAt: '',
  source: 'managed', kind: 'chat', groupId: 'devs',
} as Session]

afterEach(() => useChatStore.setState({ sessions: {}, workerBodies: {}, taskOutputs: {}, closedAccountNotices: {} }))

describe('message rows (D1, D2)', () => {
  test('user, assistant, and peer rows name their author and show a semantic local time', () => {
    const opened: string[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatMessages agentLabel="Claude" sessions={live} onOpenParticipant={id => opened.push(id)}
        events={[user('u1', 't1', 'hello'), assistant('a1', 't1', 'm1', 'hi'), peer()]} />)
    })
    const articles = renderer.root.findAllByType('article')
    expect(articles.map(article => article.props['data-chat-role'])).toEqual(['user', 'assistant', 'peer'])
    const authors = byTestId(renderer.root, 'chat-row-author').map(textOf)
    expect(authors[0]).toBe('You')
    expect(authors[1]).toBe('Claude')
    expect(authors[2]).toContain('Export button')
    for (const article of articles) {
      const time = article.findByType('time')
      expect(time.props.dateTime).toMatch(/^2026-10-16T10:0\dZ|^2026-10-16T10:0\d:00\.000Z$/)
      // The full date, time, and zone are on hover and read by assistive technology.
      expect(time.props.title).toMatch(/2026/)
      expect(textOf(time.findByProps({ className: 'sr-only' }))).toBe(time.props.title)
    }
    // The peer author keeps its participant link and its routing metadata.
    act(() => { renderer.root.findByProps({ 'data-testid': 'participant-name' }).props.onClick() })
    expect(opened).toEqual(['chat-live'])
    const peerText = textOf(articles[2]!)
    for (const value of ['devs', 'urgent', '#review', '/repo/.worktrees/a', 'Please review']) expect(peerText).toContain(value)
    expect(peerText.match(/#review/g)).toHaveLength(1)
    act(() => renderer.unmount())
  })

  test('the agent label is the given identity, never the model', () => {
    const renderer = TestRenderer.create(<ChatMessages agentLabel="Codex" events={[assistant('a1', 't1', 'm1', 'hi')]} />)
    expect(textOf(byTestId(renderer.root, 'chat-row-author')[0]!)).toBe('Codex')
    renderer.unmount()
  })

  test('an undated message keeps its author and shows no clock', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[user('u1', 't1', 'old', '')]} />)
    expect(textOf(byTestId(renderer.root, 'chat-row-author')[0]!)).toBe('You')
    expect(renderer.root.findAllByType('time')).toHaveLength(0)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Invalid Date')
    renderer.unmount()
  })

  test('turn and author changes separate; same-author continuations stay tight and keep their own time', () => {
    const tool: ChatEvent = { id: 'c1', sequence: 0, at: at(1), type: 'tool_call', turnId: 't1', toolCallId: 'c1', tool: 'Read', input: {} }
    const renderer = TestRenderer.create(<ChatMessages events={[
      user('u1', 't1', 'go'), assistant('a1', 't1', 'm1', 'first', at(1)), tool, assistant('a2', 't1', 'm1', 'second', at(3)),
      user('u2', 't2', 'next', at(4)),
    ]} />)
    const articles = renderer.root.findAllByType('article')
    expect(articles.map(classOf)).toEqual([
      'chat-row', 'chat-row chat-row-author', 'chat-row chat-row-continue', 'chat-row chat-row-turn',
    ])
    // The continuation keeps its author for assistive technology and its own time.
    const continuation = articles[2]!
    expect(classOf(continuation.findByProps({ 'data-testid': 'chat-row-author' }))).toBe('sr-only')
    expect(continuation.findByType('time').props.dateTime).toBe(at(3))
    // The tool row is an aside in the body column, between the two texts.
    const rows = renderer.root.findAll(node => classOf(node).startsWith('chat-row') && node.type === 'div' && classOf(node).includes('chat-row-aside'))
    expect(rows).toHaveLength(1)
    renderer.unmount()
  })

  test('a local day change shows one date separator', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      user('u1', 't1', 'late', '2026-10-14T12:00:00.000Z'), user('u2', 't2', 'undated', ''), user('u3', 't3', 'next day', '2026-10-15T12:00:00.000Z'),
    ]} />)
    // The first row opens with its date (not today), then one at the day change.
    expect(byTestId(renderer.root, 'chat-day-separator')).toHaveLength(2)
    renderer.unmount()
  })
})

describe('stable rows while streaming (D1, D3)', () => {
  const worker: ChatWorker = {
    workerId: 'toolu_w1', taskId: 'task-w1', agentType: 'Explore', description: 'Map the workspace',
    depth: 1, status: 'running', live: true, lastTool: 'Grep', elapsedMs: 1_000,
  }
  const agentCall: ChatEvent = { type: 'tool_call', id: 'e-w1', sequence: 0, at: at(1), turnId: 't1', toolCallId: 'toolu_w1', tool: 'Agent', input: {} }

  test('an expanded worker stays expanded as text streams after it, and its body reflows as its own transcript', () => {
    act(() => { useChatStore.getState().setWorkers(SESSION, [worker]) })
    const render = (events: ChatEvent[]) => <ChatMessages sessionId={SESSION} sendMessage={() => {}} connected events={events} />
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(render([user('u1', 't1', 'go'), agentCall])) })
    act(() => { renderer.root.findByProps({ 'data-testid': 'chat-worker-row' }).props.onToggle({ currentTarget: { open: true } }) })
    act(() => {
      useChatStore.getState().setWorkerBody({
        type: 'chat-worker-transcript', sessionId: SESSION, workerId: 'toolu_w1', status: 'ok',
        events: [user('w1', 'wt', 'map it'), assistant('w2', 'wt', 'wm', 'mapped')],
      })
    })
    expect(byTestId(renderer.root, 'chat-worker-body')).toHaveLength(1)
    // Streaming text after the worker: the row keeps its key, so its open state survives.
    act(() => { renderer.update(render([user('u1', 't1', 'go'), agentCall, assistant('a1', 't1', 'm2', 'Wor')])) })
    act(() => { renderer.update(render([user('u1', 't1', 'go'), agentCall, assistant('a2', 't1', 'm2', 'Working')])) })
    const body = byTestId(renderer.root, 'chat-worker-body')
    expect(body).toHaveLength(1)
    // The nested transcript is its own inline-size container with its own rows.
    const nested = body[0]!.findByProps({ 'data-testid': 'chat-transcript' })
    expect(classOf(nested)).toBe('chat-transcript')
    expect(nested.findAllByType('article')).toHaveLength(2)
    act(() => renderer.unmount())
  })
})

describe('mixed transcript keeps every value and control (D3)', () => {
  const bashCall: ChatEvent = { type: 'tool_call', id: 'e-bash', sequence: 0, at: at(1), turnId: 't1', toolCallId: 'call_bash', tool: 'Bash', input: { command: 'bun run ci' } }
  const task: ChatBackgroundTask = {
    taskId: 'b1', toolCallId: 'call_bash', kind: 'shell', description: 'Wait for CI', status: 'running', live: true,
    startedAtMs: Date.now() - 5_000, elapsedMs: 5_000,
  }
  const events: ChatEvent[] = [
    { id: 'trig', sequence: 0, at: at(0), type: 'turn_started', turnId: 't0', trigger: { kind: 'task', tasks: [{ taskId: 'b0', status: 'completed', summary: 'Build finished' }] } },
    user('u1', 't1', 'run the checks'),
    peer({
      turnId: 't1b', possibleDuplicate: true,
      revisionNotice: { revision: 3, rationale: 'Scope narrowed' },
      task: { id: 'task-1', title: 'Ship layout', status: 'active', revision: 2, direction: 'Do the layout', acceptance: 'Looks right',
        openspecChange: 'chat-transcript-layout', worktree: '/repo/.worktrees/x', journal: [{ author: 'lead', text: 'Started', createdAt: at(0) }] },
      thread: [{ messageId: 'm0', senderSession: 'chat-live', body: 'Earlier ask' }],
    } as Partial<Extract<ChatEvent, { type: 'peer_message' }>>),
    { id: 'cmd', sequence: 0, at: at(1), type: 'command_output', turnId: 't1b', text: 'Context: 12k tokens' },
    assistant('a1', 't1b', 'm1', 'Running'),
    { type: 'tool_call', id: 'e-read', sequence: 0, at: at(1), turnId: 't1b', toolCallId: 'call_read', tool: 'Read', input: { file_path: '/repo/x.ts' } },
    { type: 'tool_result', id: 'r-read', sequence: 0, at: at(1), turnId: 't1b', toolCallId: 'call_read', output: 'ENOENT: no such file', isError: true },
    bashCall,
    { id: 'appr', sequence: 0, at: at(1), type: 'approval_request', turnId: 't1b', requestId: 'req-1', tool: 'Write', input: { file_path: '/repo/y.ts' } },
    { id: 'res-user', sequence: 0, at: at(1), type: 'request_resolved', requestId: 'req-1', outcome: 'denied', decidedBy: 'user' },
    { id: 'res-policy', sequence: 0, at: at(1), type: 'request_resolved', requestId: 'req-2', outcome: 'allowed', decidedBy: 'policy', tool: 'Edit' },
    { id: 'note', sequence: 0, at: at(1), type: 'notice', text: 'Context compacted' },
    { id: 'err', sequence: 0, at: at(1), type: 'error', message: 'Overloaded' },
    { id: 'int', sequence: 0, at: at(1), type: 'turn_interrupted', turnId: 't1b' },
    { id: 'done', sequence: 0, at: at(1), type: 'turn_completed', turnId: 't1b', subtype: 'success', totalCostUsd: 0.1234, numTurns: 7 },
  ] as ChatEvent[]

  const renderMixed = (archived: boolean) => {
    act(() => {
      useChatStore.getState().snapshot({
        type: 'chat-snapshot', sessionId: SESSION, profileId: 'default', events: [], pendingRequests: [], status: 'waiting',
        throughSequence: 0, commands: { status: 'unavailable', commands: [] }, activity: null, contextUsage: null, usage: null,
        workers: [], backgroundTasks: [task], notifications: [], model: null,
      })
    })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatMessages events={events} sessionId={SESSION} sendMessage={() => {}} connected
        archived={archived} sessions={live} projectPath="/repo" />)
    })
    return renderer
  }

  test('every previously displayed value remains, in order', () => {
    const renderer = renderMixed(false)
    const text = textOf(renderer.root)
    const expected = [
      '⟲ Build finished', 'run the checks', 'Possible duplicate', 'Revision 3 published: Scope narrowed', ' · delivered under revision 2',
      'Task: Ship layout · active · revision 2', 'Worktree: /repo/.worktrees/x', 'Linked OpenSpec change chat-transcript-layout (authoritative)',
      'Do the layout', 'Acceptance: Looks right', 'lead: Started', 'Earlier messages in this thread', 'Earlier ask',
      'Command output', 'Context: 12k tokens', 'Running', 'Read', 'x.ts', 'ENOENT: no such file', 'Wait for CI',
      'Write', 'Denied by user', 'Auto-approved Edit', 'Context compacted', 'Overloaded', 'Turn stopped',
      'Turn complete · success · $0.1234 · 7 turns',
    ]
    let from = 0
    for (const value of expected) {
      const found = text.indexOf(value, from)
      expect({ value, found: found >= 0 }).toEqual({ value, found: true })
      from = found
    }
    expect(renderer.root.findAllByProps({ 'aria-label': 'Tool failed' }).length).toBeGreaterThan(0)
    expect(byTestId(renderer.root, 'chat-task-stop')).toHaveLength(1)
    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(1)
    // Anchors stay where search reveals them.
    for (const anchor of ['u1', 'peer-1', 'a1', 'tool:call_read', 'tool:call_bash', 'appr', 'note', 'err', 'cmd']) {
      expect(renderer.root.findAllByProps({ 'data-anchor-id': anchor }).length).toBeGreaterThan(0)
    }
    act(() => renderer.unmount())
  })

  const renderCompletion = (event: Record<string, unknown>) => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatMessages sessionId={SESSION} sendMessage={() => {}} connected
        archived={false} sessions={live} projectPath="/repo"
        events={[{ id: 'done', sequence: 0, at: at(1), type: 'turn_completed', turnId: 't1', subtype: 'success', numTurns: 1, ...event }] as ChatEvent[]} />)
    })
    return renderer
  }

  test('OpenRouter turn: the provider-reported charge replaces the estimate, explained on hover', () => {
    const renderer = renderCompletion({ totalCostUsd: 0.042563, providerCostUsd: 0.001064075 })
    expect(textOf(renderer.root)).toContain('Turn complete · success · $0.0011 · 1 turns')
    expect(textOf(renderer.root)).not.toContain('$0.0426 ·')
    const [cost] = byTestId(renderer.root, 'turn-provider-cost')
    expect(String(cost!.props.title)).toContain('Charged by the provider')
    expect(String(cost!.props.title)).toContain('not included')
    expect(String(cost!.props.title)).toContain('$0.0426')
    act(() => renderer.unmount())
  })

  test('Provider without reported cost: the SDK estimate shows as before', () => {
    const renderer = renderCompletion({ totalCostUsd: 0.1234 })
    expect(textOf(renderer.root)).toContain('Turn complete · success · $0.1234 · 1 turns')
    expect(byTestId(renderer.root, 'turn-provider-cost')).toHaveLength(0)
    act(() => renderer.unmount())
  })

  test('archived: the same details remain, but no task Stop', () => {
    const renderer = renderMixed(true)
    const text = textOf(renderer.root)
    for (const value of ['Wait for CI', 'ENOENT: no such file', 'Earlier ask', 'Turn complete · success']) expect(text).toContain(value)
    expect(byTestId(renderer.root, 'chat-task-stop')).toHaveLength(0)
    act(() => renderer.unmount())
  })
})

describe('ChatView integration (D3)', () => {
  const windowSlot = globalThis as { window?: unknown }
  const originalWindow = windowSlot.window
  afterEach(() => { windowSlot.window = originalWindow })

  const session = (archived: boolean) => ({
    id: SESSION, name: 'Rows', projectPath: '/repo', status: 'working', kind: 'chat', agentType: 'claude',
    ...(archived ? { archivedAt: '2026-10-01T00:00:00.000Z' } : {}),
  }) as unknown as Session
  const bashCall: ChatEvent = { type: 'tool_call', id: 'e-bash', sequence: 1, at: at(1), turnId: 't1', toolCallId: 'call_bash', tool: 'Bash', input: { command: 'sleep 9' } }
  const seed = (pending: boolean) => act(() => {
    useChatStore.getState().snapshot({
      type: 'chat-snapshot', sessionId: SESSION, profileId: 'default', status: 'working', throughSequence: 0,
      events: [user('u1', 't1', 'go'), bashCall],
      pendingRequests: pending ? [{ kind: 'approval', requestId: 'r1', tool: 'Write', input: {}, at: at(1) }] : [],
      commands: { status: 'unavailable', commands: [] }, activity: { phase: 'running_tools', elapsedMs: 1_000, tool: 'Bash', count: 1 },
      contextUsage: null, usage: null, workers: [], notifications: [], model: null,
      backgroundTasks: [{ taskId: 'b1', toolCallId: 'call_bash', kind: 'shell', description: 'Sleep', status: 'running', live: true, startedAtMs: Date.now(), elapsedMs: 0 }],
    })
  })
  const renderView = (archived: boolean) => {
    windowSlot.window = { confirm: () => true }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={session(archived)} sendMessage={() => {}}
        connectionStatus="connected" connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />)
    })
    return renderer
  }

  test('a live chat streams into rows, shows activity in the body column, and keeps cards and composer', () => {
    seed(false)
    const renderer = renderView(false)
    const activity = renderer.root.findByProps({ 'data-testid': 'chat-activity' })
    let ancestor: ReactTestInstance | null = activity
    while (ancestor && !classOf(ancestor).includes('chat-row-aside')) ancestor = ancestor.parent
    expect(ancestor).not.toBeNull()
    // Streaming text hides the phase row (its own progress) and lands as a Claude row.
    act(() => {
      useChatStore.getState().apply(SESSION, [{ id: 'd1', sequence: 2, at: at(2), type: 'assistant_delta', turnId: 't1', messageId: 'm1', delta: 'Wor' }])
      useChatStore.getState().setActivity(SESSION, { phase: 'responding', elapsedMs: 0 })
    })
    expect(byTestId(renderer.root, 'chat-activity')).toHaveLength(0)
    expect(textOf(byTestId(renderer.root, 'chat-row-author').at(-1)!)).toBe('Claude')
    expect(byTestId(renderer.root, 'chat-task-stop')).toHaveLength(1)
    expect(renderer.root.findAllByType('textarea')).toHaveLength(1)
    act(() => renderer.unmount())

    // A pending approval owns the footer: its card shows, the phase row does not.
    seed(true)
    const withCard = renderView(false)
    expect(byTestId(withCard.root, 'chat-activity')).toHaveLength(0)
    expect(withCard.root.findAllByType('section').length).toBeGreaterThan(0)
    act(() => withCard.unmount())
  })

  test('an archived chat keeps rows and details but no cards, Stop, activity, or composer; Restore remains', () => {
    seed(true)
    const renderer = renderView(true)
    expect(renderer.root.findAllByType('article')).toHaveLength(1)
    expect(textOf(renderer.root)).toContain('Sleep')
    expect(byTestId(renderer.root, 'chat-task-stop')).toHaveLength(0)
    expect(byTestId(renderer.root, 'chat-activity')).toHaveLength(0)
    expect(renderer.root.findAllByType('section')).toHaveLength(0)
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0)
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-archived-bar' }))).toContain('Restore')
    act(() => renderer.unmount())
  })
})

describe('gutter contrast (D1)', () => {
  test('author, time, and day labels use the secondary token the palette test holds to 4.5:1', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[user('u1', 't1', 'hi', '2026-10-01T10:00:00.000Z')]} />)
    for (const node of [...byTestId(renderer.root, 'chat-row-meta'), ...byTestId(renderer.root, 'chat-day-separator')]) {
      expect(classOf(node)).toContain('text-secondary')
      expect(classOf(node)).not.toContain('text-muted')
    }
    expect(classOf(renderer.root.findByType('time'))).not.toContain('text-muted')
    renderer.unmount()
  })
})
