// Messages-view subscriptions and human sends over the chat connection
// (team-message-threads 5.1): open snapshots the subscription's own filters,
// changes push, close and disconnect unsubscribe; a reconnect is an
// authoritative snapshot again; threads keep live; sends and replies answer
// with the stored row or the refusal, and the client request id never lands
// in a durable row.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { TeamMailbox } from '../team/TeamMailbox'
import { MailboxStore } from '../team/mailboxStore'
import { MessageFeed } from '../team/messageFeed'
import { MessageQuery } from '../team/messageQuery'
import { TaskStore } from '../team/taskStore'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'

const REQUEST = 'req-42'

let dir: string
let project: string
let elsewhere: string
let db: Database
let store: MailboxStore
let tasks: TaskStore
let mailbox: TeamMailbox
let feed: MessageFeed
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
let records: Map<string, ChatSessionRecord>
let teams: Map<string, TeamIdentity>
let team: TeamIdentity

beforeEach(async () => {
  clearTeamCache()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-message-connections-'))
  project = path.join(dir, 'project')
  elsewhere = path.join(dir, 'elsewhere')
  for (const root of [project, elsewhere]) {
    fs.mkdirSync(path.join(root, '.kawai/groups'), { recursive: true })
    fs.writeFileSync(path.join(root, '.kawai/groups/devs.md'), '---\ndescription: Developers\n---\nBuild features')
  }
  const row = (id: string, projectPath: string): ChatSessionRecord => ({
    sessionId: id, projectPath, groupId: 'devs', name: id, sdkSessionId: null,
    status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  records = new Map([['dev', row('dev', project)], ['stranger', row('stranger', elsewhere)]])
  teams = new Map()
  db = new Database(':memory:')
  // Task summaries join the session table for participants; the rest of the
  // schema this test needs is created by the stores themselves.
  db.run('CREATE TABLE IF NOT EXISTS chat_sessions (session_id TEXT PRIMARY KEY, task_id TEXT)')
  store = new MailboxStore(db)
  tasks = new TaskStore(db)
  mailbox = new TeamMailbox(store, { getSession: id => records.get(id), homeDir: dir, tasks })
  feed = new MessageFeed(store, new MessageQuery(db))
  team = await resolveTeam(project)
  teams.set('dev', team)
  teams.set('stranger', await resolveTeam(elsewhere))
  messages = []
  connection = { send: message => messages.push(message) }
  const manager = {
    has: (id: string) => records.has(id),
    whenRestored: () => Promise.resolve(),
    teams: {
      teamOf: (id: string) => teams.get(id),
      resolvedTeamOf: async (id: string) => teams.get(id),
    },
    mailbox, messages: feed,
    // The real manager exposes a TaskService, whose store lists summaries.
    tasks: { store: tasks }, dispatcher: { notify: () => {} },
    directory: { list: () => [{ sessionId: 'gone', name: 'Killed helper', group: 'qa' }] },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
})
afterEach(() => {
  feed.close()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const send = (message: ClientMessage) => connections.handle(connection, message)
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)
const count = (type: ServerMessage['type']) => messages.filter(message => message.type === type).length
const bodies = (rows: { body: string }[]) => rows.map(row => row.body)
const sendResult = () => last('team-message-send-result')!
const failOf = (requestId = REQUEST) => {
  const result = messages.filter(message => message.type === 'team-message-send-result')
    .filter(message => (message as { requestId: string }).requestId === requestId).at(-1)
  return (result as { error?: string }).error
}

const fromTeam = (to: { kind: 'group' | 'session'; id: string }, body: string, teamId = team.teamId) =>
  store.enqueue({
    teamId, toKind: to.kind, toId: to.id, fromSession: 'lead', fromGroup: 'devs',
    originPath: '/repo', body,
  })

test('list open snapshots the team, changes push, close and disconnect unsubscribe', async () => {
  fromTeam({ kind: 'group', id: 'devs' }, 'Existing')
  fromTeam({ kind: 'group', id: 'devs' }, 'Theirs', teams.get('stranger')!.teamId)
  const task = tasks.create({ teamId: team.teamId, title: 'Export CSV', direction: 'd', creator: { kind: 'human', sessionId: null } })
  await send({ type: 'team-messages-open', sessionId: 'dev' })
  // One open, one authoritative snapshot — never two, and never on change.
  expect(count('team-messages-snapshot')).toBe(1)
  expect(last('team-messages-snapshot')!.teamId).toBe(team.teamId)
  expect(bodies(last('team-messages-snapshot')!.messages)).toEqual(['Existing'])
  // The snapshot also names killed participants and offers the team's tasks,
  // so the composer needs no other panel open.
  expect(last('team-messages-snapshot')!.directory).toEqual([{ sessionId: 'gone', name: 'Killed helper', group: 'qa' }])
  expect(last('team-messages-snapshot')!.tasks).toEqual([{ id: task.id, title: 'Export CSV' }])
  fromTeam({ kind: 'group', id: 'devs' }, 'Second')
  expect(bodies(last('team-messages')!.messages)).toEqual(['Second'])
  fromTeam({ kind: 'group', id: 'devs' }, 'Elsewhere', teams.get('stranger')!.teamId)
  expect(bodies(last('team-messages')!.messages)).toEqual(['Second'])
  expect(count('team-messages-snapshot')).toBe(1)
  await send({ type: 'team-messages-close', sessionId: 'dev' })
  const afterClose = messages.length
  fromTeam({ kind: 'group', id: 'devs' }, 'Unseen')
  expect(messages.length).toBe(afterClose)
  await send({ type: 'team-messages-open', sessionId: 'dev' })
  expect(count('team-messages-snapshot')).toBe(2)
  // A re-open sees everything the team has, including the row that arrived
  // while the view was closed — only pushes are subscription-scoped.
  expect(bodies(last('team-messages-snapshot')!.messages)).toEqual(['Unseen', 'Second', 'Existing'])
  connections.disconnect(connection)
  const afterDisconnect = messages.length
  fromTeam({ kind: 'group', id: 'devs' }, 'Unseen too')
  expect(messages.length).toBe(afterDisconnect)
})

test('a reconnect is an authoritative snapshot of the current filters', async () => {
  fromTeam({ kind: 'group', id: 'devs' }, 'Queued')
  await send({ type: 'team-messages-open', sessionId: 'dev', filters: { state: 'queued' } })
  expect(bodies(last('team-messages-snapshot')!.messages)).toEqual(['Queued'])
  connections.disconnect(connection)
  const delivered = fromTeam({ kind: 'group', id: 'devs' }, 'Delivered')
  store.claim(delivered.id, 'dev')
  store.markPushed(delivered.id)
  store.markDelivered(delivered.id)
  const reconnected: ServerMessage[] = []
  await connections.handle({ send: message => reconnected.push(message) }, {
    type: 'team-messages-open', sessionId: 'dev', filters: { state: 'queued' },
  })
  const snapshot = reconnected.find(message => message.type === 'team-messages-snapshot')!
  expect(snapshot.type).toBe('team-messages-snapshot')
  expect((snapshot as { filters: unknown }).filters).toEqual({ state: 'queued' })
  expect(bodies((snapshot as { messages: { body: string }[] }).messages)).toEqual(['Queued'])
})

test('thread open sends the thread with its events and re-sends on change', async () => {
  const first = fromTeam({ kind: 'group', id: 'devs' }, 'Question')
  store.claim(first.id, 'dev'); store.markPushed(first.id); store.markDelivered(first.id)
  await send({ type: 'team-thread-open', sessionId: 'dev', threadId: first.threadId })
  expect(last('team-thread')!.threadId).toBe(first.threadId)
  expect(last('team-thread')!.entries).toHaveLength(1)
  expect(last('team-thread')!.entries[0]!.events.map(event => event.kind))
    .toEqual(['sent', 'claimed', 'pushed', 'delivered'])
  // A thread open answers with the thread only — it never disturbs a list.
  expect(count('team-messages-snapshot')).toBe(0)
  // A change in the open thread re-sends it whole…
  await mailbox.reply({ kind: 'human', team }, { message_id: first.id, body: 'Follow-up' })
  expect(last('team-thread')!.entries).toHaveLength(2)
  // …while a change in another thread does not.
  const elsewhereRow = fromTeam({ kind: 'group', id: 'devs' }, 'Elsewhere')
  expect(count('team-thread')).toBe(2)
  await send({ type: 'team-thread-close', sessionId: 'dev', threadId: first.threadId })
  store.cancel(elsewhereRow.id)
  expect(count('team-thread')).toBe(2)
})

test('a cursor open answers with that page and leaves an open thread alone', async () => {
  const rows = ['First', 'Second', 'Third'].map(body => fromTeam({ kind: 'group', id: 'devs' }, body))
  // A page of two is what a client would already have walked; its cursor is
  // the keyset of the last row it holds.
  const walked = feed.snapshot(team.teamId, {}, null, 2)
  expect(bodies(walked.messages)).toEqual(['Third', 'Second'])
  await send({ type: 'team-messages-open', sessionId: 'dev', cursor: walked.nextCursor! })
  expect(count('team-messages-snapshot')).toBe(1)
  expect(bodies(last('team-messages-snapshot')!.messages)).toEqual(['First'])
  expect(last('team-messages-snapshot')!.nextCursor).toBeNull()
  // Opening a thread beside that page must not re-send any list page.
  await send({ type: 'team-thread-open', sessionId: 'dev', threadId: rows[0]!.threadId })
  expect(count('team-messages-snapshot')).toBe(1)
  expect(count('team-thread')).toBe(1)
})

test('a thread of another team is refused', async () => {
  const theirs = fromTeam({ kind: 'group', id: 'devs' }, 'Theirs', teams.get('stranger')!.teamId)
  await send({ type: 'team-thread-open', sessionId: 'dev', threadId: theirs.threadId })
  expect(last('error')?.message).toBe('Message does not belong to this team')
  expect(count('team-thread')).toBe(0)
})

test('a send to a group is stored and answered with the row', async () => {
  await send({
    type: 'team-message-send', sessionId: 'dev', requestId: REQUEST,
    to: { kind: 'group', id: 'devs' }, body: 'Build it', taskId: undefined,
  })
  const result = sendResult()
  expect(result.requestId).toBe(REQUEST)
  expect(result.error).toBeUndefined()
  expect(result.message).toMatchObject({
    fromKind: 'human', fromSession: null, toKind: 'group', toId: 'devs', body: 'Build it', state: 'queued',
  })
  const stored = store.get(result.message!.id)
  expect(stored?.body).toBe(result.message!.body)
  expect(stored).toEqual(result.message ?? null)
})

test('a reply to a human message reaches them, settled on send', async () => {
  const question = await mailbox.send({ kind: 'human', team }, {
    to_kind: 'group', to_id: 'devs', body: 'Please advise',
  })
  store.claim(question.id, 'dev'); store.markPushed(question.id); store.markDelivered(question.id)
  await send({
    type: 'team-message-send', sessionId: 'dev', requestId: REQUEST,
    inReplyTo: question.id, body: 'Done',
  })
  const reply = sendResult().message!
  expect(reply.toKind).toBe('human')
  expect(reply.state).toBe('delivered')
  expect(reply.inReplyTo).toBe(question.id)
  // Settled on send: no claim or push ever happens to a human recipient.
  expect(feed.thread(team.teamId, question.threadId).map(entry => entry.events.map(event => event.kind)))
    .toEqual([['sent', 'claimed', 'pushed', 'delivered'], ['sent', 'delivered']])
})

test('a send needs exactly one of to and inReplyTo', async () => {
  await send({ type: 'team-message-send', sessionId: 'dev', requestId: 'both', body: 'x', to: { kind: 'group', id: 'devs' }, inReplyTo: 'y' })
  await send({ type: 'team-message-send', sessionId: 'dev', requestId: 'neither', body: 'x' })
  expect(failOf('both')).toBe('Provide exactly one of to or inReplyTo')
  expect(failOf('neither')).toBe('Provide exactly one of to or inReplyTo')
  expect(store.listForTeam(team.teamId)).toHaveLength(0)
})

test('send results report refusals and request ids never persist', async () => {
  await send({ type: 'team-message-send', sessionId: 'dev', requestId: REQUEST, to: { kind: 'group', id: 'nope' }, body: 'x' })
  expect(failOf()).toContain('Unknown group')
  await send({ type: 'team-message-send', sessionId: 'dev', requestId: REQUEST, to: { kind: 'group', id: 'devs' }, body: 'Forged', taskId: 'task-missing' })
  expect(failOf()).toContain('Task not found')
  await send({ type: 'team-message-send', sessionId: 'stranger', requestId: REQUEST, to: { kind: 'group', id: 'devs' }, body: 'From afar' })
  // A stranger's send is stamped with its own team, never this one.
  expect(store.listForTeam(team.teamId)).toHaveLength(0)
  const accepted = await mailbox.send({ kind: 'human', team }, { to_kind: 'group', to_id: 'devs', body: 'Kept' })
  await send({ type: 'team-message-send', sessionId: 'dev', requestId: REQUEST, to: { kind: 'group', id: 'devs' }, body: 'Stored' })
  const rows = store.listForTeam(team.teamId)
  expect(bodies(rows)).toEqual(['Kept', 'Stored'])
  for (const row of rows) expect(JSON.stringify(row)).not.toContain(REQUEST)
  expect(JSON.stringify(feed.thread(team.teamId, accepted.threadId))).not.toContain(REQUEST)
  expect(store.eventsFor(accepted.id).map(event => event.kind)).toEqual(['sent'])
})
