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

// Findings (4.1/4.2, D4): bound to the examined result, never inherited.
test('findings attach to the named result with author and verdict; a newer result has none until its own are submitted', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const first = await results.submit(agent('dev'), task.id, submission)
  const reviewer = taskHandlers(tasks, 'reviewer', results)
  const findings = await reviewer.task_submit_findings!({ task_id: task.id, result_id: first.id, kind: 'review', verdict: 'fail', findings: 'Header row missing' })
  expect(findings).toMatchObject({ resultId: first.id, kind: 'review', verdict: 'fail', author: { kind: 'agent', sessionId: 'reviewer' }, handoffId: null })
  const second = await results.submit(agent('dev'), task.id, { ...submission, summary: 'CSV export, header fixed' })
  expect(tasks.store.results.get(second.id)!.findings).toEqual([])
  // The earlier result keeps its findings, readable beside it.
  expect(tasks.store.results.get(first.id)!.findings).toMatchObject([{ findings: 'Header row missing' }])
  await reviewer.task_submit_findings!({ task_id: task.id, result_id: second.id, kind: 'review', verdict: 'pass', findings: 'Looks right' })
  expect(tasks.store.results.get(second.id)!.findings).toMatchObject([{ verdict: 'pass' }])
  expect(tasks.store.results.get(first.id)!.findings).toHaveLength(1)
  expect(tasks.store.journal(task.id).at(-1)?.text).toBe(`Review findings on result ${second.id}: pass`)
})

test('findings refusals: a result of another task, empty text, another team, and the human', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const otherTask = await tasks.create(agent('lead'), { title: 'Import', direction: 'v1' })
  const result = await results.submit(agent('dev'), otherTask.id, submission)
  const input = { resultId: result.id, kind: 'review' as const, verdict: 'pass' as const, findings: 'ok' }
  await expect(results.submitFindings(agent('reviewer'), task.id, input)).rejects.toThrow(`is not a result of task ${task.id}`)
  await expect(results.submitFindings(agent('reviewer'), otherTask.id, { ...input, findings: ' ' })).rejects.toThrow('need text')
  await expect(results.submitFindings(agent('stranger'), otherTask.id, input)).rejects.toThrow('not found in this team')
  await expect(results.submitFindings(human(), otherTask.id, input)).rejects.toThrow('task_submit_findings')
  expect(tasks.store.results.get(result.id)!.findings).toEqual([])
})

test('findings answering the caller\'s outstanding handoff for that result record its id', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  // An outstanding review handoff of this result, its instruction claimed by the reviewer.
  const mail = new MailboxStore(db.db)
  const instruction = mail.enqueue({ teamId: team.teamId, toKind: 'group', toId: 'reviewers', fromSession: null, fromGroup: null,
    originPath: repo, body: 'Review it', taskId: task.id })
  mail.claim(instruction.id, 'reviewer')
  db.db.prepare(`INSERT INTO team_task_assignments (id, team_id, task_id, request_key, target_kind, target_id, role, instruction,
    created_by_kind, message_id, claimed_by, handoff_kind, result_id, created_at, updated_at)
    VALUES ('handoff-1', ?, ?, 'k', 'group', 'reviewers', 'reviewers', 'Review it', 'human', ?, 'reviewer', 'review', ?, 'now', 'now')`)
    .run(team.teamId, task.id, instruction.id, result.id)
  const answered = await results.submitFindings(agent('reviewer'), task.id, { resultId: result.id, kind: 'review', verdict: 'pass', findings: 'ok' })
  expect(answered.handoffId).toBe('handoff-1')
  // Someone else's findings on the same result answer no handoff of theirs.
  const unrelated = await results.submitFindings(agent('lead'), task.id, { resultId: result.id, kind: 'qa', verdict: 'pass', findings: 'ok' })
  expect(unrelated.handoffId).toBeNull()
})

// Acceptance (5.1, D5): closing rights first; one transaction; guardrail reasons journaled.
const accepted = (resultId: string) => tasks.store.results.get(resultId)!.acceptedAt !== null

