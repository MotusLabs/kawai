// The plan-execution test matrix's bench (rev 5, B5): the plan bench, the
// team services with the real ownership, the execution store, service, and
// executor, over a bare `origin` the real git adapters push to, fetch from,
// and read. The gh surface is scripted in-process and acts on `origin` the
// way GitHub would: PRs per branch, check runs and statuses per commit, a
// pinned merge under `merge`/`squash`/`rebase` (refused when the head moved),
// and `update-branch` merging the base into the PR branch. Hooks let a test
// move the base or the head at the exact moment a race needs. A settable
// clock drives the CI windows.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { gitFetch, isAncestor, lsRemoteHead, mergeTree, pushToRemote } from '../plans/landing/gitRemote'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import type { MailboxStore } from '../team/mailboxStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ExecutionStore } from '../plans/execution/executionStore'
import { ExecutionRevisionStore } from '../plans/revisionControl/executionRevisionStore'
import { executionOwnership } from '../plans/execution/executionOwnership'
import { ExecutionService } from '../plans/execution/ExecutionService'
import { ExecutionExecutor, type ExecutorDeps } from '../plans/execution/executor'
import { provisionAdapter } from '../plans/execution/executionProvision'
import type { RoundAdapters } from '../plans/execution/executionRounds'
import type { LandingAdapters } from '../plans/execution/executionLanding'
import { PlanService } from '../plans/PlanService'
import { StrategyStore } from '../strategy/strategyStore'
import type { CiCheck, MergeMethod } from '../../shared/planExecution'
import type { PlanCheck } from '../../shared/plans'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'
import { neutralExecutorSeams } from './executorTestSeams'

export const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

export function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
export const commitAll = (cwd: string, message: string): string => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
  return git(['rev-parse', 'HEAD'], cwd).trim()
}

