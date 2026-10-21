// The executor end to end (plan-execution §11.1/11.3/11.4) over the plan
// bench and a real bare `origin`: a wake schedules one tick (concurrent
// wakes share it), the tick walks a waiting change through provisioning (a
// real worktree from origin's base, never touching a foreign branch) into
// implementing with Kawai's task, attempt manifest, and keyed dispatch —
// once, replays included — and a fresh executor over the same rows resumes
// without duplicating anything.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ExecutionStore } from '../plans/execution/executionStore'
import { executionOwnership } from '../plans/execution/executionOwnership'
import { ExecutionExecutor } from '../plans/execution/executor'
import { provisionAdapter } from '../plans/execution/executionProvision'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'
import { neutralExecutorSeams } from './executorTestSeams'

let world: PlanWorld
let bench: PlanBench
let mail: MailboxStore
let tasks: TaskService
let assignments: AssignmentService
let results: TaskResultService
let executions: ExecutionStore
let executor: ExecutionExecutor
let gitRoot: string
let origin: string
let baseSha: string

/** The team's main checkout: the plan world's repo, given the bare origin. */
const main = () => world.repo

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

/** An approved plan whose revision lists exactly these independent changes. */
async function approvedPlan(changes: string[]): Promise<{ planId: string; revision: number; hash: string }> {
  for (const change of changes) {
    // Task creation validates the OpenSpec change exists in the main checkout.
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(world.repo, 'changes')
  git(['push', '-q', 'origin', 'master'], world.repo)
  const { planId, revision, hash } = await bench.draftInReview({
    changes: changes.map(change => ({ change, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' })),
  })
  await bench.approve(planId, revision)
  return { planId, revision, hash }
}

/** One running execution of an approved plan over these changes. */
function startExecution(plan: { planId: string; revision: number; hash: string }, changes: string[]): string {
  return executions.insertExecution({
    teamId: world.team.teamId, planId: plan.planId, revision: plan.revision, contentHash: plan.hash, reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: baseSha, floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    maxParallel: 2, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  }).id
}

/** An approved plan plus its running execution, under unique change names. */
async function runningExecution(changes: string[]): Promise<string> {
  return startExecution(await approvedPlan(changes), changes)
}

const makeExecutor = () => new ExecutionExecutor({
  ...neutralExecutorSeams,
  store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
  records: () => bench.records.values(), plansService: bench.service,
  teamOf: id => (id === world.team.teamId ? world.team : undefined),
  adapters: { provision: provisionAdapter(executions) },
})

beforeAll(async () => {
  world = await createPlanWorld('kawai-executor-')
  writeGroup(world, 'middle-devs', '---\nmax: 2\n---\nBuild.')
  gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-exec-git-'))
  origin = path.join(gitRoot, 'origin.git')
  git(['init', '-q', '--bare', '-b', 'master', origin], gitRoot)
  // The plan world's repository is the team's main checkout (D6: worktree add
  // runs from it); give it the bare origin and publish its master.
  fs.writeFileSync(path.join(world.repo, 'seed.txt'), 'seed\n')
  for (const change of ['api', 'ui', 'web']) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(world.repo, 'seed')
  git(['remote', 'add', 'origin', origin], world.repo)
  git(['push', '-q', 'origin', 'master'], world.repo)
  baseSha = git(['rev-parse', 'master'], origin).trim()
})
afterAll(() => {
  fs.rmSync(world.root, { recursive: true, force: true })
  fs.rmSync(gitRoot, { recursive: true, force: true })
})

beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
  mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  executions = new ExecutionStore(bench.db.db)
  const ownership = executionOwnership(executions, {
    isAncestor: async () => ({ ok: true, ancestor: true }),
    lsRemoteHead: async () => ({ ok: true, sha: null }),
  }, () => null)
  tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans, ownership })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => (bench.records.get(id)?.projectPath === world.other ? undefined : world.team)
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership,
  })
  results = new TaskResultService(tasks, { getSession: id => bench.records.get(id), assignments, ownership })
  executor = makeExecutor()
})
afterEach(() => executor.close())

describe('the executor loop (§11.1)', () => {
  test('concurrent wakes run one tick; a restart resumes from stored rows', async () => {
    const plan = await approvedPlan(['first-a', 'first-b'])
    const executionId = startExecution(plan, ['first-a', 'first-b'])
    executor.wake(world.team.teamId)
    executor.wake(world.team.teamId)
    await executor.idle()
    const rows = executions.changes(executionId)
    // maxParallel 2: both scheduled; both provisioned and dispatched, once each.
    expect(rows.map(row => [row.change, row.state, row.taskId !== null])).toEqual([['first-a', 'implementing', true], ['first-b', 'implementing', true]])
    expect(executions.effectsOf(executionId)).toHaveLength(2)
    expect(executions.attempts(executionId, 'first-a')).toHaveLength(1)
    // A second wake over the settled state changes nothing.
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.attempts(executionId, 'first-a')).toHaveLength(1)
    expect(executions.effectsOf(executionId)).toHaveLength(2)
    // A fresh executor (a restart) resumes from the rows: no duplicates.
    executor.close()
    const restarted = makeExecutor()
    restarted.wake(world.team.teamId)
    await restarted.idle()
    restarted.close()
    expect(executions.attempts(executionId, 'first-a')).toHaveLength(1)
    expect(bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_task_assignments').get()).toMatchObject({ n: 2 })
  })
})

