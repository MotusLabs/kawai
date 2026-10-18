// The end-to-end integration test (plan-execution §17.1): a plan of two
// dependent changes runs against a local bare `origin` and a stub `gh`, with
// fake members submitting results and findings. One change sees a flaky
// check, the other a failed review with a fix round. Both land, the plan
// completes as `system`, and the server "restarts" once mid-merge — a fresh
// executor over the same rows continues without a duplicate dispatch, push,
// or merge, and one landing fact per change is recorded.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { isAncestor as realIsAncestor, lsRemoteHead as realLsRemoteHead } from '../plans/landing/gitRemote'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ExecutionStore } from '../plans/execution/executionStore'
import { executionViewReads, executionViews } from '../plans/execution/executionView'
import { flakyChecks } from '../../shared/planExecutionGates'
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

/** The stub gh's scripted state. */
/** The stub gh's scripted state: mergedHeads carries each branch's real merge commit. */
let gh: {
  checks: string
  pulls: Array<{ number: number; url: string; state: string; headRefOid: string }>
  merged: string[]
  mergedHeads: Record<string, string>
  /** While set, the next prMerge call waits on it (the mid-merge restart gate). */
  mergeGate: Promise<void> | null
}


function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}
/** origin's current head of a branch, read from the bare repository itself; null when absent. */
const remoteHead = (branch: string): string | null => {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: origin, encoding: 'utf8', env: cleanGitEnv() })
  const rev = result.status === 0 ? result.stdout.trim() : ''
  return rev === '' ? null : rev
}

/** A member works in the change's worktree, submits a result; a reviewer passes it. */
async function implement(executionId: string, change: string, file: string): Promise<void> {
  const row = executions.change(executionId, change)!
  fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
  fs.writeFileSync(path.join(row.worktree!, 'src', `${change}.ts`), file)
  commitAll(row.worktree!, `implement ${change}`)
  git(['push', '-q', 'origin', `HEAD:refs/heads/${change}`], row.worktree!)
  const commit = git(['rev-parse', 'HEAD'], row.worktree!).trim()
  await results.submit(bench.agent('dev'), row.taskId!, { summary: `done ${change}`, commit, tests: [{ description: 'unit', outcome: 'pass' }] })
}

/** Deliver the assignment's instruction to a session so it can act and findings count. */
const deliver = (messageId: string, sessionId: string) => {
  mail.claim(messageId, sessionId)
  mail.markPushed(messageId)
  mail.markDelivered(messageId)
}

/** A passing review by the independent reviewer. */
async function reviewPass(executionId: string, change: string): Promise<void> {
  const row = executions.change(executionId, change)!
  const round = executions.rounds(executionId, change).at(-1)!
  const assignment = tasks.store.assignmentsOf(row.taskId!).find(entry => entry.id === round.reviewAssignmentId)!
  deliver(assignment.messageId!, 'rev1')
  await results.submitFindings(bench.agent('rev1'), row.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'pass', findings: 'clean' })
}

/** A failing review (the fix round's source). */
async function reviewFail(executionId: string, change: string, text: string): Promise<void> {
  const row = executions.change(executionId, change)!
  const round = executions.rounds(executionId, change).at(-1)!
  const assignment = tasks.store.assignmentsOf(row.taskId!).find(entry => entry.id === round.reviewAssignmentId)!
  deliver(assignment.messageId!, 'rev1')
  await results.submitFindings(bench.agent('rev1'), row.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'fail', findings: text })
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-exec-e2e-')
  writeGroup(world, 'middle-devs', '---\nmax: 2\nprofiles: [default]\n---\nBuild.')
  writeGroup(world, 'reviewers', '---\nmax: 2\n---\nReview.')
  gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-exec-e2e-git-'))
  origin = path.join(gitRoot, 'origin.git')
  git(['init', '-q', '--bare', '-b', 'master', origin], gitRoot)
  fs.writeFileSync(path.join(world.repo, 'seed.txt'), 'seed\n')
  for (const change of ['dep-a', 'flaky-b']) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(world.repo, 'seed + changes')
  // A GitHub-shaped remote URL rewritten to the local bare repository: the
  // executor's repo identity reads owner/repo while git stays local (the
  // landingProbe bench pattern).
  git(['remote', 'add', 'origin', 'https://github.com/acme/app.git'], world.repo)
  git(['config', `url.${origin}.insteadOf`, 'https://github.com/acme/app.git'], world.repo)
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
  bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), claudeProfileId: 'default', spawned: true })
  bench.records.set('rev1', { sessionId: 'rev1', groupId: 'reviewers', projectPath: world.feature, name: 'rev1', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' })
  mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  executions = new ExecutionStore(bench.db.db)
  // The real git checks: everything here is a real repository.
  const ownership = executionOwnership(executions, {
    isAncestor: (cwd, ancestor, descendant) => realIsAncestor(cwd, ancestor, descendant),
    lsRemoteHead: (cwd, ref) => realLsRemoteHead(cwd, ref),
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
    getSession: () => null, strategies: new StrategyStore(bench.db.db),
    executionOf: id => executions.execution(id),
  })
  gh = { checks: '[]', pulls: [], merged: [], mergedHeads: {}, mergeGate: null }
  executor = makeExecutor()
})
afterEach(() => executor.close())

