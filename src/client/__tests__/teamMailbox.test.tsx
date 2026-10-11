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

afterEach(() => { useTeamMailboxStore.setState({ views: {} }); useChatStore.setState({ sessions: {}, closedAccountNotices: {} }) })
const peer: ChatEvent = { type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 'turn', messageId: 'mail',
  senderSession: 'lead', senderGroup: 'leads', priority: 'urgent', originPath: '/repo/worktree', tags: ['review', 'review'],
  threadId: 'thread', body: 'Review this change', possibleDuplicate: true }
const mail = (id: string, state: TeamMessage['state'], deliverAt: string | null = null): TeamMessage => ({
  id, state, deliverAt, teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads',
  originPath: '/repo', priority: 'normal', tags: [], threadId: id, inReplyTo: null, hop: 1, body: id,
  claimedBy: state === 'uncertain' ? 'dev' : null, claimedAt: null, createdAt: new Date().toISOString(),
  pushedAt: null, deliveredAt: null, reason: null, possibleDuplicate: false, attachThread: false,
})
test('peer row is distinct and restored by reconnect snapshot', () => {
  const events: ChatEvent[] = [{ type: 'user_message', id: 'u1', sequence: 0, at: 'now', turnId: 't', text: 'Human' }, peer]
  useChatStore.getState().snapshot({ type: 'chat-snapshot', sessionId: 'dev', profileId: 'default', events,
    pendingRequests: [], status: 'waiting', throughSequence: 1, commands: { status: 'unavailable', commands: [] },
    activity: null, contextUsage: null, usage: null, workers: [], notifications: [] })
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
  expect(renderer.root.findAllByType('section').map(section => section.props['aria-label'])).toEqual(['Queued', 'Receiving', 'Scheduled', 'Dead letters', 'Held for review'])
  const actions = renderer.root.findAllByType('button').slice(1)
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
