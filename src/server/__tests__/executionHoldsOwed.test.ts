// The owed fix dispatch under holds (revision-control 3.2, review B1): a
// fix attempt answers one round — its manifest's answers.roundId — so a
// second debt (a failed round, or a D9 republish) after a fix round mints
// its own attempt, and the hold's release dispatches exactly one
// instruction under the newest attempt's own request key. The table covers
// {ci, review, d9} × {previous attempt implement, fix}; the restart test
// fills recovery-matrix R1: hold rows and the owed attempt are durable, and
// a fresh executor over the same database gates and dispatches the same way.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { ImpactStore } from '../strategy/impactStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ExecutionStore } from '../plans/execution/executionStore'
import { executionOwnership } from '../plans/execution/executionOwnership'
import { ExecutionExecutor } from '../plans/execution/executor'
import { provisionAdapter } from '../plans/execution/executionProvision'
import { HoldService } from '../plans/revisionControl/holdService'
import { HoldStore } from '../plans/revisionControl/holdStore'
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
let holds: HoldService
let gitRoot: string
let origin: string
let baseSha: string
let ghStub: { checkRuns: string; statuses: string; pulls: string; created: string; reruns: number[] }

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

async function approvedExecution(changes: string[]): Promise<{ executionId: string; planId: string }> {
  for (const change of changes) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(world.repo, 'change')
  git(['push', '-q', 'origin', 'master'], world.repo)
  const { planId, revision, hash } = await bench.draftInReview({
    changes: changes.map(change => ({ change, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' })),
    reviewGroup: 'reviewers',
  })
  await bench.approve(planId, revision)
  const executionId = executions.insertExecution({
    teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: baseSha,
    floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    maxParallel: 2, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  }).id
  return { executionId, planId }
}

/** The executor over the current bench; rebuilt verbatim by the restart test. */
function buildExecutor(): ExecutionExecutor {
  return new ExecutionExecutor({
    ...neutralExecutorSeams, plansService: bench.service,
    store: executions, plans: bench.plans, tasks, assignments, mailbox: mail, results,
    records: () => bench.records.values(),
    teamOf: id => (id === world.team.teamId ? world.team : undefined),
    adapters: { provision: provisionAdapter(executions) },
    holds: {
      active: (teamId, planId) => new HoldStore(bench.db.db).active(teamId, planId).map(hold => ({ id: hold.id, scope: hold.scope, changes: hold.changes })),
      openTargets: () => [],
    },
    roundAdapters: {
      lsRemoteHead: async () => ({ ok: true, sha: null }),
      push: async (cwd: string, source: string, branch: string) => {
        const result = spawnSync('git', ['push', 'origin', `${source}:refs/heads/${branch}`], { cwd, encoding: 'utf8', env: cleanGitEnv() })
        return result.status === 0 ? { ok: true as const } : { ok: false as const, error: { argv: ['git', 'push'], exitCode: result.status, stderr: result.stderr } }
      },
      checkRuns: async () => ({ ok: true, data: JSON.parse(ghStub.checkRuns) }),
      statuses: async () => ({ ok: true, data: JSON.parse(ghStub.statuses) }),
      prList: async () => ({ ok: true, data: JSON.parse(ghStub.pulls) }),
      prCreate: async () => ({ ok: true, data: JSON.parse(ghStub.created) }),
      rerun: async (_repo: string, runId: number) => { ghStub.reruns.push(runId); return { ok: true, data: null } },
    },
  })
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-owed-')
  writeGroup(world, 'middle-devs', '---\nmax: 2\n---\nBuild.')
  writeGroup(world, 'reviewers', '---\nmax: 2\n---\nReview.')
  gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-owed-git-'))
  origin = path.join(gitRoot, 'origin.git')
  git(['init', '-q', '--bare', '-b', 'master', origin], gitRoot)
  fs.writeFileSync(path.join(world.repo, 'seed.txt'), 'seed\n')
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
  bench.records.set('rev1', { sessionId: 'rev1', groupId: 'reviewers', projectPath: world.feature, name: 'rev1', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' })
  bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), claudeProfileId: 'glm' })
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
  ghStub = { checkRuns: '[]', statuses: '[]', pulls: '[]', created: '{"number":7,"url":"https://example.internal/pr/7"}', reruns: [] }
  executor = buildExecutor()
  holds = new HoldService({
    holds: new HoldStore(bench.db.db), plans: bench.plans, planService: bench.service,
    strategies: bench.strategies, impact: new ImpactStore(bench.db.db), decisions: new DecisionStore(bench.db.db),
    executions, wake: id => executor.wake(id), now: () => new Date(),
  })
})
afterEach(() => { executor?.close() })

const passCi = () => {
  ghStub.checkRuns = JSON.stringify([
    { id: 't', name: 'ci', source: 'actions', conclusion: 'success', link: 'https://example.internal/runs/11/at', runId: 11, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
    { id: 'e', name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
  ])
}

/** A final CI failure: the e2e status check cannot be rerun, so the round fails at once. */
const failCi = () => {
  ghStub.checkRuns = JSON.stringify([
    { id: 't', name: 'ci', source: 'actions', conclusion: 'success', link: 'https://example.internal/runs/11/at', runId: 11, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
    { id: 'e', name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null },
  ])
}

/** The implement stage through the dispatch; the change ends implementing with its task. */
async function implementStage(executionId: string, change: string, edit: string): Promise<NonNullable<ReturnType<ExecutionStore['change']>>> {
  executor.wake(world.team.teamId)
  await executor.idle()
  const row = executions.change(executionId, change)
  expect(row?.state).toBe('implementing')
  await submitResult(executionId, change, edit)
  return executions.change(executionId, change)!
}

/** A developer result: an edit, a commit, a submission (the round records on the next tick). */
async function submitResult(executionId: string, change: string, edit: string): Promise<void> {
  const row = executions.change(executionId, change)!
  fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
  fs.writeFileSync(path.join(row.worktree!, 'src', `${change}.ts`), edit)
  commitAll(row.worktree!, `work ${change}`)
  const commit = git(['rev-parse', 'HEAD'], row.worktree!).trim()
  await results.submit(bench.agent('dev'), row.taskId!, { summary: 'done', commit, tests: [{ description: 'unit', outcome: 'pass' }] })
}

/** The reviewer claims, reads, and fails the newest round's review. */
async function failReview(executionId: string, change: string, findings: string): Promise<void> {
  const row = executions.change(executionId, change)!
  const round = executions.rounds(executionId, change).at(-1)!
  const review = tasks.store.assignmentsOf(row.taskId!).find(entry => entry.id === round.reviewAssignmentId)!
  mail.claim(review.messageId!, 'rev1')
  mail.markPushed(review.messageId!)
  mail.markDelivered(review.messageId!)
  await results.submitFindings(bench.agent('rev1'), row.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'fail', findings })
}

function placeHold(planId: string, changeNames: string[], commandId: string): { id: string } {
  const placed = holds.place(bench.human, {
    planId, scope: 'changes', changes: changeNames,
    rationale: 'rethink the direction', deadline: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    cites: null, commandId,
  })
  if (!placed.ok) throw new Error(placed.message)
  return { id: placed.result!.hold.id }
}

function releaseHold(planId: string, holdId: string): void {
  const released = holds.release(bench.human, { planId, holdId, reason: 'done waiting', commandId: `release-${holdId}` })
  if (!released.ok) throw new Error(released.message)
}

describe('owed fix dispatches under holds (revision-control 3.2, review B1)', () => {
  const rows = [
    ['ci', 'implement'], ['ci', 'fix'],
    ['review', 'implement'], ['review', 'fix'],
    ['d9', 'implement'], ['d9', 'fix'],
  ] as const

  test.each(rows)('an owed %s fix after a %s attempt dispatches exactly once on release', async (failure, previous) => {
    const name = `owed-${failure}-${previous}`
    const { executionId, planId } = await approvedExecution([name])
    const first = await implementStage(executionId, name, 'v1\n')
    const taskId = first.taskId!

    if (failure === 'review') {
      // Round 1's pipeline up to its review handoff, unheld: the verdict can
      // then fail under the hold, and a fix-previous round 2 needs its own
      // review out before the hold too.
      ghStub.pulls = '[]'
      passCi()
      executor.wake(world.team.teamId)
      await executor.idle()
    }

    if (previous === 'fix') {
      // Round 1 fails unheld; its fix dispatches and the fix round is
      // submitted — the newest attempt is now a fix answering round 1. A
      // d9 row's first failure is a ci failure too: only the second debt's
      // kind identifies the row.
      if (failure === 'review') {
        await failReview(executionId, name, 'fix round 1')
        executor.wake(world.team.teamId)
        await executor.idle()
      } else {
        failCi()
        executor.wake(world.team.teamId)
        await executor.idle()
      }
      expect(executions.attempts(executionId, name).at(-1)!.kind).toBe('fix')
      await submitResult(executionId, name, 'v2\n')
      if (failure === 'review') {
        // Round 2's review handoff goes out before the hold.
        executor.wake(world.team.teamId)
        await executor.idle()
      }
    }

    // The second debt arrives under the hold: a ci or review failure of the
    // newest round, or a D9 republish superseding it.
    const hold = placeHold(planId, [name], `owed-${failure}-${previous}-1`)
    await executor.idle()
    if (failure === 'd9') {
      await tasks.amend(bench.human, taskId, { direction: 'the new direction', rationale: 'changed' })
    } else if (failure === 'ci') {
      failCi()
    } else {
      await failReview(executionId, name, 'fix round 2')
    }
    executor.wake(world.team.teamId)
    await executor.idle()

    const expectedNumber = previous === 'fix' ? 3 : 2
    const attempts = executions.attempts(executionId, name)
    expect(attempts.at(-1)!.number).toBe(expectedNumber)
    // The attempt answers the round the change now stands on — never the
    // earlier round the previous fix answered.
    const round = executions.rounds(executionId, name).at(-1)!
    expect(attempts.at(-1)!.manifest.answers?.roundId).toBe(round.id)

    const before = tasks.store.assignmentsOf(taskId).length
    releaseHold(planId, hold.id)
    await executor.idle()
    const dispatched = tasks.store.assignmentsOf(taskId)
    expect(dispatched.length).toBe(before + 1)
    expect(dispatched.at(-1)!.requestKey).toContain(`attempt:${expectedNumber}:`)
    if (failure === 'd9') expect(dispatched.at(-1)!.instruction).toContain('revision 2')
    if (failure === 'ci') expect(dispatched.at(-1)!.instruction).toContain('e2e')
    if (failure === 'review') expect(dispatched.at(-1)!.instruction).toContain(previous === 'fix' ? 'fix round 2' : 'fix round 1')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(tasks.store.assignmentsOf(taskId).length).toBe(before + 1)
  })
})

// Recovery-matrix R1: hold placed or released at a crash. The hold rows and
// the owed attempt are durable; a fresh executor and the same hold service
// read them from the database, gate the same way, and the release dispatches
// exactly once through the new executor.
describe('holds across an executor restart (revision-control 3.2, review N1)', () => {
  test('a hold and its owed fix survive an executor restart; the release dispatches once', async () => {
    const name = 'restart-owed'
    const { executionId, planId } = await approvedExecution([name])
    const first = await implementStage(executionId, name, 'v1\n')
    const taskId = first.taskId!
    // Round 1 fails unheld; its fix dispatches and the fix round is submitted.
    failCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    await submitResult(executionId, name, 'v2\n')

    // The hold, then round 2's CI failure under it: attempt 3 is minted, no
    // dispatch. The executor dies and a fresh one opens over the same
    // database — the state the crash left behind.
    const hold = placeHold(planId, [name], 'restart-owed-1')
    await executor.idle()
    failCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.attempts(executionId, name).at(-1)!.number).toBe(3)
    const held = tasks.store.assignmentsOf(taskId).length
    executor.close()
    executor = buildExecutor()
    await executor.idle()
    // Still held across the restart: nothing dispatches.
    expect(tasks.store.assignmentsOf(taskId).length).toBe(held)

    // The release dispatches the owed fix exactly once, through the new
    // executor.
    releaseHold(planId, hold.id)
    await executor.idle()
    const dispatched = tasks.store.assignmentsOf(taskId)
    expect(dispatched.length).toBe(held + 1)
    expect(dispatched.at(-1)!.requestKey).toContain('attempt:3:')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(tasks.store.assignmentsOf(taskId).length).toBe(held + 1)
  })
})