test('a contributor cannot accept a result of a human-created task: refused, and nothing is written', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const journal = tasks.store.journal(task.id).length
  await expect(results.accept(agent('dev'), task.id, result.id)).rejects.toThrow("Only the task's creator can accept its results and close it")
  expect(accepted(result.id)).toBe(false)
  expect(tasks.store.journal(task.id)).toHaveLength(journal)
  expect(tasks.store.get(task.id)?.status).toBe('open')
})

test('the human accepts: the mark, the journal entry, and done commit together, with the criteria shown', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1', acceptance: 'A CSV downloads' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const outcome = await results.accept(human(), task.id, result.id)
  expect(outcome).toMatchObject({ task: { status: 'done' }, result: { id: result.id, acceptedBy: { kind: 'human', sessionId: null } },
    acceptanceCriteria: 'A CSV downloads', openChildren: [] })
  expect(tasks.store.journal(task.id).at(-1)).toMatchObject({ author: { kind: 'human' }, text: `Accepted result ${result.id}` })
  // Reopening keeps the acceptance: nothing clears it.
  await tasks.setStatus(human(), task.id, 'open')
  expect(tasks.store.get(task.id)?.status).toBe('open')
  expect(accepted(result.id)).toBe(true)
})

test('the creating agent may accept; a failure inside the transaction leaves no mark and no status', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, submission)
  const append = tasks.store.appendJournal.bind(tasks.store)
  tasks.store.appendJournal = () => { throw new Error('disk full') }
  await expect(results.accept(agent('lead'), task.id, result.id)).rejects.toThrow('disk full')
  tasks.store.appendJournal = append
  expect(accepted(result.id)).toBe(false)
  expect(tasks.store.get(task.id)?.status).toBe('open')
  await results.accept(agent('lead'), task.id, result.id)
  expect(tasks.store.get(task.id)?.status).toBe('done')
})

test('open child work and a flagged result need a journaled reason; a child\'s acceptance never closes its parent', async () => {
  const parent = await tasks.create(human(), { title: 'Exports', direction: 'v1' })
  const child = await tasks.create(human(), { title: 'CSV', direction: 'v1', parent_id: parent.id })
  const parentResult = await results.submit(agent('dev'), parent.id, submission)
  await expect(results.accept(human(), parent.id, parentResult.id)).rejects.toThrow('1 open child task needs a stated reason')
  expect(accepted(parentResult.id)).toBe(false)
  // The child's own acceptance closes the child, never the parent.
  const childResult = await results.submit(agent('dev'), child.id, submission)
  await results.accept(human(), child.id, childResult.id)
  expect(tasks.store.get(child.id)?.status).toBe('done')
  expect(tasks.store.get(parent.id)?.status).toBe('open')
  // A newer revision flags the parent's result: a reason is needed again, and journaled.
  await tasks.amend(human(), parent.id, { direction: 'v2' })
  await expect(results.accept(human(), parent.id, parentResult.id, '  ')).rejects.toThrow('needs re-evaluation (pinned at revision 1, task at 2)')
  await results.accept(human(), parent.id, parentResult.id, 'Scope change is cosmetic')
  expect(tasks.store.journal(parent.id).at(-1)?.text)
    .toBe(`Accepted result ${parentResult.id} despite needs re-evaluation (pinned at revision 1, task at 2): Scope change is cosmetic`)
  expect(tasks.store.get(parent.id)?.status).toBe('done')
})

test('accepting a result of another task, or another team\'s task, is refused', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  const otherTask = await tasks.create(human(), { title: 'Import', direction: 'v1' })
  const result = await results.submit(agent('dev'), otherTask.id, submission)
  await expect(results.accept(human(), task.id, result.id)).rejects.toThrow('is not a result of task')
  await expect(results.accept(agent('stranger'), otherTask.id, result.id)).rejects.toThrow('not found in this team')
  expect(accepted(result.id)).toBe(false)
})
