// Task-result human actions over the chat connection (task-results-handoffs
// 3.3/5.2/6.2): accept-result, handoff, and release, each answered by
// team-task-result with refusals inline, every one refused across teams,
// and the task detail carrying results to subscribers.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { initDatabase, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import type { ClientMessage, ServerMessage } from '../../shared/types'

let dir: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let results: TaskResultService
let assignments: AssignmentService
let connections: ChatConnections
let messages: ServerMessage[]
const connection = { send: (message: ServerMessage) => { messages.push(message) } }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-result-connections-'))
  fs.mkdirSync(path.join(dir, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild features')
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'reviewers.md'), '---\nlabel: Reviewers\n---\nReview')
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  mail = new MailboxStore(db.db)
  const teams = new Map([['/repo', { teamId: 'team', groupsRoot: dir }], ['/other', { teamId: 'other', groupsRoot: dir }]])
  const assignmentStore = new AssignmentStore(db.db, mail)
  const taskStore = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(taskStore, { getSession: () => undefined })
  const worktrees = new TeamWorktrees()
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => [], teamOf: () => undefined, caps: new TeamCaps({}), worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(db.db, assignmentStore, taskStore, mail, {
    getSession: () => undefined, records: () => [], teamOf: () => undefined, staffing, caps: new TeamCaps({}), worktrees,
  })
  results = new TaskResultService(tasks, { getSession: () => undefined, assignments })
  messages = []
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: { resolve: async (teamPath: string) => teams.get(teamPath) },
    mailbox: { store: mail }, dispatcher: { notify: () => {} }, tasks, assignments, results,
    directory: { list: () => [] },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  taskStore.subscribe(task => connections.publishTasks(task.teamId))
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const send = (message: ClientMessage) => connections.handle(connection, message)
const human = (teamId = 'team') => ({ kind: 'human' as const, team: { teamId, groupsRoot: dir } })
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)
/** A result submitted by an agent (the store path; this harness has no agent sessions). */
const resultFor = (taskId: string, revision = 1) => tasks.store.results.insert({
  teamId: tasks.store.get(taskId)!.teamId, taskId, summary: 'CSV export', commit: 'abc123', diff: null, worktree: null,
  tests: [], limitations: null, taskRevision: revision, submittedBy: { kind: 'agent', sessionId: 'dev' },
})

test('accept-result closes the task and pushes the result; a flagged result is refused inline until a reason is given', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  const result = resultFor(task.id)
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  await tasks.amend(human(), task.id, { direction: 'v2' })
  await send({ type: 'team-task-accept-result', teamPath: '/repo', requestId: 'a1', taskId: task.id, resultId: result.id })
  expect(last('team-task-result')!.error).toContain('needs a stated reason; nothing was accepted')
  expect(tasks.store.get(task.id)?.status).toBe('open')
  await send({ type: 'team-task-accept-result', teamPath: '/repo', requestId: 'a2', taskId: task.id, resultId: result.id, reason: 'Cosmetic change' })
  expect(last('team-task-result')).toMatchObject({ requestId: 'a2', task: { status: 'done' } })
  expect(last('team-task-detail')!.detail.results).toMatchObject([{ id: result.id, acceptedBy: { kind: 'human' }, needsReevaluation: true }])
})

test('accept-result on another team\'s task is refused and writes nothing', async () => {
  const foreign = await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  const result = resultFor(foreign.id)
  await send({ type: 'team-task-accept-result', teamPath: '/repo', requestId: 'x', taskId: foreign.id, resultId: result.id, reason: 'r' })
  expect(last('team-task-result')!.error).toContain('not found in this team')
  expect(tasks.store.results.get(result.id)!.acceptedAt).toBeNull()
  expect(tasks.store.get(foreign.id)?.status).toBe('open')
})

test('handoff dispatches a review of a result to a role; the same key replays; the detail shows the handoff assignment', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  const result = resultFor(task.id)
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  const request = { type: 'team-task-handoff' as const, teamPath: '/repo', taskId: task.id, kind: 'review' as const, resultId: result.id,
    target: { kind: 'group' as const, id: 'reviewers' }, instructions: 'Review the export', requestKey: 'handoff-1' }
  await send({ ...request, requestId: 'h1' })
  const first = last('team-task-result')!
  expect(first).toMatchObject({ requestId: 'h1', replay: false, assignment: { handoffKind: 'review', resultId: result.id, targetId: 'reviewers' } })
  await send({ ...request, requestId: 'h2' })
  expect(last('team-task-result')).toMatchObject({ requestId: 'h2', replay: true, assignment: { id: first.assignment!.id } })
  expect(mail.forTask(task.id)).toHaveLength(1)
  expect(last('team-task-detail')!.detail.assignments).toMatchObject([{ id: first.assignment!.id, handoffKind: 'review', state: 'queued' }])
  // A replay of the key for another result is refused inline.
  const newer = resultFor(task.id)
  await send({ ...request, requestId: 'h3', resultId: newer.id })
  expect(last('team-task-result')!.error).toContain('Request key already used with a different')
})

test('handoff on another team\'s task is refused and dispatches nothing', async () => {
  const foreign = await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  const result = resultFor(foreign.id)
  await send({ type: 'team-task-handoff', teamPath: '/repo', requestId: 'x', taskId: foreign.id, kind: 'review', resultId: result.id,
    target: { kind: 'group', id: 'reviewers' }, instructions: 'Review', requestKey: 'k' })
  expect(last('team-task-result')!.error).toContain('not found in this team')
  expect(mail.forTask(foreign.id)).toEqual([])
})
