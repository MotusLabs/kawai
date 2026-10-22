// The `task_checkpoint` tool and the `push-checkpoint` effect (revision-control
// D7), against a bare origin: every refusal writes nothing, a valid call
// records the checkpoint, enqueues the effect, and the push lands without
// force, a diverged origin fails the push and the change keeps running while
// a failed round `push` still stops its change, an unknown effect is
// inspected after a restart before anything repeats, and a submitted result
// counts as the target's checkpoint once its push is done.
import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase } from '../db'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { ExecutionStore } from '../plans/execution/executionStore'
import type { ChangeRow } from '../plans/execution/executionRows'
import { EffectRunner } from '../plans/execution/effects'
import { pushAdapter, roundAdapters } from '../plans/execution/executionRounds'
import { applyEffectFailure, applyEffectOutcome, type OutcomeDeps } from '../plans/execution/executorOutcomes'
import { inspectDueUnknownEffects, recoverUnknownEffects } from '../plans/execution/executorStartup'
import { startupReads } from '../plans/execution/startupReads'
import { directMechanism } from '../plans/landing/directMechanism'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { CheckpointStore } from '../plans/revisionControl/checkpointStore'
import { CheckpointTool, type CheckpointOutcome } from '../plans/revisionControl/checkpointTool'
import { teamToolTable, TEAM_ALLOWED_TOOLS } from '../team/mailboxTools'
import { TeamMailbox } from '../team/TeamMailbox'
import { MailboxStore } from '../team/mailboxStore'

let world: PlanWorld
let origin = ''
let serial = 0

beforeAll(async () => {
  world = await createPlanWorld('kawai-checkpoint-')
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

interface Bench {
  db: ReturnType<typeof initDatabase>
  executions: ExecutionStore
  pauses: PauseStore
  checkpoints: CheckpointStore
  tool: CheckpointTool
  executionId: string
  row: ChangeRow
  work: { cwd: string; branch: string; commit: string; base: string }
  pauseId: string
  /** The `resultOf` read's backing map: register a result's submitter here. */
  resultsById: Map<string, { sessionId: string | null }>
}

/** A fresh database with one running execution, an implementing change with an attempt, and an open pause targeting it. */
function bench(stage: 'attempt' | 'review' = 'attempt', options: { withdrawn?: boolean } = {}): Bench {
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
    maxParallel: 2, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
  }).id
  const work = changeWorktree('api')
  const base = executions.change(executionId, 'api')!
  const row = executions.transition(executionId, 'api', base, {
    state: 'implementing', step: null, taskId: 'task-x', worktree: work.cwd, branch: work.branch, baselineCommit: work.base,
  })!
  const attempt = executions.insertAttempt({
    executionId, change: 'api', kind: 'implement', assignmentId: null,
    manifest: {
      version: 1, plan: { id: 'plan-x', revision: 1, contentHash: 'h' }, execution: executionId,
      task: { id: 'task-x', revision: 1 }, validation: { reportId: 'r', inputHash: 'i' },
      baseline: work.base, startCommit: work.base, artifacts: {}, roleProfiles: [],
    },
    manifestHash: 'mh',
  })
  // A withdrawn target is built the production way — insert-time, holder null
  // (pauseWithin's target shape; PauseStore has no mark-withdrawn setter).
  const pause = pauses.insert(
    { teamId: world.team.teamId, planId: 'plan-x', executionId, holdId: 'hold-x', deadline: new Date(Date.now() + 86_400_000).toISOString(), note: null, commandId: 'cmd-1' },
    [options.withdrawn === true
      ? { change: 'api', stage, attemptId: attempt.id, assignmentId: 'asg-x', holderSession: null, withdrawn: true }
      : { change: 'api', stage, attemptId: attempt.id, assignmentId: 'asg-x', holderSession: 'dev' }],
  )
  return { db, executions, pauses, checkpoints, tool, executionId, row, work, pauseId: pause.id, resultsById: results }
}

