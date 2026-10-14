// Team workspace subscriptions over the chat connection (team-workspace 5.1,
// 5.2; team-workspace-pages 1.4): teamPath addressing through the team-scope
// resolver, authoritative snapshots on open and reconnect, diffed full-set
// change pushes, close and disconnect, and team isolation between two
// repositories.
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
import { AssignmentStore } from '../team/assignmentStore'
import { loadGroupCatalog, type GroupCatalog } from '../team/groupCatalog'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { ChatSessionRecord } from '../db'

let dir: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
let records: Array<ChatSessionRecord & { teamId: string }>
let pendingRequests: Map<string, unknown[]>
let catalog: GroupCatalog

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-workspace-connections-'))
  fs.mkdirSync(path.join(dir, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild features')
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  mail = new MailboxStore(db.db)
  const assignmentStore = new AssignmentStore(db.db, mail)
  const taskStore = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(taskStore, { getSession: () => undefined })
  catalog = loadGroupCatalog({ groupsRoot: dir })
  records = []
  pendingRequests = new Map()
  messages = []
  connection = { send: message => messages.push(message) }
  // Known team paths (team-workspace-pages D1): this repository (two paths,
  // one team) and another team's.
  const teams = new Map<string, TeamIdentity>([
    ['/repo', { teamId: 'team', groupsRoot: dir }],
    ['/repo/.worktrees/feat-x', { teamId: 'team', groupsRoot: dir }],
    ['/other', { teamId: 'other', groupsRoot: dir }],
  ])
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: { resolve: async (teamPath: string) => teams.get(teamPath) },
    mailbox: { store: mail },
    tasks,
    waitingFor: () => ({}),
    teamRecords: (teamId: string) => records.filter(record => record.teamId === teamId),
    directory: { list: () => [] },
    getPendingRequests: (sessionId: string) => pendingRequests.get(sessionId) ?? [],
    groupProfileCounts: () => ({}),
    getHistory: () => null,
    teams: { catalogForTeam: () => catalog },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  taskStore.subscribe(task => connections.publishTasks(task.teamId))
  mail.subscribe(team => connections.publishMailbox(team))
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const send = (message: ClientMessage) => connections.handle(connection, message)
const human = (teamId = 'team') => ({ kind: 'human' as const, team: { teamId, groupsRoot: dir } })
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)
const recordOf = (overrides: Partial<ChatSessionRecord & { teamId: string }> = {}): ChatSessionRecord & { teamId: string } => ({
  sessionId: 'chat-1', name: 'Dev one', projectPath: '/repo', sdkSessionId: null,
  status: 'waiting', createdAt: '2026-10-14T00:00:00Z', lastActivityAt: '2026-10-14T01:00:00Z',
  groupId: 'devs', teamId: 'team', ...overrides,
})

test('open snapshots the team; a team with no tasks serializes empty lists', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  const snapshot = last('team-workspace-snapshot')!
  expect(snapshot).toMatchObject({ teamPath: '/repo', teamId: 'team', tasks: [], attention: [], directory: [] })
  expect(snapshot.members.map(member => member.id)).toEqual(['devs'])
  expect(snapshot.summary.completedResults.items).toEqual([])
})

test('changes push full sets, an unchanged read stays quiet, close and disconnect unsubscribe', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  const task = await tasks.create(human(), { title: 'Existing', direction: 'd' })
  expect(last('team-workspace')!.tasks.map(row => row.title)).toEqual(['Existing'])
  // The same unchanged state pushes nothing (diff before sending).
  const count = messages.length
  connections.publishWorkspace('team')
  expect(messages).toHaveLength(count)
  // A meaningful change pushes again.
  await tasks.setStatus(human(), task.id, 'active')
  expect(last('team-workspace')!.tasks[0]!.status).toBe('active')
  await send({ type: 'team-workspace-close', teamPath: '/repo' })
  const afterClose = messages.length
  await tasks.create(human(), { title: 'Unseen', direction: 'd' })
  expect(messages).toHaveLength(afterClose)
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  connections.disconnect(connection)
  const afterDisconnect = messages.length
  await tasks.create(human(), { title: 'Unseen too', direction: 'd' })
  expect(messages).toHaveLength(afterDisconnect)
})