describe('provisioning (§11.3)', () => {
  test('branches from origin\'s base; a foreign remote branch is never touched', async () => {
    // A foreign branch on origin no execution provisioned.
    git(['push', '-q', 'origin', `HEAD:refs/heads/foreign`], main())
    const foreignHead = git(['rev-parse', 'HEAD'], main()).trim()
    const executionId = await runningExecution(['probe-a'])
    executor.wake(world.team.teamId)
    await executor.idle()
    const row = executions.change(executionId, 'probe-a')!
    expect(row.worktree).toBe(path.join(main(), '.worktrees', 'probe-a'))
    expect(row.branch).toBe('probe-a')
    expect(row.baselineCommit).toBe(baseSha)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], row.worktree!).trim()).toBe('probe-a')
    expect(git(['rev-parse', 'HEAD'], row.worktree!).trim()).toBe(baseSha)
    expect(git(['rev-parse', 'refs/heads/foreign'], origin).trim()).toBe(foreignHead)
  })

  test('a name taken by work not of this plan stops as name-taken', async () => {
    git(['branch', 'taken-b'], main())
    const executionId = await runningExecution(['taken-b'])
    executor.wake(world.team.teamId)
    await executor.idle()
    const effect = executions.effectsOf(executionId)[0]!
    expect(effect).toMatchObject({ kind: 'provision', state: 'failed' })
    expect(effect.error).toContain('name-taken')
    expect(executions.change(executionId, 'taken-b')).toMatchObject({ state: 'stopped', stopReason: 'name-taken' })
  })

  test('a later execution of the same plan reuses the worktree and branch', async () => {
    const plan = await approvedPlan(['reuse-a'])
    const first = startExecution(plan, ['reuse-a'])
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(first, 'reuse-a')!.state).toBe('implementing')
    executions.finishExecution(first, 'stopped', 'test')
    const second = startExecution(plan, ['reuse-a'])
    executor.wake(world.team.teamId)
    await executor.idle()
    const row = executions.change(second, 'reuse-a')!
    expect(row.state).toBe('implementing')
    expect(row.worktree).toBe(path.join(main(), '.worktrees', 'reuse-a'))
    // One worktree on disk, on the same branch, still at the base.
    expect(git(['worktree', 'list', '--porcelain'], main()).split('\n').filter((line: string) => line.includes('.worktrees/reuse-a'))).toHaveLength(1)
    expect(executions.attempts(second, 'reuse-a')).toHaveLength(1)
  })
})

describe('Kawai\'s task and dispatch (§11.4)', () => {
  test('task fields, link, dispatcher, allowed_profiles, and a replayed step yields one instruction', async () => {
    const plan = await approvedPlan(['task-a'])
    const planId = plan.planId
    // The fixture's role narrows middle-devs to ['default'] — it rides the mail.
    const execution = { id: startExecution(plan, ['task-a']) }
    executor.wake(world.team.teamId)
    await executor.idle()
    const row = executions.change(execution.id, 'task-a')!
    const task = tasks.store.get(row.taskId!)!
    expect(task.creator).toEqual({ kind: 'system', sessionId: null })
    expect(task.title).toMatch(/^task-a — /)
    expect(task.direction).toContain('authoritative direction')
    expect(task.openspecChange).toBe('task-a')
    expect(task.planId).toBe(planId)
    expect(task.planChange).toBe('task-a')
    expect(task.worktree).toBe(path.join(main(), '.worktrees', 'task-a'))
    const assignment = tasks.store.assignmentsOf(task.id)[0]!
    expect(assignment.createdBy).toEqual({ kind: 'system', sessionId: null })
    // The key carries the generation at dispatch (waiting→provisioning→implementing→task bumps it).
    expect(assignment.requestKey).toBe(`exec:${execution.id}:task-a:attempt:1:${row.generation}`)
    const message = mail.get(assignment.messageId!)!
    expect(message).toMatchObject({ fromKind: 'system', allowedProfiles: ['default'] })
    // Roles alone narrow Kawai's dispatches (dispatch-worker-choice): no worker choice on the row or the mail.
    expect([assignment.workerChoice ?? null, message.workerChoice ?? null]).toEqual([null, null])
    expect(message.body).toContain('OpenSpec change "task-a"')
    // A replayed dispatch step yields one instruction (the key replays).
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_task_assignments WHERE task_id = ?').get(task.id)).toMatchObject({ n: 1 })
    const attempt = executions.attempts(execution.id, 'task-a')[0]!
    expect(attempt.kind).toBe('implement')
    expect(attempt.manifest.plan.id).toBe(planId)
    expect(attempt.manifest.baseline).toBe(baseSha)
    expect(attempt.manifest.roleProfiles).toEqual(['default'])
    expect(Object.keys(attempt.manifest.artifacts)).toContain('seed.txt')
  })
})
