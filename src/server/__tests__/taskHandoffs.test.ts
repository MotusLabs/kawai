// Handoffs (task-results-handoffs 3.1/3.2, design D3): review, QA, and fix
// handoffs ride task-assignment's dispatch with their kind, result, and
// expected response in the request key's payload identity — at the service
// pre-check and the store's insert-then-read — superseding the outstanding
// assignment as the task's next stage; task_handoff returns a standing
// equivalent instead of dispatching again, and a failed one loses standing.
// Session targets (session-targeted-task-handoffs): the tool's explicit
// recipient kind rides the same dispatch — recipient validation, ordinary
// direct task mail, atomic supersession — and the standing equivalent is
// returned whatever recipient a retry names, with both sides on a mismatch.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { NULL_OWNERSHIP } from '../plans/execution/executionOwnership'
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
let feature: string
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
  feature = path.join(root, 'repo-feature')
  other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  for (const id of ['devs', 'reviewers', 'qa']) fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), `${id}.`)
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')], ['reviewer', row('reviewer', 'reviewers')],
    ['stranger', row('stranger', 'leads', other)]])
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

// Pin 11: every handoff supersedes the outstanding assignment through task-assignment's stop branch.
test('a handoff over a delivered assignment supersedes it — no note, no cancel — and records its fields', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const plain = await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build it', requestKey: 'assign-1' })
  const plainMail = plain.message!.id
  mail.claim(plainMail, 'dev'); mail.markPushed(plainMail); mail.markDelivered(plainMail)
  const result = await results.submit(agent('dev'), task.id, submission)
  const handed = await results.handoff(human(), task.id, review(result.id))
  expect(handed).toMatchObject({ duplicate: false, notice: null,
    assignment: { handoffKind: 'review', resultId: result.id, expectedResponse: null, targetId: 'reviewers', state: 'queued' } })
  expect(tasks.store.assignmentsOf(task.id).map(row => [row.id, row.supersededBy])).toEqual([
    [plain.assignment.id, handed.assignment.id], [handed.assignment.id, null]])
  expect(tasks.store.outstandingAssignment(task.id)?.id).toBe(handed.assignment.id)
  // Two instructions, nothing else: no reassignment note to the developer, and its delivered work is untouched.
  expect(taskMail(task.id).map(row => [row.toId, row.state])).toEqual([['devs', 'delivered'], ['reviewers', 'queued']])
  const instruction = taskMail(task.id)[1]!
  expect(instruction.body).toBe(`Review the export\n\nReview of result ${result.id} (commit abc123): CSV export\n` +
    'Expected response: findings with task_submit_findings (kind review) on this result')
  expect(tasks.store.journal(task.id).slice(-2).map(entry => entry.text)).toEqual([
    `Review handoff of result ${result.id} to group reviewers by human`,
    'Assignment to group devs superseded by the review handoff',
  ])
})

test('a handoff over a still-queued instruction cancels it, leaving exactly one deliverable instruction', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  // A review queued behind the developer, then Return for fixes: the review must never deliver later.
  const queued = await results.handoff(human(), task.id, review(result.id))
  const fix = await results.handoff(agent('lead'), task.id, {
    kind: 'fix', resultId: result.id, target: { kind: 'group', id: 'devs' }, instructions: 'Fix the quoting', expectedResponse: null,
  })
  expect(taskMail(task.id).map(row => [row.toId, row.state])).toEqual([['reviewers', 'cancelled'], ['devs', 'queued']])
  expect(tasks.store.assignmentsOf(task.id).map(row => [row.id, row.supersededBy])).toEqual([
    [queued.assignment.id, fix.assignment.id], [fix.assignment.id, null]])
  // The dispatching agent supersedes and cancels as itself.
  expect(tasks.store.journal(task.id).at(-1)).toMatchObject({ author: { kind: 'agent', sessionId: 'lead' }, text: 'Assignment to group reviewers superseded by the fix handoff' })
  expect(mail.eventsFor(taskMail(task.id)[0]!.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'agent', actorSession: 'lead' })
})

