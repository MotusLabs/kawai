// Peer replay and human controls exercise real stores and rendered actions.
import { afterEach, expect, spyOn, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { TeamMessage, TeamWorktreeOccupancy, WaitingReason } from '@shared/team'
import type { ClientMessage } from '@shared/types'
import ChatMessages from '../components/chat/ChatMessages'
import TeamMailboxPanel from '../components/chat/TeamMailboxPanel'
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useChatStore } from '../stores/chatStore'
import { toastManager } from '../components/Toast'
import { notifyMailboxDeadLetter } from '../utils/teamMailboxNotification'

afterEach(() => { useTeamMailboxStore.setState({ views: {} }); useChatStore.setState({ sessions: {}, closedAccountNotices: {} }) })
const peer: ChatEvent = { type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 'turn', messageId: 'mail',
  senderSession: 'lead', senderGroup: 'leads', priority: 'urgent', originPath: '/repo/worktree', tags: ['review', 'review'],
  threadId: 'thread', body: 'Review this change', possibleDuplicate: true }
const mail = (id: string, state: TeamMessage['state'], deliverAt: string | null = null): TeamMessage => ({
  id, state, deliverAt, teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads',
  originPath: '/repo', priority: 'normal', tags: [], threadId: id, inReplyTo: null, hop: 1, body: id,
  claimedBy: state === 'uncertain' ? 'dev' : null, claimedAt: null, createdAt: new Date().toISOString(),
  pushedAt: null, deliveredAt: null, reason: null, possibleDuplicate: false, attachThread: false, taskId: null,
  taskRevision: null, claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null,
})
/** Rendered text below a test instance (instances are cyclic; never stringify them). */
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

