// Peer replay and human controls exercise real stores and rendered actions.
// The Mailbox view (team-workspace-pages 5.3): the fixed section order with
// the action sections first and expanded, one-line rows that expand to the
// full body and constraints, search narrowing every section, hideable empty
// sections, routing as its own collapsible section — and every delivery
// operation still sending its message.
import { afterEach, expect, spyOn, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { TeamMessage, TeamWorktreeOccupancy, WaitingReason } from '@shared/team'
import type { ClientMessage } from '@shared/types'
import ChatMessages from '../components/chat/ChatMessages'
import TeamMailboxView from '../components/team/TeamMailboxView'
import { useTeamMailboxStore } from '../stores/teamMailboxStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import { useChatStore } from '../stores/chatStore'
import { toastManager } from '../components/Toast'
import { notifyMailboxDeadLetter } from '../utils/teamMailboxNotification'

/** Every renderer mounted by a test; unmounted in afterEach so a test that fails mid-way cannot leave one firing effects into later tests. */
const mounted: TestRenderer.ReactTestRenderer[] = []

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => { renderer.unmount() })
  }
  useTeamMailboxStore.setState({ views: {} })
  useTeamWorkspaceStore.setState({ views: {} })
  useChatStore.setState({ sessions: {}, closedAccountNotices: {} })
})
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

/** Every text leaf of a rendered tree, joined: JSX splits text into children. */
function allText(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(allText).join('')
  if (node && typeof node === 'object' && 'children' in node) return allText((node as { children: unknown }).children)
  return ''
}

/**
 * Mount the view with every section and row expanded: the defaults marker is
 * seeded with no collapsed sections and every row id is pre-expanded, so the
 * tests see the full rows the way an expanded view shows them.
 */
function mountView(view: Record<string, unknown>, props: { sent?: ClientMessage[]; collapsedSections?: string[]; expanded?: string[]; sessions?: unknown[]; onOpenSession?: (id: string) => void; groups?: string[] } = {}) {
  const sent = props.sent ?? []
  act(() => {
    useTeamWorkspaceStore.setState({
      views: { dev: {
        open: true, tab: 'mailbox',
        tabs: {
          strategy: { search: '', filters: {}, expanded: [], collapsedSections: [] },
          tasks: { search: '', filters: {}, expanded: [], collapsedSections: [] },
          messages: { search: '', filters: {}, expanded: [], collapsedSections: [] },
          mailbox: { search: '', filters: {}, expanded: props.expanded ?? ((view.messages as TeamMessage[] | undefined) ?? []).map(row => row.id), collapsedSections: ['#defaults', ...(props.collapsedSections ?? [])] },
          members: { search: '', filters: {}, expanded: [], collapsedSections: [] },
          plans: { search: '', filters: {}, expanded: [], collapsedSections: [] },
          audit: { search: '', filters: {}, expanded: [], collapsedSections: [] },
          metrics: { search: '', filters: {}, expanded: [], collapsedSections: [] },
        },
        notice: null,
      } },
    })
  })
  let renderer!: TestRenderer.ReactTestRenderer
  const element = (connected = true) => <TeamMailboxView teamPath="dev" view={view as never} connected={connected}
    sendMessage={message => { sent.push(message) }} groups={props.groups ?? []}
    sessions={(props.sessions ?? []) as never} onOpenSession={props.onOpenSession} />
  act(() => { renderer = TestRenderer.create(element()) })
  mounted.push(renderer)
  const update = (connected = true) => act(() => { renderer.update(element(connected)) })
  return { renderer, sent, update }
}

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