/** The executor with real git and the scripted gh. */
function makeExecutor(): ExecutionExecutor {
  return new ExecutionExecutor({
    ...neutralExecutorSeams,
    store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
    records: () => bench.records.values(),
    teamOf: id => (id === world.team.teamId ? world.team : undefined),
    adapters: { provision: provisionAdapter(executions) },
    plansService,
    roundAdapters: {
      lsRemoteHead: async () => ({ ok: true as const, sha: null as string | null }),
      push: async (cwd: string, source: string, branch: string) => {
        const pushed = spawnSync('git', ['push', 'origin', `${source}:refs/heads/${branch}`], { cwd, encoding: 'utf8', env: cleanGitEnv() })
        return pushed.status === 0 ? { ok: true as const } : { ok: false as const, error: { argv: ['git', 'push'], exitCode: pushed.status, stderr: pushed.stderr } }
      },
      checkRuns: async () => ({ ok: true as const, data: JSON.parse(gh.checks) }),
      statuses: async () => ({ ok: true as const, data: [] }),
      prList: async () => ({ ok: true as const, data: gh.pulls }),
      prCreate: async () => ({ ok: true as const, data: { number: 7, url: 'https://example.internal/pr/7' } }),
      rerun: async () => ({ ok: true as const, data: null }),
    },
    landingAdapters: {
      fetch: async () => ({ ok: true as const }),
      isAncestor: async (cwd: string, ancestor: string, descendant: string) => {
        const out = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, encoding: 'utf8', env: cleanGitEnv() })
        return { ok: true as const, ancestor: out.status === 0 }
      },
      mergeTree: async (cwd: string, ours: string, theirs: string) => {
        const out = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', ours, theirs], { cwd, encoding: 'utf8', env: cleanGitEnv() })
        if (out.status !== 0 && out.status !== 1) return { ok: false as const, error: { argv: ['git', 'merge-tree'], exitCode: out.status, stderr: out.stderr } }
        const head = (out.stdout.split('\n\n')[0] ?? '').trim()
        const conflicts = (out.stdout.split('\n\n').slice(1).join('\n\n') || '').split('\n').map(line => line.trim()).filter(line => line !== '')
        return { ok: true as const, tree: head, conflicts }
      },
      lsRemoteHead: async (_cwd: string, ref: string) => ({
        ok: true as const,
        sha: (() => {
          if (!ref.startsWith('refs/heads/')) return null
          const branch = ref.slice('refs/heads/'.length)
          const rev = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], origin).trim()
          return rev === '' ? null : rev
        })(),
      }),
      updateBranch: async () => ({ ok: true as const, data: null }),
      prMerge: async (_repo: string, pr: number, _method: 'merge' | 'squash' | 'rebase', head: string) => {
        if (gh.mergeGate !== null) await gh.mergeGate
        gh.merged.push(head)
        // A real merge commit on origin: the branch head + master, clean.
        const branch = gh.pulls.find(pull => pull.number === pr)?.headRefOid === head
          ? (gh.pulls.find(pull => pull.number === pr)!.number === 7 ? 'dep-a' : 'flaky-b') : 'dep-a'
        const scratch = path.join(gitRoot, `merge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
        git(['clone', '-q', origin, scratch], gitRoot)
        git(['checkout', '-q', branch], scratch)
        const base = git(['rev-parse', 'refs/remotes/origin/master'], scratch).trim()
        git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'merge', '-q', '--no-ff', '-m', `merge ${branch}`, base], scratch)
        git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], scratch)
        gh.mergedHeads[branch] = git(['rev-parse', 'HEAD'], scratch).trim()
        fs.rmSync(scratch, { recursive: true, force: true })
        gh.pulls = gh.pulls.map(pull => pull.number === pr ? { ...pull, state: 'MERGED' } : pull)
        return { ok: true as const, data: null }
      },
      prView: async (_repo: string, pr: number) => {
        const pull = gh.pulls.find(entry => entry.number === pr)
        if (pull === undefined) return { ok: false as const, error: { argv: ['gh', 'pr', 'view'], exitCode: 1, httpStatus: null, message: 'no pr' } }
        const branch = pr === 7 ? 'dep-a' : 'flaky-b'
        return {
          ok: true as const,
          data: {
            number: pr, url: 'https://example.internal/pr/7', state: pull.state, headRefOid: pull.headRefOid,
            mergeCommit: pull.state === 'MERGED' ? gh.mergedHeads[branch] ?? null : null,
          },
        }
      },
    },
  })
}

describe('the executed plan end to end (§17.1)', () => {
  test('two dependent changes land through flaky CI, a failed review with a fix round, and a mid-merge restart', async () => {
    // The plan: dep-a, then flaky-b depending on it.
    const { planId, revision, hash } = await bench.draftInReview({
      changes: [
        { change: 'dep-a', dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' },
        { change: 'flaky-b', dependsOn: ['dep-a'], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' },
      ],
      reviewGroup: 'reviewers',
    })
    await bench.approve(planId, revision)
    const executionId = executions.insertExecution({
      teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: baseSha, floor: { version: 1, map: FLOOR },
      maxParallel: 2, mergeMethod: 'merge', changes: [{ change: 'dep-a', landed: false }, { change: 'flaky-b', landed: false }],
    }).id

    // dep-a runs first (flaky-b waits on it).
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'dep-a')!.state).toBe('implementing')
    expect(executions.change(executionId, 'flaky-b')!.state).toBe('waiting')

    // dep-a's round: green CI, passing review.
    gh.pulls = [{ number: 7, url: 'https://example.internal/pr/7', state: 'OPEN', headRefOid: 'will-move' }]
    gh.checks = JSON.stringify([
      { name: 'ci', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
      { name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
    ])
    await implement(executionId, 'dep-a', 'export const a = 1\n')
    gh.pulls[0]!.headRefOid = remoteHead('dep-a')!
    executor.wake(world.team.teamId)
    await executor.idle()
    await reviewPass(executionId, 'dep-a')

    // The verdict lands and the merge starts — then the server "restarts"
    // before it settles: the first prMerge call parks on the gate, and the
    // executor is dropped mid-call.
    const gate = Promise.withResolvers<void>()
    gh.mergeGate = gate.promise
    executor.wake(world.team.teamId)
    await new Promise(resolve => setTimeout(resolve, 50))
    const depRow = executions.change(executionId, 'dep-a')!
    expect(depRow.state).toBe('landing')
    const mergeEffect = executions.effectsOf(executionId).find(effect => effect.kind === 'merge' && effect.change === 'dep-a')
    expect(mergeEffect).toBeDefined()
    expect(mergeEffect!.state).toBe('running')
    // The abandoned call never settles: the restart dropped the process
    // mid-call, and only the fresh executor proceeds.
    executor.close()
    gh.mergeGate = null
    executor = makeExecutor()
    // The restart flips the running merge to unknown; the inspection finds
    // the pull request still open (nothing merged), so the merge re-runs and
    // this time it completes — one real merge, never two.
    await executor.startup()
    executor.wake(world.team.teamId)
    await executor.idle()
    // The landing outcome settles asynchronously (the done handler wakes the
    // executor again); one more wake closes it.
    executor.wake(world.team.teamId)
    await executor.idle()

    const depAfter = executions.change(executionId, 'dep-a')!
    expect(depAfter.state).toBe('landed')

    // flaky-b, freed by the landing: a flaky check (fail, rerun, pass), then
    // a failed review with one fix round, then the pass.
    gh.pulls = [{ number: 8, url: 'https://example.internal/pr/8', state: 'OPEN', headRefOid: remoteHead('flaky-b') ?? 'x' }]
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'flaky-b')!.state).toBe('implementing')
    gh.checks = JSON.stringify([
      { name: 'ci', source: 'actions', conclusion: 'failure', link: 'https://example.internal/runs/31/at', runId: 31, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
      { name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
    ])
    await implement(executionId, 'flaky-b', 'export const b = 1\n')
    gh.pulls[0]!.headRefOid = remoteHead('flaky-b')!
    executor.wake(world.team.teamId)
    await executor.idle()
    // The rerun effect ran; with CI green now the round reaches review.
    gh.checks = JSON.stringify([
      // GitHub lists the failed attempt beside the rerun's run; the
      // post-rerun run completes after the rerun was requested (a far
      // future stamp keeps it after the recorded rerun time).
      { name: 'ci', source: 'actions', conclusion: 'failure', link: 'https://example.internal/runs/31/at', runId: 31, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
      { name: 'ci', source: 'actions', conclusion: 'success', link: 'https://example.internal/runs/31/bt', runId: 31, startedAt: '2026-10-17T00:02:00.000Z', completedAt: '2099-01-01T00:00:00.000Z' },
      { name: 'e2e', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
    ])
    executor.wake(world.team.teamId)
    await executor.idle()

    // The review fails once — the fix round — then passes.
    await reviewFail(executionId, 'flaky-b', 'the settings page breaks')
    executor.wake(world.team.teamId)
    await executor.idle()
    expect(executions.change(executionId, 'flaky-b')!.state).toBe('implementing')
    const fixAttempt = executions.attempts(executionId, 'flaky-b').at(-1)!
    expect(fixAttempt.kind).toBe('fix')
    // The member fixes and submits; the round passes and lands.
    await implement(executionId, 'flaky-b', 'export const b = 2\n')
    gh.pulls[0]!.headRefOid = remoteHead('flaky-b')!
    executor.wake(world.team.teamId)
    await executor.idle()
    await reviewPass(executionId, 'flaky-b')
    executor.wake(world.team.teamId)
    await executor.idle()
    executor.wake(world.team.teamId)
    await executor.idle()

    // Both landed; the execution completed and the plan completed as system.
    expect(executions.change(executionId, 'flaky-b')!.state).toBe('landed')
    expect(executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'completed' })
    expect(bench.plans.get(planId)!.lifecycle).toBe('completed')
    const completion = bench.plans.events(planId).at(-1)!
    expect(completion).toMatchObject({ kind: 'completed', actor: { kind: 'system' }, commandId: `exec:${executionId}:complete` })
    // flaky-b's CI passed on the one rerun: its CI round marks the name flaky.
    const flakyRound = executions.rounds(executionId, 'flaky-b').find(round => round.ci !== null && flakyChecks(round.ci).includes('ci'))
    expect(flakyRound).toBeDefined()
    const flakyView = executionViews(executions, planId, executionViewReads(bench.plans, bench.db.db))
      .find(entry => entry.id === executionId)!.changes.find(entry => entry.change === 'flaky-b')!
    expect(flakyView.state).toBe('landed')
    // One landing fact per change; no duplicate dispatch, push, or merge.
    const facts = executions.landings(planId)
    expect(facts.map(fact => fact.change).sort()).toEqual(['dep-a', 'flaky-b'])
    const effects = executions.effectsOf(executionId)
    expect(effects.filter(effect => effect.kind === 'merge')).toHaveLength(2)
    expect(gh.merged).toHaveLength(2)
    const pushes = effects.filter(effect => effect.kind === 'push')
    // dep-a 1 round + flaky-b 2 rounds = 3 pushes, one per round.
    expect(pushes).toHaveLength(3)
    expect(executions.attempts(executionId, 'flaky-b')).toHaveLength(2)
  }, 90000)
})
