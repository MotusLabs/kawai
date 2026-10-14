// Messages view (team-message-threads 5.2): the store's authoritative pages
// and unfiltered pushes, the filterable list with its delivery-state and
// priority badges, paging from the keyset cursor, and a thread detail that
// keeps chronological order, reply relations, the current recipient, the task
// revision a delivery carried, and each message's history.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, ServerMessage } from '@shared/types'
import type {
  MessageCursor,
  MessageEvent,
  MessageQueryFilters,
  SessionDirectoryEntry,
  TeamMessage,
  ThreadEntry,
} from '@shared/team'
import TeamMessagesView from '../components/chat/TeamMessagesView'
import { closedMessageView, useTeamMessageStore } from '../stores/teamMessageStore'

afterEach(() => {
  useTeamMessageStore.setState({ views: {} })
})

const message = (id: string, extra: Partial<TeamMessage> = {}): TeamMessage => ({
  id, teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads',
  originPath: '/repo', priority: 'normal', tags: [], threadId: id, inReplyTo: null, hop: 1,
  body: `Body ${id}`, state: 'queued', claimedBy: null, claimedAt: null, deliverAt: null,
  createdAt: '2026-10-13T10:00:00.000Z', pushedAt: null, deliveredAt: null, reason: null,
  possibleDuplicate: false, attachThread: false, taskId: null, taskRevision: null, claimCommit: null,
  parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null,
  ...extra,
})
const event = (id: string, seq: number, kind: MessageEvent['kind'], extra: Partial<MessageEvent> = {}): MessageEvent => ({
  messageId: id, teamId: 'team', seq, createdAt: `2026-10-13T10:00:0${seq}.000Z`, kind, actor: 'system', actorSession: null,
  prevState: null, prevClaimedBy: null, prevRecipient: null, prevReason: null, reason: null, ...extra,
})
const at = (n: number) => `2026-10-13T10:00:${String(n).padStart(2, '0')}.000Z`
const snapshot = (
  messages: TeamMessage[], extra: {
    filters?: MessageQueryFilters; nextCursor?: MessageCursor | null
    directory?: SessionDirectoryEntry[]; tasks?: { id: string; title: string }[]
  } = {},
): Extract<ServerMessage, { type: 'team-messages-snapshot' }> => ({
  type: 'team-messages-snapshot', teamPath: 'dev', teamId: 'team', filters: extra.filters ?? {},
  messages, nextCursor: extra.nextCursor ?? null, directory: extra.directory ?? [], tasks: extra.tasks ?? [], threadSizes: {},
})
const push = (messages: TeamMessage[], directory: SessionDirectoryEntry[] = []): Extract<ServerMessage, { type: 'team-messages' }> =>
  ({ type: 'team-messages', teamPath: 'dev', teamId: 'team', messages, directory })
const thread = (threadId: string, entries: ThreadEntry[], directory: SessionDirectoryEntry[] = []): Extract<ServerMessage, { type: 'team-thread' }> =>
  ({ type: 'team-thread', teamPath: 'dev', teamId: 'team', threadId, entries, directory })

const directory: SessionDirectoryEntry[] = [{ sessionId: 'gone', name: 'Killed one', group: 'devs' }]
const sessions = [{ id: 'dev', name: 'Dev one', groupId: 'devs' }]
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

/** A host that feeds the store the way the chat side slot does. */
function Host({ sent, connected = true, epoch = 0 }: {
  sent: ClientMessage[]; connected?: boolean; epoch?: number
}) {
  const view = useTeamMessageStore(state => state.views.dev) ?? closedMessageView()
  return <TeamMessagesView teamPath="dev" view={view} sendMessage={message => sent.push(message)}
    connected={connected} connectionEpoch={epoch} sessions={sessions} directory={directory} onClose={() => {}} />
}