test('sections render in the fixed order with counts, and Cancel, Retry, and Discard still send', () => {
  const view = { open: true, loading: false, messages: [
    mail('queued', 'queued'), mail('future', 'queued', new Date(Date.now() + 60000).toISOString()),
    mail('dead', 'dead'), mail('held', 'uncertain'),
  ] }
  const { renderer, sent, update } = mountView(view)
  const sections = renderer.root.findAllByType('section').filter(section => section.props['data-mailbox-section'] !== undefined)
  expect(sections.map(section => section.props['data-mailbox-section'])).toEqual([
    'Held for review', 'Dead letters', 'Parked', 'Starting agent', 'Queued', 'Receiving', 'Scheduled', 'Routing',
  ])
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-count-Queued' }).children.join('')).toBe('1 message')
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-count-Scheduled' }).children.join('')).toBe('1 message')
  // The delivery operations send their messages, rows in section order.
  const actions = renderer.root.findAllByType('button')
    .filter(button => ['Cancel', 'Retry', 'Discard'].includes(textOf(button)))
  act(() => { for (const button of actions) button.props.onClick() })
  expect(sent.map(message => message.type)).toEqual([
    'team-mailbox-retry', 'team-mailbox-discard', // held (Held for review, first)
    'team-mailbox-retry', 'team-mailbox-discard', // dead (Dead letters, second)
    'team-mailbox-cancel', // queued (Queued)
    'team-mailbox-cancel', // future (Scheduled)
  ])
  update(false)
  expect(renderer.root.findAllByType('button')
    .filter(button => ['Cancel', 'Retry', 'Discard'].includes(textOf(button)))
    .every(button => button.props.disabled)).toBe(true)
  act(() => { renderer.unmount() })
})

test('the action sections start expanded and the rest collapsed until expanded', () => {
  const view = { open: true, loading: false, messages: [mail('held', 'uncertain'), mail('queued', 'queued')] }
  act(() => { useTeamWorkspaceStore.setState({ views: {} }) })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamMailboxView teamPath="dev" view={view as never} connected sendMessage={() => {}} />)
  })
  mounted.push(renderer)
  // First mount seeds the defaults: Held for review open, Queued collapsed.
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={view as never} connected sendMessage={() => {}} />) })
  expect(renderer.root.findByProps({ 'data-mailbox-section': 'Held for review' }).findAllByType('article')).toHaveLength(1)
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-toggle-Queued' }).props['aria-expanded']).toBe(false)
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-count-Queued' }).children.join('')).toBe('1 message')
  act(() => { renderer.root.findByProps({ 'data-testid': 'mailbox-section-toggle-Queued' }).props.onClick() })
  expect(renderer.root.findByProps({ 'data-mailbox-section': 'Queued' }).findAllByType('article')).toHaveLength(1)
  act(() => renderer.unmount())
})

test('a row collapses to one line and expands to the full body, constraints, and handoff detail', () => {
  const long = Array.from({ length: 20 }, (_, line) => `line ${line + 1}`).join('\n')
  const row = { ...mail('queued', 'queued'), body: long }
  const { renderer } = mountView({ open: true, loading: false, messages: [row] }, { expanded: [] })
  const article = renderer.root.findByProps({ 'data-message-id': 'queued' })
  expect(article.props['data-expanded']).toBe('false')
  // One line: participants, age, priority, blocker, the body's first line.
  const line = article.findByProps({ 'data-testid': 'mailbox-row-line' })
  expect(textOf(line)).toContain('lead (leads) → group: devs')
  expect(textOf(line)).toContain('queued')
  expect(textOf(line)).toContain('line 1')
  expect(textOf(line)).not.toContain('line 2')
  expect(article.findAllByProps({ 'data-testid': 'mailbox-row-body' })).toHaveLength(0)
  act(() => { article.findByProps({ 'data-testid': 'mailbox-row-toggle' }).props.onClick() })
  const expanded = renderer.root.findByProps({ 'data-message-id': 'queued' })
  expect(expanded.props['data-expanded']).toBe('true')
  expect(textOf(expanded.findByProps({ 'data-testid': 'mailbox-row-body' }))).toContain('line 20')
  act(() => { expanded.findByProps({ 'data-testid': 'mailbox-row-toggle' }).props.onClick() })
  expect(renderer.root.findByProps({ 'data-message-id': 'queued' }).props['data-expanded']).toBe('false')
  act(() => renderer.unmount())
})

