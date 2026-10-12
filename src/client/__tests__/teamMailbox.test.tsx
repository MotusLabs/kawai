// Peer replay and human controls exercise real stores and rendered actions.
import { afterEach, expect, spyOn, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { TeamMessage } from '@shared/team'
import type { ClientMessage } from '@shared/types'
import ChatMessages from '../components/chat/ChatMessages'
import TeamMailboxPanel from '../components/chat/TeamMailboxPanel'
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useChatStore } from '../stores/chatStore'
import { toastManager } from '../components/Toast'
import { notifyMailboxDeadLetter } from '../utils/teamMailboxNotification'

afterEach(() => { useTeamMailboxStore.setState({ views: {} }); useChatStore.setState({ sessions: {} }) })
const peer: ChatEvent = { type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 'turn', messageId: 'mail',
  senderSession: 'lead', senderGroup: 'leads', priority: 'urgent', originPath: '/repo/worktree', tags: ['review', 'review'],
  threadId: 'thread', body: 'Review this change', possibleDuplicate: true }
const mail = (id: string, state: TeamMessage['state'], deliverAt: string | null = null): TeamMessage => ({
  id, state, deliverAt, teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads',
  originPath: '/repo', priority: 'normal', tags: [], threadId: id, inReplyTo: null, hop: 1, body: id,
  claimedBy: state === 'uncertain' ? 'dev' : null, claimedAt: null, createdAt: new Date().toISOString(),
  pushedAt: null, deliveredAt: null, reason: null, possibleDuplicate: false, attachThread: false, taskId: null,
  claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null,
})
test('peer row is distinct and restored by reconnect snapshot', () => {
  const events: ChatEvent[] = [{ type: 'user_message', id: 'u1', sequence: 0, at: 'now', turnId: 't', text: 'Human' }, peer]
  useChatStore.getState().snapshot({ type: 'chat-snapshot', sessionId: 'dev', profileId: 'default', events,
    pendingRequests: [], status: 'waiting', throughSequence: 1, commands: { status: 'unavailable', commands: [] },
    activity: null, contextUsage: null, usage: null, workers: [] })
  const renderer = TestRenderer.create(<ChatMessages events={useChatStore.getState().sessions.dev!.events} />)
  const row = renderer.root.findByProps({ 'data-chat-role': 'peer' })
  expect(row.props['data-chat-role']).toBe('peer')
  for (const text of ['leads', 'urgent', '/repo/worktree', 'review', 'Possible duplicate', 'Review this change']) {
    expect(JSON.stringify(renderer.toJSON())).toContain(text)
  }
  expect(row.findAllByType('span').filter(span => JSON.stringify(span.children) === '["#","review"]')).toHaveLength(1)
  expect(renderer.root.findAllByProps({ 'data-chat-role': 'user' })).toHaveLength(1)
  renderer.unmount()
})
test('mailbox lists all categories and sends cancel, retry, discard; offline actions disabled', () => {
  const sent: ClientMessage[] = []
  const view = { open: true, loading: false, messages: [mail('queued', 'queued'), mail('future', 'queued', new Date(Date.now()+60000).toISOString()), mail('dead', 'dead'), mail('held', 'uncertain')] }
  const props = { sessionId: 'dev', view, connected: true, sendMessage: (message: ClientMessage) => sent.push(message), onClose: () => {} }
  const renderer = TestRenderer.create(<TeamMailboxPanel {...props} />)
  expect(renderer.root.findAllByType('section').map(section => section.props['aria-label'])).toEqual(['Routing rules', 'Routing decisions', 'Queued', 'Receiving', 'Parked', 'Scheduled', 'Dead letters', 'Held for review'])
  // Close mailbox and Reload routing rules come first.
  const actions = renderer.root.findAllByType('button').slice(2)
  act(() => { for (const button of actions) button.props.onClick() })
  expect(sent.map(message => message.type)).toEqual(['team-mailbox-cancel', 'team-mailbox-cancel', 'team-mailbox-retry', 'team-mailbox-discard', 'team-mailbox-retry', 'team-mailbox-discard'])
  act(() => renderer.update(<TeamMailboxPanel {...props} connected={false} />))
  expect(renderer.root.findAllByType('button').slice(1).every(button => button.props.disabled)).toBe(true)
  renderer.unmount()
})
test('snapshot replaces stale mailbox rows and ignores closed views', () => {
  const store = useTeamMailboxStore.getState()
  store.open('dev'); store.apply({ type: 'team-mailbox-snapshot', sessionId: 'dev', teamId: 'team', messages: [mail('old', 'dead')] })
  store.open('dev'); expect(useTeamMailboxStore.getState().views.dev!.loading).toBe(true)
  store.apply({ type: 'team-mailbox-snapshot', sessionId: 'dev', teamId: 'team', messages: [] })
  expect(useTeamMailboxStore.getState().views.dev).toMatchObject({ messages: [], loading: false })
  store.close('dev'); store.apply({ type: 'team-mailbox-snapshot', sessionId: 'dev', teamId: 'team', messages: [mail('late', 'queued')] })
  expect(useTeamMailboxStore.getState().views.dev).toBeUndefined()
})
test('hop-limit notice adds a human toast', () => {
  const add = spyOn(toastManager, 'add').mockImplementation(() => 'toast')
  try {
    notifyMailboxDeadLetter({ type: 'team-mailbox-dead-letter', teamId: 'team', messageId: 'stopped', senderSession: 'lead' })
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Team message stopped at hop limit', description: expect.stringContaining('stopped') }))
  } finally { add.mockRestore() }
})

