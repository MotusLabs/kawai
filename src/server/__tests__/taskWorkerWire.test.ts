// The human's dispatch paths carry a worker choice over the chat connection
// (dispatch-worker-choice 4.1, design D7, task-assignment "Human dispatch can
// name a worker", task-results "Handoffs can name a worker"): team-task-assign,
// team-task-handoff, and team-task-release pass `worker` through
// TaskConnections to the real AssignmentService, which stores the normalized
// choice on the assignment row and its instruction mail, treats it as part of
// the request key's payload identity, and refuses it on a session target with
// nothing written.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { MemberRelease } from '../team/memberRelease'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WORKER_GROUP_TARGET_ONLY } from '../team/workerChoiceCheck'
import type { ClientMessage, ServerMessage } from '../../shared/types'

let dir: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let connections: ChatConnections
let messages: ServerMessage[]
let records: Map<string, ChatSessionRecord>
const connection = { send: (message: ServerMessage) => { messages.push(message) } }

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-worker-wire-')))
  // An empty home: the shipped catalog, claude {default, opus, sonnet, haiku} and zai {glm, glm-flash}.
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  fs.mkdirSync(path.join(dir, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'devs.md'), '---\nprofiles: [sonnet, glm-flash]\n---\nBuild features')
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'reviewers.md'), '---\nprofiles: [sonnet, glm-flash]\n---\nReview')
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  mail = new MailboxStore(db.db)
  const teams = new Map([['/repo', { teamId: 'team', groupsRoot: dir }]])
  const assignmentStore = new AssignmentStore(db.db, mail)
  const taskStore = new TaskStore(db.db, mail, assignmentStore)
  records = new Map()
  tasks = new TaskService(taskStore, { getSession: id => records.get(id) })
  const worktrees = new TeamWorktrees()
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(db.db, assignmentStore, taskStore, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf: () => undefined,
    staffing, caps: new TeamCaps({}), worktrees, homeDir: home,
  })
  const releases = new MemberRelease(db.db, {
    store: mail, tasks: taskStore, records: () => records.values(), getRecord: id => records.get(id), teamOf: () => undefined,
    definition: async () => undefined, cachedDefinition: () => undefined,
    recipient: () => ({ idle: true, pendingRequest: false }), hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    archive: id => { records.get(id)!.archivedAt = 'now'; return { ok: true } }, notify: () => {},
  })
  const results = new TaskResultService(tasks, {
    getSession: id => records.get(id), assignments, releases, records: () => records.values(), homeDir: home,
  })
  messages = []
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: { resolve: async (teamPath: string) => teams.get(teamPath) },
    mailbox: { store: mail }, dispatcher: { notify: () => {} }, tasks, assignments, results,
    directory: { list: () => [] },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const send = (message: ClientMessage) => connections.handle(connection, message)
const human = () => ({ kind: 'human' as const, team: { teamId: 'team', groupsRoot: dir } })
const resultOf = (requestId: string) =>
  messages.find((message): message is Extract<ServerMessage, { type: 'team-task-result' }> => message.type === 'team-task-result' && message.requestId === requestId)!
const assignmentRows = () => db.db.prepare('SELECT worker_choice FROM team_task_assignments').all() as Array<{ worker_choice: string | null }>
const resultFor = (taskId: string) => tasks.store.results.insert({
  teamId: 'team', taskId, summary: 'CSV export', commit: 'abc123', diff: null, worktree: null,
  tests: [], limitations: null, taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'dev' },
})