test('a reconnect gets a fresh authoritative snapshot', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  connections.disconnect(connection)
  await tasks.create(human(), { title: 'Made while away', direction: 'd' })
  const reconnected: ServerMessage[] = []
  await connections.handle({ send: message => reconnected.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
  expect(reconnected).toHaveLength(1)
  expect(reconnected[0]).toMatchObject({ type: 'team-workspace-snapshot', teamId: 'team', tasks: [{ title: 'Made while away' }] })
})

test('an unknown path is refused with no data', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/nowhere' })
  expect(messages).toEqual([{ type: 'error', message: 'unknown-team: /nowhere' }])
})

test('a worktree path and the main checkout reach the same team; each subscription gets its copy', async () => {
  await tasks.create(human(), { title: 'Shared', direction: 'd' })
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  await send({ type: 'team-workspace-open', teamPath: '/repo/.worktrees/feat-x' })
  expect(messages.filter(message => message.type === 'team-workspace-snapshot')).toHaveLength(2)
  // One change fans out to both subscriptions of the team, each under its own teamPath.
  messages.length = 0
  await tasks.create(human(), { title: 'Second', direction: 'd' })
  const pushes = messages.filter(message => message.type === 'team-workspace')
  expect(pushes.map(push => push.teamPath).sort()).toEqual(['/repo', '/repo/.worktrees/feat-x'])
})

test('a second repository stays isolated: no tasks, mail, or attention of the other team', async () => {
  const ours = await tasks.create(human(), { title: 'Ours', direction: 'd' })
  const theirs = await tasks.create(human('other'), { title: 'Theirs', direction: 'd' })
  records = [
    recordOf({ sessionId: 'our-dev', groupId: 'devs' }),
    recordOf({ sessionId: 'their-dev', groupId: 'devs', teamId: 'other', taskId: theirs.id }),
  ]
  pendingRequests.set('our-dev', [{
    kind: 'approval', requestId: 'req-1', tool: 'Bash', input: {},
    at: '2026-10-14T06:00:00Z',
  }])
  mail.enqueue({ teamId: 'other', toKind: 'session', toId: 'their-dev', fromSession: 'x', fromGroup: null, originPath: dir, body: 'foreign', taskId: theirs.id })
  const ours_ = mail.enqueue({ teamId: 'team', toKind: 'session', toId: 'our-dev', fromSession: 'x', fromGroup: null, originPath: dir, body: 'ours', taskId: ours.id })
  mail.claim(ours_.id, 'our-dev')
  mail.holdUncertain(ours_.id, 'transcript missing')
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  const snapshot = last('team-workspace-snapshot')!
  expect(snapshot.tasks.map(row => row.title)).toEqual(['Ours'])
  expect(snapshot.attention.map(item => item.id)).toEqual(['approval:our-dev:req-1', `uncertain-delivery:${ours_.id}`])
  expect(snapshot.members[0]!.members.map(member => member.sessionId)).toEqual(['our-dev'])
  // Opening the other team beside the first keeps each to its own facts.
  messages.length = 0
  await send({ type: 'team-workspace-open', teamPath: '/other' })
  const other = last('team-workspace-snapshot')!
  expect(other.teamId).toBe('other')
  expect(other.tasks.map(row => row.title)).toEqual(['Theirs'])
  expect(other.attention.map(item => item.id)).toEqual([])
})

test('a pending approval appears live when the workspace is open', async () => {
  records = [recordOf({ sessionId: 'our-dev', groupId: 'devs' })]
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  expect(last('team-workspace-snapshot')!.attention).toEqual([])
  pendingRequests.set('our-dev', [{
    kind: 'approval', requestId: 'req-1', tool: 'Bash', input: {},
    at: '2026-10-14T06:00:00Z',
  }])
  connections.publishWorkspace('team')
  expect(last('team-workspace')!.attention.map(item => item.id)).toEqual(['approval:our-dev:req-1'])
})
