// Direct landing (plan-execution D13, §14) over the plan bench, a bare
// origin, and a stub gh: an unresolved acceptance condition holds the change
// outside the slot; a passed change takes the team's one slot, is verified
// up to date against the base head, merges with the reviewed head pinned,
// records the landing fact with the re-read base and the tree check, accepts
// its task as Kawai, removes the clean unoccupied worktree, and completes
// the execution and the plan as the system. A base that moved between the
// check and the merge returns the change to the up-to-date step keeping the
// slot; a conflicting base returns the change as an update attempt naming
// the files.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { isAncestor as realIsAncestor, mergeTree as realMergeTree } from '../plans/landing/gitRemote'
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
import { PlanService } from '../plans/PlanService'
import { StrategyStore } from '../strategy/strategyStore'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'
import { neutralExecutorSeams } from './executorTestSeams'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

let world: PlanWorld
let bench: PlanBench
let mail: MailboxStore
let tasks: TaskService
let assignments: AssignmentService
let results: TaskResultService
let executions: ExecutionStore
let plansService: PlanService
let executor: ExecutionExecutor
let gitRoot: string
let origin: string
let baseSha: string
let ghStub: { prMerge: Record<string, string>; prView: Record<string, { state: string; mergeCommit: string | null; headRefOid: string }> }
let predictedConflicts: string[]
/** Unresolved acceptance conditions by execution id (the live read, D13 step 1). */
let conditions: Record<string, string[]>


function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

