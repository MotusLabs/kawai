// Result checks over a submitted result (independent-verification D1/D4,
// tasks 2.3/2.4): the pending row rides the result's own transaction (I1),
// the service settles it afterwards outside every gate — a failing check
// never blocks a handoff, findings, or acceptance (I4) — and the tool's
// recheck records beside the earlier checks without starting a second.
// Split from taskHandoffs.test.ts (review findings-66e79a5b B1) with the
// same repository scaffolding.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
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
import { rawCoverage } from '../../shared/coverageMaps'
import { ResultCheckService } from '../verification/resultCheckService'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let results: TaskResultService
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const submission = { summary: 'CSV export', commit: 'abc123' }
const review = (resultId: string) => ({
  kind: 'review' as const, resultId, target: { kind: 'group' as const, id: 'reviewers' }, instructions: 'Review the export',
  expectedResponse: null, requestKey: 'review-1',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-result-check-handoffs-')))
  repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  for (const id of ['devs', 'reviewers']) fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), `${id}.`)
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  const records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')], ['reviewer', row('reviewer', 'reviewers')]])
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  mail = new MailboxStore(db.db)
  const assignmentStore = new AssignmentStore(db.db, mail)
  tasks = new TaskService(new TaskStore(db.db, mail, assignmentStore), { getSession: id => records.get(id) })
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees: new TeamWorktrees(),
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(db.db, assignmentStore, tasks.store, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf: () => undefined, staffing, caps: new TeamCaps({}),
    worktrees: new TeamWorktrees(),
  })
  results = new TaskResultService(tasks, { getSession: id => records.get(id), assignments })
})