test('claimed mail stays visible while waiting for the durable receipt', () => {
  const renderer = TestRenderer.create(<TeamMailboxPanel sessionId="dev" view={{ open: true, loading: false, messages: [mail('in flight', 'claimed')] }} connected sendMessage={() => {}} onClose={() => {}} />)
  expect(JSON.stringify(renderer.root.findByProps({ 'aria-label': 'Receiving' }).findByType('article').findAllByType('p').map(p => p.children))).toContain('in flight')
  renderer.unmount()
})

/** Every text leaf of a rendered tree, joined: JSX splits text into children. */
function allText(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(allText).join('')
  if (node && typeof node === 'object' && 'children' in node) return allText((node as { children: unknown }).children)
  return ''
}

const REPORT = {
  loadedAt: '2026-10-12T12:00:00.000Z', dir: '/home/me/.kawai/routing',
  rules: [
    { groupId: 'devs', file: '/home/me/.kawai/routing/devs.ts', ok: true, change: 'changed' as const, env: ['GLM_API_KEY'] },
    { groupId: 'qa', file: '/home/me/.kawai/routing/qa.ts', ok: false, error: 'SyntaxError: Unexpected token', change: 'unchanged' as const },
  ],
}

test('routing rules: reload sends once, shows per-rule results and load errors, and is disabled offline', () => {
  const sent: ClientMessage[] = []
  const store = useTeamMailboxStore.getState()
  store.open('dev')
  store.apply({ type: 'team-mailbox-snapshot', sessionId: 'dev', teamId: 'team', messages: [], routing: {
    rules: null, decisions: [{ at: '2026-10-12T12:00:00.000Z', teamId: 'team', groupId: 'devs', messageId: 'm1', source: 'fallback', decision: 'built-in', reason: 'rule failed: timeout' }],
  } })
  const render = (connected = true) => <TeamMailboxPanel sessionId="dev" view={useTeamMailboxStore.getState().views.dev!} connected={connected}
    sendMessage={message => sent.push(message)} onClose={() => {}} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(render()) })
  const text = () => allText(renderer.toJSON())
  expect(text()).toContain('Not loaded yet')
  expect(text()).toContain('rule failed: timeout')
  const reload = () => renderer.root.findAllByType('button').find(button => JSON.stringify(button.children).includes('routing rules'))!
  act(() => reload().props.onClick())
  expect(sent).toEqual([{ type: 'team-mailbox-reload-rules', sessionId: 'dev' }])
  act(() => renderer.update(render()))
  expect(text()).toContain('Reloading…')
  act(() => { useTeamMailboxStore.getState().applyRulesResult({ type: 'team-mailbox-rules-result', sessionId: 'dev', ok: true, report: REPORT }) })
  act(() => renderer.update(render()))
  expect(renderer.root.findByProps({ 'data-rule-group': 'devs' })).toBeDefined()
  expect(text()).toContain('GLM_API_KEY')
  expect(text()).toContain('SyntaxError: Unexpected token')
  act(() => renderer.update(render(false)))
  expect(reload().props.disabled).toBe(true)
  act(() => { useTeamMailboxStore.getState().applyRulesResult({ type: 'team-mailbox-rules-result', sessionId: 'dev', ok: false, error: 'reload failed' }) })
  act(() => renderer.update(render()))
  expect(text()).toContain('reload failed')
  renderer.unmount()
})

test('parked work shows its resume time and hands off to a chosen group or session', () => {
  const sent: ClientMessage[] = []
  const parked = { ...mail('parked', 'parked'), claimedBy: 'dev', parkedUntil: '2026-10-12T15:40:00.000Z', parkCount: 2 }
  const forwarded = { ...mail('fwd', 'queued'), handoff: { fromSession: 'dev', fromProfile: 'glm', claimCommit: null, lastError: null, progress: { toolCalls: 4, tools: [], filesTouched: [] } } }
  const view = { open: true, loading: false, messages: [parked, forwarded] }
  const props = { sessionId: 'lead', view, connected: true, sendMessage: (message: ClientMessage) => sent.push(message), onClose: () => {}, groups: ['architects', 'devs'] }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamMailboxPanel {...props} />) })
  const text = allText(renderer.toJSON())
  expect(text).toContain('Parked on dev after a provider limit')
  expect(text).toContain('(parked 2 times)')
  expect(text).toContain('Handed off from dev (glm) after 4 tool calls')
  const control = renderer.root.findByProps({ 'data-testid': 'parked-hand-off' })
  const handOff = () => control.findAllByType('button').find(button => JSON.stringify(button.children).includes('Hand off'))!
  expect(handOff().props.disabled).toBe(true)
  act(() => control.findByProps({ 'aria-label': 'Hand off target' }).props.onChange({ target: { value: 'architects' } }))
  act(() => handOff().props.onClick())
  act(() => control.findByProps({ 'aria-label': 'Hand off to' }).props.onChange({ target: { value: 'session' } }))
  act(() => control.findByProps({ 'aria-label': 'Hand off target' }).props.onChange({ target: { value: ' dev2 ' } }))
  act(() => handOff().props.onClick())
  expect(sent).toEqual([
    { type: 'team-mailbox-hand-off', sessionId: 'lead', messageId: 'parked', target: { kind: 'group', id: 'architects' } },
    { type: 'team-mailbox-hand-off', sessionId: 'lead', messageId: 'parked', target: { kind: 'session', id: 'dev2' } },
  ])
  act(() => renderer.update(<TeamMailboxPanel {...props} view={{ ...view, handOffResult: { type: 'team-mailbox-hand-off-result', sessionId: 'lead', messageId: 'parked', ok: false, error: 'Unknown group in this team: x' } }} />))
  expect(allText(renderer.toJSON())).toContain('Unknown group in this team: x')
  act(() => renderer.update(<TeamMailboxPanel {...props} connected={false} />))
  expect(handOff().props.disabled).toBe(true)
  renderer.unmount()
})