/** A passing floor: the Actions `ci` run and the `e2e` status, both green. */
export const greenChecks = (): CiCheck[] => [
  { name: 'ci', source: 'actions', conclusion: 'success', link: 'https://example.internal/runs/11', runId: 11, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
  { name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
]

interface PullState { number: number; branch: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; mergeCommit: string | null }

/** The scripted GitHub: what each gh call answers, and what it does to origin. */
export interface GhScript {
  /** Check runs and statuses by commit; a missing commit reads the defaults. */
  checks: Map<string, CiCheck[]>
  defaultChecks: CiCheck[]
  pulls: PullState[]
  prCreates: number
  pushes: string[]
  reruns: number[]
  merges: Array<{ pr: number; method: MergeMethod; head: string }>
  updates: Array<{ pr: number; head: string }>
  /** Runs inside the merge call before GitHub merges (a race: move the base or the head). */
  beforeMerge: (() => void | Promise<void>) | null
  /** Replaces update-branch's clean merge (a hand merge, a push), acting on origin; 'conflict' answers GitHub's 422. */
  update: ((branch: string, head: string) => void | 'conflict' | Promise<void | 'conflict'>) | null
}

export interface MatrixWorld { world: PlanWorld; origin: string; gitRoot: string }

export async function createMatrixWorld(prefix: string): Promise<MatrixWorld> {
  const world = await createPlanWorld(prefix)
  writeGroup(world, 'middle-devs', '---\nmax: 4\n---\nBuild.')
  writeGroup(world, 'reviewers', '---\nmax: 4\n---\nReview.')
  const gitRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}git-`)))
  const origin = path.join(gitRoot, 'origin.git')
  git(['init', '-q', '--bare', '-b', 'master', origin], gitRoot)
  fs.writeFileSync(path.join(world.repo, 'seed.txt'), 'seed\n')
  commitAll(world.repo, 'seed')
  git(['remote', 'add', 'origin', origin], world.repo)
  git(['push', '-q', 'origin', 'master'], world.repo)
  return { world, origin, gitRoot }
}

export function removeMatrixWorld(matrix: MatrixWorld): void {
  fs.rmSync(matrix.world.root, { recursive: true, force: true })
  fs.rmSync(matrix.gitRoot, { recursive: true, force: true })
}

/** Work on origin through a throwaway clone (GitHub's side of a race). */
export function onOrigin(matrix: MatrixWorld, work: (clone: string) => void): void {
  const clone = fs.mkdtempSync(path.join(matrix.gitRoot, 'clone-'))
  try {
    git(['clone', '-q', matrix.origin, clone])
    work(clone)
  } finally {
    fs.rmSync(clone, { recursive: true, force: true })
  }
}

/** Push one new commit onto an origin branch (a base that moves, a head moved by a push). */
export function pushCommit(matrix: MatrixWorld, branch: string, file: string, content: string): string {
  let sha = ''
  onOrigin(matrix, clone => {
    git(['checkout', '-q', branch], clone)
    fs.writeFileSync(path.join(clone, file), content)
    sha = commitAll(clone, `commit ${file}`)
    git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], clone)
  })
  return sha
}

export const originHead = (matrix: MatrixWorld, branch: string): string | null => {
  const result = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: matrix.origin, encoding: 'utf8', env: cleanGitEnv() })
  return result.status === 0 ? result.stdout.trim() : null
}

export interface MatrixBench {
  matrix: MatrixWorld
  bench: PlanBench
  mail: MailboxStore
  tasks: TaskService
  assignments: AssignmentService
  results: TaskResultService
  executions: ExecutionStore
  service: ExecutionService
  plansService: PlanService
  executor: ExecutionExecutor
  gh: GhScript
  clock: { now: number }
  conditions: Record<string, string[]>
  /** Build another executor over the same services (a restart, or other seams). */
  makeExecutor: (overrides?: Partial<ExecutorDeps>) => ExecutionExecutor
  tick: (executor?: ExecutionExecutor) => Promise<void>
  /** The scripted GitHub as adapters, for benches that compose more than the executor (promotions). */
  roundAdapters: RoundAdapters
  landingAdapters: LandingAdapters
}

export function createMatrixBench(matrix: MatrixWorld): MatrixBench {
  const { world } = matrix
  const bench = createPlanBench(world)
  bench.records.set('rev1', { sessionId: 'rev1', groupId: 'reviewers', projectPath: world.feature, name: 'rev1', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' })
  bench.records.set('dev', { ...bench.records.get('dev')!, claudeProfileId: 'glm' })
  const mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  const executions = new ExecutionStore(bench.db.db)
  const ownership = executionOwnership(executions, { isAncestor, lsRemoteHead }, () => null)
  const tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans, ownership })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => (bench.records.get(id)?.projectPath === world.other ? undefined : world.team)
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership,
  })
  const results = new TaskResultService(tasks, { getSession: id => bench.records.get(id), assignments, ownership })
  const plansService = new PlanService(bench.plans, {
    getSession: () => null, strategies: new StrategyStore(bench.db.db), executionOf: id => executions.execution(id),
  })
  const clock = { now: Date.parse('2026-10-17T00:00:00.000Z') }
  const gh: GhScript = {
    checks: new Map(), defaultChecks: greenChecks(), pulls: [], prCreates: 0, pushes: [], reruns: [], merges: [], updates: [],
    beforeMerge: null, update: null,
  }
  const conditions: Record<string, string[]> = {}
  const pullOf = (pr: number) => gh.pulls.find(pull => pull.number === pr)
  const fail = (args: string[], message: string, httpStatus: number | null = 422) => ({ ok: false as const, error: { argv: ['gh', ...args], exitCode: 1, httpStatus, message } })

  const roundAdapters: RoundAdapters = {
    lsRemoteHead,
    push: async (cwd, source, branch) => { gh.pushes.push(`${branch}@${source}`); return pushToRemote(cwd, source, branch) },
    checkRuns: async (_repo, sha) => ({ ok: true, data: (gh.checks.get(sha) ?? gh.defaultChecks).filter(check => check.source === 'actions') }),
    statuses: async (_repo, sha) => ({ ok: true, data: (gh.checks.get(sha) ?? gh.defaultChecks).filter(check => check.source !== 'actions') }),
    prList: async (_repo, input) => ({
      ok: true,
      data: gh.pulls.filter(pull => pull.branch === input.head).map(pull => ({ number: pull.number, url: `https://example.internal/pr/${pull.number}`, state: pull.state, headRefOid: originHead(matrix, pull.branch) ?? '' })),
    }),
    prCreate: async (_repo, input) => {
      gh.prCreates += 1
      const number = 100 + gh.pulls.length
      gh.pulls.push({ number, branch: input.head, state: 'OPEN', mergeCommit: null })
      return { ok: true, data: { number, url: `https://example.internal/pr/${number}` } }
    },
    rerun: async (_repo, runId) => { gh.reruns.push(runId); return { ok: true, data: null } },
  }

  const landingAdapters: LandingAdapters = {
    fetch: gitFetch, isAncestor, mergeTree, lsRemoteHead,
    prView: async (_repo, pr) => {
      const pull = pullOf(pr)
      if (pull === undefined) return fail(['pr', 'view'], 'no such pull request', 404)
      return { ok: true, data: { number: pr, url: `https://example.internal/pr/${pr}`, state: pull.state, headRefOid: originHead(matrix, pull.branch) ?? '', mergeCommit: pull.mergeCommit } }
    },
    updateBranch: async (_repo, pr, expectedHead) => {
      const pull = pullOf(pr)
      if (pull === undefined) return fail(['api', 'update-branch'], 'no such pull request', 404)
      if (originHead(matrix, pull.branch) !== expectedHead) return fail(['api', 'update-branch'], 'expected head sha didn\'t match current head ref.')
      gh.updates.push({ pr, head: expectedHead })
      if (gh.update !== null) {
        if (await gh.update(pull.branch, expectedHead) === 'conflict') return fail(['api', 'update-branch'], 'merge conflict between base and head')
        return { ok: true, data: null }
      }
      onOrigin(matrix, clone => {
        git(['checkout', '-q', pull.branch], clone)
        git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'merge', '-q', '--no-ff', '-m', 'Merge base into branch', 'origin/master'], clone)
        git(['push', '-q', 'origin', `HEAD:refs/heads/${pull.branch}`], clone)
      })
      return { ok: true, data: null }
    },
    prMerge: async (_repo, pr, method, head) => {
      const pull = pullOf(pr)
      if (pull === undefined) return fail(['pr', 'merge'], 'no such pull request', 404)
      await gh.beforeMerge?.()
      if (originHead(matrix, pull.branch) !== head) return fail(['pr', 'merge'], 'Head branch was modified. Review and try the merge again.')
      gh.merges.push({ pr, method, head })
      onOrigin(matrix, clone => {
        const who = ['-c', 'user.email=gh@e', '-c', 'user.name=GitHub']
        git(['checkout', '-q', 'master'], clone)
        if (method === 'merge') git([...who, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr}`, head], clone)
        if (method === 'squash') {
          git([...who, 'merge', '-q', '--squash', head], clone)
          git([...who, 'commit', '-q', '-m', `Squash #${pr}`], clone)
        }
        if (method === 'rebase') {
          git(['checkout', '-q', '-b', 'rebased', head], clone)
          git([...who, 'rebase', '-q', '--force-rebase', 'master'], clone)
          git(['checkout', '-q', 'master'], clone)
          git(['merge', '-q', '--ff-only', 'rebased'], clone)
        }
        git(['push', '-q', 'origin', 'master'], clone)
      })
      pull.state = 'MERGED'
      pull.mergeCommit = originHead(matrix, 'master')
      return { ok: true, data: null }
    },
  }

  const service = new ExecutionService({
    store: executions, plansStore: bench.plans, plans: bench.service,
    validation: { prepareStanding: async () => ({}), standing: () => null },
    impact: { gate: () => null },
    settings: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    getSession: () => null,
    landingModes: () => new Set(['direct']),
    promotions: { runningPromotion: () => null },
    identityOf: () => world.team,
    executionRevisions: new ExecutionRevisionStore(bench.db.db),
    tasks,
  })
  const makeExecutor = (overrides: Partial<ExecutorDeps> = {}) => new ExecutionExecutor({
    ...neutralExecutorSeams,
    store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail, plansService,
    records: () => bench.records.values(),
    teamOf: id => (id === world.team.teamId ? world.team : undefined),
    adapters: { provision: provisionAdapter(executions) },
    conditionsOf: executionId => conditions[executionId] ?? [],
    roundAdapters, landingAdapters,
    now: () => new Date(clock.now),
    ...overrides,
  })
  const executor = makeExecutor()
  const tick = async (target: ExecutionExecutor = executor) => {
    target.wake(world.team.teamId)
    await target.idle()
  }
  return { matrix, bench, mail, tasks, assignments, results, executions, service, plansService, executor, gh, clock, conditions, makeExecutor, tick, roundAdapters, landingAdapters }
}

