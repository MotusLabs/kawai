// Every open pause target of a change is visible to `task_checkpoint` and to
// the result checkpoint (revision-control D7): D6 refuses a second pause only
// on the same hold, so two holds on different changes stand side by side —
// the plan's first pause must never be the only one searched — and two holds
// can even cover one change, where one recording serves both targets with one
// push and a result counts for each uncheckpointed target.
import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase } from '../db'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { ExecutionStore } from '../plans/execution/executionStore'
import { EffectRunner } from '../plans/execution/effects'
import { pushAdapter, roundAdapters } from '../plans/execution/executionRounds'
import { recoverUnknownEffects } from '../plans/execution/executorStartup'
import { startupReads } from '../plans/execution/startupReads'
import type { OutcomeDeps } from '../plans/execution/executorOutcomes'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { CheckpointStore } from '../plans/revisionControl/checkpointStore'
import { CheckpointTool, type CheckpointOutcome } from '../plans/revisionControl/checkpointTool'
import { derivePauseTarget, runPauseTick, type PauseTickDeps } from '../plans/revisionControl/pauseTick'
import { MailboxStore } from '../team/mailboxStore'

let world: PlanWorld
let origin = ''
let serial = 0

beforeAll(async () => {
  world = await createPlanWorld('kawai-checkpoint-pauses-')
  origin = path.join(world.root, 'origin.git')
  fs.mkdirSync(origin, { recursive: true })
  git(['init', '-q', '--bare', origin])
  git(['remote', 'add', 'origin', origin], world.repo)
  git(['push', '-q', 'origin', 'master'], world.repo)
})

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const revParse = (ref: string, cwd: string) => git(['rev-parse', ref], cwd).trim()

/** One change worktree off origin's master, with one commit on its branch. */
function changeWorktree(name: string): { cwd: string; branch: string; commit: string; base: string } {
  serial += 1
  const branch = `${name}-branch-${serial}`
  const cwd = path.join(world.root, `wt-${name}-${serial}`)
  const base = revParse('origin/master', world.repo)
  git(['worktree', 'add', '-q', '-b', branch, cwd, base], world.repo)
  fs.writeFileSync(path.join(cwd, 'work.ts'), `export const ${name} = ${serial}\n`)
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', `${name} work`], cwd)
  return { cwd, branch, commit: revParse('HEAD', cwd), base }
}

interface Work { cwd: string; branch: string; commit: string; base: string }

interface Bench {
  db: ReturnType<typeof initDatabase>
  executions: ExecutionStore
  pauses: PauseStore
  checkpoints: CheckpointStore
  tool: CheckpointTool
  executionId: string
  work: Record<string, Work>
  /** The `resultOf` read's backing map: register a result's submitter here. */
  resultsById: Map<string, { sessionId: string | null }>
}

/** A running execution over the named changes, each implementing with an attempt and its own `task-<change>` task. */
function benchWith(changes: string[]): Bench {
  const db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(world.root, 'db-')), 'cp.db') })
  const executions = new ExecutionStore(db.db)
  const pauses = new PauseStore(db.db)
  const checkpoints = new CheckpointStore(db.db)
  const results = new Map<string, { sessionId: string | null }>()
  const tool = new CheckpointTool({ executions, pauses, checkpoints, resultOf: id => results.get(id) ?? null })
  const executionId = executions.insertExecution({
    teamId: world.team.teamId, planId: 'plan-x', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: revParse('origin/master', world.repo),
    floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    maxParallel: 2, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  }).id
  const work: Record<string, Work> = {}
  for (const change of changes) {
    const built = changeWorktree(change)
    work[change] = built
    const row = executions.change(executionId, change)!
    executions.transition(executionId, change, row, {
      state: 'implementing', step: null, taskId: `task-${change}`, worktree: built.cwd, branch: built.branch, baselineCommit: built.base,
    })
    executions.insertAttempt({
      executionId, change, kind: 'implement', assignmentId: null,
      manifest: {
        version: 1, plan: { id: 'plan-x', revision: 1, contentHash: 'h' }, execution: executionId,
        task: { id: `task-${change}`, revision: 1 }, validation: { reportId: 'r', inputHash: 'i' },
        baseline: built.base, startCommit: built.base, artifacts: {}, roleProfiles: [],
      },
      manifestHash: 'mh',
    })
  }
  return { db, executions, pauses, checkpoints, tool, executionId, work, resultsById: results }
}