describe('team-task-assign', () => {
  const assign = (taskId: string, requestId: string, extra: Partial<Extract<ClientMessage, { type: 'team-task-assign' }>> = {}) => send({
    type: 'team-task-assign', teamPath: '/repo', requestId, taskId, target: { kind: 'group', id: 'devs' },
    instruction: 'Build the export', requestKey: 'assign-1', ...extra,
  })

  test('the normalized worker rides the assignment row and its instruction mail', async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    await assign(task.id, 'a1', { worker: 'glm-flash' })
    const answer = resultOf('a1')
    expect(answer.error).toBeUndefined()
    expect(answer.assignment!.workerChoice).toBe('zai/glm-flash')
    expect(assignmentRows()).toEqual([{ worker_choice: 'zai/glm-flash' }])
    expect(mail.forTask(task.id).map(message => [message.toKind, message.toId, message.workerChoice])).toEqual([['group', 'devs', 'zai/glm-flash']])
  })

  test('without a worker the dispatch carries no choice, as before', async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    await assign(task.id, 'a1')
    expect(resultOf('a1').assignment!.workerChoice ?? null).toBeNull()
    expect(mail.forTask(task.id).map(message => message.workerChoice ?? null)).toEqual([null])
  })

  test('the same key with a different worker is refused naming worker; a normalized-equal worker replays', async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    await assign(task.id, 'a1', { worker: 'zai/glm-flash' })
    const first = resultOf('a1').assignment!
    await assign(task.id, 'a2', { worker: 'claude' })
    expect(resultOf('a2').error).toBe('Request key already used with a different worker')
    await assign(task.id, 'a3')
    expect(resultOf('a3').error).toBe('Request key already used with a different worker')
    await assign(task.id, 'a4', { worker: 'glm-flash' })
    expect(resultOf('a4')).toMatchObject({ assignment: { id: first.id } })
    expect(resultOf('a4').error).toBeUndefined()
    expect(mail.forTask(task.id)).toHaveLength(1)
  })

  test('a session target with a worker is refused and writes nothing', async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    records.set('dev', { sessionId: 'dev', name: 'dev', projectPath: dir, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '', groupId: 'devs' })
    await assign(task.id, 'a1', { target: { kind: 'session', id: 'dev' }, worker: 'claude' })
    expect(resultOf('a1').error).toBe(WORKER_GROUP_TARGET_ONLY)
    expect(assignmentRows()).toEqual([])
    expect(mail.forTask(task.id)).toEqual([])
  })

  test('a worker the group does not list is refused naming it and writes nothing', async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    await assign(task.id, 'a1', { worker: 'opus' })
    expect(resultOf('a1').error).toContain('opus')
    expect(assignmentRows()).toEqual([])
    expect(mail.forTask(task.id)).toEqual([])
  })
})

describe('team-task-handoff', () => {
  test('a review handoff carries the worker; another worker under the same key is refused naming worker', async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    const result = resultFor(task.id)
    const request = {
      type: 'team-task-handoff' as const, teamPath: '/repo', taskId: task.id, kind: 'review' as const, resultId: result.id,
      target: { kind: 'group' as const, id: 'reviewers' }, instructions: 'Review the export', requestKey: 'handoff-1',
    }
    await send({ ...request, requestId: 'h1', worker: 'claude' })
    expect(resultOf('h1')).toMatchObject({ replay: false, assignment: { handoffKind: 'review', workerChoice: 'claude' } })
    expect(mail.forTask(task.id).map(message => message.workerChoice)).toEqual(['claude'])
    await send({ ...request, requestId: 'h2', worker: 'zai' })
    expect(resultOf('h2').error).toBe('Request key already used with a different worker')
    await send({ ...request, requestId: 'h3', worker: 'claude' })
    expect(resultOf('h3')).toMatchObject({ replay: true })
    expect(mail.forTask(task.id)).toHaveLength(1)
  })

  test('a session-target handoff naming a worker is refused and writes nothing', async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    const result = resultFor(task.id)
    records.set('rev', { sessionId: 'rev', name: 'rev', projectPath: dir, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '', groupId: 'reviewers' })
    await send({
      type: 'team-task-handoff', teamPath: '/repo', requestId: 'h1', taskId: task.id, kind: 'review', resultId: result.id,
      target: { kind: 'session', id: 'rev' }, instructions: 'Review the export', requestKey: 'handoff-1', worker: 'claude',
    })
    expect(resultOf('h1').error).toBe(WORKER_GROUP_TARGET_ONLY)
    expect(assignmentRows()).toEqual([])
    expect(mail.forTask(task.id)).toEqual([])
  })
})