describe('result checks over a submitted result', () => {
  const checkSources = () => ({
    result: (id: string) => {
      const stored = tasks.store.results.get(id)
      return stored === null ? null : { commit: stored.commit, worktree: stored.worktree, coverage: rawCoverage(stored.coverage) }
    },
    openTasks: (teamId: string) => tasks.store.list(teamId)
      .filter(task => task.status === 'open' || task.status === 'active' || task.status === 'blocked')
      .map(task => ({ id: task.id, worktree: task.worktree, createdAt: task.createdAt })),
    listedWorktrees: (teamId: string) => new TeamWorktrees().list(teamId),
  })
  /** Failing facts a settled check can carry (a base conflict), for I4. */
  const failingFacts = () => JSON.stringify({
    version: 1,
    commit: { given: 'abc123', sha: 'abc123', resolvedAtCheckTime: true, status: 'fail', note: 'commit not found' },
    head: null,
    clean: null,
    recorded: { status: 'unknown', recordBun: null, recordAt: null, commitBun: null, note: 'not checked' },
    base: { ref: 'refs/remotes/origin/HEAD', sha: null, behind: null, mergeClean: false,
      conflicts: ['src/export.ts'], moreConflicts: 0, status: 'fail', note: null },
    branches: { compared: [], comparedCount: 0, skipped: 0, status: 'pass' },
  })
  /** Clean facts, for the check a recheck supersedes. */
  const cleanFacts = () => JSON.stringify({
    version: 1,
    commit: { given: 'abc123', sha: 'abc123', resolvedAtCheckTime: true, status: 'pass', note: null },
    head: null,
    clean: null,
    recorded: { status: 'unknown', recordBun: null, recordAt: null, commitBun: null, note: 'not checked' },
    base: { ref: 'refs/remotes/origin/HEAD', sha: null, behind: 0, mergeClean: true,
      conflicts: [], moreConflicts: 0, status: 'pass', note: null },
    branches: { compared: [], comparedCount: 0, skipped: 0, status: 'pass' },
  })

  // @covers: task-results › Result checks never block or gate › Restart during a check
  test('submit commits a pending check with the result; the service settles it; a restart finds nothing (I1, C2)', async () => {
    const task = await tasks.create(agent('lead'), { title: 'Checked', direction: 'v1' })
    const checks = tasks.store.checks
    const result = await results.submit(agent('dev'), task.id, submission)
    // The pending row committed in the result's transaction: submit returns
    // with it already standing.
    const pendingRow = checks.pendingForResult(result.id)
    expect(pendingRow).toMatchObject({ status: 'pending', trigger: 'submit', taskId: task.id, seq: 1 })
    // The service runs it against the real repository (the harness repo; the
    // given text 'abc123' is no commit there, so the commit fact fails).
    const service = new ResultCheckService({ store: checks, sources: checkSources() })
    service.wake(team.teamId)
    await service.quiesce()
    const stored = checks.get(pendingRow!.id)
    expect(stored?.status).toBe('done')
    expect(stored?.facts?.commit).toMatchObject({ status: 'fail', note: 'commit not found' })
    expect(stored?.facts?.head).toBeNull()
    // Restart (C2's last leg): nothing is pending, and a fresh start() runs
    // nothing — the row settled exactly once.
    expect(checks.pendingForResult(result.id)).toBeNull()
    expect(checks.teamsWithPending()).toEqual([])
    new ResultCheckService({ store: checks, sources: checkSources() }).start()
    await service.quiesce()
    expect(checks.allForResult(result.id)).toHaveLength(1)
  })

  // @covers: task-results › Result checks never block or gate › A failing check does not gate
  test('a settled check with failing facts never gates findings, handoff, or acceptance (I4)', async () => {
    const task = await tasks.create(agent('lead'), { title: 'Gated?', direction: 'v1' })
    const result = await results.submit(agent('dev'), task.id, submission)
    const pendingRow = tasks.store.checks.pendingForResult(result.id)!
    // The check came back failing: a conflict with the base.
    expect(tasks.store.checks.settle(pendingRow.id, 'done', failingFacts(), null)).toBe(true)
    const findings = await results.submitFindings(agent('reviewer'), task.id,
      { kind: 'review', resultId: result.id, verdict: 'pass', findings: 'ok' })
    expect(findings.verdict).toBe('pass')
    const handed = await results.handoff(human(), task.id, review(result.id))
    expect(handed.assignment).toMatchObject({ handoffKind: 'review', state: 'queued' })
    await results.accept(human(), task.id, result.id)
    expect(tasks.store.get(task.id)?.status).toBe('done')
    expect(tasks.store.results.get(result.id)!.acceptedAt).not.toBeNull()
  })

  // @covers: task-results › Results can be rechecked › Recheck after the base moved
  test('task_check_result rechecks after the base moved: a new check beside the readable earlier one', async () => {
    const task = await tasks.create(agent('lead'), { title: 'Rechecked', direction: 'v1' })
    const result = await results.submit(agent('dev'), task.id, submission)
    const checks = tasks.store.checks
    // The submit check ran clean; then the base gained a conflicting commit.
    const first = checks.pendingForResult(result.id)!
    expect(checks.settle(first.id, 'done', cleanFacts(), null)).toBe(true)
    const tool = taskHandlers(tasks, 'dev', results)
    const rechecked = await tool.task_check_result!({ task_id: task.id, result_id: result.id }) as { id: string; seq: number; trigger: string; status: string }
    expect(rechecked).toMatchObject({ seq: 2, trigger: 'recheck', status: 'pending' })
    checks.settle(rechecked.id, 'done', failingFacts(), null)
    const all = checks.allForResult(result.id)
    expect(all).toHaveLength(2)
    // Newest first: the conflict, then the earlier clean check, still readable.
    expect(all[0]?.facts?.base).toMatchObject({ mergeClean: false, conflicts: ['src/export.ts'] })
    expect(all[1]?.facts?.base).toMatchObject({ mergeClean: true })
  })

  // @covers: task-results › Results can be rechecked › Recheck while pending
  test('a recheck requested while a check is pending returns it, and no second check runs', async () => {
    const task = await tasks.create(agent('lead'), { title: 'Pending', direction: 'v1' })
    const result = await results.submit(agent('dev'), task.id, submission)
    const standing = tasks.store.checks.pendingForResult(result.id)!.id
    const tool = taskHandlers(tasks, 'dev', results)
    const again = await tool.task_check_result!({ task_id: task.id, result_id: result.id }) as { id: string }
    expect(again.id).toBe(standing)
    expect(tasks.store.checks.allForResult(result.id)).toHaveLength(1)
  })
})