test('search narrows every section and each count reflects the match', () => {
  const messages = [
    { ...mail('held-strategy', 'uncertain'), body: 'strategy-ui question' },
    mail('held-other', 'uncertain'),
    { ...mail('dead-strategy', 'dead'), body: 'mentions strategy-ui too' },
    mail('queued', 'queued'),
  ]
  const { renderer } = mountView({ open: true, loading: false, messages }, { collapsedSections: [] })
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-count-Held for review' }).children.join('')).toBe('2 messages')
  act(() => {
    renderer.root.findByProps({ 'aria-label': 'Search mailbox' }).props.onChange({ target: { value: 'STRATEGY-UI' } })
  })
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={{ open: true, loading: false, messages } as never} connected sendMessage={() => {}} />) })
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-count-Held for review' }).children.join('')).toBe('1 message')
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-count-Dead letters' }).children.join('')).toBe('1 message')
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-count-Queued' }).children.join('')).toBe('0 messages')
  expect(renderer.root.findByProps({ 'data-mailbox-section': 'Held for review' }).findAllByType('article').map(article => article.props['data-message-id'])).toEqual(['held-strategy'])
  act(() => renderer.unmount())
})

test('hiding empty sections removes them', () => {
  const view = { open: true, loading: false, messages: [mail('held', 'uncertain')] }
  const { renderer } = mountView(view, { collapsedSections: [] })
  expect(renderer.root.findAllByProps({ 'data-mailbox-section': 'Receiving' })).toHaveLength(1)
  act(() => {
    renderer.root.findByProps({ 'aria-label': 'Hide empty sections' }).props.onChange({ target: { checked: true } })
  })
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={view as never} connected sendMessage={() => {}} />) })
  expect(renderer.root.findAllByProps({ 'data-mailbox-section': 'Receiving' })).toHaveLength(0)
  expect(renderer.root.findAllByProps({ 'data-mailbox-section': 'Held for review' })).toHaveLength(1)
  act(() => renderer.unmount())
})

test('parked rows offer Cancel beside Hand off and send team-mailbox-cancel', () => {
  const parked = { ...mail('parked-1', 'parked'), claimedBy: 'dev', parkedUntil: new Date(Date.now() + 3_600_000).toISOString(), resumeMessageId: 'resume-1' }
  const view = { open: true, loading: false, messages: [parked, mail('queued-1', 'queued')] }
  const { renderer, sent, update } = mountView(view, { expanded: ['parked-1'] })
  const row = renderer.root.findByProps({ 'data-message-id': 'parked-1' })
  const labels = row.findAllByType('button').map(button => textOf(button))
  expect(labels).toContain('Cancel')
  expect(labels).toContain('Hand off')
  act(() => { row.findAllByType('button').find(button => textOf(button) === 'Cancel')!.props.onClick() })
  expect(sent).toEqual([{ type: 'team-mailbox-cancel', teamPath: 'dev', messageId: 'parked-1' }])
  update(false)
  expect(renderer.root.findByProps({ 'data-message-id': 'parked-1' }).findAllByType('button').find(button => textOf(button) === 'Cancel')!.props.disabled).toBe(true)
  act(() => { renderer.unmount() })
})

test('every row shows its short id with the full id in the title, and copy yields the full id', () => {
  const id = '0e849a2e-5025-4a8c-9f0b-123456789abc'
  const view = { open: true, loading: false, messages: [mail(id, 'queued'), mail('abcdef12-0000-0000-0000-000000000000', 'dead')] }
  const { renderer } = mountView(view)
  const shown = renderer.root.findAllByProps({ 'data-testid': 'message-id' }).filter(node => typeof node.type === 'string')
  expect(shown.map(node => textOf(node))).toEqual(['abcdef12', '0e849a2e'])
  expect(shown[1]!.props.title).toBe(id)
  const copied: string[] = []
  const realDocument = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => ({ value: '', style: {}, focus() {}, select() {} }),
    body: { appendChild: (node: { value: string }) => copied.push(node.value), removeChild() {} },
    execCommand: () => true,
  }
  try {
    const copy = renderer.root.findByProps({ 'data-message-id': id }).findByProps({ 'aria-label': 'Copy message id 0e849a2e' })
    act(() => { copy.props.onClick() })
  } finally { (globalThis as { document?: unknown }).document = realDocument }
  expect(copied).toEqual([id])
  act(() => { renderer.unmount() })
})