/** One open pause over the named targets, the way the pause service inserts them. */
function openPause(bench: Bench, holdId: string, commandId: string, targets: Array<{ change: string; holder: string }>) {
  return bench.pauses.insert(
    { teamId: world.team.teamId, planId: 'plan-x', executionId: bench.executionId, holdId, deadline: new Date(Date.now() + 86_400_000).toISOString(), note: null, commandId },
    targets.map(({ change, holder }) => ({
      change, stage: 'attempt' as const, attemptId: bench.executions.attempts(bench.executionId, change)[0]!.id,
      assignmentId: `asg-${change}`, holderSession: holder,
    })),
  )
}

const caller = { kind: 'agent' as const, sessionId: 'dev' }
const checkpointCount = (bench: Bench) => bench.db.db.prepare('SELECT COUNT(*) AS n FROM plan_checkpoints').get() as { n: number }

/** Narrow a tool outcome to its ok form, failing the test with the refusal's message. */
function okOutcome(outcome: CheckpointOutcome, label: string): Extract<CheckpointOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`${label}: ${outcome.message}`)
  return outcome
}

/** Run one effect through the round pipeline's own push adapter, as the executor's chain resolves it. */
async function runEffect(bench: Bench, effectId: string): Promise<void> {
  const effect = bench.executions.effect(effectId)!
  await new EffectRunner({
    store: bench.executions,
    adapter: { call: effect2 => pushAdapter(roundAdapters).call(effect2) },
    backoffsMs: [0, 0, 0],
  }).runOne(effect)
}

