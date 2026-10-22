// The hold gate at the executor (revision-control 3.2): a held change's
// review handoff waits while its push, PR, and CI still run, a failed round
// still records its guarded fix transition but owes its dispatch, the owed
// dispatch runs exactly once on the first tick after release, a hold placed
// while a dev's turn runs sends that session no mail, an unheld sibling
// keeps advancing, and a release with nothing owed dispatches nothing.
// Holds are placed through the real HoldService over the bench, whose wake
// drives this executor.
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
import { landingAdapters as realLandingAdapters } from '../plans/execution/executionLanding'
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
let ghStub: { checkRuns: string; statuses: string; pulls: string; created: string; reruns: number[] }
/** Landing reads fail while latched: a change stops after taking the slot. */
let failLsRemote = false
/** The head the stubbed merge merged, for prView's MERGED answer. */
let mergedHead: string | null = null

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

async function approvedExecution(changes: string[], maxParallel = 2, baseCommit?: string): Promise<{ executionId: string; planId: string }> {
  for (const change of changes) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(world.repo, 'change')
  git(['push', '-q', 'origin', 'master'], world.repo)
  // The base defaults to origin's head after the push: the change branches
  // (provisioned from it) contain the base, so landing merges instead of
  // updating the branch through gh.
  const base = baseCommit ?? git(['rev-parse', 'origin/master'], world.repo).trim()
  const { planId, revision, hash } = await bench.draftInReview({
    changes: changes.map(change => ({ change, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' })),
    // The plan's review group; the fixture role narrows middle-devs to default.
    reviewGroup: 'reviewers',
  })
  await bench.approve(planId, revision)
  const executionId = executions.insertExecution({
    teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: base,
    floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    maxParallel, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  }).id
  return { executionId, planId }
}

/** The whole implement stage: provision, task, dispatch — returns the change row and worktree. */
async function implementStage(executionId: string, change: string, edit: string): Promise<{ row: NonNullable<ReturnType<ExecutionStore['change']>>; commit: string }> {
  executor.wake(world.team.teamId)
  await executor.idle()
  const row = executions.change(executionId, change)
  expect(row?.state).toBe('implementing')
  // The implementer works in its worktree and submits a result.
  fs.mkdirSync(path.join(row!.worktree!, 'src'), { recursive: true })
  fs.writeFileSync(path.join(row!.worktree!, 'src', `${change}.ts`), edit)
  commitAll(row!.worktree!, `implement ${change}`)
  const commit = git(['rev-parse', 'HEAD'], row!.worktree!).trim()
  await results.submit(bench.agent('dev'), row!.taskId!, { summary: 'done', commit, tests: [{ description: 'unit', outcome: 'pass' }] })
  return { row: row!, commit }
}

const deliverToReviewer = (messageId: string, sessionId: string) => {
  mail.claim(messageId, sessionId)
  mail.markPushed(messageId)
  mail.markDelivered(messageId)
}

/** Place a hold through the real service; its wake drives the executor. */
function placeHold(planId: string, scope: 'plan' | 'changes', changeNames: string[], commandId: string): { id: string } {
  const placed = holds.place(bench.human, {
    planId, scope,
    ...(scope === 'changes' ? { changes: changeNames } : {}),
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

beforeAll(async () => {
  world = await createPlanWorld('kawai-holds-')
  writeGroup(world, 'middle-devs', '---\nmax: 2\n---\nBuild.')
  writeGroup(world, 'reviewers', '---\nmax: 2\n---\nReview.')
  gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-holds-git-'))
  origin = path.join(gitRoot, 'origin.git')
  git(['init', '-q', '--bare', '-b', 'master', origin], gitRoot)
  fs.writeFileSync(path.join(world.repo, 'seed.txt'), 'seed\n')
  commitAll(world.repo, 'seed')
  git(['remote', 'add', 'origin', origin], world.repo)
  git(['push', '-q', 'origin', 'master'], world.repo)
})
afterAll(() => {
  fs.rmSync(world.root, { recursive: true, force: true })
  fs.rmSync(gitRoot, { recursive: true, force: true })
})

beforeEach(() => {
  bench?.db.close()
  failLsRemote = false
  mergedHead = null
  bench = createPlanBench(world)
  // A reviewer session of the reviewers group.
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
  // The scripted gh surface: the round adapters below read the ghStub object.
  ghStub = { checkRuns: '[]', statuses: '[]', pulls: '[]', created: '{"number":7,"url":"https://example.internal/pr/7"}', reruns: [] }
  executor = new ExecutionExecutor({
    ...neutralExecutorSeams, plansService: bench.service,
    store: executions, plans: bench.plans, tasks, assignments, mailbox: mail, results,
    records: () => bench.records.values(),
    teamOf: id => (id === world.team.teamId ? world.team : undefined),
    adapters: { provision: provisionAdapter(executions) },
    // The real landing reads, except the lsRemoteHead stub the slot test
    // latches (a change stops after taking the slot), and a merge that
    // merges on GitHub: prMerge succeeds and prView reads MERGED with a
    // merge commit (its tree check then records treeVerified false).
    landingAdapters: {
      ...realLandingAdapters,
      lsRemoteHead: async (cwd: string, ref: string, remote?: string) => {
        if (failLsRemote) return { ok: false as const, error: { argv: ['git', 'ls-remote'], exitCode: 128, stderr: 'stubbed for the hold test' } }
        return realLandingAdapters.lsRemoteHead(cwd, ref, remote)
      },
      prMerge: async (_repo: string, _pr: number, _method: 'merge' | 'squash' | 'rebase', head: string) => {
        mergedHead = head
        return { ok: true as const, data: null }
      },
      prView: async (_repo: string, pr: number) => ({
        ok: true as const,
        data: { number: pr, url: `https://example.internal/pr/${pr}`, state: 'MERGED' as const, headRefOid: mergedHead ?? '', mergeCommit: `merged-${pr}` },
      }),
    },
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
  holds = new HoldService({
    holds: new HoldStore(bench.db.db), plans: bench.plans, planService: bench.service,
    strategies: bench.strategies, impact: new ImpactStore(bench.db.db), decisions: new DecisionStore(bench.db.db),
    executions, wake: id => executor.wake(id), now: () => new Date(),
  })
})
afterEach(() => executor.close())

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

describe('the hold gate at the executor (revision-control 3.2)', () => {
  test("a held change's review handoff waits while its CI runs; the release resumes the same round", async () => {
    const { executionId, planId } = await approvedExecution(['hold-a'])
    await implementStage(executionId, 'hold-a', 'export const a = 1\n')
    const hold = placeHold(planId, 'changes', ['hold-a'], 'hold-review-1')
    await executor.idle()
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()

    // The round exists and its push ran, but no review handoff was sent.
    const held = executions.change(executionId, 'hold-a')!
    const round = executions.rounds(executionId, 'hold-a').at(-1)!
    expect(round.pushedAt).not.toBeNull()
    expect(held.prNumber).toBe(7)
    expect(round.reviewAssignmentId).toBeNull()
    expect(held.step).not.toBe('reviewing')
    expect(tasks.store.assignmentsOf(held.taskId!).length).toBe(1)

    // The release resumes the same round: one review, no new round.
    releaseHold(planId, hold.id)
    await executor.idle()
    const released = executions.change(executionId, 'hold-a')!
    expect(executions.rounds(executionId, 'hold-a').length).toBe(1)
    expect(executions.rounds(executionId, 'hold-a').at(-1)!.reviewAssignmentId).not.toBeNull()
    expect(released.step).toBe('reviewing')
  })

  test('a failed round under a hold records the fix transition and owes its dispatch; the release runs it once', async () => {
    const { executionId, planId } = await approvedExecution(['hold-b'])
    const { row } = await implementStage(executionId, 'hold-b', 'v1')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    // An independent reviewer fails the round; the hold lands before the verdict.
    const round = executions.rounds(executionId, 'hold-b').at(-1)!
    const review = tasks.store.assignmentsOf(row.taskId!).find(entry => entry.id === round.reviewAssignmentId)!
    deliverToReviewer(review.messageId!, 'rev1')
    const hold = placeHold(planId, 'changes', ['hold-b'], 'hold-fix-1')
    await executor.idle()
    await results.submitFindings(bench.agent('rev1'), row.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'fail', findings: 'the change is wrong' })
    executor.wake(world.team.teamId)
    await executor.idle()

    // The decision stands: the round failed, the fix transition recorded, the
    // fix attempt exists — and no handoff went out.
    const held = executions.change(executionId, 'hold-b')!
    // The fix transition stands; a failed implement round does not count
    // toward the fix-round limit, so fixRounds stays 0 (D12's rule).
    expect(held).toMatchObject({ state: 'implementing', fixRounds: 0 })
    const attempts = executions.attempts(executionId, 'hold-b')
    expect(attempts.at(-1)!.kind).toBe('fix')
    expect(tasks.store.assignmentsOf(row.taskId!).length).toBe(2)

    // The release dispatches the owed fix exactly once, naming the finding.
    releaseHold(planId, hold.id)
    await executor.idle()
    const after = tasks.store.assignmentsOf(row.taskId!)
    expect(after.length).toBe(3)
    expect(after.at(-1)!.requestKey.startsWith(`exec:${executionId}:hold-b:attempt:${attempts.at(-1)!.number}:`)).toBe(true)
    expect(after.at(-1)!.instruction).toContain('the change is wrong')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(tasks.store.assignmentsOf(row.taskId!).length).toBe(3)
  })

  test('a hold placed while a dev’s turn runs sends that session no mail', async () => {
    const { executionId, planId } = await approvedExecution(['hold-c'])
    const { row } = await implementStage(executionId, 'hold-c', 'v1')
    const hold = placeHold(planId, 'changes', ['hold-c'], 'hold-mail-1')
    await executor.idle()
    const before = tasks.store.assignmentsOf(row.taskId!).length

    // The dev's revised result and a failing CI under the hold: the round is
    // recorded and the fix decision stands, yet no new instruction is sent.
    const worktree = executions.change(executionId, 'hold-c')!.worktree!
    fs.writeFileSync(path.join(worktree, 'src', 'hold-c.ts'), 'v2\n')
    commitAll(worktree, 'revise')
    await results.submit(bench.agent('dev'), row.taskId!, { summary: 'revised', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    ghStub.pulls = '[]'
    failCi()
    executor.wake(world.team.teamId)
    await executor.idle()

    expect(executions.rounds(executionId, 'hold-c').at(-1)).toMatchObject({ outcome: 'fail' })
    expect(executions.attempts(executionId, 'hold-c').at(-1)!.kind).toBe('fix')
    expect(executions.change(executionId, 'hold-c')!).toMatchObject({ state: 'implementing', fixRounds: 0 })
    expect(tasks.store.assignmentsOf(row.taskId!).length).toBe(before)
    void hold
  })

  test('a hold covering one change leaves an unheld sibling advancing', async () => {
    const { executionId, planId } = await approvedExecution(['hold-d', 'free-d'])
    placeHold(planId, 'changes', ['hold-d'], 'hold-sibling-1')
    executor.wake(world.team.teamId)
    await executor.idle()

    expect(executions.change(executionId, 'hold-d')!.state).toBe('waiting')
    const free = executions.change(executionId, 'free-d')!
    expect(free.state).toBe('implementing')
    expect(free.taskId).not.toBeNull()
  })

  test('a release with nothing owed dispatches nothing', async () => {
    const { executionId, planId } = await approvedExecution(['hold-e'])
    const { row } = await implementStage(executionId, 'hold-e', 'v1')
    const hold = placeHold(planId, 'changes', ['hold-e'], 'hold-idle-1')
    await executor.idle()
    const assignmentsBefore = tasks.store.assignmentsOf(row.taskId!).length
    const attemptsBefore = executions.attempts(executionId, 'hold-e').length

    releaseHold(planId, hold.id)
    await executor.idle()

    expect(tasks.store.assignmentsOf(row.taskId!).length).toBe(assignmentsBefore)
    expect(executions.attempts(executionId, 'hold-e').length).toBe(attemptsBefore)
    // The open round's pipeline advanced under the hold (decisions run); the
    // release dispatched nothing for it.
    expect(executions.change(executionId, 'hold-e')!.state).toBe('gating')
  })

  test("a task revision published under a hold supersedes the round and owes the fix; the release dispatches it once", async () => {
    const { executionId, planId } = await approvedExecution(['hold-rev'])
    const { row } = await implementStage(executionId, 'hold-rev', 'v1')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const assignmentsBefore = tasks.store.assignmentsOf(row.taskId!).length

    // D9's revision fix (revision-control 3.2): the revision is published
    // under the hold — the round is superseded, the change returns to
    // implementing, and the fix attempt exists — the decision runs — but
    // the handoff never goes out.
    const hold = placeHold(planId, 'changes', ['hold-rev'], 'hold-rev-1')
    await executor.idle()
    await tasks.amend(bench.human, row.taskId!, { direction: 'Do it differently now', rationale: 'scope changed' })
    executor.wake(world.team.teamId)
    await executor.idle()

    expect(executions.rounds(executionId, 'hold-rev').at(-1)!.outcome).toBe('superseded')
    expect(executions.attempts(executionId, 'hold-rev').at(-1)!.kind).toBe('fix')
    expect(executions.change(executionId, 'hold-rev')!.state).toBe('implementing')
    expect(tasks.store.assignmentsOf(row.taskId!).length).toBe(assignmentsBefore)

    // The release dispatches the owed fix exactly once, naming the revision.
    releaseHold(planId, hold.id)
    await executor.idle()
    const dispatched = tasks.store.assignmentsOf(row.taskId!)
    expect(dispatched.length).toBe(assignmentsBefore + 1)
    expect(dispatched.at(-1)!.instruction).toContain('revision 2')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(tasks.store.assignmentsOf(row.taskId!).length).toBe(assignmentsBefore + 1)
  })
})

// The hold gate at the landing slot (revision-control 3.3): a held slot
// holder with no live landing effect gives the slot up, a sibling takes
// it and lands, and the release lands the held change after it.
describe('the hold gate at the landing slot (revision-control 3.3)', () => {
  test('a held slot holder gives the slot up and a sibling takes it and lands; the release lands the held change after it', async () => {
    // The execution starts from origin's head after its own push (the
    // approvedExecution default), so the branches contain the base and
    // landing merges instead of updating through gh.
    const { executionId, planId } = await approvedExecution(['hold-slot', 'free-slot'])
    await implementStage(executionId, 'hold-slot', 'a')
    await implementStage(executionId, 'free-slot', 'b')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    // Both reviews pass.
    for (const name of ['hold-slot', 'free-slot']) {
      const row = executions.change(executionId, name)!
      const round = executions.rounds(executionId, name).at(-1)!
      const review = tasks.store.assignmentsOf(row.taskId!).find(entry => entry.id === round.reviewAssignmentId)!
      deliverToReviewer(review.messageId!, 'rev1')
      await results.submitFindings(bench.agent('rev1'), row.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'pass', findings: 'checked' })
    }
    // Both reviews pass; the landing-read latch is armed first, so the
    // wake decides the rounds and leaves hold-slot standing at the slot
    // with no live landing effect while free-slot waits for it.
    failLsRemote = true
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'hold-slot')!).toMatchObject({ state: 'landing', step: 'up-to-date' })
    expect(executions.change(executionId, 'hold-slot')!.passedAt).not.toBeNull()
    expect(executions.slot(world.team.teamId)).toMatchObject({ holderKind: 'change', holderId: `${executionId}:hold-slot` })
    expect(executions.change(executionId, 'free-slot')!.step).toBe('awaiting-slot')

    // The hold gives the slot up; the latch lifts first, so free-slot takes
    // the freed slot and lands.
    failLsRemote = false
    const hold = placeHold(planId, 'changes', ['hold-slot'], 'hold-slot-1')
    await executor.idle()
    const released = executions.change(executionId, 'hold-slot')!
    expect(released).toMatchObject({ state: 'gating', step: null })
    expect(released.passedAt).not.toBeNull()
    expect(executions.rounds(executionId, 'hold-slot').at(-1)!.outcome).toBe('pass')
    expect(executions.change(executionId, 'free-slot')!.state).toBe('landed')
    expect(executions.slot(world.team.teamId)).toBeNull()

    // The release resumes hold-slot at its passed round: it takes the freed
    // slot and lands too.
    releaseHold(planId, hold.id)
    await executor.idle()
    expect(executions.change(executionId, 'hold-slot')!.state).toBe('landed')
  })
})

// The R10 integration test (revision-control 3.4): submission is never
// refused for a hold — the result is kept, its round recorded, CI runs —
// while the review handoff, the slot, and the merge wait; the release
// resumes the same round.
describe('the R10 result under a hold (revision-control 3.4)', () => {
  test('a result arriving under a hold is kept; its CI runs; no review or landing; the release resumes the same round', async () => {
    const { executionId, planId } = await approvedExecution(['hold-r'])
    // The change reaches implementing with no result yet: provision, task, dispatch.
    executor.wake(world.team.teamId)
    await executor.idle()
    const row = executions.change(executionId, 'hold-r')!
    expect(row.state).toBe('implementing')
    const hold = placeHold(planId, 'changes', ['hold-r'], 'hold-r10')
    await executor.idle()

    // The result arrives under the hold and is kept: one round, recorded.
    fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
    fs.writeFileSync(path.join(row.worktree!, 'src', 'hold-r.ts'), 'r\n')
    commitAll(row.worktree!, 'implement hold-r')
    const commit = git(['rev-parse', 'HEAD'], row.worktree!).trim()
    await results.submit(bench.agent('dev'), row.taskId!, { summary: 'done', commit, tests: [{ description: 'unit', outcome: 'pass' }] })

    // Its CI runs under the hold; the review handoff does not, and nothing lands.
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const held = executions.change(executionId, 'hold-r')!
    const rounds = executions.rounds(executionId, 'hold-r')
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.pushedAt).not.toBeNull()
    expect(held.prNumber).toBe(7)
    expect(rounds[0]!.reviewAssignmentId).toBeNull()
    expect(held.state).not.toBe('landing')

    // The release resumes the same round: its review handoff goes out.
    releaseHold(planId, hold.id)
    await executor.idle()
    expect(executions.rounds(executionId, 'hold-r')).toHaveLength(1)
    expect(executions.rounds(executionId, 'hold-r').at(-1)!.reviewAssignmentId).not.toBeNull()
    expect(executions.change(executionId, 'hold-r')!.step).toBe('reviewing')
  })
})