test('a handoff over parked work supersedes it but never cancels it, nor its resume', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const plain = await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build it', requestKey: 'assign-1' })
  const id = plain.message!.id
  mail.claim(id, 'dev'); mail.markPushed(id); mail.markDelivered(id)
  const resume = mail.enqueue({ teamId: team.teamId, toKind: 'session', toId: 'dev', fromKind: 'human', fromSession: null, fromGroup: null,
    originPath: repo, body: 'Resume', deliverAt: new Date(Date.now() + 3_600_000).toISOString() })
  mail.park(id, resume.deliverAt!, resume.id)
  const result = await results.submit(agent('dev'), task.id, submission)
  await results.handoff(human(), task.id, review(result.id))
  expect([mail.get(id)?.state, mail.get(resume.id)?.state]).toEqual(['parked', 'queued'])
  expect(tasks.store.assignmentsOf(task.id)[0]!.supersededBy).not.toBeNull()
})

test('a double-clicked handoff or a retried task_handoff never supersedes its own handoff', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build it', requestKey: 'assign-1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const first = await results.handoff(human(), task.id, review(result.id))
  const again = await results.handoff(human(), task.id, review(result.id))
  expect(again).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id, supersededBy: null } })
  const lead = taskHandlers(tasks, 'lead', results)
  const call = { task_id: task.id, kind: 'review', result_id: result.id, target: 'reviewers', instructions: 'Review the export' }
  expect(await lead.task_handoff!(call)).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
  expect(tasks.store.outstandingAssignment(task.id)?.id).toBe(first.assignment.id)
  expect(taskMail(task.id).map(row => [row.toId, row.state])).toEqual([['devs', 'cancelled'], ['reviewers', 'queued']])
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

// Session targets (session-targeted-task-handoffs 1.1/1.2): an explicit
// recipient kind through the real tool handler; omission never reads a
// session-shaped id as a session.
const sessionCall = (taskId: string, resultId: string, extra: Record<string, unknown> = {}) => ({
  task_id: taskId, kind: 'review' as const, result_id: resultId, target_kind: 'session',
  target: 'reviewer', instructions: 'Review the export', ...extra,
})

test('task_handoff target_kind defaults to group: omitted and explicit group route identically, never reading a session-shaped id as a session', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const base = { task_id: task.id, kind: 'review', result_id: result.id, instructions: 'Review the export' }
  await expect(lead.task_handoff!({ ...base, target: 'chat-session-shaped' })).rejects.toThrow('Unknown group: chat-session-shaped')
  const omitted = await lead.task_handoff!({ ...base, target: 'reviewers' }) as { assignment: { id: string; targetKind: string; targetId: string } }
  expect(omitted.assignment).toMatchObject({ targetKind: 'group', targetId: 'reviewers' })
  const explicit = await lead.task_handoff!({ ...base, target_kind: 'group', target: 'reviewers' }) as { duplicate: boolean; assignment: { id: string } }
  expect(explicit).toMatchObject({ duplicate: true, assignment: { id: omitted.assignment.id } })
  expect(taskMail(task.id)).toHaveLength(1)
})

test('task_handoff refuses a blank target and an unsupported target_kind before any write', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const base = { task_id: task.id, kind: 'review', result_id: result.id, target: 'reviewers', instructions: 'Review the export' }
  await expect(lead.task_handoff!({ ...base, target: '   ' })).rejects.toThrow('A handoff target needs an identifier')
  await expect(lead.task_handoff!({ ...base, target_kind: 'role' })).rejects
    .toThrow(`Invalid option: expected one of \\"group\\"|\\"session\\"`)
  expect(tasks.store.assignmentsOf(task.id)).toEqual([])
  expect(taskMail(task.id)).toEqual([])
  expect(tasks.store.outstandingAssignment(task.id)).toBeNull()
})

test('a session-targeted handoff onto an execution-owned task is refused with zero writes', async () => {
  const owned = new TaskResultService(tasks, {
    getSession: id => records.get(id), assignments,
    ownership: { ...NULL_OWNERSHIP, ownerOfTask: () =>
      ({ executionId: 'exec-1', revision: 1, change: 'change-a', step: null, worktree: null, branch: null }) },
  })
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const journal = tasks.store.journal(task.id).length
  await expect(owned.handoff(agent('lead'), task.id, {
    kind: 'review', resultId: result.id, target: { kind: 'session', id: 'reviewer' }, instructions: 'Review it', expectedResponse: null,
  })).rejects.toThrow('owned by a running execution (exec-1)')
  expect(tasks.store.assignmentsOf(task.id)).toEqual([])
  expect(taskMail(task.id)).toEqual([])
  expect(tasks.store.journal(task.id)).toHaveLength(journal)
})