const caller = { kind: 'agent' as const, sessionId: 'dev' }
const baseInput = { task_id: 'task-x', summary: 'where work stands', next_steps: 'finish the parser' }
const checkpointCount = (bench: Bench) => bench.db.db.prepare('SELECT COUNT(*) AS n FROM plan_checkpoints').get() as { n: number }
const effectCount = (bench: Bench) => (bench.executions.effectsOf(bench.executionId)).length
const freshRow = (bench: Bench) => bench.executions.change(bench.executionId, 'api')!

/** Run one effect through the round pipeline's own push adapter, as the executor's chain resolves it. */
async function runEffect(bench: Bench, effectId: string): Promise<void> {
  const effect = bench.executions.effect(effectId)!
  await new EffectRunner({
    store: bench.executions,
    adapter: { call: effect2 => pushAdapter(roundAdapters).call(effect2) },
    backoffsMs: [0, 0, 0],
  }).runOne(effect)
}

const outcomeDeps = (bench: Bench, extra: Partial<OutcomeDeps> = {}): OutcomeDeps => ({
  store: bench.executions, taskStatusOf: () => null, mechanismOf: () => directMechanism, now: () => new Date(), ...extra,
})

/** The inspectors' real git reads (startupReads' default), for the restart passes. */
const realReads = () => startupReads()

/** Narrow a tool outcome to its ok form, failing the test with the refusal's message. */
function okOutcome(outcome: CheckpointOutcome, label: string): Extract<CheckpointOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`${label}: ${outcome.message}`)
  return outcome
}

/** Narrow a tool outcome to its refusal, failing the test when it unexpectedly succeeded. */
function refusalOf(outcome: CheckpointOutcome, label: string): Extract<CheckpointOutcome, { ok: false }> {
  if (outcome.ok) throw new Error(`${label}: unexpectedly succeeded`)
  return outcome
}