describe('every open pause target of the change is visible (D7)', () => {
  test('two holds and two pauses on different changes: the second change\'s holder records, and its result counts', async () => {
    const b = benchWith(['api', 'ui'])
    const pauseApi = openPause(b, 'hold-api', 'cmd-1', [{ change: 'api', holder: 'dev' }])
    const pauseUi = openPause(b, 'hold-ui', 'cmd-2', [{ change: 'ui', holder: 'dev2' }])

    // A result round counts for the ui target — through the second pause,
    // though the plan's first pause only holds api — and nowhere else.
    b.resultsById.set('result-ui', { sessionId: 'dev2' })
    const { round } = b.executions.insertRound({
      executionId: b.executionId, change: 'ui', attemptId: b.executions.attempts(b.executionId, 'ui')[0]!.id,
      resultId: 'result-ui', commitSha: b.work.ui!.commit, fixRound: false,
    })
    b.tool.recordResultCheckpoint(b.executionId, 'ui', round.id)
    const counted = b.pauses.target(pauseUi.id, 'ui')!.checkpointId
    expect(counted).not.toBeNull()
    expect(b.checkpoints.get(counted!)!.kind).toBe('result')
    expect(b.checkpoints.get(counted!)!.pauseId).toBe(pauseUi.id)
    expect(b.pauses.target(pauseApi.id, 'api')!.checkpointId).toBeNull()
    expect(checkpointCount(b).n).toBe(1)

    // The second change's holder records through the second pause (the plan's
    // first pause names a different change and holder), superseding the
    // counted result there; api's target is untouched.
    const recorded = okOutcome(await b.tool.record(
      { kind: 'agent', sessionId: 'dev2' },
      { task_id: 'task-ui', summary: 'ui stands', next_steps: 'finish the view', commit: b.work.ui!.commit },
    ), 'ui holder records')
    const served = b.pauses.target(pauseUi.id, 'ui')!.checkpointId!
    expect(served).not.toBe(counted)
    expect(b.checkpoints.get(served)!.kind).toBe('commit')
    expect(b.checkpoints.get(counted!)!.supersededBy).toBe(served)
    expect(b.pauses.target(pauseApi.id, 'api')!.checkpointId).toBeNull()
    expect(recorded.effectId).toBe(b.checkpoints.get(served)!.effectId)
    expect(b.executions.effectsOf(b.executionId)).toHaveLength(1)
  })

  test('two overlapping pauses on one change: one recording serves both targets with one push', async () => {
    const b = benchWith(['api'])
    const first = openPause(b, 'hold-1', 'cmd-1', [{ change: 'api', holder: 'dev' }])
    const second = openPause(b, 'hold-2', 'cmd-2', [{ change: 'api', holder: 'dev' }])
    const recorded = okOutcome(await b.tool.record(caller, {
      task_id: 'task-api', summary: 'stands', next_steps: 'finish the parser', commit: b.work.api!.commit,
    }), 'overlapping record')
    const firstCp = b.pauses.target(first.id, 'api')!.checkpointId
    const secondCp = b.pauses.target(second.id, 'api')!.checkpointId
    expect(firstCp).not.toBeNull()
    expect(secondCp).not.toBeNull()
    expect(firstCp).not.toBe(secondCp)
    // Each target's own chain: the rows differ and name their pause, and
    // both carry the one effect (L1), so each settles with the push.
    expect(b.checkpoints.get(firstCp!)!.pauseId).toBe(first.id)
    expect(b.checkpoints.get(secondCp!)!.pauseId).toBe(second.id)
    // Exactly one push, under the first row's key.
    expect(recorded.checkpointId).toBe(firstCp!)
    expect(b.checkpoints.get(secondCp!)!.effectId).toBe(recorded.effectId)
    expect(b.executions.effectsOf(b.executionId)).toHaveLength(1)
    const effect = b.executions.effect(recorded.effectId!)!
    expect(effect.roundId).toBe(firstCp!)
    expect(effect.command).toEqual({ cwd: b.work.api!.cwd, commit: b.work.api!.commit, branch: b.work.api!.branch })
    // A second recording supersedes each target's own chain and pushes once again.
    fs.writeFileSync(path.join(b.work.api!.cwd, 'work.ts'), 'export const api = 2\n')
    git(['add', '-A'], b.work.api!.cwd)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'api work 2'], b.work.api!.cwd)
    const again = okOutcome(await b.tool.record(caller, {
      task_id: 'task-api', summary: 'stands further', next_steps: 'polish', commit: revParse('HEAD', b.work.api!.cwd),
    }), 'overlapping record 2')
    expect(b.checkpoints.get(firstCp!)!.supersededBy).not.toBeNull()
    expect(b.checkpoints.get(secondCp!)!.supersededBy).not.toBeNull()
    expect(b.pauses.target(first.id, 'api')!.checkpointId).not.toBe(firstCp)
    expect(b.pauses.target(second.id, 'api')!.checkpointId).not.toBe(secondCp)
    expect(b.executions.effectsOf(b.executionId)).toHaveLength(2)
    expect(b.executions.effect(again.effectId!)!.roundId).toBe(again.checkpointId)
  })

  test('a result counts for each open uncheckpointed target across overlapping pauses', () => {
    const b = benchWith(['api'])
    const first = openPause(b, 'hold-1', 'cmd-1', [{ change: 'api', holder: 'dev' }])
    const second = openPause(b, 'hold-2', 'cmd-2', [{ change: 'api', holder: 'dev' }])
    b.resultsById.set('result-1', { sessionId: 'dev' })
    const { round } = b.executions.insertRound({
      executionId: b.executionId, change: 'api', attemptId: b.executions.attempts(b.executionId, 'api')[0]!.id,
      resultId: 'result-1', commitSha: b.work.api!.commit, fixRound: false,
    })
    b.tool.recordResultCheckpoint(b.executionId, 'api', round.id)
    const firstCp = b.pauses.target(first.id, 'api')!.checkpointId
    const secondCp = b.pauses.target(second.id, 'api')!.checkpointId
    expect(firstCp).not.toBeNull()
    expect(secondCp).not.toBeNull()
    expect(firstCp).not.toBe(secondCp)
    expect(b.checkpoints.get(firstCp!)!.resultId).toBe('result-1')
    expect(b.checkpoints.get(secondCp!)!.resultId).toBe('result-1')
    expect(b.checkpoints.get(secondCp!)!.sessionId).toBe('dev')
    // The holder's record always wins: a checkpointed target is never recounted.
    b.tool.recordResultCheckpoint(b.executionId, 'api', round.id)
    expect(checkpointCount(b).n).toBe(2)
  })
})