test('peer row is distinct and restored by reconnect snapshot', () => {
  const events: ChatEvent[] = [{ type: 'user_message', id: 'u1', sequence: 0, at: 'now', turnId: 't', text: 'Human' }, peer]
  useChatStore.getState().snapshot({ type: 'chat-snapshot', sessionId: 'dev', profileId: 'default', events,
    pendingRequests: [], status: 'waiting', throughSequence: 1, commands: { status: 'unavailable', commands: [] },
    activity: null, contextUsage: null, usage: null, workers: [], backgroundTasks: [], notifications: [], model: null })
  const renderer = TestRenderer.create(<ChatMessages events={useChatStore.getState().sessions.dev!.events} />)
  const row = renderer.root.findByProps({ 'data-chat-role': 'peer' })
  expect(row.props['data-chat-role']).toBe('peer')
  for (const text of ['leads', 'urgent', '/repo/worktree', 'review', 'Possible duplicate', 'Review this change']) {
    expect(JSON.stringify(renderer.toJSON())).toContain(text)
  }
  // Tags are deduped: two 'review' inputs render one #review chip.
  expect(row.findAllByType('span').filter(span => textOf(span) === '#review')).toHaveLength(1)
  expect(renderer.root.findAllByProps({ 'data-chat-role': 'user' })).toHaveLength(1)
  renderer.unmount()
})
test('mailbox lists all categories and sends cancel, retry, discard; offline actions disabled', () => {
  const sent: ClientMessage[] = []
  const view = { open: true, loading: false, messages: [mail('queued', 'queued'), mail('future', 'queued', new Date(Date.now()+60000).toISOString()), mail('dead', 'dead'), mail('held', 'uncertain')] }
  const props = { sessionId: 'dev', view, connected: true, sendMessage: (message: ClientMessage) => sent.push(message), onClose: () => {} }
  const renderer = TestRenderer.create(<TeamMailboxPanel {...props} />)
  expect(renderer.root.findAllByType('section').map(section => section.props['aria-label'])).toEqual(['Routing rules', 'Routing decisions', 'Queued', 'Starting agent', 'Receiving', 'Parked', 'Scheduled', 'Dead letters', 'Held for review'])
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

// Waiting reasons (team-waiting-reasons): every unsettled state on
// listForTeam's surface matches exactly one section, a spawning row shows
// its reservation's facts, and waiting rows render blocker-first with the
// other constraints expandable.
const sessions = [{ id: 'writer', name: 'Writer One', groupId: 'devs' }]
const reason = (blocker: WaitingReason['blocker'], others: WaitingReason['others'] = []) => ({ blocker, others })

test('every unsettled state renders in exactly one section', () => {
  const messages = [
    mail('queued-due', 'queued'),
    mail('awaiting', 'awaiting-request'),
    mail('starting', 'spawning'),
    mail('receiving', 'claimed'),
    mail('parked', 'parked'),
    mail('future', 'queued', new Date(Date.now() + 60_000).toISOString()),
    mail('dead', 'dead'),
    mail('uncertain', 'uncertain'),
  ]
  const renderer = TestRenderer.create(<TeamMailboxPanel sessionId="dev" view={{ open: true, loading: false, messages }} connected sendMessage={() => {}} onClose={() => {}} />)
  const sections = renderer.root.findAllByType('section').filter(section => section.props['aria-label'] !== 'Routing rules' && section.props['aria-label'] !== 'Routing decisions')
  const placed = sections.flatMap(section => section.findAllByType('article').map(() => section.props['aria-label']))
  expect(sections.map(section => section.props['aria-label'])).toEqual(['Queued', 'Starting agent', 'Receiving', 'Parked', 'Scheduled', 'Dead letters', 'Held for review'])
  // Eight rows, each in exactly one section: queued-due and awaiting share Queued.
  expect(placed).toHaveLength(8)
  const count = (id: string) => renderer.root.findAllByProps({ 'data-message-id': id }).length
  for (const id of ['queued-due', 'awaiting', 'starting', 'receiving', 'parked', 'future', 'dead', 'uncertain']) expect(count(id)).toBe(1)
  renderer.unmount()
})

test('a spawning row shows Starting agent with its reservation facts, then Receiving', () => {
  const waiting = { starting: reason({ kind: 'starting-agent', reservation: { group: 'devs', profile: 'glm', worktree: '/repo/feat-x', startedAt: new Date(Date.now() - 90_000).toISOString() } },
    [{ kind: 'group-cap', counts: { live: 1, cap: 1 } }, { kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, detail: '/repo/feat-x' }]) }
  const props = { sessionId: 'lead', connected: true, sendMessage: () => {}, onClose: () => {} }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamMailboxPanel {...props} view={{ open: true, loading: false, messages: [mail('starting', 'spawning')], waiting }} />) })
  const section = renderer.root.findByProps({ 'aria-label': 'Starting agent' })
  expect(section.findByType('article').findByProps({ 'data-testid': 'waiting-reason' })).toBeDefined()
  const text = allText(renderer.toJSON())
  expect(text).toContain('Starting devs on glm in feat-x')
  expect(text).toContain('for 1m')
  // Its own reservation's capacity facts sit in the expander, never as the blocker.
  expect(section.findByProps({ 'data-testid': 'waiting-reason' }).findByProps({ 'data-testid': 'waiting-others' })).toBeDefined()
  expect(allText(renderer.toJSON())).toContain('1/1')
  // A spawning row carries no controls (Q2).
  expect(section.findAllByType('button')).toHaveLength(0)
  // The spawn landed: the row moves to Receiving.
  act(() => renderer.update(<TeamMailboxPanel {...props} view={{ open: true, loading: false, messages: [mail('starting', 'claimed')], waiting: {} }} />))
  expect(renderer.root.findByProps({ 'aria-label': 'Receiving' }).findByProps({ 'data-message-id': 'starting' })).toBeDefined()
  expect(() => renderer.root.findByProps({ 'aria-label': 'Starting agent' }).findByType('article')).toThrow()
  renderer.unmount()
})

test('a waiting row shows its blocker and expands to the other constraints with links', () => {
  const opened: string[] = []
  const waiting = { blocked: reason(
    { kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, sessionIds: ['writer'], detail: '/repo/feat-x' },
    [{ kind: 'no-eligible-member', sessionIds: ['writer'], detail: 'writer working' }, { kind: 'spawn-backoff', retryAt: new Date(Date.now() + 30_000).toISOString() }]) }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamMailboxPanel sessionId="lead" view={{ open: true, loading: false, messages: [mail('blocked', 'queued')], waiting }}
    connected sendMessage={() => {}} onClose={() => {}} sessions={sessions} onOpenSession={id => opened.push(id)} />) })
  const article = renderer.root.findByProps({ 'data-message-id': 'blocked' })
  // The blocker is one line: worktree basename, occupant named and linked.
  const blocker = article.findByProps({ 'data-testid': 'waiting-reason' }).children[0] as TestRenderer.ReactTestInstance
  const holder = article.findByProps({ 'data-testid': 'waiting-session' })
  expect(holder.props.children).toBe('Writer One')
  act(() => holder.props.onClick())
  expect(opened).toEqual(['writer'])
  expect(allText(blocker)).toContain('feat-x')
  // The worktree shows its basename with the full path available (title).
  expect(blocker.findByProps({ title: '/repo/feat-x' })).toBeDefined()
  // The other constraints are expandable.
  const others = article.findByProps({ 'data-testid': 'waiting-others' })
  const othersText = allText(others)
  expect(othersText).toContain('No eligible member')
  expect(othersText).toContain('writer working')
  expect(othersText).toContain('failed spawn retries')
  renderer.unmount()
})

