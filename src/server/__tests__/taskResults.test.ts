// Task results service and tools (task-results-handoffs 2.x/4.x/5.x): result
// submission pinned server-side with no status change; findings bound to the
// examined result; acceptance under TaskService.setStatus's closing rule,
// refused with nothing written for a contributor, atomic otherwise, with the
// guardrail reasons journaled. Agents are real sessions of a git-backed team.
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
let feature: string
let other: string
let team: TeamIdentity
let db: SessionDatabase
let records: Map<string, ChatSessionRecord>
let tasks: TaskService
let results: TaskResultService
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string | null, projectPath = repo): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-results-')))
  repo = path.join(root, 'repo')
  feature = path.join(root, 'repo-feature')
  other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Build.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([
    ['lead', row('lead', 'leads')],
    ['dev', row('dev', 'devs', feature)],
    ['reviewer', row('reviewer', 'reviewers')],
    ['stranger', row('stranger', 'leads', other)],
  ])
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  const mail = new MailboxStore(db.db)
  const store = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  results = new TaskResultService(tasks, { getSession: id => records.get(id) })
})

const submission = { summary: 'CSV export', commit: 'abc123', tests: [{ description: 'bun run test', outcome: 'pass' }] }

test('submission pins the current revision and the task worktree, journals a note, and leaves the status alone', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1', worktree: feature })
  await tasks.setStatus(agent('dev'), task.id, 'active')
  await tasks.amend(agent('lead'), task.id, { direction: 'v2' })
  const result = await results.submit(agent('dev'), task.id, { ...submission, limitations: 'No XLSX' })
  expect(result).toMatchObject({ taskRevision: 2, worktree: feature, submittedBy: { kind: 'agent', sessionId: 'dev' },
    commit: 'abc123', diff: null, limitations: 'No XLSX', needsReevaluation: false })
  expect(tasks.store.get(task.id)?.status).toBe('active')
  expect(tasks.store.journal(task.id).at(-1)).toMatchObject({ author: { kind: 'agent', sessionId: 'dev' }, text: `Submitted result ${result.id}: CSV export` })
})

test('without a task worktree, the submitter\'s resolved worktree is pinned', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  expect((await results.submit(agent('dev'), task.id, submission)).worktree).toBe(feature)
})

test('submission refusals: no reference, no summary, a half test, another team, and the human', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  await expect(results.submit(agent('dev'), task.id, { summary: 'x' })).rejects.toThrow('a commit or a diff reference')
  await expect(results.submit(agent('dev'), task.id, { summary: '  ', commit: 'a' })).rejects.toThrow('needs a summary')
  await expect(results.submit(agent('dev'), task.id, { ...submission, tests: [{ description: 'x', outcome: ' ' }] })).rejects.toThrow('description and an outcome')
  await expect(results.submit(agent('stranger'), task.id, submission)).rejects.toThrow('not found in this team')
  await expect(results.submit(human(), task.id, submission)).rejects.toThrow('task_submit_result')
  expect(tasks.store.results.listByTask(task.id)).toEqual([])
})

test('task_submit_result binds the calling session and round-trips; it registers only with a result service', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const handlers = taskHandlers(tasks, 'dev', results)
  const result = await handlers.task_submit_result!({ task_id: task.id, ...submission, submitted_by: 'lead' }) as { id: string; submittedBy: unknown }
  expect(result.submittedBy).toEqual({ kind: 'agent', sessionId: 'dev' })
  expect((await taskHandlers(tasks, 'dev').task_get({ task_id: task.id })).results).toMatchObject([{ id: result.id }])
  expect('task_submit_result' in taskHandlers(tasks, 'dev')).toBe(false)
  await expect(handlers.task_submit_result!({ task_id: task.id, summary: 'x' })).rejects.toThrow('a commit or a diff reference')
  const { TEAM_ALLOWED_TOOLS } = await import('../team/mailboxTools')
  expect(TEAM_ALLOWED_TOOLS).toContain('mcp__kawai-team__task_submit_result')
})
