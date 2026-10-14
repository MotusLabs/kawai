// Handoffs (task-results-handoffs 3.1/3.2, design D3): review, QA, and fix
// handoffs ride task-assignment's dispatch with their kind, result, and
// expected response in the request key's payload identity — at the service
// pre-check and the store's insert-then-read — superseding the outstanding
// assignment as the task's next stage; task_handoff returns a standing
// equivalent instead of dispatching again, and a failed one loses standing.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { taskHandlers } from '../team/taskTools'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let other: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let assignmentStore: AssignmentStore
let tasks: TaskService
let results: TaskResultService
let assignments: AssignmentService
let records: Map<string, ChatSessionRecord>
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string, projectPath = repo): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoffs-')))
  repo = path.join(root, 'repo')
  other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  for (const id of ['devs', 'reviewers', 'qa']) fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), `${id}.`)
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')], ['stranger', row('stranger', 'leads', other)]])
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  mail = new MailboxStore(db.db)
  assignmentStore = new AssignmentStore(db.db, mail)
  const store = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  const worktrees = new TeamWorktrees()
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(db.db, assignmentStore, store, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf: () => undefined, staffing, caps: new TeamCaps({}), worktrees,
  })
  results = new TaskResultService(tasks, { getSession: id => records.get(id), assignments })
})

const submission = { summary: 'CSV export', commit: 'abc123' }
const review = (resultId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'review' as const, resultId, target: { kind: 'group' as const, id: 'reviewers' }, instructions: 'Review the export',
  expectedResponse: null, requestKey: 'review-1', ...extra,
})
const taskMail = (taskId: string) => mail.forTask(taskId)

test('a handoff supersedes the outstanding plain assignment as the next stage — no note, no cancel — and records its fields', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const plain = await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build it', requestKey: 'assign-1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const handed = await results.handoff(human(), task.id, review(result.id))
  expect(handed).toMatchObject({ duplicate: false, notice: null,
    assignment: { handoffKind: 'review', resultId: result.id, expectedResponse: null, targetId: 'reviewers', state: 'queued' } })
  expect(tasks.store.assignmentsOf(task.id).map(row => [row.id, row.supersededBy])).toEqual([
    [plain.assignment.id, handed.assignment.id], [handed.assignment.id, null]])
  expect(tasks.store.outstandingAssignment(task.id)?.id).toBe(handed.assignment.id)
  // Two instructions, nothing else: no reassignment note to the developer, and the plain one is not cancelled.
  expect(taskMail(task.id).map(row => [row.toId, row.state])).toEqual([['devs', 'queued'], ['reviewers', 'queued']])
  const instruction = taskMail(task.id)[1]!
  expect(instruction.body).toBe(`Review the export\n\nReview of result ${result.id} (commit abc123): CSV export\n` +
    'Expected response: findings with task_submit_findings (kind review) on this result')
  expect(tasks.store.journal(task.id).slice(-2).map(entry => entry.text)).toEqual([
    `Review handoff of result ${result.id} to group reviewers by human`,
    'Assignment to group devs superseded by the review handoff',
  ])
})

test('a replayed handoff key returns the prior handoff; another result, kind, or expected response under it is refused, writing nothing', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const a = await results.submit(agent('dev'), task.id, submission)
  const b = await results.submit(agent('dev'), task.id, { ...submission, summary: 'CSV export v2' })
  const first = await results.handoff(human(), task.id, review(a.id))
  expect(await results.handoff(human(), task.id, review(a.id))).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
  // Review of A retried as B: the instruction text differs too, but the handoff field is named first-class by the store check.
  await expect(results.handoff(human(), task.id, review(b.id))).rejects.toThrow('Request key already used with a different')
  await expect(results.handoff(human(), task.id, review(a.id, { kind: 'qa' }))).rejects.toThrow('Request key already used with a different')
  await expect(results.handoff(human(), task.id, review(a.id, { expectedResponse: 'A verdict only' }))).rejects.toThrow('Request key already used with a different')
  expect(tasks.store.assignmentsOf(task.id)).toHaveLength(1)
  expect(taskMail(task.id)).toHaveLength(1)
})