test('an invalid session target cannot replace current work: unknown, killed, archived, and other-team recipients are refused with zero writes', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const standing = await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build it', requestKey: 'assign-1' })
  const lead = taskHandlers(tasks, 'lead', results)
  const journal = tasks.store.journal(task.id).length
  await expect(lead.task_handoff!(sessionCall(task.id, result.id, { target: 'nobody' }))).rejects.toThrow('Unknown session: nobody')
  records.delete('dev')
  await expect(lead.task_handoff!(sessionCall(task.id, result.id, { target: 'dev' }))).rejects.toThrow('Unknown session: dev')
  records.set('retired', { ...row('retired', 'reviewers'), archivedAt: new Date().toISOString() })
  await expect(lead.task_handoff!(sessionCall(task.id, result.id, { target: 'retired' }))).rejects.toThrow('Session retired is archived')
  await expect(lead.task_handoff!(sessionCall(task.id, result.id, { target: 'stranger' }))).rejects.toThrow('Session stranger belongs to another team')
  // The plain assignment still stands; nothing was superseded, enqueued, or journaled.
  expect(tasks.store.outstandingAssignment(task.id)?.id).toBe(standing.assignment.id)
  expect(tasks.store.assignmentsOf(task.id)).toHaveLength(1)
  expect(taskMail(task.id).map(row => [row.toId, row.state])).toEqual([['devs', 'queued']])
  expect(tasks.store.journal(task.id)).toHaveLength(journal)
})

test('a session handoff to a context-exhausted session is refused with zero writes', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const standing = await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build it', requestKey: 'assign-1' })
  records.set('clogged', { ...row('clogged', 'reviewers'),
    contextExhausted: { at: '2026-10-18T09:00:00.000Z', reason: 'prompt_too_long' } })
  const lead = taskHandlers(tasks, 'lead', results)
  const journal = tasks.store.journal(task.id).length
  await expect(lead.task_handoff!(sessionCall(task.id, result.id, { target: 'clogged' }))).rejects
    .toThrow('context is exhausted (prompt_too_long, since 2026-10-18T09:00:00.000Z)')
  expect(tasks.store.outstandingAssignment(task.id)?.id).toBe(standing.assignment.id)
  expect(tasks.store.assignmentsOf(task.id)).toHaveLength(1)
  expect(taskMail(task.id).map(row => [row.toId, row.state])).toEqual([['devs', 'queued']])
  expect(tasks.store.journal(task.id)).toHaveLength(journal)
})

test('a session-targeted review dispatches ordinary direct task mail to that session: identity, actor, result reference, and atomic supersession', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const plain = await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Build it', requestKey: 'assign-1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const handed = await results.handoff(agent('lead'), task.id, {
    kind: 'review', resultId: result.id, target: { kind: 'session', id: 'reviewer' }, instructions: 'Review the export', expectedResponse: 'A verdict',
  })
  expect(handed).toMatchObject({ duplicate: false, notice: null, assignment: {
    handoffKind: 'review', resultId: result.id, expectedResponse: 'A verdict', targetKind: 'session', targetId: 'reviewer',
    role: 'reviewers', createdBy: { kind: 'agent', sessionId: 'lead' }, state: 'queued' } })
  expect(tasks.store.assignmentsOf(task.id).map(row => [row.id, row.supersededBy])).toEqual([
    [plain.assignment.id, handed.assignment.id], [handed.assignment.id, null]])
  // Ordinary direct task mail from the dispatching agent, carrying the task and result context.
  const instruction = taskMail(task.id)[1]!
  expect(instruction).toMatchObject({ taskId: task.id, toKind: 'session', toId: 'reviewer', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads' })
  expect(instruction.body).toBe(`Review the export\n\nReview of result ${result.id} (commit abc123): CSV export\nExpected response: A verdict`)
  expect(tasks.store.journal(task.id).slice(-2).map(entry => entry.text)).toEqual([
    `Review handoff of result ${result.id} to session reviewer by lead`,
    'Assignment to group devs superseded by the review handoff',
  ])
})

test('a busy or request-holding recipient queues the instruction without interruption or a different member', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  records.set('busy', { ...row('busy', 'reviewers'), status: 'working' })
  records.set('carded', { ...row('carded', 'reviewers'), status: 'permission' })
  const lead = taskHandlers(tasks, 'lead', results)
  const first = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'busy' })) as { duplicate: boolean; assignment: { targetId: string; state: string } }
  expect(first).toMatchObject({ duplicate: false, assignment: { targetId: 'busy', state: 'queued' } })
  // A different kind reaches the second session; the superseding stop branch cancels the first instruction while queued.
  const second = await lead.task_handoff!({ ...sessionCall(task.id, result.id, { target: 'carded' }), kind: 'qa' }) as { duplicate: boolean; assignment: { handoffKind: string; targetId: string; state: string } }
  expect(second).toMatchObject({ duplicate: false, assignment: { handoffKind: 'qa', targetId: 'carded', state: 'queued' } })
  expect(taskMail(task.id).map(row => [row.toId, row.state])).toEqual([['busy', 'cancelled'], ['carded', 'queued']])
})