const render = (sent: ClientMessage[], props: { connected?: boolean; epoch?: number } = {}) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    useTeamMessageStore.getState().open('dev')
    renderer = TestRenderer.create(<Host sent={sent} {...props} />)
  })
  return renderer
}
const opens = (sent: ClientMessage[]) => sent.filter(message => message.type === 'team-messages-open')
const lastOpen = (sent: ClientMessage[]) => opens(sent).at(-1) as Extract<ClientMessage, { type: 'team-messages-open' }>

test('store: snapshots replace, a cursor page appends, pushes merge and drop rows that left the filter', () => {
  const store = useTeamMessageStore.getState()
  store.applySnapshot(snapshot([message('a'), message('b')]))
  expect(useTeamMessageStore.getState().views.dev).toBeUndefined()
  act(() => { store.open('dev') })
  store.applySnapshot(snapshot([message('a', { createdAt: at(2) }), message('b', { createdAt: at(1) })]))
  expect(useTeamMessageStore.getState().views.dev!.messages.map(row => row.id)).toEqual(['a', 'b'])
  // A page walk appends; the next cursor of the first page is what the
  // component sends, and the store must not replace the rows it already holds.
  act(() => { store.beginMore('dev') })
  store.applySnapshot(snapshot([message('c', { createdAt: at(0) })], { nextCursor: null }))
  expect(useTeamMessageStore.getState().views.dev!.messages.map(row => row.id)).toEqual(['a', 'b', 'c'])
  // An unfiltered push updates in place, inserts a new row in creation order,
  // and drops a row that has left the filter it was listed under.
  store.applyPush(push([message('b', { createdAt: at(1), state: 'delivered' }), message('z', { createdAt: at(3) })]))
  expect(useTeamMessageStore.getState().views.dev!.messages.map(row => row.id)).toEqual(['z', 'a', 'b', 'c'])
  expect(useTeamMessageStore.getState().views.dev!.messages[2]!.state).toBe('delivered')
  store.setFilters('dev', { state: 'queued' })
  store.applySnapshot(snapshot([message('z', { createdAt: at(3) })], { filters: { state: 'queued' } }))
  store.applyPush(push([message('z', { createdAt: at(3), state: 'claimed' }), message('q', { createdAt: at(4), state: 'queued' })]))
  expect(useTeamMessageStore.getState().views.dev!.messages.map(row => row.id)).toEqual(['q'])
  store.close('dev')
  store.applyPush(push([message('late')]))
  store.applySnapshot(snapshot([message('late')]))
  expect(useTeamMessageStore.getState().views.dev).toBeUndefined()
})

test('store: under a text search, a push is kept when its body or a name in the push’s directory matches, and dropped otherwise', () => {
  const store = useTeamMessageStore.getState()
  act(() => { store.open('dev', { text: 'ui dev' }) })
  // The snapshot predates the participant: only the push's directory names it.
  store.applySnapshot(snapshot([], { filters: { text: 'ui dev' }, directory: [] }))
  const named = [{ sessionId: 'dev-1', name: 'Strategy UI dev', group: 'devs' }]
  store.applyPush(push([
    message('named', { createdAt: at(1), toKind: 'session', toId: 'dev-1', fromGroup: null }),
    message('body', { createdAt: at(2), body: 'ask the UI dev' }),
    message('other', { createdAt: at(3), body: 'unrelated' }),
  ], named))
  expect(useTeamMessageStore.getState().views.dev!.messages.map(row => row.id)).toEqual(['body', 'named'])
  expect(useTeamMessageStore.getState().views.dev!.directory).toEqual(named)
})