test('snapshot replaces stale mailbox rows and ignores closed views', () => {
  const store = useTeamMailboxStore.getState()
  store.open('dev'); store.apply({ type: 'team-mailbox-snapshot', teamPath: 'dev', teamId: 'team', messages: [mail('old', 'dead')] })
  store.open('dev'); expect(useTeamMailboxStore.getState().views.dev!.loading).toBe(true)
  store.apply({ type: 'team-mailbox-snapshot', teamPath: 'dev', teamId: 'team', messages: [] })
  expect(useTeamMailboxStore.getState().views.dev).toMatchObject({ messages: [], loading: false })
  store.close('dev'); store.apply({ type: 'team-mailbox-snapshot', teamPath: 'dev', teamId: 'team', messages: [mail('late', 'queued')] })
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
  const { renderer } = mountView({ open: true, loading: false, messages: [mail('in flight', 'claimed')] })
  expect(allText(renderer.root.findByProps({ 'data-mailbox-section': 'Receiving' }).findByType('article'))).toContain('in flight')
  act(() => { renderer.unmount() })
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
  const { renderer } = mountView({ open: true, loading: false, messages })
  const sections = renderer.root.findAllByType('section').filter(section => section.props['data-mailbox-section'] !== undefined && section.props['data-mailbox-section'] !== 'Routing')
  const placed = sections.flatMap(section => section.findAllByType('article').map(() => section.props['data-mailbox-section']))
  expect(sections.map(section => section.props['data-mailbox-section'])).toEqual([
    'Held for review', 'Dead letters', 'Parked', 'Starting agent', 'Queued', 'Receiving', 'Scheduled',
  ])
  // Eight rows, each in exactly one section: queued-due and awaiting share Queued.
  expect(placed).toHaveLength(8)
  const count = (id: string) => renderer.root.findAllByProps({ 'data-message-id': id }).length
  for (const id of ['queued-due', 'awaiting', 'starting', 'receiving', 'parked', 'future', 'dead', 'uncertain']) expect(count(id)).toBe(1)
  act(() => { renderer.unmount() })
})

test('a spawning row shows Starting agent with its reservation facts, then Receiving', () => {
  const waiting = { starting: reason({ kind: 'starting-agent', reservation: { group: 'devs', profile: 'glm', worktree: '/repo/feat-x', startedAt: new Date(Date.now() - 90_000).toISOString() } },
    [{ kind: 'group-cap', counts: { live: 1, cap: 1 } }, { kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, detail: '/repo/feat-x' }]) }
  let view = { open: true, loading: false, messages: [mail('starting', 'spawning')], waiting }
  const { renderer } = mountView(view)
  const section = renderer.root.findByProps({ 'data-mailbox-section': 'Starting agent' })
  expect(section.findByType('article').findByProps({ 'data-testid': 'waiting-reason' })).toBeDefined()
  expect(allText(renderer.toJSON())).toContain('Starting devs on glm in feat-x')
  expect(allText(renderer.toJSON())).toContain('for 1m')
  // Its own reservation's capacity facts sit in the expander, never as the blocker.
  expect(section.findByProps({ 'data-testid': 'waiting-reason' }).findByProps({ 'data-testid': 'waiting-others' })).toBeDefined()
  expect(allText(renderer.toJSON())).toContain('1/1')
  // A spawning row carries no controls (Q2) beyond its row toggle and copy.
  expect(section.findByType('article').findAllByType('button')
    .filter(button => !['Expand', 'Collapse'].includes(textOf(button)) && !String(button.props['aria-label']).startsWith('Copy message id'))).toHaveLength(0)
  // The spawn landed: the row moves to Receiving.
  const moved = mountView({ open: true, loading: false, messages: [mail('starting', 'claimed')], waiting: {} })
  expect(moved.renderer.root.findByProps({ 'data-mailbox-section': 'Receiving' }).findByProps({ 'data-message-id': 'starting' })).toBeDefined()
  expect(moved.renderer.root.findAllByProps({ 'data-mailbox-section': 'Starting agent' })[0]!.findAllByType('article')).toHaveLength(0)
  act(() => { renderer.unmount(); moved.renderer.unmount() })
})