describe('team-task-release', () => {
  /** A task whose worktree holds one live spawned member, with a submitted result. */
  const releasable = async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    const worktree = path.join(dir, 'wt')
    fs.mkdirSync(path.join(worktree, '.git'), { recursive: true })
    db.db.prepare('UPDATE team_tasks SET worktree = ? WHERE id = ?').run(worktree, task.id)
    records.set('dev', { sessionId: 'dev', name: 'dev', projectPath: worktree, sdkSessionId: null, status: 'waiting', createdAt: '',
      lastActivityAt: '', groupId: 'devs', spawned: true, taskId: task.id })
    return { task, result: resultFor(task.id) }
  }
  /** Request review queued before the release, as when the worktree is occupied. */
  const requestReview = async (taskId: string, resultId: string, worker: string) => {
    await send({ type: 'team-task-handoff', teamPath: '/repo', requestId: 'standing', taskId, kind: 'review', resultId,
      target: { kind: 'group', id: 'reviewers' }, instructions: 'Review the export', requestKey: 'handoff-standing', worker })
    return resultOf('standing').assignment!
  }
  const state = (messageId: string | null) => mail.get(messageId!)!.state

  test('the review handoff after the release carries the worker; a resend with another worker is refused naming worker', async () => {
    const { task } = await releasable()
    const release = (requestId: string, worker: string) => send({ type: 'team-task-release', teamPath: '/repo', requestId, taskId: task.id,
      target: 'reviewers', instructions: 'Review the export', requestKey: 'release-1', worker })
    await release('r1', 'glm-flash')
    expect(resultOf('r1')).toMatchObject({ replay: false, assignment: { handoffKind: 'review', workerChoice: 'zai/glm-flash' } })
    expect(records.get('dev')!.archivedAt).toBe('now')
    expect(mail.forTask(task.id).map(message => message.workerChoice)).toEqual(['zai/glm-flash'])
    await release('r2', 'zai/glm-flash')
    expect(resultOf('r2')).toMatchObject({ replay: true })
    await release('r3', 'claude')
    expect(resultOf('r3').error).toBe('Request key already used with a different worker')
    expect(mail.forTask(task.id)).toHaveLength(1)
  })

  test('an invalid worker is refused before any member is archived, with nothing dispatched', async () => {
    const { task } = await releasable()
    await send({ type: 'team-task-release', teamPath: '/repo', requestId: 'r1', taskId: task.id,
      target: 'reviewers', instructions: 'Review the export', requestKey: 'release-1', worker: 'opus' })
    expect(resultOf('r1').error).toContain('opus')
    expect(records.get('dev')!.archivedAt).toBeUndefined()
    expect(assignmentRows()).toEqual([])
    expect(mail.forTask(task.id)).toEqual([])
  })

  test('a standing review with the same normalized worker proceeds in the freed worktree; nothing new is dispatched', async () => {
    const { task, result } = await releasable()
    const standing = await requestReview(task.id, result.id, 'zai/glm-flash')
    await send({ type: 'team-task-release', teamPath: '/repo', requestId: 'r1', taskId: task.id,
      target: 'reviewers', instructions: 'Review the export', requestKey: 'release-1', worker: 'glm-flash' })
    expect(resultOf('r1')).toMatchObject({ replay: true, assignment: { id: standing.id } })
    expect(records.get('dev')!.archivedAt).toBe('now')
    expect(mail.forTask(task.id)).toHaveLength(1)
    expect(state(standing.messageId)).toBe('queued')
  })

  test('a different worker over a queued standing review dispatches a new review and cancels the queued one', async () => {
    const { task, result } = await releasable()
    const standing = await requestReview(task.id, result.id, 'claude')
    await send({ type: 'team-task-release', teamPath: '/repo', requestId: 'r1', taskId: task.id,
      target: 'reviewers', instructions: 'Review the export', requestKey: 'release-1', worker: 'glm-flash' })
    const answer = resultOf('r1')
    expect(answer).toMatchObject({ replay: false, assignment: { handoffKind: 'review', workerChoice: 'zai/glm-flash' } })
    expect(answer.assignment!.id).not.toBe(standing.id)
    expect(records.get('dev')!.archivedAt).toBe('now')
    expect(state(standing.messageId)).toBe('cancelled')
    expect(tasks.store.assignmentsOf(task.id).find(row => row.id === standing.id)!.supersededBy).toBe(answer.assignment!.id)
  })

  test('a different worker over a claimed standing review dispatches a new review and leaves the claimed one untouched', async () => {
    const { task, result } = await releasable()
    const standing = await requestReview(task.id, result.id, 'claude')
    records.set('rev', { sessionId: 'rev', name: 'rev', projectPath: dir, sdkSessionId: null, status: 'working', createdAt: '', lastActivityAt: '', groupId: 'reviewers' })
    expect(mail.claim(standing.messageId!, 'rev')).toBe(true)
    await send({ type: 'team-task-release', teamPath: '/repo', requestId: 'r1', taskId: task.id,
      target: 'reviewers', instructions: 'Review the export', requestKey: 'release-1', worker: 'glm-flash' })
    const answer = resultOf('r1')
    expect(answer.error).toBeUndefined()
    expect(answer).toMatchObject({ replay: false, assignment: { workerChoice: 'zai/glm-flash' } })
    expect(state(standing.messageId)).toBe('claimed')
    expect(mail.get(standing.messageId!)!.claimedBy).toBe('rev')
    expect(mail.forTask(task.id).filter(message => message.state !== 'cancelled')).toHaveLength(2)
  })
})