test('rows name their participants, carry delivery-state and priority badges, and show the delivered revision', () => {
  const sent: ClientMessage[] = []
  const renderer = render(sent)
  act(() => {
    useTeamMessageStore.getState().applySnapshot(snapshot([
      message('a', {
        createdAt: at(1), state: 'delivered', priority: 'urgent', taskId: 't1', taskRevision: 3,
        fromSession: 'gone', fromGroup: 'devs', toKind: 'session', toId: 'dev', body: 'Please review',
      }),
      message('b', { createdAt: at(2), fromKind: 'human', fromSession: null, fromGroup: null, toKind: 'group', toId: 'leads', body: 'From the human' }),
    ], { directory }))
  })
  const rows = renderer.root.findAllByProps({ 'data-testid': 'message-row' })
  expect(rows.map(row => row.props['data-message-id'])).toEqual(['a', 'b'])
  expect(textOf(rows[0]!)).toContain('Killed one (gone)')
  expect(textOf(rows[0]!)).toContain('Dev one')
  expect(rows[0]!.findByProps({ 'data-testid': 'message-state' }).children.join('')).toBe('delivered')
  expect(rows[0]!.findByProps({ 'data-testid': 'message-priority' }).children.join('')).toBe('urgent')
  expect(rows[0]!.findByProps({ 'data-testid': 'message-task-revision' }).children.join('')).toBe('Task revision 3')
  expect(rows[0]!.findByProps({ 'data-testid': 'message-body' }).children.join('')).toBe('Please review')
  expect(textOf(rows[1]!)).toContain('Human')
  expect(textOf(rows[1]!)).toContain('group leads')
  // A taskless message records no revision rather than a zero one.
  expect(rows[1]!.findAllByProps({ 'data-testid': 'message-task-revision' })).toHaveLength(0)
  act(() => renderer.unmount())
})

test('filters open a narrowed page and keep a host’s base filters', () => {
  const sent: ClientMessage[] = []
  const renderer = render(sent)
  act(() => { useTeamMessageStore.getState().setFilters('dev', { taskId: 't1' }) })
  act(() => renderer.update(<Host sent={sent} />))
  expect(lastOpen(sent)!.filters).toEqual({ taskId: 't1' })
  const field = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
  act(() => field('Filter by priority').props.onChange({ target: { value: 'urgent' } }))
  expect(lastOpen(sent)!.filters).toEqual({ taskId: 't1', priority: 'urgent' })
  act(() => field('Filter by delivery state').props.onChange({ target: { value: 'delivered' } }))
  expect(lastOpen(sent)!.filters).toEqual({ taskId: 't1', priority: 'urgent', state: 'delivered' })
  act(() => field('Filter by human involvement').props.onChange({ target: { value: 'false' } }))
  expect(lastOpen(sent)!.filters).toEqual({ taskId: 't1', priority: 'urgent', state: 'delivered', human: false })
  // Clearing a control clears only that key.
  act(() => field('Filter by priority').props.onChange({ target: { value: '' } }))
  expect(lastOpen(sent)!.filters).toEqual({ taskId: 't1', state: 'delivered', human: false })
  act(() => renderer.unmount())
})

test('load more asks for the next page from the cursor and appends it', () => {
  const sent: ClientMessage[] = []
  const renderer = render(sent)
  const cursor: MessageCursor = { createdAt: at(1), rowid: 7 }
  act(() => {
    useTeamMessageStore.getState().applySnapshot(snapshot(
      [message('new', { createdAt: at(3) }), message('mid', { createdAt: at(2) })],
      { nextCursor: cursor },
    ))
  })
  const more = renderer.root.findByProps({ 'data-testid': 'messages-load-more' })
  expect(more.children.join('')).toBe('Load more')
  act(() => more.props.onClick())
  expect(lastOpen(sent)!.cursor).toEqual(cursor)
  expect(useTeamMessageStore.getState().views.dev!.loadingMore).toBe(true)
  expect(renderer.root.findByProps({ 'data-testid': 'messages-load-more' }).children.join('')).toBe('Loading more…')
  act(() => {
    useTeamMessageStore.getState().applySnapshot(snapshot([message('old', { createdAt: at(1) })], { nextCursor: null }))
  })
  expect(useTeamMessageStore.getState().views.dev!.messages.map(row => row.id)).toEqual(['new', 'mid', 'old'])
  expect(renderer.root.findAllByProps({ 'data-testid': 'messages-load-more' })).toHaveLength(0)
  act(() => renderer.unmount())
})