test('both payload-identity sites name the handoff field: the service pre-check and the store insert-then-read', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const a = await results.submit(agent('dev'), task.id, submission)
  const b = await results.submit(agent('dev'), task.id, { ...submission, summary: 'CSV export v2' })
  const service = assignments
  const base = { taskId: task.id, target: { kind: 'group' as const, id: 'reviewers' }, instruction: 'Same text', requestKey: 'k-1' }
  await service.dispatch(human(), { ...base, handoff: { kind: 'review', resultId: a.id, expectedResponse: null } })
  await expect(service.dispatch(human(), { ...base, handoff: { kind: 'review', resultId: b.id, expectedResponse: null } })).rejects.toThrow('different result')
  await expect(service.dispatch(human(), { ...base, handoff: { kind: 'qa', resultId: a.id, expectedResponse: null } })).rejects.toThrow('different handoff kind')
  await expect(service.dispatch(human(), { ...base, handoff: { kind: 'review', resultId: a.id, expectedResponse: 'x' } })).rejects.toThrow('different expected response')
  await expect(service.dispatch(human(), base)).rejects.toThrow('different handoff kind')
  // The store's own insert-then-read (a concurrent same-key insert) names it too.
  const insert = { teamId: team.teamId, taskId: task.id, requestKey: 'k-1', targetKind: 'group' as const, targetId: 'reviewers',
    role: 'reviewers', instruction: 'Same text', creator: { kind: 'human' as const, sessionId: null } }
  expect(() => assignmentStore.insert({ ...insert, handoff: { kind: 'review', resultId: b.id, expectedResponse: null } })).toThrow('different result')
  expect(assignmentStore.insert({ ...insert, handoff: { kind: 'review', resultId: a.id, expectedResponse: null } }).replay).toBe(true)
  expect(tasks.store.assignmentsOf(task.id)).toHaveLength(1)
})

// task_handoff (3.2): no key from agents; a standing equivalent is returned, not dispatched again.
test('task_handoff dispatches a QA handoff as the lead; a retried call returns it with a notice and dispatches nothing', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const call = { task_id: task.id, kind: 'qa', result_id: result.id, target: 'qa', instructions: 'Run the QA pass', expected_response: 'A QA verdict' }
  const first = await lead.task_handoff!(call) as { assignment: { id: string }; duplicate: boolean }
  expect(first).toMatchObject({ duplicate: false, assignment: { handoffKind: 'qa', resultId: result.id, expectedResponse: 'A QA verdict',
    targetKind: 'group', targetId: 'qa', createdBy: { kind: 'agent', sessionId: 'lead' } } })
  const retry = await lead.task_handoff!(call) as { assignment: { id: string }; duplicate: boolean; notice: string }
  expect(retry).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
  expect(retry.notice).toContain(`already outstanding (${first.assignment.id}, dispatched by lead, queued)`)
  // One instruction, ordinary task mail from the lead, carrying the result reference.
  const instructions = taskMail(task.id)
  expect(instructions).toHaveLength(1)
  expect(instructions[0]).toMatchObject({ taskId: task.id, toKind: 'group', toId: 'qa', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads' })
  expect(instructions[0]!.body).toContain(`QA of result ${result.id} (commit abc123): CSV export\nExpected response: A QA verdict`)
})

test('a dead-lettered handoff loses standing, so the same request dispatches again', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const call = { task_id: task.id, kind: 'review', result_id: result.id, target: 'reviewers', instructions: 'Review it' }
  await lead.task_handoff!(call)
  mail.deadLetter(taskMail(task.id)[0]!.id, 'hop-limit')
  const again = await lead.task_handoff!(call) as { duplicate: boolean }
  expect(again.duplicate).toBe(false)
  expect(taskMail(task.id).map(row => row.state)).toEqual(['dead', 'queued'])
})

test('task_handoff refusals: a result of another task, an unknown group, another team, and empty instructions', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const otherTask = await tasks.create(agent('lead'), { title: 'Import', direction: 'v1' })
  const result = await results.submit(agent('dev'), otherTask.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const call = { task_id: task.id, kind: 'review', result_id: result.id, target: 'reviewers', instructions: 'Review it' }
  await expect(lead.task_handoff!(call)).rejects.toThrow(`is not a result of task ${task.id}`)
  await expect(lead.task_handoff!({ ...call, task_id: otherTask.id, target: 'nobody' })).rejects.toThrow('Unknown group: nobody')
  await expect(taskHandlers(tasks, 'stranger', results).task_handoff!({ ...call, task_id: otherTask.id })).rejects.toThrow('not found in this team')
  await expect(results.handoff(agent('lead'), otherTask.id, review(result.id, { instructions: '  ' }))).rejects.toThrow('needs instructions')
  expect(mail.forTask(otherTask.id)).toEqual([])
})
