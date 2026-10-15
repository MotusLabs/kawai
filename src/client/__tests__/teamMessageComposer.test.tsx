// The human composer (team-message-threads 5.3): a new message addresses one
// of the team's groups or sessions with an optional task, a reply in a thread
// is addressed to its parent's sender and inherits that task, urgent is
// explained where it is chosen, refusals render inline, and nothing is
// writable while disconnected.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import TeamMessageComposer, { type ComposerMode } from '../components/chat/TeamMessageComposer'
import TeamMessagesView from '../components/chat/TeamMessagesView'
import { closedMessageView, useTeamMessageStore } from '../stores/teamMessageStore'

afterEach(() => {
  act(() => { useTeamMessageStore.setState({ views: {} }) })
})

const groups = [{ id: 'devs', label: 'Developers' }, { id: 'leads', label: 'Leads' }]
const sessions = [{ id: 'dev', name: 'Dev one', groupId: 'devs' }]
const tasks = [{ id: 't1', title: 'Export CSV' }]
const replyMode: ComposerMode = {
  kind: 'reply', inReplyTo: 'q1', fromSession: 'dev', fromKind: 'agent',
  taskId: 't1', taskTitle: 'Export CSV', body: 'Please advise',
}

function Host({ sent, mode, connected = true }: {
  sent: ClientMessage[]; mode: ComposerMode; connected?: boolean
}) {
  const view = useTeamMessageStore(state => state.views.dev) ?? closedMessageView()
  return <TeamMessageComposer teamPath="dev" mode={mode} groups={groups} sessions={sessions} tasks={tasks}
    view={view} sendMessage={message => sent.push(message)} connected={connected} />
}

const render = (mode: ComposerMode, connected = true) => {
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    useTeamMessageStore.getState().open('dev')
    renderer = TestRenderer.create(<Host sent={sent} mode={mode} connected={connected} />)
  })
  return { sent, renderer }
}
const field = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
  renderer.root.find(node => node.props['aria-label'] === label)
const button = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
  renderer.root.find(node => node.type === 'button' && node.children.join('') === label)
const textOf = (node: TestRenderer.ReactTestInstance | string | TestRenderer.ReactTestInstance[]): string =>
  typeof node === 'string' ? node
    : Array.isArray(node) ? node.map(textOf).join('')
      : (node.children ?? []).map(textOf).join('')
const text = (renderer: TestRenderer.ReactTestRenderer) => textOf(renderer.root)

test('a new message addresses a group or session with a task and an optional urgent flag', () => {
  const { sent, renderer } = render({ kind: 'new' })
  expect(text(renderer)).toContain('Urgent mail interrupts')
  expect(renderer.root.findByProps({ 'data-testid': 'urgent-explanation' }).props.children).toBeTruthy()
  act(() => field(renderer, 'Recipient').props.onChange({ target: { value: 'group:devs' } }))
  act(() => field(renderer, 'Task').props.onChange({ target: { value: 't1' } }))
  act(() => field(renderer, 'Message body').props.onChange({ target: { value: ' Build it ' } }))
  act(() => field(renderer, 'Urgent').props.onChange({ target: { checked: true } }))
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  const request = sent[0] as Extract<ClientMessage, { type: 'team-message-send' }>
  expect(request.type).toBe('team-message-send')
  expect(request.teamPath).toBe('dev')
  expect(typeof request.requestId).toBe('string')
  expect(request.body).toBe('Build it')
  expect(request.to).toEqual({ kind: 'group', id: 'devs' })
  expect(request.taskId).toBe('t1')
  expect(request.urgent).toBe(true)
  // Pending until the result lands, then the form is free again.
  expect(textOf(button(renderer, 'Sending…'))).toBe('Sending…')
  act(() => useTeamMessageStore.getState().applyResult({
    type: 'team-message-send-result', teamPath: 'dev', requestId: request.requestId, message: undefined,
  }))
  expect(textOf(button(renderer, 'Send message'))).toBe('Send message')
  expect(field(renderer, 'Urgent').props.checked).toBe(false)
  act(() => renderer.unmount())
})

test('a reply is addressed to its parent and inherits its task rather than asking again', () => {
  const { sent, renderer } = render(replyMode)
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'composer-reply-to' }))).toContain('Dev one')
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'composer-reply-body' }))).toBe('Please advise')
  const inherited = renderer.root.findByProps({ 'data-testid': 'composer-task' })
  expect(textOf(inherited)).toContain('Task Export CSV')
  expect(textOf(inherited)).toContain('inherited')
  // No recipient picker and no task picker: the reply has no choice to make.
  expect(renderer.root.findAll(node => node.props['aria-label'] === 'Recipient')).toHaveLength(0)
  expect(renderer.root.findAll(node => node.props['aria-label'] === 'Task')).toHaveLength(0)
  act(() => field(renderer, 'Message body').props.onChange({ target: { value: 'Done' } }))
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  const request = sent[0] as Extract<ClientMessage, { type: 'team-message-send' }>
  expect(request.body).toBe('Done')
  expect(request.inReplyTo).toBe('q1')
  expect(request.to).toBeUndefined()
  // The inherited task travels with the reply by the server's own rule; the
  // client never restates it.
  expect(Object.keys(request)).not.toContain('taskId')
  expect(textOf(button(renderer, 'Sending…'))).toBe('Sending…')
  act(() => renderer.unmount())
})