test('a no-eligible-member breakdown links every named member', () => {
  const opened: string[] = []
  const waiting = { blocked: reason({ kind: 'no-eligible-member', sessionIds: ['writer', 'other'], members: [
    { sessionId: 'writer', cause: 'working' },
    { sessionId: 'other', cause: 'in another worktree', detail: '/repo/feat-y' },
  ] }) }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamMailboxPanel sessionId="lead" view={{ open: true, loading: false, messages: [mail('blocked', 'queued')], waiting }}
    connected sendMessage={() => {}} onClose={() => {}} sessions={[...sessions, { id: 'other', name: 'Other Dev', groupId: 'devs' }]} onOpenSession={id => opened.push(id)} />) })
  const article = renderer.root.findByProps({ 'data-message-id': 'blocked' })
  const links = article.findAllByProps({ 'data-testid': 'waiting-session' })
  expect(links.map(link => link.props.children)).toEqual(['Writer One', 'Other Dev'])
  act(() => { for (const link of links) link.props.onClick() })
  expect(opened).toEqual(['writer', 'other'])
  // The per-member causes render beside their links, with the worktree short.
  const text = allText(article.findByProps({ 'data-testid': 'waiting-reason' }))
  expect(text).toContain('No eligible member —')
  expect(text).toContain('Writer One working')
  expect(text).toContain('Other Dev in another worktree (feat-y)')
  renderer.unmount()
})

test('a dead letter reads as a sentence with the code still visible', () => {
  const dead = { ...mail('gone', 'dead'), reason: 'worktree-missing: /repo/gone' }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamMailboxPanel sessionId="lead" view={{ open: true, loading: false, messages: [dead] }} connected sendMessage={() => {}} onClose={() => {}} />) })
  const line = renderer.root.findByProps({ 'data-testid': 'dead-letter-reason' })
  const text = allText(line)
  expect(text).toContain('The target worktree is missing')
  expect(text).toContain('(worktree-missing: /repo/gone)')
  renderer.unmount()
})

test('snapshot updates reasons and the roster without row changes', () => {
  const store = useTeamMailboxStore.getState()
  store.open('dev')
  const snapshot = (waiting?: Record<string, WaitingReason>, worktrees?: TeamWorktreeOccupancy[]) =>
    store.apply({ type: 'team-mailbox-snapshot', sessionId: 'dev', teamId: 'team', messages: [mail('m', 'queued')], ...waiting ? { waiting } : {}, ...worktrees ? { worktrees } : {} })
  snapshot({ m: reason({ kind: 'group-cap', counts: { live: 2, cap: 2 } }) })
  expect(useTeamMailboxStore.getState().views.dev!.waiting).toEqual({ m: { blocker: { kind: 'group-cap', counts: { live: 2, cap: 2 } }, others: [] } })
  // A reason-only re-publish replaces the reasons; rows untouched.
  snapshot({ m: reason({ kind: 'no-eligible-member', detail: 'a working' }) })
  expect(useTeamMailboxStore.getState().views.dev!.waiting!.m!.blocker.kind).toBe('no-eligible-member')
  expect(useTeamMailboxStore.getState().views.dev!.messages).toHaveLength(1)
  // A roster update lands the same way.
  const roster: TeamWorktreeOccupancy[] = [{ worktree: '/repo', sessions: [], pendingSpawns: [] }]
  snapshot(undefined, roster)
  expect(useTeamMailboxStore.getState().views.dev!.worktrees).toEqual(roster)
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
