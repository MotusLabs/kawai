// Task subscriptions and human actions over the chat connection (team-tasks
// 6.1/6.2): team-scoped list/detail snapshots, delayed team resolution,
// cross-team refusal, and every human action including reopening a task
// whose creator was killed.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { initDatabase, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'

let dir: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
let sessions: Map<string, TeamIdentity>
let resolveDelay: Promise<void> | null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-connections-'))
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'add-x'), { recursive: true })
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  mail = new MailboxStore(db.db)
  sessions = new Map([['dev', { teamId: 'team', groupsRoot: dir }], ['stranger', { teamId: 'other', groupsRoot: dir }]])
  tasks = new TaskService(new TaskStore(db.db, mail), { getSession: () => undefined })
  resolveDelay = null
  messages = []
  connection = { send: message => messages.push(message) }
  const manager = {
    has: (id: string) => sessions.has(id),
    whenRestored: () => Promise.resolve(),
    teams: {
      teamOf: (id: string) => sessions.get(id),
      resolvedTeamOf: async (id: string) => { if (resolveDelay) await resolveDelay; return sessions.get(id) },
    },
    mailbox: { store: mail }, dispatcher: { notify: () => {} }, tasks,
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  tasks.store.subscribe(task => connections.publishTasks(task.teamId))
  mail.subscribe((team, message) => connections.publishMailbox(team, message))
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const send = (message: ClientMessage) => connections.handle(connection, message)
const human = (teamId = 'team') => ({ kind: 'human' as const, team: { teamId, groupsRoot: dir } })
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)

test('list open snapshots the team, changes push, close and disconnect unsubscribe', async () => {
  const existing = await tasks.create(human(), { title: 'Existing', direction: 'd' })
  await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  await send({ type: 'team-tasks-open', sessionId: 'dev' })
  expect(last('team-tasks-snapshot')).toMatchObject({ sessionId: 'dev', teamId: 'team', tasks: [{ id: existing.id, title: 'Existing' }] })
  await tasks.create(human(), { title: 'Second', direction: 'd' })
  expect(last('team-tasks-snapshot')!.tasks.map(task => task.title)).toEqual(['Existing', 'Second'])
  await tasks.create(human('other'), { title: 'Elsewhere', direction: 'd' })
  expect(last('team-tasks-snapshot')!.tasks).toHaveLength(2)
  await send({ type: 'team-tasks-close', sessionId: 'dev' })
  const count = messages.length
  await tasks.create(human(), { title: 'Unseen', direction: 'd' })
  expect(messages).toHaveLength(count)
  await send({ type: 'team-tasks-open', sessionId: 'dev' })
  connections.disconnect(connection)
  const after = messages.length
  await tasks.create(human(), { title: 'Unseen too', direction: 'd' })
  expect(messages).toHaveLength(after)
})

test('a reconnect gets a fresh authoritative snapshot', async () => {
  await send({ type: 'team-tasks-open', sessionId: 'dev' })
  connections.disconnect(connection)
  await tasks.create(human(), { title: 'Made while away', direction: 'd' })
  const reconnected: ServerMessage[] = []
  await connections.handle({ send: message => reconnected.push(message) }, { type: 'team-tasks-open', sessionId: 'dev' })
  expect(reconnected).toMatchObject([{ type: 'team-tasks-snapshot', tasks: [{ title: 'Made while away' }] }])
})

test('detail open sends revisions, journal, subtasks, participants, and task mail; updates push', async () => {
  const task = await tasks.create(human(), { title: 'Parent', direction: 'v1' })
  await send({ type: 'team-task-open', sessionId: 'dev', taskId: task.id })
  expect(last('team-task-detail')!.detail).toMatchObject({ task: { id: task.id }, revisions: [{ revision: 1 }], journal: [], subtasks: [], messages: [] })
  await tasks.create(human(), { title: 'Child', direction: 'c', parent_id: task.id })
  await tasks.amend(human(), task.id, { direction: 'v2' })
  const sent = mail.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: dir, body: 'go', taskId: task.id })
  const detail = last('team-task-detail')!.detail
  expect(detail.revisions.map(revision => revision.direction)).toEqual(['v1', 'v2'])
  expect(detail.subtasks.map(child => child.title)).toEqual(['Child'])
  expect(detail.messages.map(row => row.id)).toEqual([sent.id])
  expect(detail.task.participants).toEqual(['lead'])
  await send({ type: 'team-task-close', sessionId: 'dev', taskId: task.id })
  const count = messages.filter(message => message.type === 'team-task-detail').length
  await tasks.note(human(), task.id, 'later')
  expect(messages.filter(message => message.type === 'team-task-detail')).toHaveLength(count)
})