describe('the pause tick over overlapping pauses (L1: every row carries the effect, D8)', () => {
  const tickDeps = (bench: Bench): PauseTickDeps => ({
    pauses: bench.pauses, checkpoints: bench.checkpoints, executions: bench.executions,
    mailbox: new MailboxStore(bench.db.db),
    deliverOwed: () => [],
    assignmentMessageState: () => null,
    readiness: () => ({ ready: true, reason: null }),
    factsOf: () => ({ state: 'live', pendingRequest: false, busy: false, providerLimit: null }),
  })
  const tick = (bench: Bench) => runPauseTick(tickDeps(bench), world.team.teamId, world.root)
  const stateOf = (bench: Bench, pauseId: string, change: string) => {
    const deps = tickDeps(bench)
    const pause = bench.pauses.get(world.team.teamId, pauseId)!
    const target = bench.pauses.target(pauseId, change)!
    const finished = bench.executions.execution(pause.executionId)!.state !== 'running'
    return derivePauseTarget(deps, pause, target, finished, new Date()).state
  }

  /** Two overlapping pauses on api, one recording through the real tool. */
  async function overlapped() {
    const b = benchWith(['api'])
    const first = openPause(b, 'hold-1', 'cmd-1', [{ change: 'api', holder: 'dev' }])
    const second = openPause(b, 'hold-2', 'cmd-2', [{ change: 'api', holder: 'dev' }])
    const recorded = okOutcome(await b.tool.record(caller, {
      task_id: 'task-api', summary: 'stands', next_steps: 'finish the parser', commit: b.work.api!.commit,
    }), 'overlapped record')
    return { b, first, second, recorded }
  }

  test('the push is done and both targets record Paused once', async () => {
    const { b, first, second, recorded } = await overlapped()
    await runEffect(b, recorded.effectId!)
    expect(b.executions.effect(recorded.effectId!)!.state).toBe('done')
    tick(b)
    const firstAt = b.pauses.target(first.id, 'api')!.pausedAt
    const secondAt = b.pauses.target(second.id, 'api')!.pausedAt
    expect(firstAt).not.toBeNull()
    expect(secondAt).not.toBeNull()
    expect(stateOf(b, first.id, 'api')).toEqual({ state: 'paused' })
    expect(stateOf(b, second.id, 'api')).toEqual({ state: 'paused' })
    // The guarded write keeps each fact across further ticks.
    tick(b)
    expect(b.pauses.target(first.id, 'api')!.pausedAt).toBe(firstAt)
    expect(b.pauses.target(second.id, 'api')!.pausedAt).toBe(secondAt)
  })

  test('the push fails and both read checkpoint-push-failed', async () => {
    const { b, first, second, recorded } = await overlapped()
    b.executions.setEffectOutcome(recorded.effectId!, { state: 'failed' })
    tick(b)
    expect(b.pauses.target(first.id, 'api')!.pausedAt).toBeNull()
    expect(b.pauses.target(second.id, 'api')!.pausedAt).toBeNull()
    for (const pauseId of [first.id, second.id]) {
      const state = stateOf(b, pauseId, 'api')
      if (state.state !== 'pausing') throw new Error(`expected pausing, got ${state.state}`)
      expect(state.causes).toContainEqual({ kind: 'checkpoint-push-failed' })
      expect(state.ownerRequired).toBe(true)
    }
  })

  test('the effect is unknown at restart and the inspector settles it for both', async () => {
    const { b, first, second, recorded } = await overlapped()
    // The restart: the effect was running when the process died, so startup
    // marks every running effect unknown and the targets stay Pausing.
    b.executions.markEffectRunning(recorded.effectId!)
    b.executions.markRunningEffectsUnknown()
    tick(b)
    expect(b.pauses.target(first.id, 'api')!.pausedAt).toBeNull()
    expect(b.pauses.target(second.id, 'api')!.pausedAt).toBeNull()
    // The push had landed before the restart: the inspection reads origin
    // once and settles done, and both targets follow their own row to Paused.
    git(['push', '-q', origin, `refs/heads/${b.work.api!.branch}:refs/heads/${b.work.api!.branch}`], b.work.api!.cwd)
    await recoverUnknownEffects({ store: b.executions, reads: startupReads() })
    expect(b.executions.effect(recorded.effectId!)!.state).toBe('done')
    tick(b)
    expect(b.pauses.target(first.id, 'api')!.pausedAt).not.toBeNull()
    expect(b.pauses.target(second.id, 'api')!.pausedAt).not.toBeNull()
    expect(stateOf(b, first.id, 'api')).toEqual({ state: 'paused' })
    expect(stateOf(b, second.id, 'api')).toEqual({ state: 'paused' })
  })
})

/** The outcome deps the executor wires (executorDeps), over the bench's own tool. */
function outcomeDepsOf(b: Bench): OutcomeDeps {
  return {
    store: b.executions, taskStatusOf: () => null,
    // A push outcome never consults the landing mechanism.
    mechanismOf: () => { throw new Error('a push outcome never consults the mechanism') },
    now: () => new Date(),
    recordResultCheckpoint: (executionId, change, roundId) => b.tool.recordResultCheckpoint(executionId, change, roundId),
  }
}

/** One round's `push` effect, marked running so a restart reads it unknown. */
function roundPushLeftUnknown(b: Bench, round: { id: string; number: number }, commit: string, branch: string, cwd: string): string {
  const effect = b.executions.insertEffect({
    executionId: b.executionId, change: 'api', roundId: round.id, kind: 'push',
    effectKey: `${b.executionId}:api:push:${round.number}:1`,
    command: { cwd, commit, branch },
  })
  b.executions.markEffectRunning(effect.id)
  b.executions.markRunningEffectsUnknown()
  return effect.id
}

