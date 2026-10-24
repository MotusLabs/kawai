// Coverage on task_submit_result (independent-verification D5, task 3.1):
// the map is validated at the service boundary — malformed input refused
// naming the clause index — and a refused submission writes nothing at all:
// no result row and no pending check row (J1). Agents are real sessions of a
// git-backed team, as in taskResults.test.ts.
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
import { taskHandlers } from '../team/taskTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let team: TeamIdentity
let db: SessionDatabase
let tasks: TaskService
let results: TaskResultService
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-result-coverage-')))
  repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  const records = new Map<string, ChatSessionRecord>([
    ['lead', { sessionId: 'lead', groupId: 'leads', projectPath: repo, name: 'lead', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' }],
  ])
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  const mail = new MailboxStore(db.db)
  const store = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  results = new TaskResultService(tasks, { getSession: id => records.get(id) })
})

const submission = (coverage: unknown) => ({
  summary: 'Coverage submission', commit: 'abc123',
  coverage,
})

test('a valid map is accepted and the submission lands like any other', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Coverage', direction: 'map it' })
  const result = await results.submit(agent('lead'), task.id, submission([
    { clause: 'task-results › Results carry a coverage map › Citation resolves and ran', tests: ['`src/a.test.ts` › `ran`'] },
  ]))
  const stored = tasks.store.results.listByTask(task.id)
  expect(stored).toHaveLength(1)
  expect(stored[0]!.id).toBe(result.id)
})

test('each malformed coverage refusal names its clause index', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Coverage', direction: 'map it' })
  const cases: Array<[unknown, RegExp]> = [
    ['not a list', /coverage must be a list of clauses/],
    [{ clause: 'x', tests: 'none' }, /coverage must be a list of clauses/],
    [[{ clause: 'x', tests: 'none' }], /coverage clause 1 needs a list of citations/],
    [[{ clause: 'ok', tests: [] }, { clause: 'x', tests: ['no backticks here'] }], /coverage clause 2: "no backticks here" is not a citation/],
  ]
  for (const [coverage, message] of cases) {
    expect(results.submit(agent('lead'), task.id, submission(coverage))).rejects.toThrow(message)
  }
})

test('a refused coverage submission writes nothing: no result row and no check row (J1)', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Coverage', direction: 'map it' })
  await expect(results.submit(agent('lead'), task.id, submission([
    { clause: 'ok', tests: [] },
    { clause: 'bad', tests: ['`f.ts` › `unclosed'] },
  ]))).rejects.toThrow(/coverage clause 2/)
  expect(tasks.store.results.listByTask(task.id)).toHaveLength(0)
  const pending = tasks.store.checks.pendingForTeam(team.teamId)
  expect(pending).toHaveLength(0)
})

test('task_submit_result passes the caller\'s coverage through the tool handler to validation', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Coverage', direction: 'map it' })
  const handlers = taskHandlers(tasks, 'lead', results)
  const submit = handlers.task_submit_result!
  await expect(submit({ task_id: task.id, summary: 's', commit: 'abc', coverage: [] }))
    .resolves.toBeDefined()
  await expect(submit({ task_id: task.id, summary: 's', commit: 'abc', coverage: { clause: 'x' } }))
    .rejects.toThrow(/coverage must be a list of clauses/)
  await expect(submit({ task_id: task.id, summary: 's', commit: 'abc', unknownField: true }))
    .resolves.toBeDefined()
})