test('another team’s task cannot be opened or acted on', async () => {
  const foreign = await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  await send({ type: 'team-task-open', sessionId: 'dev', taskId: foreign.id })
  expect(messages.at(-1)).toEqual({ type: 'error', message: 'Task does not belong to this team' })
  for (const action of [
    { type: 'team-task-note', sessionId: 'dev', requestId: 'r1', taskId: foreign.id, text: 'x' },
    { type: 'team-task-status', sessionId: 'dev', requestId: 'r2', taskId: foreign.id, status: 'done' },
    { type: 'team-task-amend', sessionId: 'dev', requestId: 'r3', taskId: foreign.id, direction: 'x' },
  ] as ClientMessage[]) {
    await send(action)
    expect(last('team-task-result')!.error).toContain('not found in this team')
  }
  expect(tasks.store.get(foreign.id)).toMatchObject({ status: 'open', revision: 1 })
  expect(tasks.store.journal(foreign.id)).toEqual([])
})

test('delayed team resolution: a close sent meanwhile wins over the earlier open', async () => {
  let release!: () => void
  resolveDelay = new Promise(resolve => { release = resolve })
  const opening = send({ type: 'team-tasks-open', sessionId: 'dev' })
  await send({ type: 'team-tasks-close', sessionId: 'dev' })
  release(); await opening
  expect(messages).toEqual([])
  resolveDelay = null
  await send({ type: 'team-tasks-open', sessionId: 'dev' })
  expect(last('team-tasks-snapshot')).toBeDefined()
})

test('an unknown session is refused', async () => {
  await send({ type: 'team-tasks-open', sessionId: 'ghost' })
  expect(messages).toEqual([{ type: 'error', message: 'Chat team is unavailable' }])
  await send({ type: 'team-task-create', sessionId: 'ghost', requestId: 'r', title: 't', direction: 'd' })
  expect(last('team-task-result')).toEqual({ type: 'team-task-result', sessionId: 'ghost', requestId: 'r', error: 'Chat team is unavailable' })
})

test('human create with parent and change, amend, note, and status answer by request id and push revisions', async () => {
  await send({ type: 'team-tasks-open', sessionId: 'dev' })
  await send({ type: 'team-task-create', sessionId: 'dev', requestId: 'c1', title: 'Parent', direction: 'p' })
  const parent = last('team-task-result')!.task!
  await send({ type: 'team-task-create', sessionId: 'dev', requestId: 'c2', title: 'Child', direction: 'v1', acceptance: 'ok', parentId: parent.id, openspecChange: 'add-x' })
  const created = last('team-task-result')!
  expect(created).toMatchObject({ requestId: 'c2', task: { title: 'Child', parentId: parent.id, openspecChange: 'add-x', creator: { kind: 'human' } } })
  const id = created.task!.id
  await send({ type: 'team-task-open', sessionId: 'dev', taskId: id })
  await send({ type: 'team-task-amend', sessionId: 'dev', requestId: 'a1', taskId: id, direction: 'v2' })
  expect(last('team-task-result')).toMatchObject({ requestId: 'a1', task: { revision: 2 } })
  expect(last('team-task-detail')!.detail.revisions.map(revision => revision.direction)).toEqual(['v1', 'v2'])
  await send({ type: 'team-task-note', sessionId: 'dev', requestId: 'n1', taskId: id, text: 'Human note' })
  expect(last('team-task-detail')!.detail.journal).toMatchObject([{ text: 'Human note', author: { kind: 'human' } }])
  await send({ type: 'team-task-status', sessionId: 'dev', requestId: 's1', taskId: id, status: 'blocked' })
  expect(last('team-task-result')).toMatchObject({ requestId: 's1', task: { status: 'blocked' } })
  expect(last('team-tasks-snapshot')!.tasks.find(task => task.id === id)?.status).toBe('blocked')
})