describe('a round push the restart inspection settles done (F4)', () => {
  const tickDeps = (bench: Bench): PauseTickDeps => ({
    pauses: bench.pauses, checkpoints: bench.checkpoints, executions: bench.executions,
    mailbox: new MailboxStore(bench.db.db),
    deliverOwed: () => [],
    assignmentMessageState: () => null,
    readiness: () => ({ ready: true, reason: null }),
    factsOf: () => ({ state: 'live', pendingRequest: false, busy: false, providerLimit: null }),
  })
  const tick = (b: Bench): void => runPauseTick(tickDeps(b), world.team.teamId, world.root)

  test('a round push unknown at restart and on origin counts the result, and no second push runs', async () => {
    const b = benchWith(['api'])
    const pauseRow = openPause(b, 'hold-1', 'cmd-1', [{ change: 'api', holder: 'dev' }])
    b.resultsById.set('result-1', { sessionId: 'dev' })
    const { round } = b.executions.insertRound({
      executionId: b.executionId, change: 'api', attemptId: b.executions.attempts(b.executionId, 'api')[0]!.id,
      resultId: 'result-1', commitSha: b.work.api!.commit, fixRound: false,
    })
    const effect = roundPushLeftUnknown(b, round, b.work.api!.commit, b.work.api!.branch, b.work.api!.cwd)
    // The push had landed before the restart. The done inspection must reach
    // the outcome path — markRoundPushed plus the D7 result checkpoint — or
    // the planner's pushedAt heal re-issues the push as a second one.
    git(['push', '-q', origin, `refs/heads/${b.work.api!.branch}:refs/heads/${b.work.api!.branch}`], b.work.api!.cwd)
    await recoverUnknownEffects({ store: b.executions, reads: startupReads(), outcomes: outcomeDepsOf(b) })
    expect(b.executions.effect(effect)!.state).toBe('done')
    expect(b.executions.round(round.id)!.pushedAt).not.toBeNull()
    const counted = b.pauses.target(pauseRow.id, 'api')!.checkpointId
    expect(counted).not.toBeNull()
    expect(b.checkpoints.get(counted!)!.kind).toBe('result')
    // Exactly the one push effect: the planner never re-issues it.
    expect(b.executions.effectsOf(b.executionId)).toHaveLength(1)
    // The counted result is the work on origin, so the next tick records Paused.
    tick(b)
    expect(b.pauses.target(pauseRow.id, 'api')!.pausedAt).not.toBeNull()
  })

  test('a round push unknown at restart with origin past it still settles done', async () => {
    const b = benchWith(['api'])
    const pauseRow = openPause(b, 'hold-1', 'cmd-1', [{ change: 'api', holder: 'dev' }])
    b.resultsById.set('result-1', { sessionId: 'dev' })
    const { round } = b.executions.insertRound({
      executionId: b.executionId, change: 'api', attemptId: b.executions.attempts(b.executionId, 'api')[0]!.id,
      resultId: 'result-1', commitSha: b.work.api!.commit, fixRound: false,
    })
    const effect = roundPushLeftUnknown(b, round, b.work.api!.commit, b.work.api!.branch, b.work.api!.cwd)
    // A checkpoint moved origin past the round commit before the restart:
    // the round commit is contained, so the inspection settles done — the
    // equality read would re-run the push and fail it non-fast-forward.
    fs.writeFileSync(path.join(b.work.api!.cwd, 'checkpoint.ts'), 'export const c = 1\n')
    git(['add', '-A'], b.work.api!.cwd)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'checkpoint work'], b.work.api!.cwd)
    git(['push', '-q', origin, `refs/heads/${b.work.api!.branch}:refs/heads/${b.work.api!.branch}`], b.work.api!.cwd)
    await recoverUnknownEffects({ store: b.executions, reads: startupReads(), outcomes: outcomeDepsOf(b) })
    expect(b.executions.effect(effect)!.state).toBe('done')
    expect(b.executions.round(round.id)!.pushedAt).not.toBeNull()
    expect(b.pauses.target(pauseRow.id, 'api')!.checkpointId).not.toBeNull()
    // No failed push stopped the change: the submitted round had moved it to
    // gating (D9), and it stays there.
    expect(b.executions.change(b.executionId, 'api')!.state).toBe('gating')
  })
})