test('a thread shows chronological order, reply relations, the current recipient, and each message’s history', () => {
  const sent: ClientMessage[] = []
  const renderer = render(sent)
  const first = message('q1', {
    createdAt: at(1), state: 'delivered', toKind: 'group', toId: 'devs', fromKind: 'human', fromSession: null,
    taskId: 't1', taskRevision: 2, body: 'Please advise', threadId: 'th',
  })
  const second = message('a1', {
    createdAt: at(2), state: 'delivered', toKind: 'human', toId: null, fromSession: 'gone', fromGroup: 'devs',
    inReplyTo: 'q1', hop: 2, body: 'Done', threadId: 'th', taskRevision: 2,
  })
  act(() => { useTeamMessageStore.getState().applySnapshot(snapshot([first, second], { directory })) })
  act(() => renderer.root.findAllByProps({ 'data-testid': 'message-open-thread' })[0]!.props.onClick())
  expect(sent.map(message => message.type)).toContain('team-thread-open')
  expect(useTeamMessageStore.getState().views.dev!.selectedThreadId).toBe('th')
  act(() => {
    useTeamMessageStore.getState().applyThread(thread('th', [
      { message: first, events: [event('q1', 1, 'sent'), event('q1', 2, 'delivered', { prevState: 'claimed' })] },
      {
        message: second,
        events: [event('a1', 1, 'sent'), event('a1', 2, 'retried', { prevClaimedBy: 'gone', prevReason: 'uncertain receipt', reason: 'human retry' })],
      },
    ], directory))
  })
  const entries = renderer.root.findAllByProps({ 'data-testid': 'thread-entry' })
  expect(entries.map(entry => entry.props['data-message-id'])).toEqual(['q1', 'a1'])
  expect(entries.map(entry => entry.props['data-hop'])).toEqual([1, 2])
  // Reply relation names the parent's body; a killed sender keeps its name.
  expect(entries[1]!.findByProps({ 'data-testid': 'message-reply-to' }).children.join('')).toBe('In reply to Please advise')
  expect(textOf(entries[1]!)).toContain('Killed one (gone)')
  expect(entries[1]!.findByProps({ 'data-testid': 'message-to' }).children.join('')).toBe('Human')
  expect(entries[0]!.findByProps({ 'data-testid': 'message-task-revision' }).children.join('')).toBe('Task revision 2')
  const history = entries[1]!.findByProps({ 'data-testid': 'message-events' })
  expect(history.findAll(node => node.props['data-kind'] !== undefined).map(node => node.props['data-kind']))
    .toEqual(['sent', 'retried'])
  expect(textOf(history)).toContain('claimed by gone')
  expect(textOf(history)).toContain('was: uncertain receipt')
  // The list is gone while the thread is open; the back control restores it.
  expect(renderer.root.findAllByProps({ 'data-testid': 'message-row' })).toHaveLength(0)
  act(() => renderer.root.findByProps({ 'data-testid': 'thread-back' }).props.onClick())
  expect(useTeamMessageStore.getState().views.dev!.selectedThreadId).toBeNull()
  expect(sent.map(message => message.type)).toContain('team-thread-close')
  act(() => renderer.unmount())
})