test('invalid references come back as errors and create nothing', async () => {
  for (const [requestId, extra, error] of [
    ['p', { parentId: 'task-missing' }, 'Parent task not found'],
    ['w', { worktree: path.join(dir, 'nowhere') }, 'is not a worktree'],
    ['o', { openspecChange: 'missing-change' }, 'OpenSpec change not found'],
  ] as const) {
    await send({ type: 'team-task-create', sessionId: 'dev', requestId, title: 't', direction: 'd', ...extra })
    expect(last('team-task-result')).toMatchObject({ requestId })
    expect(last('team-task-result')!.error).toContain(error)
  }
  expect(tasks.store.list('team')).toEqual([])
})

test('the human reopens and closes a task whose agent creator was killed', async () => {
  const task = tasks.store.create({ teamId: 'team', title: 'Orphan', direction: 'd', creator: { kind: 'agent', sessionId: 'killed-lead' } })
  tasks.store.setStatus(task.id, 'done')
  await send({ type: 'team-task-status', sessionId: 'dev', requestId: 'r', taskId: task.id, status: 'open' })
  expect(last('team-task-result')).toMatchObject({ task: { status: 'open', creator: { kind: 'agent', sessionId: 'killed-lead' } } })
  await send({ type: 'team-task-status', sessionId: 'dev', requestId: 'r2', taskId: task.id, status: 'cancelled' })
  expect(tasks.store.get(task.id)!.status).toBe('cancelled')
})

test('list and detail opened together both subscribe (header link opens the panel on a task)', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'd' })
  let release!: () => void
  resolveDelay = new Promise(resolve => { release = resolve })
  const list = send({ type: 'team-tasks-open', sessionId: 'dev' })
  const detail = send({ type: 'team-task-open', sessionId: 'dev', taskId: task.id })
  release(); await Promise.all([list, detail])
  expect(last('team-tasks-snapshot')!.tasks.map(row => row.id)).toEqual([task.id])
  expect(last('team-task-detail')!.detail.task.id).toBe(task.id)
  // The list stays subscribed: a later task change still pushes it.
  resolveDelay = null
  await tasks.create(human(), { title: 'Import', direction: 'd' })
  expect(last('team-tasks-snapshot')!.tasks.map(row => row.title)).toEqual(['Export', 'Import'])
})

test('reconnect with a detail open resubscribes both list and detail', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'd' })
  await send({ type: 'team-tasks-open', sessionId: 'dev' })
  await send({ type: 'team-task-open', sessionId: 'dev', taskId: task.id })
  connections.disconnect(connection)
  messages = []
  // The client's effects re-run in order: both closes, then both opens, unawaited.
  let release!: () => void
  resolveDelay = new Promise(resolve => { release = resolve })
  const pending = [
    send({ type: 'team-tasks-close', sessionId: 'dev' }),
    send({ type: 'team-task-close', sessionId: 'dev', taskId: task.id }),
    send({ type: 'team-tasks-open', sessionId: 'dev' }),
    send({ type: 'team-task-open', sessionId: 'dev', taskId: task.id }),
  ]
  release(); await Promise.all(pending)
  expect(messages.map(message => message.type).sort()).toEqual(['team-task-detail', 'team-tasks-snapshot'])
  resolveDelay = null
  await tasks.note(human(), task.id, 'after reconnect')
  expect(last('team-tasks-snapshot')).toBeDefined()
  expect(last('team-task-detail')!.detail.journal.map(entry => entry.text)).toEqual(['after reconnect'])
  expect(messages.filter(message => message.type === 'team-tasks-snapshot').length).toBeGreaterThan(1)
})

test('a close still supersedes a pending open of the same detail only', async () => {
  const a = await tasks.create(human(), { title: 'A', direction: 'd' })
  const b = await tasks.create(human(), { title: 'B', direction: 'd' })
  let release!: () => void
  resolveDelay = new Promise(resolve => { release = resolve })
  const openA = send({ type: 'team-task-open', sessionId: 'dev', taskId: a.id })
  const openB = send({ type: 'team-task-open', sessionId: 'dev', taskId: b.id })
  await send({ type: 'team-task-close', sessionId: 'dev', taskId: a.id })
  release(); await Promise.all([openA, openB])
  expect(messages.filter(message => message.type === 'team-task-detail').map(message => (message as { detail: { task: { id: string } } }).detail.task.id)).toEqual([b.id])
})
