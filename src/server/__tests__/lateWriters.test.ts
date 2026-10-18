// Late writers (execution-safety-recovery 7.3, D11; spec execution-recovery
// "Late results stay pinned and never win"): no lease or fencing token guards
// a result, so the pins and supersession are the guard. A still-live agent
// whose assignment was superseded can submit: its result is readable history
// and the current assignment is untouched. A result pinned to revision 2 and
// read after revision 3 reads as needing re-evaluation, and accepting it
// needs a stated reason. The third D11 case — an orphan landing-slot holder
// cleared at startup — is planExecutionStore.test.ts's "orphans are cleared
// at startup; a live holder and an unknown mechanism kind are kept".
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore, outstandingOf } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { PlanStore } from '../plans/planStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
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
let home: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let assignments: AssignmentStore
let tasks: TaskService
let results: TaskResultService
let dispatcher: AssignmentService
let records: Map<string, ChatSessionRecord>
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-late-writers-')))
  repo = path.join(root, 'repo')
  home = path.join(root, 'home')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), '---\nmax: 3\n---\nBuild.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'seniors.md'), 'Build the hard parts.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([['dev', row('dev', 'devs')], ['senior', row('senior', 'seniors')]])
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  mail = new MailboxStore(db.db, { recipientExists: id => records.has(id) })
  assignments = new AssignmentStore(db.db, mail)
  const store = new TaskStore(db.db, mail, assignments)
  tasks = new TaskService(store, { getSession: id => records.get(id), homeDir: home })
  results = new TaskResultService(tasks, { getSession: id => records.get(id) })
  const caps = new TeamCaps({ homeDir: home })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => (records.has(id) ? team : undefined)
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  dispatcher = new AssignmentService(db.db, assignments, store, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf,
    staffing, caps, worktrees, homeDir: home, plans: new PlanStore(db.db), cooldownUntil: () => null,
  })
})

const submission = { summary: 'CSV export', commit: 'abc123', tests: [{ description: 'bun run test', outcome: 'pass' }] }

test('a superseded agent\'s result is readable history and leaves the current assignment unchanged', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'CSV' })
  const first = await dispatcher.dispatch(human(), {
    taskId: task.id, target: { kind: 'session', id: 'dev' }, instruction: 'Build it', requestKey: 'late-1',
  })
  // The dev received the work, then the human reassigned it to the senior (stop).
  mail.claim(first.assignment.messageId!, 'dev')
  mail.markPushed(first.assignment.messageId!)
  mail.markDelivered(first.assignment.messageId!)
  const second = await dispatcher.dispatch(human(), {
    taskId: task.id, target: { kind: 'session', id: 'senior' }, instruction: 'Take over', requestKey: 'late-2', handling: 'stop',
  })
  const before = assignments.listByTask(task.id)
  expect(before.map(entry => [entry.id, entry.targetId, entry.state])).toEqual([
    [first.assignment.id, 'dev', 'superseded'],
    [second.assignment.id, 'senior', 'queued'],
  ])
  expect(outstandingOf(before)?.id).toBe(second.assignment.id)

  // The still-live dev submits late.
  const late = await results.submit(agent('dev'), task.id, submission)

  // Readable history, pinned and attributed exactly.
  expect(tasks.store.results.listByTask(task.id).map(result => result.id)).toEqual([late.id])
  expect(tasks.store.results.get(late.id)).toMatchObject({
    taskId: task.id, summary: 'CSV export', commit: 'abc123', taskRevision: 1,
    submittedBy: { kind: 'agent', sessionId: 'dev' }, acceptedAt: null, needsReevaluation: false,
  })
  // The current assignment and its instruction are unchanged, and so is the task.
  expect(assignments.listByTask(task.id)).toEqual(before)
  expect(outstandingOf(assignments.listByTask(task.id))?.id).toBe(second.assignment.id)
  expect(mail.get(second.assignment.messageId!)!.state).toBe('queued')
  expect(tasks.store.get(task.id)?.status).toBe('open')
})

test('a result pinned to revision 2 reads as needing re-evaluation after revision 3; accepting it needs a stated reason', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'CSV' })
  await tasks.amend(human(), task.id, { direction: 'CSV with headers' })
  const pinned = await results.submit(agent('dev'), task.id, submission)
  expect(pinned.taskRevision).toBe(2)
  expect(tasks.store.results.get(pinned.id)?.needsReevaluation).toBe(false)

  await tasks.amend(human(), task.id, { direction: 'CSV and TSV with headers' })
  expect(tasks.store.get(task.id)?.revision).toBe(3)
  expect(tasks.store.results.get(pinned.id)).toMatchObject({ taskRevision: 2, needsReevaluation: true, acceptedAt: null })

  await expect(results.accept(human(), task.id, pinned.id)).rejects.toThrow('needs re-evaluation (pinned at revision 2, task at 3)')
  expect(tasks.store.results.get(pinned.id)?.acceptedAt).toBeNull()
  expect(tasks.store.get(task.id)?.status).toBe('open')
  await results.accept(human(), task.id, pinned.id, 'TSV is a follow-up')
  expect(tasks.store.journal(task.id).at(-1)?.text)
    .toBe(`Accepted result ${pinned.id} despite needs re-evaluation (pinned at revision 2, task at 3): TSV is a follow-up`)
  expect(tasks.store.results.get(pinned.id)?.taskRevision).toBe(2)
  expect(tasks.store.get(task.id)?.status).toBe('done')
})