test('fixes return to a named developer session: the assignment names it, the instruction references the result, and a new result is expected', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const fix = await lead.task_handoff!({ ...sessionCall(task.id, result.id, { target: 'dev' }), kind: 'fix' }) as
    { duplicate: boolean; assignment: { handoffKind: string; targetKind: string; targetId: string; expectedResponse: string | null } }
  expect(fix).toMatchObject({ duplicate: false, assignment: { handoffKind: 'fix', targetKind: 'session', targetId: 'dev', expectedResponse: null } })
  const instruction = taskMail(task.id)[0]!
  expect(instruction).toMatchObject({ toKind: 'session', toId: 'dev', taskId: task.id })
  expect(instruction.body).toContain(`Fix of result ${result.id} (commit abc123): CSV export`)
  expect(instruction.body).toContain('Expected response: a new result with task_submit_result')
})

test('a reviewer outside the task worktree receives the instruction where it lives; nothing spawns or moves', async () => {
  records.set('roving', row('roving', 'reviewers', feature))
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1', worktree: repo })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const handed = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'roving' })) as { duplicate: boolean; assignment: { targetKind: string; targetId: string; role: string | null } }
  expect(handed).toMatchObject({ duplicate: false, assignment: { targetKind: 'session', targetId: 'roving', role: 'reviewers' } })
  const instruction = taskMail(task.id)[0]!
  expect(instruction).toMatchObject({ toKind: 'session', toId: 'roving', taskId: task.id })
  expect(instruction.body).toContain(`Review of result ${result.id}`)
  // The recipient stayed where it was and no member was spawned for the dispatch.
  expect(records.get('roving')?.projectPath).toBe(feature)
  expect([...records.values()].filter(rec => rec.sessionId === 'roving')).toHaveLength(1)
})

// Duplicates (2.1): the standing recipient is exposed; a differing request names both sides.
test('a session retry returns the standing handoff; a different session or a group request names both recipients and reassigns nothing', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  records.set('second', row('second', 'reviewers'))
  const lead = taskHandlers(tasks, 'lead', results)
  const first = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' })) as { assignment: { id: string } }
  const same = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' })) as { duplicate: boolean; assignment: { id: string; supersededBy: string | null }; notice: string }
  expect(same).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id, supersededBy: null } })
  expect(same.notice).toContain(`already outstanding (${first.assignment.id}, dispatched by lead, queued) to session reviewer`)
  const other = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'second' })) as { duplicate: boolean; assignment: { id: string; targetId: string }; notice: string }
  expect(other).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id, targetId: 'reviewer' } })
  expect(other.notice).toContain('You asked for session second, which differs from the standing session reviewer: no reassignment occurred')
  const asGroup = await lead.task_handoff!({ ...sessionCall(task.id, result.id), target: 'reviewers', target_kind: 'group' }) as { duplicate: boolean; assignment: { id: string }; notice: string }
  expect(asGroup).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
  expect(asGroup.notice).toContain('You asked for group reviewers, which differs from the standing session reviewer: no reassignment occurred')
  // Exactly one instruction ever: duplicates never enqueue.
  expect(taskMail(task.id)).toHaveLength(1)
})

test('a group handoff stands against a session-targeted retry of the same kind, with both recipients named', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const group = await lead.task_handoff!({ task_id: task.id, kind: 'qa', result_id: result.id, target: 'qa', instructions: 'Run the QA pass' }) as { assignment: { id: string } }
  const asSession = await lead.task_handoff!({ task_id: task.id, kind: 'qa', result_id: result.id, target_kind: 'session', target: 'reviewer', instructions: 'Run the QA pass' }) as
    { duplicate: boolean; assignment: { id: string; targetKind: string; targetId: string; supersededBy: string | null }; notice: string }
  expect(asSession).toMatchObject({ duplicate: true, assignment: { id: group.assignment.id, targetKind: 'group', targetId: 'qa', supersededBy: null } })
  expect(asSession.notice).toContain('You asked for session reviewer, which differs from the standing group qa: no reassignment occurred')
  expect(taskMail(task.id)).toHaveLength(1)
})