describe('task_checkpoint refusals (D7)', () => {
  test('a task no running execution owns is refused and writes nothing', async () => {
    const unowned = bench()
    const unknown = refusalOf(await unowned.tool.record(caller, { ...baseInput, task_id: 'task-none', commit: unowned.work.commit }), 'unknown task')
    expect(unknown.reason).toBe('no-execution')
    const stopped = bench()
    // Landing clears the row's ownership (owns = 0): the task is no longer owned.
    stopped.executions.transition(stopped.executionId, 'api', freshRow(stopped), { state: 'landed' })
    const ended = refusalOf(await stopped.tool.record(caller, { ...baseInput, commit: stopped.work.commit }), 'stopped execution')
    expect(ended.reason).toBe('no-execution')
    expect(checkpointCount(unowned).n).toBe(0)
    expect(effectCount(unowned)).toBe(0)
    expect(checkpointCount(stopped).n).toBe(0)
  })

  test('no pause naming the caller as claimant is no-pause-requested', async () => {
    const unpaused = bench()
    unpaused.pauses.recordDecision({ pauseId: unpaused.pauseId, change: 'api', decision: 'continue', detail: {}, commandId: 'cmd-2' })
    const decided = refusalOf(await unpaused.tool.record(caller, { ...baseInput, commit: unpaused.work.commit }), 'decided pause')
    expect(decided.reason).toBe('no-pause-requested')
    const foreign = bench()
    const stranger = refusalOf(await foreign.tool.record({ kind: 'agent', sessionId: 'someone-else' }, { ...baseInput, commit: foreign.work.commit }), 'foreign caller')
    expect(stranger.reason).toBe('no-pause-requested')
    const withdrawn = bench('attempt', { withdrawn: true })
    const gone = refusalOf(await withdrawn.tool.record(caller, { ...baseInput, commit: withdrawn.work.commit }), 'withdrawn target')
    expect(gone.reason).toBe('no-pause-requested')
    for (const b of [unpaused, foreign, withdrawn]) {
      expect(checkpointCount(b).n).toBe(0)
      expect(effectCount(b)).toBe(0)
    }
  })

  test('an attempt target without a commit is refused; a review target without one leaves notes', async () => {
    const attempt = bench('attempt')
    const missing = refusalOf(await attempt.tool.record(caller, baseInput), 'missing commit')
    expect(missing.reason).toBe('commit-required')
    expect(checkpointCount(attempt).n).toBe(0)
    expect(effectCount(attempt)).toBe(0)
    const review = bench('review')
    const notes = okOutcome(await review.tool.record(caller, baseInput), 'notes')
    expect(notes.effectId).toBeNull()
    const stored = review.checkpoints.newest(review.pauseId, 'api')!
    expect(stored.kind).toBe('notes')
    expect(stored.commitSha).toBeNull()
    expect(freshRow(review).state).toBe('implementing')
  })

  test('a commit that is not the branch head, or a dirty worktree, is refused and writes nothing', async () => {
    const bench1 = bench()
    const notHead = refusalOf(await bench1.tool.record(caller, { ...baseInput, commit: revParse('origin/master', world.repo) }), 'not the head')
    expect(notHead.reason).toBe('not-branch-head')
    expect(notHead.message).toContain(bench1.work.branch)
    const dirty = bench()
    fs.writeFileSync(path.join(dirty.work.cwd, 'scratch.ts'), 'unfinished\n')
    const messy = refusalOf(await dirty.tool.record(caller, { ...baseInput, commit: dirty.work.commit }), 'dirty worktree')
    expect(messy.reason).toBe('dirty-worktree')
    expect(messy.message).toContain('scratch.ts')
    expect(messy.message).toContain('ignored files are excluded')
    for (const b of [bench1, dirty]) {
      expect(checkpointCount(b).n).toBe(0)
      expect(effectCount(b)).toBe(0)
    }
  })

  test('a failed status read is refused and writes nothing', async () => {
    const unreadable = bench()
    const gitDir = git(['rev-parse', '--absolute-git-dir'], unreadable.work.cwd).trim()
    fs.chmodSync(path.join(gitDir, 'index'), 0o000)
    try {
      const failed = refusalOf(await unreadable.tool.record(caller, { ...baseInput, commit: unreadable.work.commit }), 'unreadable index')
      expect(failed.reason).toBe('dirty-worktree')
      expect(failed.message).toContain('Reading the worktree state failed')
      expect(failed.message).toContain('Permission denied')
    } finally {
      fs.chmodSync(path.join(gitDir, 'index'), 0o644)
    }
    expect(checkpointCount(unreadable).n).toBe(0)
    expect(effectCount(unreadable)).toBe(0)
  })

  test('an origin read failure is refused and writes nothing', async () => {
    const unreachable = bench()
    // The remote is repo-wide config; re-pointed at an unreachable path here
    // and restored in the finally (a `remote remove` would drop the tracking
    // refs later benches read as `origin/master`).
    git(['remote', 'set-url', 'origin', path.join(world.root, 'unreachable-origin.git')], world.repo)
    try {
      const failed = refusalOf(await unreachable.tool.record(caller, { ...baseInput, commit: unreachable.work.commit }), 'no origin')
      expect(failed.reason).toBe('not-contains-origin')
      expect(failed.message).toContain("Reading origin's")
      expect(failed.message).toContain('does not appear')
    } finally {
      git(['remote', 'set-url', 'origin', origin], world.repo)
    }
    expect(checkpointCount(unreachable).n).toBe(0)
    expect(effectCount(unreachable)).toBe(0)
  })

  test('a commit that does not contain origin head, or Kawai writing the branch, is refused', async () => {
    const diverged = bench()
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'origin moves on'], world.repo)
    git(['push', '-q', 'origin', `master:refs/heads/${diverged.work.branch}`], world.repo)
    const behind = refusalOf(await diverged.tool.record(caller, { ...baseInput, commit: diverged.work.commit }), 'diverged origin')
    expect(behind.reason).toBe('not-contains-origin')
    const writing = bench()
    writing.executions.transition(writing.executionId, 'api', freshRow(writing), { state: 'landing', step: 'merging' })
    const busy = refusalOf(await writing.tool.record(caller, { ...baseInput, commit: writing.work.commit }), 'landing merge')
    expect(busy.reason).toBe('kawai-writing')
    for (const b of [diverged, writing]) {
      expect(checkpointCount(b).n).toBe(0)
      expect(effectCount(b)).toBe(0)
    }
  })
})

