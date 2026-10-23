// The shared fixture behind the two round-pipeline integration files
// (plan-execution §12): the plan bench over a bare origin and a scripted gh,
// the services and executor the tests drive, and the helpers they share.
// Each test file registers the four hooks around these functions itself —
// bun runs test files with per-file isolation, so both files build their
// own world.
import { expect } from 'bun:test'
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

export let world: PlanWorld
export let bench: PlanBench
export let mail: MailboxStore
export let tasks: TaskService
export let assignments: AssignmentService
export let results: TaskResultService
export let executions: ExecutionStore
export let executor: ExecutionExecutor
export let origin: string
export let ghStub: { checkRuns: string; statuses: string; pulls: string; created: string; reruns: number[] }
let gitRoot: string
let baseSha: string

export function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
export const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

export async function approvedExecution(change: string): Promise<string> {
  fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
  fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  commitAll(world.repo, 'change')
  git(['push', '-q', 'origin', 'master'], world.repo)
  const { planId, revision, hash } = await bench.draftInReview({
    changes: [{ change, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' }],
    // The plan's review group; the fixture role narrows middle-devs to default.
    reviewGroup: 'reviewers',
  })
  await bench.approve(planId, revision)
  return executions.insertExecution({
    teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: baseSha, floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    maxParallel: 1, mergeMethod: 'merge', changes: [{ change, landed: false }],
  }).id
}

/** The whole implement stage: provision, task, dispatch — returns the change row and worktree. */
export async function implementStage(executionId: string, change: string, edit: string): Promise<{ row: ReturnType<ExecutionStore['change']>; commit: string }> {
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

export const deliverToReviewer = (messageId: string, sessionId: string) => {
  mail.claim(messageId, sessionId)
  mail.markPushed(messageId)
  mail.markDelivered(messageId)
}

/** The world and bare origin both files' tests run over (each file's beforeAll). */
export async function setupWorld() {
  world = await createPlanWorld('kawai-rounds-')
  writeGroup(world, 'middle-devs', '---\nmax: 2\n---\nBuild.')
  writeGroup(world, 'reviewers', '---\nmax: 2\n---\nReview.')
  gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-rounds-git-'))
  origin = path.join(gitRoot, 'origin.git')
  git(['init', '-q', '--bare', '-b', 'master', origin], gitRoot)
  fs.writeFileSync(path.join(world.repo, 'seed.txt'), 'seed\n')
  commitAll(world.repo, 'seed')
  git(['remote', 'add', 'origin', origin], world.repo)
  git(['push', '-q', 'origin', 'master'], world.repo)
  baseSha = git(['rev-parse', 'master'], origin).trim()
}
export function teardownWorld() {
  fs.rmSync(world.root, { recursive: true, force: true })
  fs.rmSync(gitRoot, { recursive: true, force: true })
}

/** The stub round adapters, reading the live ghStub object. */
export const stubRoundAdapters = () => ({
  lsRemoteHead: async () => ({ ok: true as const, sha: null as string | null }),
  push: async (cwd: string, source: string, branch: string) => {
    const result = spawnSync('git', ['push', 'origin', `${source}:refs/heads/${branch}`], { cwd, encoding: 'utf8', env: cleanGitEnv() })
    return result.status === 0 ? { ok: true as const } : { ok: false as const, error: { argv: ['git', 'push'], exitCode: result.status, stderr: result.stderr } }
  },
  checkRuns: async () => ({ ok: true as const, data: JSON.parse(ghStub.checkRuns) }),
  statuses: async () => ({ ok: true as const, data: JSON.parse(ghStub.statuses) }),
  prList: async () => ({ ok: true as const, data: JSON.parse(ghStub.pulls) }),
  prCreate: async () => ({ ok: true as const, data: JSON.parse(ghStub.created) }),
  rerun: async (_repo: string, runId: number) => { ghStub.reruns.push(runId); return { ok: true as const, data: null } },
})

/** The bench, services, and executor every test starts from (each file's beforeEach). */
export function setupBench() {
  bench?.db.close()
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
export function closeExecutor() {
  executor.close()
}

export const passCi = () => {
  ghStub.checkRuns = JSON.stringify([
    { id: 't', name: 'ci', source: 'actions', conclusion: 'success', link: 'https://example.internal/runs/11/at', runId: 11, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
    { id: 'e', name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
  ])
}