// Kind-only mismatch (2.1): the same id under the other recipient kind is
// still a differing request — the standing handoff stands and both kinds are named.
test('a kind-only retry of the same id returns the standing handoff and names both recipient kinds', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const first = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' })) as { assignment: { id: string } }
  const asGroup = await lead.task_handoff!({ ...sessionCall(task.id, result.id), target_kind: 'group' }) as
    { duplicate: boolean; assignment: { id: string; targetKind: string; targetId: string }; notice: string }
  expect(asGroup).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id, targetKind: 'session', targetId: 'reviewer' } })
  expect(asGroup.notice).toContain('You asked for group reviewer, which differs from the standing session reviewer: no reassignment occurred')
  expect(taskMail(task.id)).toHaveLength(1)
})

// Standing before validation (2.2): the standing lookup runs before the recipient check.
test('a standing handoff survives recipient lifecycle changes: a killed, archived, or unknown retry returns it before validation, restoring nothing', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const first = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' })) as { assignment: { id: string } }
  records.delete('reviewer')
  const afterKill = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' })) as { duplicate: boolean; assignment: { id: string } }
  expect(afterKill).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
  records.set('reviewer', { ...row('reviewer', 'reviewers'), archivedAt: new Date().toISOString() })
  const afterArchive = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' })) as { duplicate: boolean; assignment: { id: string } }
  expect(afterArchive).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
  expect(records.get('reviewer')?.archivedAt).toBeTruthy()
  const unknown = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'nobody' })) as { duplicate: boolean; assignment: { id: string } }
  expect(unknown).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id } })
  expect(taskMail(task.id)).toHaveLength(1)
})

test('after a session handoff fails, a new call validates the recipient again: an unknown one is refused with zero writes', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' }))
  mail.deadLetter(taskMail(task.id)[0]!.id, 'hop-limit')
  records.delete('reviewer')
  await expect(lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' }))).rejects.toThrow('Unknown session: reviewer')
  expect(tasks.store.assignmentsOf(task.id)).toHaveLength(1)
  expect(taskMail(task.id)).toHaveLength(1)
})

// Findings answer the claimed stage (2.3): real claim and delivery transitions before task_submit_findings.
test('findings answer a claimed session handoff by exact result and handoff id; another author answers nothing; a newer result inherits neither', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const lead = taskHandlers(tasks, 'lead', results)
  const handed = await lead.task_handoff!(sessionCall(task.id, result.id, { target: 'reviewer' })) as { assignment: { id: string } }
  const instruction = taskMail(task.id)[0]!
  mail.claim(instruction.id, 'reviewer'); mail.markPushed(instruction.id); mail.markDelivered(instruction.id)
  expect(tasks.store.outstandingAssignment(task.id)).toMatchObject({ id: handed.assignment.id, claimedBy: 'reviewer' })
  const reviewer = taskHandlers(tasks, 'reviewer', results)
  const findings = await reviewer.task_submit_findings!({ task_id: task.id, result_id: result.id, kind: 'review', verdict: 'fail', findings: 'Header row missing' }) as { handoffId: string | null }
  expect(findings.handoffId).toBe(handed.assignment.id)
  const unrelated = await taskHandlers(tasks, 'dev', results).task_submit_findings!({ task_id: task.id, result_id: result.id, kind: 'qa', verdict: 'pass', findings: 'ok' }) as { handoffId: string | null }
  expect(unrelated.handoffId).toBeNull()
  // The newer result inherits neither the earlier findings nor their approval.
  const second = await results.submit(agent('dev'), task.id, { ...submission, summary: 'CSV export, header fixed' })
  expect(tasks.store.results.get(second.id)!.findings).toEqual([])
  expect(tasks.store.results.get(second.id)!.acceptedAt).toBeNull()
})

// Result checks over a submitted result (independent-verification D1/D4/I1/I4)
// live in resultCheckTaskHandoffs.test.ts, beside their own scaffolding.