describe('push-checkpoint effect (D7)', () => {
  test('a valid call records, enqueues under its own key, and pushes without force', async () => {
    const bench1 = bench()
    const pushed = okOutcome(await bench1.tool.record(caller, { ...baseInput, commit: bench1.work.commit }), 'record')
    const effect = bench1.executions.effect(pushed.effectId!)!
    expect(effect.kind).toBe('push-checkpoint')
    expect(effect.roundId).toBe(pushed.checkpointId)
    expect(effect.command).toEqual({ cwd: bench1.work.cwd, commit: bench1.work.commit, branch: bench1.work.branch })
    expect(effect.effectKey).toBe(`${bench1.executionId}:api:push-checkpoint:${pushed.checkpointId}:1`)
    await runEffect(bench1, pushed.effectId!)
    expect(git(['ls-remote', origin, `refs/heads/${bench1.work.branch}`], world.repo).trim().split(/\s+/)[0]).toBe(bench1.work.commit)
    const settled = bench1.executions.effect(pushed.effectId!)!
    expect(settled.state).toBe('done')
    expect(freshRow(bench1).state).toBe('implementing')
    const stored = bench1.checkpoints.newest(bench1.pauseId, 'api')!
    expect(stored.kind).toBe('commit')
    expect(stored.effectId).toBe(pushed.effectId)
    expect(stored.baselineCommit).toBe(bench1.work.base)
    expect(stored.manifestHash).toBe('mh')
    expect(bench1.pauses.target(bench1.pauseId, 'api')!.checkpointId).toBe(pushed.checkpointId)
    // A second record supersedes the first and pushes its own commit under a new key.
    fs.writeFileSync(path.join(bench1.work.cwd, 'work.ts'), 'export const api = 2\n')
    git(['add', '-A'], bench1.work.cwd)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'progress'], bench1.work.cwd)
    const second = okOutcome(await bench1.tool.record(caller, { ...baseInput, commit: revParse('HEAD', bench1.work.cwd) }), 're-record')
    const older = bench1.checkpoints.get(pushed.checkpointId)!
    expect(older.supersededBy).toBe(second.checkpointId)
    expect(bench1.executions.effect(second.effectId!)!.effectKey).not.toBe(effect.effectKey)
    await runEffect(bench1, second.effectId!)
    expect(git(['ls-remote', origin, `refs/heads/${bench1.work.branch}`], world.repo).trim().split(/\s+/)[0]).toBe(revParse('HEAD', bench1.work.cwd))
    expect(bench1.pauses.target(bench1.pauseId, 'api')!.checkpointId).toBe(second.checkpointId)
  })

  test('a diverged origin fails the push and never forces; the change keeps running', async () => {
    const bench1 = bench()
    const pushed = okOutcome(await bench1.tool.record(caller, { ...baseInput, commit: bench1.work.commit }), 'record')
    // origin moves to a commit the checkpoint does not contain.
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'origin moves on'], world.repo)
    const foreign = revParse('master', world.repo)
    git(['push', '-q', 'origin', `master:refs/heads/${bench1.work.branch}`], world.repo)
    await runEffect(bench1, pushed.effectId!)
    const settled = bench1.executions.effect(pushed.effectId!)!
    expect(settled.state).toBe('failed')
    expect(git(['ls-remote', origin, `refs/heads/${bench1.work.branch}`], world.repo).trim().split(/\s+/)[0]).toBe(foreign)
    expect(freshRow(bench1).state).toBe('implementing')
    expect(freshRow(bench1).stopReason).toBeNull()
  })

  test('a never-pushed branch records and pushes without force', async () => {
    const fresh = bench()
    // Origin has never seen the change's branch: no head to contain, so the record is allowed.
    expect(git(['ls-remote', origin, `refs/heads/${fresh.work.branch}`], world.repo).trim()).toBe('')
    const pushed = okOutcome(await fresh.tool.record(caller, { ...baseInput, commit: fresh.work.commit }), 'never pushed')
    await runEffect(fresh, pushed.effectId!)
    expect(git(['ls-remote', origin, `refs/heads/${fresh.work.branch}`], world.repo).trim().split(/\s+/)[0]).toBe(fresh.work.commit)
    expect(fresh.executions.effect(pushed.effectId!)!.state).toBe('done')
    expect(fresh.pauses.target(fresh.pauseId, 'api')!.checkpointId).toBe(pushed.checkpointId)
  })

  test('a restart inspects the unknown effect first: pushed means done, unreadable never stops the change', async () => {
    const pushed = bench()
    const recorded = okOutcome(await pushed.tool.record(caller, { ...baseInput, commit: pushed.work.commit }), 'record')
    pushed.executions.markEffectRunning(recorded.effectId!)
    pushed.executions.markRunningEffectsUnknown()
    // The holder pushed by hand before the restart: the inspection records done.
    git(['push', '-q', origin, `refs/heads/${pushed.work.branch}:refs/heads/${pushed.work.branch}`], pushed.work.cwd)
    await recoverUnknownEffects({ store: pushed.executions, reads: realReads() })
    expect(pushed.executions.effect(recorded.effectId!)!.state).toBe('done')
    expect(freshRow(pushed).state).toBe('implementing')
    const dark = bench()
    const record = okOutcome(await dark.tool.record(caller, { ...baseInput, commit: dark.work.commit }), 'record')
    dark.executions.markEffectRunning(record.effectId!)
    dark.executions.markRunningEffectsUnknown()
    let now = Date.now()
    const failing = { ...realReads(), remoteHead: async () => { throw new Error('origin unreachable') } }
    for (let pass = 0; pass < 4; pass++) {
      await inspectDueUnknownEffects({ store: dark.executions, reads: failing, now: () => new Date(now) })
      now += 11 * 60_000
    }
    expect(dark.executions.effect(record.effectId!)!.state).toBe('failed')
    expect(freshRow(dark).state).toBe('implementing')
    expect(freshRow(dark).stopReason).toBeNull()
  })

  test('a failed round push still stops its change; the checkpoint kind never does', () => {
    const stopped = bench()
    const effect = { id: 'effect-round', kind: 'push', change: 'api', roundId: 'round-1', executionId: stopped.executionId, state: 'failed', outcome: null, error: 'push rejected' }
    applyEffectFailure(outcomeDeps(stopped), effect)
    expect(freshRow(stopped).state).toBe('stopped')
    expect(freshRow(stopped).stopReason).toBe('effect-failed')
    const kept = bench()
    const checkpointEffect = { id: 'effect-cp', kind: 'push-checkpoint', change: 'api', roundId: 'checkpoint-1', executionId: kept.executionId, state: 'failed', outcome: null, error: 'push rejected' }
    applyEffectFailure(outcomeDeps(kept), checkpointEffect)
    expect(freshRow(kept).state).toBe('implementing')
    expect(freshRow(kept).stopReason).toBeNull()
  })
})