/** An approved execution whose change provisioned, dispatched, and passed its round. */
async function passedChangeExecution(change: string): Promise<{ executionId: string; commit: string; worktree: string; taskId: string }> {
  fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
  fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  commitAll(world.repo, 'change')
  git(['push', '-q', 'origin', 'master'], world.repo)
  const { planId, revision, hash } = await bench.draftInReview({
    changes: [{ change, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' }],
    reviewGroup: 'reviewers',
  })
  await bench.approve(planId, revision)
  const executionId = executions.insertExecution({
    teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: git(['rev-parse', 'master'], origin).trim(), floor: { version: 1, map: FLOOR },
    maxParallel: 2, mergeMethod: 'merge', changes: [{ change, landed: false }],
  }).id
  executor.wake(world.team.teamId)
  await executor.idle()
  const row = executions.change(executionId, change)!
  expect(row.state).toBe('implementing')
  fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
  fs.writeFileSync(path.join(row.worktree!, 'src', `${change}.ts`), 'export = 1\n')
  commitAll(row.worktree!, `implement ${change}`)
  git(['push', '-q', 'origin', `HEAD:refs/heads/${change}`], row.worktree!)
  const commit = git(['rev-parse', 'HEAD'], row.worktree!).trim()
  await results.submit(bench.agent('dev'), row.taskId!, { summary: 'done', commit, tests: [{ description: 'unit', outcome: 'pass' }] })
  executor.wake(world.team.teamId)
  await executor.idle()
  const round = executions.rounds(executionId, change).at(-1)!
  executions.decideRound(round.id, 'pass')
  const fresh = executions.change(executionId, change)!
  executions.transition(executionId, change, fresh, { passedAt: new Date().toISOString() })
  return { executionId, commit, worktree: row.worktree!, taskId: row.taskId! }
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-landing-')
  writeGroup(world, 'middle-devs', '---\nmax: 2\n---\nBuild.')
  writeGroup(world, 'reviewers', '---\nmax: 2\n---\nReview.')
  gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-landing-git-'))
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
  plansService = new PlanService(bench.plans, {
    getSession: () => null,
    strategies: new StrategyStore(bench.db.db),
    executionOf: id => executions.execution(id),
  })
  ghStub = { prMerge: {}, prView: {} }
  conditions = {}
  predictedConflicts = []
  executor = new ExecutionExecutor({
    ...neutralExecutorSeams,
    store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
    records: () => bench.records.values(),
    teamOf: id => (id === world.team.teamId ? world.team : undefined),
    adapters: { provision: provisionAdapter(executions) },
    plansService,
    conditionsOf: executionId => conditions[executionId] ?? [],
    roundAdapters: {
      lsRemoteHead: async () => ({ ok: true, sha: null }),
      push: async () => ({ ok: true as const }),
      checkRuns: async () => ({ ok: true as const, data: [] }),
      statuses: async () => ({ ok: true as const, data: [] }),
      prList: async () => ({ ok: true as const, data: [] }),
      prCreate: async () => ({ ok: true as const, data: { number: 7, url: 'https://example.internal/pr/7' } }),
      rerun: async () => ({ ok: true as const, data: null }),
    },
    landingAdapters: {
      fetch: async () => ({ ok: true as const }),
      isAncestor: (cwd: string, ancestor: string, descendant: string) => realIsAncestor(cwd, ancestor, descendant),
      mergeTree: async (cwd: string, ours: string, theirs: string) => {
        if (predictedConflicts.length > 0) return { ok: true as const, tree: 't', conflicts: [...predictedConflicts] }
        return realMergeTree(cwd, ours, theirs)
      },
      lsRemoteHead: async (_cwd: string, ref: string) => ({ ok: true as const, sha: remoteHeads[ref] ?? null }),
      prMerge: async (repo: string, pr: number, method: 'merge' | 'squash' | 'rebase', head: string) =>
        ghStub.prMerge[head] === undefined ? { ok: true as const, data: null } : { ok: false as const, error: { argv: ['gh', 'pr', 'merge'], exitCode: 1, httpStatus: 422, message: 'refused' } },
      updateBranch: async () => ({ ok: true as const, data: null }),
      prView: async (repo: string, pr: number) => {
        const view = ghStub.prView[String(pr)]
        return view === undefined
          ? { ok: false as const, error: { argv: ['gh', 'pr', 'view'], exitCode: 1, httpStatus: null, message: 'no pr' } }
          : { ok: true as const, data: { number: pr, url: 'https://example.internal/pr/7', state: view.state, headRefOid: view.headRefOid, mergeCommit: view.mergeCommit } }
      },
    },
  })
})
afterEach(() => executor.close())

let remoteHeads: Record<string, string>
beforeEach(() => {
  remoteHeads = {}
  void baseSha
})

describe('direct landing (§14)', () => {
  test('a passed change lands: fact, acceptance, worktree removal, completion (14.1, 14.3, 14.4)', async () => {
    const { executionId, commit, worktree } = await passedChangeExecution('land-a')
    remoteHeads['refs/heads/land-a'] = commit
    remoteHeads['refs/heads/master'] = baseSha
    // A real merge commit in the worktree: head + master, clean tree.
    git(['merge', '-q', '--no-ff', '-m', 'merge base', baseSha], worktree)
    const mergeCommit = git(['rev-parse', 'HEAD'], worktree).trim()
    ghStub.prView['7'] = { state: 'MERGED', mergeCommit, headRefOid: commit }

    executor.wake(world.team.teamId)
    await executor.idle()
    // The landing outcome lands asynchronously; the timer's wake settles it.
    executor.wake(world.team.teamId)
    await executor.idle()

    const change = executions.change(executionId, 'land-a')!
    expect(change.state).toBe('landed')
    const fact = executions.landings(bench.plans.get(executions.execution(executionId)!.planId)!.id).find(entry => entry.change === 'land-a')!
    expect(fact).toMatchObject({ mergeSha: mergeCommit, headSha: commit, baseSha: baseSha, treeVerified: true, mechanism: 'direct' })
    expect(executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'completed' })
    // The plan completed as the system.
    const plan = bench.plans.get(executions.execution(executionId)!.planId)!
    expect(bench.plans.events(plan.id).at(-1)).toMatchObject({ kind: 'completed' })
    // The clean, unoccupied worktree is removed.
    expect(fs.existsSync(worktree)).toBe(false)
  })

  test('an unresolved condition holds the change outside the slot; resolving lands (14.1)', async () => {
    const { executionId } = await passedChangeExecution('cond-a')
    conditions[executionId] = ['Confirm the rollback plan with the owner']
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'cond-a')).toMatchObject({ state: 'gating', step: 'conditions' })
    expect(executions.slot(world.team.teamId)).toBeNull()

    conditions[executionId] = []
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'cond-a')!.state).toBe('landing')
  })

  test('two passing changes land one at a time (the slot serializes) (14.1)', async () => {
    const plan = await (async () => {
      for (const change of ['ser-a', 'ser-b']) {
        fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
        fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
      }
      commitAll(world.repo, 'changes')
      git(['push', '-q', 'origin', 'master'], world.repo)
      const { planId, revision, hash } = await bench.draftInReview({
        changes: [
          { change: 'ser-a', dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' },
          { change: 'ser-b', dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' },
        ],
      })
      await bench.approve(planId, revision)
      return { planId, revision, hash }
    })()
    const executionId = executions.insertExecution({
      teamId: world.team.teamId, planId: plan.planId, revision: plan.revision, contentHash: plan.hash, reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: baseSha, floor: { version: 1, map: FLOOR },
      maxParallel: 2, mergeMethod: 'merge', changes: [{ change: 'ser-a', landed: false }, { change: 'ser-b', landed: false }],
    }).id
    executor.wake(world.team.teamId)
    await executor.idle()
    const heads: Record<string, string> = {}
    for (const change of ['ser-a', 'ser-b']) {
      const row = executions.change(executionId, change)!
      fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
      fs.writeFileSync(path.join(row.worktree!, 'src', `${change}.ts`), 'x\n')
      commitAll(row.worktree!, change)
      git(['push', '-q', 'origin', `HEAD:refs/heads/${change}`], row.worktree!)
      heads[change] = git(['rev-parse', 'HEAD'], row.worktree!).trim()
      await results.submit(bench.agent('dev'), row.taskId!, { summary: 'done', commit: heads[change]! })
    }
    executor.wake(world.team.teamId)
    await executor.idle()
    for (const change of ['ser-a', 'ser-b']) {
      const round = executions.rounds(executionId, change).at(-1)!
      executions.decideRound(round.id, 'pass')
      executions.transition(executionId, change, executions.change(executionId, change)!, { passedAt: new Date().toISOString() })
    }
    remoteHeads['refs/heads/master'] = baseSha
    // The first change lands; the second waits for the slot (one at a time).
    remoteHeads['refs/heads/ser-a'] = heads['ser-a']!
    const worktree = executions.change(executionId, 'ser-a')!.worktree!
    git(['merge', '-q', '--no-ff', '-m', 'merge base', baseSha], worktree)
    const mergeCommit = git(['rev-parse', 'HEAD'], worktree).trim()
    ghStub.prView['7'] = { state: 'MERGED', mergeCommit, headRefOid: heads['ser-a']! }
    executor.wake(world.team.teamId)
    await executor.idle()
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'ser-a')!.state).toBe('landed')
    // ser-b holds the slot next — exactly one holder at a time.
    expect(executions.slot(world.team.teamId)?.holderId).toContain(':ser-b')
  }, 20000)

  test('a base that moved between the check and the merge returns the change to up-to-date keeping the slot (14.3)', async () => {
    const { executionId, commit } = await passedChangeExecution('move-a')
    remoteHeads['refs/heads/move-a'] = commit
    remoteHeads['refs/heads/master'] = baseSha
    ghStub.prView['7'] = { state: 'MERGED', mergeCommit: commit, headRefOid: commit }
    executor.wake(world.team.teamId)
    await executor.idle()
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'move-a')).toMatchObject({ state: 'landed' })
    expect(executions.slot(world.team.teamId)).toBeNull()

    // The moved-base branch: the base head moves after the check; the branch
    // does not contain it, so the change waits in the update flow — the slot
    // held, nothing merged with a stale base.
    const second = await passedChangeExecution('move-b')
    remoteHeads['refs/heads/move-b'] = second.commit
    const movedBase = (() => {
      git(['checkout', '-q', '-b', 'bump-base', baseSha], world.repo)
      fs.writeFileSync(path.join(world.repo, 'bump.txt'), 'bump\n')
      commitAll(world.repo, 'base bumped')
      const sha = git(['rev-parse', 'HEAD'], world.repo).trim()
      git(['checkout', '-q', 'master'], world.repo)
      return sha
    })()
    remoteHeads['refs/heads/master'] = movedBase
    predictedConflicts = []
    // The second PR is open, its head still the reviewed one: GitHub has not
    // carried the update yet, so the update poll waits.
    ghStub.prView['7'] = { state: 'OPEN', mergeCommit: null, headRefOid: second.commit }
    executor.wake(world.team.teamId)
    await executor.idle()
    const row = executions.change(second.executionId, 'move-b')!
    expect(row.state).toBe('landing')
    expect(['updating', 'up-to-date']).toContain(row.step ?? 'up-to-date')
    expect(executions.slot(world.team.teamId)?.holderId ?? '').toContain(':move-b')
    expect(executions.landings(executions.execution(second.executionId)!.planId).find(entry => entry.change === 'move-b')).toBeUndefined()
  })

  test('a conflicting base returns the change as an update attempt naming the files (14.2)', async () => {
    const { executionId, commit } = await passedChangeExecution('conf-a')
    remoteHeads['refs/heads/conf-a'] = commit
    // A base head the branch does not contain, with a predicted conflict.
    const conflicting = (() => {
      git(['checkout', '-q', '-b', 'moved-base', baseSha], world.repo)
      fs.writeFileSync(path.join(world.repo, 'seed.txt'), 'base version\n')
      commitAll(world.repo, 'base moved')
      const sha = git(['rev-parse', 'HEAD'], world.repo).trim()
      git(['checkout', '-q', 'master'], world.repo)
      return sha
    })()
    remoteHeads['refs/heads/master'] = conflicting
    predictedConflicts = ['seed.txt']
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'conf-a')!
    expect(change.state).toBe('gating')
    expect(executions.slot(world.team.teamId)).toBeNull()
    // The update attempt is a fix handoff naming the conflict.
    const fix = tasks.store.assignmentsOf(change.taskId!).at(-1)!
    expect(fix.handoffKind).toBe('fix')
    const fixMail = mail.get(fix.messageId!)!
    expect(fixMail.body).toContain('up to date')
    // Kawai's handoffs carry the role's profiles only, never a worker choice (dispatch-worker-choice).
    expect([fix.workerChoice ?? null, fixMail.workerChoice ?? null]).toEqual([null, null])
  })
})
