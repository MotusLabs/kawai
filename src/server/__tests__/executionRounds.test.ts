// The round pipeline end to end (plan-execution §12, D9-D11) over the plan
// bench, a bare origin, and a stub gh: a submitted result becomes the
// change's round, its commit is pushed for real and given the change's one
// pull request, a passing CI releases nothing (unscoped reviewers) and
// dispatches the review handoff with the role's profiles and author tags,
// and an independent claimant's pass decides the round. A newer result
// supersedes the open round; a closed pull request stops as pr-closed; a
// failing CI asks for the round's one rerun; an author claiming the review
// stops it as review-unavailable.
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
let ghEnv: Record<string, string>
let ghStub: { checkRuns: string; statuses: string; pulls: string; created: string; reruns: number[] }

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

async function approvedExecution(change: string): Promise<string> {
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
async function implementStage(executionId: string, change: string, edit: string): Promise<{ row: ReturnType<ExecutionStore['change']>; commit: string }> {
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

beforeAll(async () => {
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
})
afterAll(() => {
  fs.rmSync(world.root, { recursive: true, force: true })
  fs.rmSync(gitRoot, { recursive: true, force: true })
})

/** The stub round adapters, reading the live ghStub object. */
const stubRoundAdapters = () => ({
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

beforeEach(() => {
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
  // The stub gh: scripted per test through the ghStub object.
  ghStub = { checkRuns: '[]', statuses: '[]', pulls: '[]', created: '{"number":7,"url":"https://example.internal/pr/7"}', reruns: [] }
  const bin = path.join(gitRoot, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"check-runs"*) printf '%s' "$GH_CHECK_RUNS" ;;
  *"commits/"*"status"*) printf '%s' "$GH_STATUSES" ;;
  *"pr list"*) printf '%s' "$GH_PULLS" ;;
  *"pr create"*) printf '%s' "$GH_PR_CREATE" ;;
  *"run rerun"*) echo "$*" >> "$GH_RERUN_LOG"; exit 0 ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  ghEnv = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    GH_CHECK_RUNS: '[]', GH_STATUSES: '[]', GH_PULLS: '[]',
    GH_PR_CREATE: ghStub.created, GH_RERUN_LOG: path.join(gitRoot, 'rerun.log'),
  }
  fs.writeFileSync(path.join(gitRoot, 'rerun.log'), '')
  executor = new ExecutionExecutor({
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
})
afterEach(() => executor.close())

const passCi = () => {
  ghStub.checkRuns = JSON.stringify([
    { id: 't', name: 'ci', source: 'actions', conclusion: 'success', link: 'https://example.internal/runs/11/at', runId: 11, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
    { id: 'e', name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
  ])
}

describe('the round pipeline (§12)', () => {
  test('a result becomes a decided round: push, PR, CI, review, independent pass', async () => {
    const executionId = await approvedExecution('flow-a')
    const { row, commit } = await implementStage(executionId, 'flow-a', 'export const a = 1\n')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()

    const change = executions.change(executionId, 'flow-a')!
    // The push landed on origin for real; the PR was created via the stub.
    expect(git(['rev-parse', `refs/heads/flow-a`], origin).trim()).toBe(commit)
    expect(change).toMatchObject({ prNumber: 7, prUrl: 'https://example.internal/pr/7', prOpenedByKawai: true, state: 'gating', step: 'reviewing' })
    const round = executions.rounds(executionId, 'flow-a').at(-1)!
    expect(round).toMatchObject({ number: 1, commitSha: commit, fixRound: false, pushedAt: expect.any(String) })
    expect(round.reviewAssignmentId).not.toBeNull()

    // An independent reviewer claims and passes it.
    const assignment = tasks.store.assignmentsOf(change.taskId!).find(a => a.id === round.reviewAssignmentId)!
    deliverToReviewer(assignment.messageId!, 'rev1')
    await results.submitFindings(bench.agent('rev1'), change.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'pass', findings: 'clean' })
    executor.wake(world.team.teamId)
    await executor.idle()

    const decided = executions.rounds(executionId, 'flow-a').at(-1)!
    expect(decided).toMatchObject({ outcome: 'pass', verdictFindingsId: expect.any(String), decidedAt: expect.any(String) })
    expect(executions.change(executionId, 'flow-a')!.passedAt).not.toBeNull()
    // The review mail carried the author's profile tag and no role narrowing (reviewers has no role entry).
    const reviewMail = mail.get(assignment.messageId!)!
    expect(reviewMail.tags).toContain('author-profile:glm')
    expect(reviewMail.allowedProfiles).toBeNull()
  })

  test('a newer result supersedes the open round; a merge started holds it', async () => {
    const executionId = await approvedExecution('flow-b')
    await implementStage(executionId, 'flow-b', 'v1')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'flow-b')!
    expect(change.state).toBe('gating')

    // A second result on the same attempt supersedes round 1 (back to gating, round 2).
    const worktree = change.worktree!
    fs.writeFileSync(path.join(worktree, 'src', 'flow-b.ts'), 'export const b = 2\n')
    commitAll(worktree, 'revise')
    await results.submit(bench.agent('dev'), change.taskId!, { summary: 'revised', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    executor.wake(world.team.teamId)
    await executor.idle()
    const rounds = executions.rounds(executionId, 'flow-b')
    expect(rounds.map(round => [round.number, round.outcome])).toEqual([[1, 'superseded'], [2, null]])

    // A landing change (its merge started) takes no new round.
    const row = executions.change(executionId, 'flow-b')!
    for (const state of ['provisioning', 'implementing', 'gating', 'landing'] as const) {
      const current = executions.change(executionId, 'flow-b')!
      executions.transition(executionId, 'flow-b', current, { state })
    }
    await results.submit(bench.agent('dev'), row.taskId!, { summary: 'during merge', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.rounds(executionId, 'flow-b')).toHaveLength(2)
  })

  test('a failing rerunnable CI asks for the one rerun; a closed PR stops as pr-closed', async () => {
    const executionId = await approvedExecution('flow-c')
    await implementStage(executionId, 'flow-c', 'x')
    ghStub.pulls = '[]'
    ghStub.checkRuns = JSON.stringify([
      { id: 't', name: 'ci', source: 'actions', conclusion: 'failure', link: 'https://example.internal/runs/21/at', runId: 21, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
      { id: 'e', name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
    ])
    executor.wake(world.team.teamId)
    await executor.idle()
    // The rerun effect ran through the stub adapter: the round's one rerun
    // (round 2 below earns its own — D10's rerun is per round).
    expect(ghStub.reruns).toEqual([21, 21])
    const rerunEffect = executions.effectsOf(executionId).find(effect => effect.kind === 'rerun')!
    expect(rerunEffect.state).toBe('done')

    // A closed pull request on the next round stops the change.
    ghStub.pulls = JSON.stringify([{ number: 3, url: 'https://example.internal/pr/3', state: 'CLOSED', headRefOid: 'x' }])
    const change = executions.change(executionId, 'flow-c')!
    const worktree = change.worktree!
    fs.writeFileSync(path.join(worktree, 'src', 'flow-c.ts'), 'y')
    commitAll(worktree, 'again')
    await results.submit(bench.agent('dev'), change.taskId!, { summary: 'fixed', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'flow-c')).toMatchObject({ state: 'stopped', stopReason: 'pr-closed' })
  })

  test('a failed review returns the change for a fix attempt naming what it answers', async () => {
    const executionId = await approvedExecution('fix-a')
    await implementStage(executionId, 'fix-a', 'x')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'fix-a')!
    const round = executions.rounds(executionId, 'fix-a').at(-1)!
    const assignment = tasks.store.assignmentsOf(change.taskId!).find(a => a.id === round.reviewAssignmentId)!
    deliverToReviewer(assignment.messageId!, 'rev1')
    ghStub.checkRuns = JSON.stringify([
      { id: 't', name: 'ci', source: 'actions', conclusion: 'success', link: 'l', runId: 11, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
      { id: 'e', name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null },
    ])
    await results.submitFindings(bench.agent('rev1'), change.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'fail', findings: 'the e2e test fails on the settings page' })
    executor.wake(world.team.teamId)
    await executor.idle()

    expect(executions.rounds(executionId, 'fix-a').at(-1)).toMatchObject({ outcome: 'fail' })
    const row = executions.change(executionId, 'fix-a')!
    expect(row).toMatchObject({ state: 'implementing', fixRounds: 0 })
    const fixAttempt = executions.attempts(executionId, 'fix-a').at(-1)!
    expect(fixAttempt.kind).toBe('fix')
    expect(fixAttempt.manifest.answers?.resultId).toBe(round.resultId)
    expect(fixAttempt.manifest.answers?.findingsIds).toHaveLength(1)
    const fixAssignment = tasks.store.assignmentsOf(change.taskId!).at(-1)!
    const fixMail = mail.get(fixAssignment.messageId!)!
    expect(fixMail.body).toContain('fix round 1 of 3')
    expect(fixMail.body).toContain('the e2e test fails on the settings page')
    expect(fixMail.body).toContain(round.commitSha)
  })

  test('the third failed fix round stops the change as round-limit', async () => {
    const executionId = await approvedExecution('fix-b')
    await implementStage(executionId, 'fix-b', 'x')
    const row = executions.change(executionId, 'fix-b')!
    // Two failed fix rounds already counted: the next failure is the third.
    executions.transition(executionId, 'fix-b', row, { fixRounds: 2 })
    ghStub.pulls = '[]'
    ghStub.checkRuns = '[]'
    ghStub.statuses = JSON.stringify([{ name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null }])
    executor.wake(world.team.teamId)
    await executor.idle()
    // The implement round fails on the non-rerunnable status (it never counts);
    // a fix attempt follows, and ITS failed round is the third counted stop.
    const change = executions.change(executionId, 'fix-b')!
    expect(change.state).toBe('implementing')
    const worktree = change.worktree!
    fs.writeFileSync(path.join(worktree, 'src', 'fix-b.ts'), 'fix')
    commitAll(worktree, 'fix attempt')
    await results.submit(bench.agent('dev'), change.taskId!, { summary: 'fixed', commit: git(['rev-parse', 'HEAD'], worktree).trim() })
    executor.wake(world.team.teamId)
    await executor.idle()
    const stopped = executions.change(executionId, 'fix-b')!
    expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'round-limit' })
    expect(stopped.stopDetail?.checks).toContain('e2e')
  })

  test('a failed instruction and a hand-closed task stop the change', async () => {
    const executionId = await approvedExecution('stop-a')
    await implementStage(executionId, 'stop-a', 'x')
    const change = executions.change(executionId, 'stop-a')!
    // The instruction mail dead-letters.
    const assignment = tasks.store.assignmentsOf(change.taskId!)[0]!
    mail.deadLetter(assignment.messageId!, 'killed-recipient')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'stop-a')).toMatchObject({ state: 'stopped', stopReason: 'instruction-failed' })

    // A hand-closed task stops another change.
    const other = await approvedExecution('stop-b')
    await implementStage(other, 'stop-b', 'x')
    const rowB = executions.change(other, 'stop-b')!
    await tasks.setStatus(bench.human, rowB.taskId!, 'done')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(other, 'stop-b')).toMatchObject({ state: 'stopped', stopReason: 'task-closed' })
  })

  test('a worktree-scoped review group releases the spawned implementer before review (12.4)', async () => {
    const executionId = await approvedExecution('rel-a')
    const staged = await implementStage(executionId, 'rel-a', 'x')
    const worktreeA = staged.row!.worktree!
    // dev is a spawned member working in the change's worktree.
    bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), projectPath: path.join(worktreeA, 'src'), spawned: true })
    const released: string[] = []
    const holding = { ready: true, reason: null as string | null }
    const releasingExecutor = new ExecutionExecutor({
      store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
      records: () => bench.records.values(),
      teamOf: id => (id === world.team.teamId ? world.team : undefined),
      adapters: { provision: provisionAdapter(executions) },
      roundAdapters: stubRoundAdapters(),
      releases: { readiness: id => (id === 'dev' ? holding : { ready: true, reason: null }), release: id => released.push(id) },
      groupScoped: () => true,
    })
    try {
      ghStub.pulls = '[]'
      passCi()
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(released).toEqual(['dev'])
      expect(executions.change(executionId, 'rel-a')!.step).toBe('reviewing')

      // A not-ready member holds the step with its reason.
      const execution2 = await approvedExecution('rel-b')
      const second = await implementStage(execution2, 'rel-b', 'x')
      bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), projectPath: path.join(second.row!.worktree!, 'src'), spawned: true })
      holding.ready = false
      holding.reason = 'busy'
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(executions.change(execution2, 'rel-b')!.step).toBe('releasing')
      // Ready again, the review follows on the next tick.
      holding.ready = true
      ghStub.pulls = '[]'
      passCi()
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(executions.change(execution2, 'rel-b')!.step).toBe('reviewing')
    } finally {
      releasingExecutor.close()
    }
  })

  test('a new task revision supersedes the round and dispatches a fix naming it (12.1)', async () => {
    const executionId = await approvedExecution('rev-a')
    await implementStage(executionId, 'rev-a', 'x')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'rev-a')!
    expect(change.state).toBe('gating')

    // The human republishes the task's direction.
    await tasks.amend(bench.human, change.taskId!, { direction: 'Do it differently now', rationale: 'scope changed' })
    executor.wake(world.team.teamId)
    await executor.idle()

    const rounds = executions.rounds(executionId, 'rev-a')
    expect(rounds.map(round => round.outcome)).toEqual(['superseded'])
    const row = executions.change(executionId, 'rev-a')!
    expect(row.state).toBe('implementing')
    const fix = tasks.store.assignmentsOf(change.taskId!).at(-1)!
    const fixMail = mail.get(fix.messageId!)!
    expect(fixMail.body).toContain('revision 2')
    expect(fixMail.body).toContain('scope changed')
    expect(executions.attempts(executionId, 'rev-a').at(-1)!.kind).toBe('fix')
  })

  test('an author claiming the review stops it as review-unavailable', async () => {
    const executionId = await approvedExecution('flow-d')
    await implementStage(executionId, 'flow-d', 'x')
    ghStub.pulls = '[]'
    passCi()
    executor.wake(world.team.teamId)
    await executor.idle()
    const change = executions.change(executionId, 'flow-d')!
    const round = executions.rounds(executionId, 'flow-d').at(-1)!
    // dev authored the result; rev1 passes — but first make dev the claimant.
    const assignment = tasks.store.assignmentsOf(change.taskId!).find(a => a.id === round.reviewAssignmentId)!
    deliverToReviewer(assignment.messageId!, 'dev')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'flow-d')).toMatchObject({ state: 'stopped', stopReason: 'review-unavailable' })
    expect(executions.change(executionId, 'flow-d')!.stopDetail?.session).toBe('dev')
  })
})
