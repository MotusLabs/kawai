// Mailbox subscriptions enforce team scope and publish authoritative state.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { MailboxStore } from '../team/mailboxStore'
import type { ServerMessage } from '../../shared/types'

let db: Database
let store: MailboxStore
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
beforeEach(() => {
  db = new Database(':memory:'); store = new MailboxStore(db); messages = []
  connection = { send: message => messages.push(message) }
  const manager = {
    has: (id: string) => id === 'dev',
    teams: { teamOf: () => ({ teamId: 'team' }), resolvedTeamOf: async () => ({ teamId: 'team' }) },
    mailbox: { store }, dispatcher: { notify: () => {} },
    getSnapshot: () => ({ type: 'chat-snapshot', sessionId: 'dev', events: [], pendingRequests: [] }),
    isArchived: () => true,
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  store.subscribe((team, message) => connections.publishMailbox(team, message))
})
afterEach(() => db.close())
const enqueue = (teamId = 'team', hopLimit?: number) => store.enqueue({ teamId, fromSession: 'lead', fromGroup: null,
  toKind: 'group', toId: 'devs', originPath: '/repo', body: 'Work', hopLimit })
const open = () => connections.handle(connection, { type: 'team-mailbox-open', sessionId: 'dev' })

test('open snapshots, enqueue pushes, close and disconnect unsubscribe', async () => {
  await open(); expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot', messages: [] })
  const mail = enqueue(); expect(messages.at(-1)).toMatchObject({ messages: [{ id: mail.id, state: 'queued' }] })
  await connections.handle(connection, { type: 'team-mailbox-close', sessionId: 'dev' })
  const count = messages.length; enqueue(); expect(messages).toHaveLength(count)
  await open(); connections.disconnect(connection)
  const disconnected = messages.length; enqueue(); expect(messages).toHaveLength(disconnected)
})
test('cancel, retry, discard push updated snapshots; cross-team actions are refused', async () => {
  await open()
  const mail = enqueue()
  await connections.handle(connection, { type: 'team-mailbox-cancel', sessionId: 'dev', messageId: mail.id })
  expect(store.get(mail.id)?.state).toBe('cancelled')
  const dead = enqueue(); store.deadLetter(dead.id, 'killed-recipient')
  await connections.handle(connection, { type: 'team-mailbox-retry', sessionId: 'dev', messageId: dead.id })
  expect(store.get(dead.id)?.state).toBe('queued')
  store.deadLetter(dead.id, 'killed-recipient')
  await connections.handle(connection, { type: 'team-mailbox-discard', sessionId: 'dev', messageId: dead.id })
  expect(store.get(dead.id)?.state).toBe('discarded')
  const foreign = enqueue('other')
  await connections.handle(connection, { type: 'team-mailbox-cancel', sessionId: 'dev', messageId: foreign.id })
  expect(store.get(foreign.id)?.state).toBe('queued')
  expect(messages.at(-1)).toMatchObject({ type: 'error', message: 'Message does not belong to this team' })
})
test('uncertain retry stays direct to the original recipient with duplicate notice', async () => {
  await open(); const mail = enqueue(); store.claim(mail.id, 'dev'); store.markPushed(mail.id); store.holdUncertain(mail.id, 'torn')
  await connections.handle(connection, { type: 'team-mailbox-retry', sessionId: 'dev', messageId: mail.id })
  expect(store.get(mail.id)).toMatchObject({ state: 'queued', toKind: 'session', toId: 'dev', possibleDuplicate: true })
  expect(messages.at(-1)).toMatchObject({ type: 'team-mailbox-snapshot' })
})
test('hop-limit dead letter notifies attached team client once', async () => {
  await connections.handle(connection, { type: 'chat-attach', sessionId: 'dev' })
  const first = enqueue(); store.claim(first.id, 'dev'); store.markDelivered(first.id)
  store.enqueue({ teamId: 'team', fromSession: 'dev', fromGroup: null, toKind: 'group', toId: 'devs', originPath: '/repo',
    body: 'Loop', inReplyTo: first, hopLimit: 1 })
  expect(messages.filter(message => message.type === 'team-mailbox-dead-letter')).toHaveLength(1)
})