/** One approved plan of the given changes and its running execution (not yet ticked). */
export async function startedExecution(h: MatrixBench, changes: Array<{ change: string; dependsOn?: string[]; acceptance?: string[]; extraChecks?: PlanCheck[]; reviewGroup?: string }>, options: { mergeMethod?: MergeMethod; maxParallel?: number; acceptanceRules?: string[]; extraChecks?: PlanCheck[]; roles?: Array<{ group: string; profiles: string[] }>; reviewGroup?: string } = {}): Promise<string> {
  const { world } = h.matrix
  // Earlier tests may have moved origin's base: catch up first.
  git(['pull', '-q', '--ff-only', 'origin', 'master'], world.repo)
  for (const { change } of changes) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(world.repo, `changes ${changes.map(entry => entry.change).join(' ')}`)
  git(['push', '-q', 'origin', 'master'], world.repo)
  const { planId, revision, hash } = await h.bench.draftInReview({
    changes: changes.map(entry => ({ change: entry.change, dependsOn: entry.dependsOn ?? [], group: 'middle-devs', acceptance: entry.acceptance ?? [], extraChecks: entry.extraChecks ?? [], guidance: '', ...(entry.reviewGroup ? { reviewGroup: entry.reviewGroup } : {}) })),
    reviewGroup: options.reviewGroup ?? 'reviewers',
    ...(options.acceptanceRules ? { acceptanceRules: options.acceptanceRules } : {}),
    ...(options.extraChecks ? { extraChecks: options.extraChecks } : {}),
    ...(options.roles ? { roles: options.roles } : {}),
  })
  await h.bench.approve(planId, revision)
  return h.executions.insertExecution({
    teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: originHead(h.matrix, 'master')!, floor: { version: 1, map: FLOOR },
    maxParallel: options.maxParallel ?? 2, mergeMethod: options.mergeMethod ?? 'merge',
    changes: changes.map(entry => ({ change: entry.change, landed: false })),
  }).id
}