test('a waiting row shows its blocker and expands to the other constraints with links', () => {
  const opened: string[] = []
  const waiting = { blocked: reason(
    { kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, sessionIds: ['writer'], detail: '/repo/feat-x' },
    [{ kind: 'no-eligible-member', sessionIds: ['writer'], detail: 'writer working' }, { kind: 'spawn-backoff', retryAt: new Date(Date.now() + 30_000).toISOString() }]) }
  const { renderer } = mountView({ open: true, loading: false, messages: [mail('blocked', 'queued')], waiting }, { sessions, onOpenSession: id => opened.push(id) })
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
  act(() => { renderer.unmount() })
})

test('a no-eligible-member breakdown links every named member', () => {
  const opened: string[] = []
  const waiting = { blocked: reason({ kind: 'no-eligible-member', sessionIds: ['writer', 'other'], members: [
    { sessionId: 'writer', cause: 'working' },
    { sessionId: 'other', cause: 'in another worktree', detail: '/repo/feat-y' },
  ] }) }
  const { renderer } = mountView({ open: true, loading: false, messages: [mail('blocked', 'queued')], waiting },
    { sessions: [...sessions, { id: 'other', name: 'Other Dev', groupId: 'devs' }], onOpenSession: id => opened.push(id) })
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
  act(() => { renderer.unmount() })
})

test('a dead letter reads as a sentence with the code still visible', () => {
  const dead = { ...mail('gone', 'dead'), reason: 'worktree-missing: /repo/gone' }
  const { renderer } = mountView({ open: true, loading: false, messages: [dead] })
  const line = renderer.root.findByProps({ 'data-testid': 'dead-letter-reason' })
  const text = allText(line)
  expect(text).toContain('The target worktree is missing')
  expect(text).toContain('(worktree-missing: /repo/gone)')
  act(() => { renderer.unmount() })
})

test('snapshot updates reasons and the roster without row changes', () => {
  const store = useTeamMailboxStore.getState()
  store.open('dev')
  const snapshot = (waiting?: Record<string, WaitingReason>, worktrees?: TeamWorktreeOccupancy[]) =>
    store.apply({ type: 'team-mailbox-snapshot', teamPath: 'dev', teamId: 'team', messages: [mail('m', 'queued')], ...waiting ? { waiting } : {}, ...worktrees ? { worktrees } : {} })
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

const REPORT = {
  loadedAt: '2026-10-12T12:00:00.000Z', dir: '/home/me/.kawai/routing',
  rules: [
    { groupId: 'devs', file: '/home/me/.kawai/routing/devs.ts', ok: true, change: 'changed' as const, env: ['GLM_API_KEY'] },
    { groupId: 'qa', file: '/home/me/.kawai/routing/qa.ts', ok: false, error: 'SyntaxError: Unexpected token', change: 'unchanged' as const },
  ],
}

test('routing: its own collapsible section; reload sends once, shows per-rule results, disabled offline', () => {
  const sent: ClientMessage[] = []
  const store = useTeamMailboxStore.getState()
  store.open('dev')
  store.apply({ type: 'team-mailbox-snapshot', teamPath: 'dev', teamId: 'team', messages: [], routing: {
    rules: null, decisions: [{ at: '2026-10-12T12:00:00.000Z', teamId: 'team', groupId: 'devs', messageId: 'm1', source: 'fallback', decision: 'built-in', reason: 'rule failed: timeout' }],
  } })
  const { renderer } = mountView(useTeamMailboxStore.getState().views.dev as unknown as Record<string, unknown>, { sent, collapsedSections: [] })
  // Collapsed by default it renders only its header; expanding shows the rules.
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={useTeamMailboxStore.getState().views.dev as never} connected sendMessage={message => { sent.push(message) }} />) })
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-toggle-Routing' }).props['aria-expanded']).toBe(true)
  const text = () => allText(renderer.toJSON())
  expect(text()).toContain('Not loaded yet')
  expect(text()).toContain('rule failed: timeout')
  const reload = () => renderer.root.findAllByType('button').find(button => JSON.stringify(button.children).includes('routing rules'))!
  act(() => reload().props.onClick())
  expect(sent).toEqual([{ type: 'team-mailbox-reload-rules', teamPath: 'dev' }])
  act(() => { useTeamMailboxStore.getState().beginReload('dev') })
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={useTeamMailboxStore.getState().views.dev as never} connected sendMessage={message => { sent.push(message) }} />) })
  expect(text()).toContain('Reloading…')
  act(() => { useTeamMailboxStore.getState().applyRulesResult({ type: 'team-mailbox-rules-result', teamPath: 'dev', ok: true, report: REPORT }) })
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={useTeamMailboxStore.getState().views.dev as never} connected sendMessage={message => { sent.push(message) }} />) })
  expect(renderer.root.findByProps({ 'data-rule-group': 'devs' })).toBeDefined()
  expect(text()).toContain('GLM_API_KEY')
  expect(text()).toContain('SyntaxError: Unexpected token')
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={useTeamMailboxStore.getState().views.dev as never} connected={false} sendMessage={message => { sent.push(message) }} />) })
  expect(reload().props.disabled).toBe(true)
  act(() => { useTeamMailboxStore.getState().applyRulesResult({ type: 'team-mailbox-rules-result', teamPath: 'dev', ok: false, error: 'reload failed' }) })
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={useTeamMailboxStore.getState().views.dev as never} connected sendMessage={message => { sent.push(message) }} />) })
  expect(text()).toContain('reload failed')
  act(() => { renderer.unmount() })
})