test('a refusal renders inline and clears the pending state', () => {
  const { sent, renderer } = render({ kind: 'new' })
  act(() => field(renderer, 'Recipient').props.onChange({ target: { value: 'session:dev' } }))
  act(() => field(renderer, 'Message body').props.onChange({ target: { value: 'Hello' } }))
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  const requestId = (sent[0] as Extract<ClientMessage, { type: 'team-message-send' }>).requestId
  act(() => useTeamMessageStore.getState().applyResult({
    type: 'team-message-send-result', teamPath: 'dev', requestId,
    error: 'Unknown group: nope',
  }))
  expect(renderer.root.findByProps({ 'data-testid': 'composer-error' }).children.join('')).toBe('Unknown group: nope')
  expect(textOf(button(renderer, 'Send message'))).toBe('Send message')
  // The next action clears the refusal.
  act(() => field(renderer, 'Message body').props.onChange({ target: { value: 'Again' } }))
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  expect(renderer.root.findAllByProps({ 'data-testid': 'composer-error' })).toHaveLength(0)
  act(() => renderer.unmount())
})

test('disconnected disables every control and refuses to send', () => {
  const { sent, renderer } = render({ kind: 'new' }, false)
  expect(text(renderer)).toContain('Disconnected')
  for (const label of ['Recipient', 'Task', 'Message body', 'Urgent']) {
    expect(field(renderer, label).props.disabled).toBe(true)
  }
  expect(button(renderer, 'Send message').props.disabled).toBe(true)
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  expect(sent).toEqual([])
  act(() => renderer.unmount())
})

test('the view composes a new message from the list and replies to a thread row', () => {
  const sent: ClientMessage[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  const ViewHost = () => {
    const view = useTeamMessageStore(state => state.views.dev) ?? closedMessageView()
    return <TeamMessagesView teamPath="dev" view={view} sendMessage={message => sent.push(message)} connected
      sessions={sessions} groups={groups} onClose={() => {}} />
  }
  act(() => {
    useTeamMessageStore.getState().open('dev')
    renderer = TestRenderer.create(<ViewHost />)
  })
  const listComposer = renderer.root.findByProps({ 'data-testid': 'message-composer' })
  expect(listComposer.props['data-mode']).toBe('new')
  const parent = {
    id: 'q1', teamId: 'team', toKind: 'group' as const, toId: 'devs', fromKind: 'agent' as const,
    fromSession: 'dev', fromGroup: 'devs', originPath: '/repo', priority: 'normal' as const, tags: [],
    threadId: 'th', inReplyTo: null, hop: 1, body: 'Please advise', state: 'delivered' as const,
    claimedBy: 'dev', claimedAt: null, deliverAt: null, createdAt: '2026-10-13T10:00:01.000Z',
    pushedAt: null, deliveredAt: null, reason: null, possibleDuplicate: false, attachThread: false,
    taskId: 't1', taskRevision: 1, claimCommit: null, parkedUntil: null, parkCount: 0,
    resumeMessageId: null, handoff: null, excludedProfile: null,
  }
  act(() => {
    useTeamMessageStore.getState().applySnapshot({
      type: 'team-messages-snapshot', teamPath: 'dev', teamId: 'team', filters: {},
      messages: [parent], nextCursor: null, directory: [], tasks, threadSizes: {},
    })
  })
  act(() => renderer.root.findByProps({ 'data-testid': 'message-open-thread' }).props.onClick())
  // No thread rows yet, so the thread's composer has nothing to reply to.
  expect(renderer.root.findAllByProps({ 'data-testid': 'message-composer' })).toHaveLength(0)
  act(() => {
    useTeamMessageStore.getState().applyThread({
      type: 'team-thread', teamPath: 'dev', teamId: 'team', threadId: 'th',
      entries: [{ message: parent, events: [{ messageId: 'q1', teamId: 'team', seq: 1, createdAt: '2026-10-13T10:00:00.000Z', kind: 'sent', actor: 'system', actorSession: null, prevState: null, prevClaimedBy: null, prevRecipient: null, prevReason: null, reason: null }] }],
      directory: [],
    })
  })
  const threadComposer = renderer.root.findByProps({ 'data-testid': 'message-composer' })
  expect(threadComposer.props['data-mode']).toBe('reply')
  expect(textOf(threadComposer)).toContain('Task Export CSV')
  act(() => renderer.unmount())
})