describe('a result counts (D7)', () => {
  test('a done round push records the result checkpoint; the holder record wins', async () => {
    const bench1 = bench()
    bench1.db.db.prepare("INSERT INTO team_task_results (id, team_id, task_id, summary, commit_ref, tests, task_revision, submitted_by_kind, submitted_by_session, created_at) VALUES ('result-1', ?, 'task-x', 'done', ?, '[]', 1, 'agent', 'dev', ?)")
      .run(world.team.teamId, bench1.work.commit, new Date().toISOString())
    bench1.resultsById.set('result-1', { sessionId: 'dev' })
    const { round } = bench1.executions.insertRound({
      executionId: bench1.executionId, change: 'api', attemptId: bench1.executions.attempts(bench1.executionId, 'api')[0]!.id,
      resultId: 'result-1', commitSha: bench1.work.commit, fixRound: false,
    })
    // The wired follow-on (executorOutcomes): the push's done outcome records the checkpoint.
    const recorded: string[] = []
    applyEffectOutcome(outcomeDeps(bench1, { recordResultCheckpoint: (executionId, change, roundId) => { recorded.push(`${executionId}:${change}:${roundId}`); bench1.tool.recordResultCheckpoint(executionId, change, roundId) } }),
      { id: 'effect-push', kind: 'push', change: 'api', roundId: round.id, executionId: bench1.executionId, state: 'done', outcome: {}, error: null })
    expect(recorded).toEqual([`${bench1.executionId}:api:${round.id}`])
    const checkpoint = bench1.checkpoints.newest(bench1.pauseId, 'api')!
    expect(checkpoint.kind).toBe('result')
    expect(checkpoint.resultId).toBe('result-1')
    expect(checkpoint.sessionId).toBe('dev')
    expect(checkpoint.commitSha).toBe(bench1.work.commit)
    expect(bench1.pauses.target(bench1.pauseId, 'api')!.checkpointId).toBe(checkpoint.id)
    // Another round's push never supersedes the holder's own record.
    const second = bench1.executions.insertRound({
      executionId: bench1.executionId, change: 'api', attemptId: bench1.executions.attempts(bench1.executionId, 'api')[0]!.id,
      resultId: 'result-2', commitSha: bench1.work.commit, fixRound: false,
    })
    bench1.tool.recordResultCheckpoint(bench1.executionId, 'api', second.round.id)
    expect(bench1.checkpoints.forTarget(bench1.pauseId, 'api').length).toBe(1)
    expect(bench1.pauses.target(bench1.pauseId, 'api')!.checkpointId).toBe(checkpoint.id)
  })

  test('a result counts nowhere without an open uncheckpointed target of that change', () => {
    const quiet = bench()
    quiet.executions.insertRound({
      executionId: quiet.executionId, change: 'api', attemptId: quiet.executions.attempts(quiet.executionId, 'api')[0]!.id,
      resultId: 'result-1', commitSha: quiet.work.commit, fixRound: false,
    })
    quiet.tool.recordResultCheckpoint(quiet.executionId, 'api', 'round-none')
    expect(checkpointCount(quiet).n).toBe(0)
    const pausedTarget = bench('attempt', { withdrawn: true })
    pausedTarget.executions.insertRound({
      executionId: pausedTarget.executionId, change: 'api', attemptId: pausedTarget.executions.attempts(pausedTarget.executionId, 'api')[0]!.id,
      resultId: 'result-1', commitSha: pausedTarget.work.commit, fixRound: false,
    })
    pausedTarget.tool.recordResultCheckpoint(pausedTarget.executionId, 'api', pausedTarget.executions.rounds(pausedTarget.executionId, 'api')[0]!.id)
    expect(checkpointCount(pausedTarget).n).toBe(0)
  })
})

describe('the tool joins the team table (D7)', () => {
  test('task_checkpoint is registered, allowed, and bound to the caller', async () => {
    const mail = new MailboxStore(initDatabase({ path: path.join(fs.mkdtempSync(path.join(world.root, 'db-')), 'mail.db') }).db)
    const bench1 = bench()
    const table = teamToolTable(new TeamMailbox(mail, { getSession: () => null }), 'dev', { checkpoints: bench1.tool })
    const spec = table.find(entry => entry.name === 'task_checkpoint')
    expect(spec).toBeDefined()
    expect(TEAM_ALLOWED_TOOLS).toContain('mcp__kawai-team__task_checkpoint')
    // Identity is bound in the handler: a forged session id in the input never reaches the tool.
    const answer = await spec!.handler({ task_id: 'task-x', summary: 's', next_steps: 'n', commit: bench1.work.commit, session_id: 'someone-else' })
    expect((answer as { ok: boolean }).ok).toBe(true)
    expect(bench1.pauses.target(bench1.pauseId, 'api')!.checkpointId).not.toBeNull()
  })
})