test('a reconnect re-opens the current filters and the selected thread', () => {
  const sent: ClientMessage[] = []
  const renderer = render(sent, { epoch: 1 })
  act(() => { useTeamMessageStore.getState().setFilters('dev', { state: 'delivered' }) })
  act(() => renderer.update(<Host sent={sent} epoch={1} />))
  expect(lastOpen(sent)!.filters).toEqual({ state: 'delivered' })
  const row = message('r1', { createdAt: at(1), threadId: 'th', state: 'delivered' })
  act(() => { useTeamMessageStore.getState().applySnapshot(snapshot([row], { filters: { state: 'delivered' } })) })
  act(() => renderer.root.findByProps({ 'data-testid': 'message-open-thread' }).props.onClick())
  act(() => {
    useTeamMessageStore.getState().applyThread(thread('th', [{ message: row, events: [event('r1', 1, 'sent')] }]))
  })
  const before = opens(sent).length
  // The connection drops and comes back: the host bumps the epoch, and the
  // view re-opens the page and the thread it was holding.
  act(() => renderer.update(<Host sent={sent} epoch={2} />))
  expect(opens(sent).length).toBe(before + 1)
  expect(lastOpen(sent)!.filters).toEqual({ state: 'delivered' })
  expect(lastOpen(sent)!.cursor).toBeUndefined()
  expect(sent.at(-1)!.type).toBe('team-thread-open')
  // The restored snapshot is authoritative for those filters again, and the
  // thread comes back whole rather than as a delta.
  act(() => {
    useTeamMessageStore.getState().applySnapshot(snapshot(
      [message('r2', { createdAt: at(2), threadId: 'th2', state: 'delivered' }), row],
      { filters: { state: 'delivered' } },
    ))
    useTeamMessageStore.getState().applyThread(thread('th', [{ message: row, events: [event('r1', 1, 'sent'), event('r1', 2, 'delivered')] }]))
  })
  expect(useTeamMessageStore.getState().views.dev!.messages.map(each => each.id)).toEqual(['r2', 'r1'])
  const entries = renderer.root.findAllByProps({ 'data-testid': 'thread-entry' })
  expect(entries.map(entry => entry.props['data-message-id'])).toEqual(['r1'])
  expect(entries[0]!.findAll(node => node.props['data-kind'] !== undefined).map(node => node.props['data-kind']))
    .toEqual(['sent', 'delivered'])
  act(() => renderer.root.findByProps({ 'data-testid': 'thread-back' }).props.onClick())
  const list = renderer.root.findAllByProps({ 'data-testid': 'message-row' })
  expect(list.map(entry => entry.props['data-message-id'])).toEqual(['r2', 'r1'])
  act(() => renderer.unmount())
})

test('thread history labels agent actors by name, live or gone; human reads human and unknown reads system', () => {
  const sent: ClientMessage[] = []
  const renderer = render(sent)
  const first = message('q1', { createdAt: at(1), threadId: 'th', state: 'cancelled' })
  act(() => { useTeamMessageStore.getState().applySnapshot(snapshot([first], { directory })) })
  act(() => renderer.root.findAllByProps({ 'data-testid': 'message-open-thread' })[0]!.props.onClick())
  act(() => {
    useTeamMessageStore.getState().applyThread(thread('th', [{
      message: first,
      events: [
        event('q1', 1, 'sent'),
        event('q1', 2, 'cancelled', { actor: 'agent', actorSession: 'dev', reason: 'cancelled by dev: stale' }),
        event('q1', 3, 'discarded', { actor: 'agent', actorSession: 'gone' }),
        event('q1', 4, 'retried', { actor: 'human' }),
        event('q1', 5, 'requeued', { actor: 'weird' as MessageEvent['actor'] }),
      ],
    }], directory))
  })
  const history = renderer.root.findByProps({ 'data-testid': 'message-events' })
  const line = (seq: number) => textOf(history.findByProps({ 'data-seq': seq }).findAllByType('p')[0]!)
  expect(line(1)).toContain('sent · system')
  expect(line(2)).toContain('cancelled · Dev one')
  expect(line(3)).toContain('discarded · Killed one (gone)')
  expect(line(4)).toContain('retried · human')
  expect(line(5)).toContain('requeued · system')
  act(() => renderer.unmount())
})
