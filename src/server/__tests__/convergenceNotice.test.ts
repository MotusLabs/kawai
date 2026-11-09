// The manual-task convergence notice (review-convergence decision 10, task
// 8.1, A10): a counted review on a task no execution owns that makes a signal
// fire writes one notice row, one journal entry, and one system message to a
// session creator — nothing else, nothing waits — once per churn episode;
// a task an execution owns gets none (its failed round opens a diagnosis).
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { CONVERGENCE_NOTICE_TAG, noticeConvergence } from '../team/convergenceNotice'
import { NULL_OWNERSHIP, type ExecutionOwnership } from '../plans/execution/executionOwnership'
import type { SubmittedDisposition, SubmittedFinding } from '../../shared/findingsLedger'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let store: TaskStore
let tasks: TaskService
const records = new Map<string, ChatSessionRecord>()
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-convergence-notice-')))
  repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Build.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
  clearTeamCache()
  team = await resolveTeam(repo)
  for (const [id, group] of [['lead', 'leads'], ['dev', 'devs'], ['reviewer', 'reviewers']] as const) records.set(id, row(id, group))
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  mail = new MailboxStore(db.db)
  store = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
  tasks = new TaskService(store, { getSession: id => records.get(id) })
})

const service = (ownership: ExecutionOwnership = NULL_OWNERSHIP) => new TaskResultService(tasks, { getSession: id => records.get(id), ownership })
const noticeMail = (taskId: string) => mail.forTask(taskId).filter(message => message.tags.includes(CONVERGENCE_NOTICE_TAG))
const notices = (taskId: string) => db.db.prepare('SELECT submission_id FROM team_task_convergence_notices WHERE task_id = ?').all(taskId) as { submission_id: string }[]
const journal = (taskId: string) => store.journal(taskId).map(entry => entry.text)

/**
 * Three counted reviews whose only signal is S3 on the third: R1 raises F1
 * and F2 (open 2); R2 resolves F1 (open 1, nothing raised); R3 keeps F2 and
 * raises F3 (open 2) — 1 raised against 1 resolved over the last two, and
 * the counts 2, 1, 2 fall once, so S4 stays quiet. R4 (after the notice)
 * keeps F2 and F3 and raises F4: S3 over R3 and R4 were the window not
 * anchored at the notice.
 */
async function churn(results: TaskResultService, taskId: string, reviews: readonly number[] = [0, 1, 2]) {
  const clause = store.get(taskId)!.identity!
  const finding = (evidence: string): SubmittedFinding => ({ level: 'P1', clause, evidence, impact: 'wrong output' })
  const plan: Array<{ items: SubmittedFinding[]; dispositions: SubmittedDisposition[] }> = [
    { items: [finding('src/a.ts:1 off by one'), finding('src/b.ts:2 drops the header')], dispositions: [] },
    { items: [], dispositions: [{ id: 'F1', disposition: 'resolved' }, { id: 'F2', disposition: 'still-open', evidence: 'src/b.ts:2 still drops it' }] },
    { items: [finding('src/c.ts:3 sorts descending')], dispositions: [{ id: 'F2', disposition: 'still-open', evidence: 'src/b.ts:2 unchanged' }] },
    { items: [finding('src/d.ts:4 loses the footer')], dispositions: [
      { id: 'F2', disposition: 'still-open', evidence: 'src/b.ts:2 unchanged' }, { id: 'F3', disposition: 'still-open', evidence: 'src/c.ts:3 unchanged' },
    ] },
  ]
  const outcomes = []
  for (const index of reviews) {
    const review = plan[index]!
    const result = await results.submit(agent('dev'), taskId, { summary: `round ${index + 1}`, commit: `c0ffee${index}`, tests: [] })
    outcomes.push(await results.submitFindings(agent('reviewer'), taskId, { resultId: result.id, kind: 'review', ...review }))
  }
  return outcomes
}

// @covers: review-convergence › Manual tasks get a convergence notice › A manual task churns
test('S3 on a hand-made task\'s third review journals S3 and its findings and mails the Lead once from Kawai', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const results = service()
  await churn(results, task.id, [0, 1])
  // Two reviews fire nothing: no row, journal entry, or mail.
  expect(notices(task.id)).toEqual([])
  expect(noticeMail(task.id)).toEqual([])
  const [third] = await churn(results, task.id, [2])
  expect(notices(task.id)).toEqual([{ submission_id: third!.id }])
  const entries = journal(task.id).filter(entry => entry.startsWith('Convergence notice'))
  expect(entries).toHaveLength(1)
  expect(entries[0]).toContain('S3 churn')
  expect(entries[0]).toContain('Findings: F3.')
  // The notice follows the review's own journal line.
  expect(journal(task.id).at(-1)).toBe(entries[0])
  const [message, ...more] = noticeMail(task.id)
  expect(more).toEqual([])
  expect(message).toMatchObject({ toKind: 'session', toId: 'lead', fromKind: 'system', fromSession: null, taskId: task.id, originPath: team.groupsRoot })
  expect(message!.body).toContain('S3 churn')
  expect(message!.body).toContain('nothing waits')
  // Nothing else: no finding changed state, and the verdict stays the review's.
  expect(results.findingsLedger.ledger(task.id).map(entry => [entry.id, entry.state])).toEqual([['F1', 'resolved'], ['F2', 'still-open'], ['F3', 'accepted']])
})

test('a replayed notice for the same review writes nothing more', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const [, , third] = await churn(service(), task.id)
  const before = journal(task.id).length
  expect(noticeConvergence(store, { teamId: team.teamId, originPath: team.groupsRoot, task: store.get(task.id)!, submissionId: third!.id })).toBeNull()
  expect(notices(task.id)).toHaveLength(1)
  expect(noticeMail(task.id)).toHaveLength(1)
  expect(journal(task.id)).toHaveLength(before)
})

test('the next review after a notice starts a new window: one more churning review notices nothing', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  await churn(service(), task.id, [0, 1, 2, 3])
  expect(notices(task.id)).toHaveLength(1)
  expect(noticeMail(task.id)).toHaveLength(1)
  expect(journal(task.id).filter(entry => entry.startsWith('Convergence notice'))).toHaveLength(1)
})

test('a human-created task journals the notice and sends no mail', async () => {
  const task = await tasks.create({ kind: 'human', team }, { title: 'Export', direction: 'v1' })
  await churn(service(), task.id)
  expect(journal(task.id).filter(entry => entry.startsWith('Convergence notice'))).toHaveLength(1)
  expect(noticeMail(task.id)).toEqual([])
})

test('a task an execution owns gets no notice: its failed round opens a diagnosis instead', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const owned: ExecutionOwnership = { ...NULL_OWNERSHIP, ownerOfTask: id => (id === task.id ? { executionId: 'e', change: 'c' } as never : null) }
  await churn(service(owned), task.id)
  expect(notices(task.id)).toEqual([])
  expect(noticeMail(task.id)).toEqual([])
  expect(journal(task.id).some(entry => entry.startsWith('Convergence notice'))).toBe(false)
})