test('parked work shows its resume time and hands off to a chosen group or session', () => {
  const sent: ClientMessage[] = []
  const parked = { ...mail('parked', 'parked'), claimedBy: 'dev', parkedUntil: '2026-10-12T15:40:00.000Z', parkCount: 2 }
  const forwarded = { ...mail('fwd', 'queued'), handoff: { fromSession: 'dev', fromProfile: 'glm', claimCommit: null, lastError: null, progress: { toolCalls: 4, tools: [], filesTouched: [] } } }
  const view = { open: true, loading: false, messages: [parked, forwarded] }
  const { renderer } = mountView(view, { sent, expanded: ['parked', 'fwd'], groups: ['architects', 'devs'] })
  const text = allText(renderer.toJSON())
  expect(text).toContain('Parked on dev after a provider limit')
  expect(text).toContain('(parked 2 times)')
  expect(text).toContain('Handed off from dev (glm) after 4 tool calls')
  const control = renderer.root.findByProps({ 'data-testid': 'parked-hand-off' })
  const handOff = () => control.findAllByType('button').find(button => JSON.stringify(button.children).includes('Hand off'))!
  expect(handOff().props.disabled).toBe(true)
  act(() => control.findByProps({ 'aria-label': 'Hand off target' }).props.onChange({ target: { value: 'architects' } }) )
  act(() => handOff().props.onClick())
  act(() => control.findByProps({ 'aria-label': 'Hand off to' }).props.onChange({ target: { value: 'session' } }))
  act(() => control.findByProps({ 'aria-label': 'Hand off target' }).props.onChange({ target: { value: ' dev2 ' } }))
  act(() => handOff().props.onClick())
  expect(sent).toEqual([
    { type: 'team-mailbox-hand-off', teamPath: 'dev', messageId: 'parked', target: { kind: 'group', id: 'architects' } },
    { type: 'team-mailbox-hand-off', teamPath: 'dev', messageId: 'parked', target: { kind: 'session', id: 'dev2' } },
  ])
  act(() => { renderer.unmount() })
})

test('search matches the resolved participant names a row displays, not only raw ids', () => {
  const named = { ...mail('from-writer', 'queued'), fromSession: 'writer', body: 'unrelated body text' }
  const { renderer } = mountView({ open: true, loading: false, messages: [named, mail('other', 'queued')] }, {
    collapsedSections: [], sessions,
  })
  act(() => {
    renderer.root.findByProps({ 'aria-label': 'Search mailbox' }).props.onChange({ target: { value: 'writer one' } })
  })
  act(() => { renderer.update(<TeamMailboxView teamPath="dev" view={{ open: true, loading: false, messages: [named, mail('other', 'queued')] } as never} connected sendMessage={() => {}} sessions={sessions as never} />) })
  expect(renderer.root.findByProps({ 'data-testid': 'mailbox-section-count-Queued' }).children.join('')).toBe('1 message')
  expect(renderer.root.findByProps({ 'data-mailbox-section': 'Queued' }).findAllByType('article').map(article => article.props['data-message-id'])).toEqual(['from-writer'])
  act(() => renderer.unmount())
})