/** The implementer commits one file in the change's worktree and submits it (pushing first when asked). */
export async function submitWork(h: MatrixBench, executionId: string, change: string, file: string, content: string, options: { push?: boolean; by?: string } = {}): Promise<string> {
  const row = h.executions.change(executionId, change)!
  fs.mkdirSync(path.dirname(path.join(row.worktree!, file)), { recursive: true })
  fs.writeFileSync(path.join(row.worktree!, file), content)
  const commit = commitAll(row.worktree!, `${change}: ${file}`)
  if (options.push === true) git(['push', '-q', 'origin', `HEAD:refs/heads/${row.branch!}`], row.worktree!)
  await h.results.submit(h.bench.agent(options.by ?? 'dev'), row.taskId!, { summary: 'done', commit, tests: [{ description: 'unit', outcome: 'pass' }] })
  return commit
}

/** The review assignment of the change's newest round, delivered to `reviewer` who rules on it. */
export async function review(h: MatrixBench, executionId: string, change: string, verdict: 'pass' | 'fail', reviewer = 'rev1', findings = 'checked'): Promise<void> {
  const row = h.executions.change(executionId, change)!
  const round = h.executions.rounds(executionId, change).at(-1)!
  const assignment = h.tasks.store.assignmentsOf(row.taskId!).find(entry => entry.id === round.reviewAssignmentId)!
  h.mail.claim(assignment.messageId!, reviewer)
  h.mail.markPushed(assignment.messageId!)
  h.mail.markDelivered(assignment.messageId!)
  await h.results.submitFindings(h.bench.agent(reviewer), row.taskId!, { resultId: round.resultId, kind: 'review', verdict, findings })
}

/** Provision, implement, push, CI, review pass — the change waits passed in gating. */
export async function passedChange(h: MatrixBench, executionId: string, change: string, file = `src/${change}.ts`): Promise<string> {
  await h.tick()
  const commit = await submitWork(h, executionId, change, file, `export const ${change.replace(/\W/g, '_')} = 1\n`)
  await h.tick()
  await review(h, executionId, change, 'pass')
  return commit
}
