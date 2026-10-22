// The executor tick's pause pass (revision-control 4.3, design D8): the owed
// pause mail delivered once through the pause service, Paused recorded from
// stored rows and live holder facts only through the guarded write when the
// work is on `origin` and the holder is ready — a review at once, a pushed
// checkpoint for an attempt — and a settled pause closed, the execution's
// finish reading every undecided target `cancelled`. A restart between the
// claim and the tick rebuilds the pass over the same database and repeats
// nothing (the B5 pattern). The last describe proves the wiring through
// `composePlanServices` — the construction the server runs.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { FloorMap } from '../../shared/planExecution'
import type { PlanHold } from '../../shared/planRevisionControl'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { initDatabase } from '../db'
import { PlanStore } from '../plans/planStore'
import { sessionRow, createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { ExecutionStore } from '../plans/execution/executionStore'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { PauseService, PLAN_PAUSE_TAG } from '../plans/revisionControl/pauseService'
import { CheckpointStore } from '../plans/revisionControl/checkpointStore'
import { derivePauseTarget, runPauseTick, type PauseHolderRuntimeFacts, type PauseTickDeps } from '../plans/revisionControl/pauseTick'

let world: PlanWorld
let bench: PlanBench
const START = Date.UTC(2026, 10, 1, 12, 0, 0)
let clock = START
const now = () => new Date(clock)
const inDays = (days: number): string => new Date(START + days * 24 * 60 * 60 * 1000).toISOString()

let holds: HoldStore
let pauses: PauseStore
let checkpoints: CheckpointStore
let executions: ExecutionStore
let service: PauseService
let teamId: string
let planCounter = 0
let dispatchCounter = 0

/** The controlled holder facts and member-release answers the tests set per case. */
const holderStates = new Map<string, PauseHolderRuntimeFacts>()
const readinessAnswers = new Map<string, { ready: boolean; reason: string | null }>()

const factsOf = (sessionId: string): PauseHolderRuntimeFacts =>
  holderStates.get(sessionId) ?? { state: 'live', pendingRequest: false, busy: false, providerLimit: null }
const readiness = (sessionId: string): { ready: boolean; reason: string | null } =>
  readinessAnswers.get(sessionId) ?? { ready: true, reason: null }

const tickDeps = (db = bench.db.db, owed = service): PauseTickDeps => ({
  pauses: new PauseStore(db, now),
  checkpoints: new CheckpointStore(db, now),
  executions: new ExecutionStore(db),
  mailbox: bench.mail,
  deliverOwed: (id, root, pauseId) => owed.deliverOwed(id, root, pauseId),
  assignmentMessageState: assignmentId => bench.assignmentStore.byId(assignmentId)?.messageId != null
    ? bench.mail.get(bench.assignmentStore.byId(assignmentId)!.messageId!)?.state ?? null
    : null,
  readiness,
  factsOf,
  now,
})

const tick = (deps: PauseTickDeps = tickDeps()): void => runPauseTick(deps, teamId, world.repo)

/** One target's derived state after a pass, read the way the view (D14) will. */
const stateOf = (deps: PauseTickDeps, pauseId: string, change: string): ReturnType<typeof derivePauseTarget>['state'] => {
  const pause = deps.pauses.get(teamId, pauseId)!
  const target = deps.pauses.target(pauseId, change)!
  const finished = deps.executions.execution(pause.executionId) !== null && deps.executions.execution(pause.executionId)!.state !== 'running'
  return derivePauseTarget(deps, pause, target, finished, now()).state
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-pause-tick-')
  bench = createPlanBench(world)
  teamId = world.team.teamId
  bench.records.set('dev2', sessionRow('dev2', 'middle-devs', world.feature))
  holds = new HoldStore(bench.db.db, now)
  pauses = new PauseStore(bench.db.db, now)
  checkpoints = new CheckpointStore(bench.db.db, now)
  executions = new ExecutionStore(bench.db.db)
  service = new PauseService({
    pauses, holds, plans: bench.plans, planService: bench.service, executions,
    assignments: bench.assignmentStore, mailbox: bench.mail,
    sessionExists: id => bench.records.has(id), now,
  })
})

// One bench serves the whole file: clear the per-case seams so no case's
// holder state leaks into the next.
beforeEach(() => {
  holderStates.clear()
  readinessAnswers.clear()
})

afterAll(() => {
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

function expectOk<T>(outcome: { ok: boolean; message?: string; result?: T }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : outcome.message)
  return outcome.result
}

async function executionWith(changes: string[]): Promise<{ planId: string; executionId: string }> {
  for (const row of executions.ownedChanges(teamId)) executions.finishExecution(row.executionId, 'completed')
  const draft = await bench.draftInReview()
  const approved = await bench.approve(draft.planId, draft.revision, `approve-tick-${++planCounter}`)
  if (!approved.ok) throw new Error(approved.message)
  const execution = executions.insertExecution({
    teamId, planId: draft.planId, revision: draft.revision, contentHash: 'hash-exec', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: {} as FloorMap },
    maxParallel: 3, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  })
  return { planId: draft.planId, executionId: execution.id }
}

const manifest = () => ({
  version: 1 as const, plan: { id: 'p', revision: 1, contentHash: 'h' }, execution: 'e', task: { id: 't', revision: 1 },
  validation: { reportId: 'r', inputHash: 'i' }, baseline: 'b', startCommit: 's', artifacts: {}, roleProfiles: [],
})

/** A change with a task, an instruction, an assignment, an attempt, and `implementing` state. */
async function inFlight(executionId: string, change: string, holder = 'dev', claim: 'claim' | 'spawning' = 'claim'): Promise<{ taskId: string; mailId: string }> {
  const task = bench.tasks.create({ teamId, title: `${change} work`, direction: 'Build it', creator: { kind: 'human', sessionId: null } })
  const message = bench.mail.enqueue({
    teamId, toKind: 'session', toId: holder, fromKind: 'human', fromSession: null, fromGroup: null,
    originPath: world.repo, body: `Build ${change}.`, taskId: task.id, actor: 'human',
  })
  const inserted = bench.assignmentStore.insert({
    teamId, taskId: task.id, requestKey: `rk-${change}-${++dispatchCounter}`, targetKind: 'session', targetId: holder,
    role: null, instruction: `Build ${change}.`, creator: { kind: 'human', sessionId: null }, messageId: message.id,
  })
  if (claim === 'claim') {
    bench.mail.claim(message.id, holder)
    bench.mail.markPushed(message.id)
    bench.mail.markDelivered(message.id)
  } else {
    bench.mail.reserveForSpawn(message.id)
  }
  executions.insertAttempt({ executionId, change, kind: 'implement', assignmentId: inserted.assignment.id, manifest: manifest(), manifestHash: 'mh' })
  const row = executions.change(executionId, change)!
  const updated = executions.transition(executionId, change, row, { state: 'implementing', worktree: world.repo, branch: `${change}-branch`, taskId: task.id })
  if (!updated) throw new Error('the transition to implementing failed')
  return { taskId: task.id, mailId: message.id }
}

const placeHold = (planId: string, changes: string[], commandId: string): PlanHold =>
  holds.insert({ teamId, planId, scope: 'changes', rationale: 'rethink the direction', deadline: inDays(10), cites: null, commandId, changes })

const pause = (planId: string, holdId: string, commandId: string) =>
  expectOk(service.pause(bench.human, { planId, holdId, deadline: inDays(2), commandId })).pause

const pauseMails = (taskId: string): number =>
  bench.mail.forTask(taskId).filter(message => message.tags.includes(PLAN_PAUSE_TAG)).length

/** Settle the target's pause mail's receipt, so `awaiting-delivery` stops applying. */
function deliverPauseMail(pauseId: string, change: string): void {
  const target = pauses.target(pauseId, change)!
  if (target.messageId === null) throw new Error('the target has no pause mail yet')
  bench.mail.claim(target.messageId, target.holderSession ?? 'dev')
  bench.mail.markPushed(target.messageId)
  bench.mail.markDelivered(target.messageId)
}

/** A `commit` checkpoint with its push-checkpoint effect, settled to `state` (the rows the tool writes, D7). */
function pushedCheckpoint(executionId: string, pauseId: string, change: string, state: 'pending' | 'done' | 'failed' | 'unknown' | 'cancelled'): void {
  const checkpoint = checkpoints.insert({
    executionId, change, pauseId, attemptId: null, sessionId: 'dev', kind: 'commit', commitSha: 'c1',
    baselineCommit: null, manifestHash: null, resultId: null, summary: 'where it stands', unfinished: null,
    errorsTests: null, nextSteps: '', effectId: null,
  })
  const effect = executions.insertEffect({
    executionId, change, roundId: checkpoint.id, kind: 'push-checkpoint',
    effectKey: `${executionId}:${change}:push-checkpoint:${checkpoint.id}:1`,
    command: { cwd: world.repo, commit: 'c1', branch: `${change}-branch` },
  })
  checkpoints.setEffect(checkpoint.id, effect.id)
  if (state !== 'pending') executions.setEffectOutcome(effect.id, { state })
  pauses.setCheckpoint(pauseId, change, checkpoint.id)
}

describe("the executor tick's pause pass (D8)", () => {
  test('a review target records Paused at once: its work is on origin and the holder is ready', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const row = executions.change(executionId, 'api')!
    expect(executions.transition(executionId, 'api', row, { state: 'gating', step: 'reviewing' })).not.toBeNull()
    const hold = placeHold(planId, ['api'], 'pt-h1')
    const pauseRow = pause(planId, hold.id, 'pt-1')
    expect(pauses.target(pauseRow.id, 'api')!.pausedAt).toBeNull()
    tick()
    const target = pauses.target(pauseRow.id, 'api')!
    expect(target.pausedAt).toBe(now().toISOString())
    expect(stateOf(tickDeps(), pauseRow.id, 'api')).toEqual({ state: 'paused' })
  })

  test('checkpoint pushed but the holder busy stays Pausing with the busy cause', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api'], 'pt-h2')
    const pauseRow = pause(planId, hold.id, 'pt-2')
    pushedCheckpoint(executionId, pauseRow.id, 'api', 'done')
    deliverPauseMail(pauseRow.id, 'api')
    holderStates.set('dev', { state: 'live', pendingRequest: false, busy: true, providerLimit: null })
    // Member release reads the same turn: a busy holder is not ready, so the
    // pushed checkpoint alone never records Paused.
    readinessAnswers.set('dev', { ready: false, reason: 'it is busy' })
    tick()
    const target = pauses.target(pauseRow.id, 'api')!
    expect(target.pausedAt).toBeNull()
    const state = stateOf(tickDeps(), pauseRow.id, 'api')
    if (state.state !== 'pausing') throw new Error(`expected pausing, got ${state.state}`)
    expect(state.causes).toEqual([{ kind: 'busy' }, { kind: 'readiness', reason: 'it is busy' }])
  })

  test('a pending approval stays pending and reads Pausing as request (R11)', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api'], 'pt-h3')
    const pauseRow = pause(planId, hold.id, 'pt-3')
    deliverPauseMail(pauseRow.id, 'api')
    holderStates.set('dev', { state: 'live', pendingRequest: true, busy: false, providerLimit: null })
    readinessAnswers.set('dev', { ready: false, reason: 'it is awaiting an approval or answer' })
    tick()
    expect(pauses.target(pauseRow.id, 'api')!.pausedAt).toBeNull()
    const state = stateOf(tickDeps(), pauseRow.id, 'api')
    if (state.state !== 'pausing') throw new Error(`expected pausing, got ${state.state}`)
    expect(state.causes).toEqual([
      { kind: 'request' },
      { kind: 'no-checkpoint' },
      { kind: 'readiness', reason: 'it is awaiting an approval or answer' },
    ])
  })

  test('an archived holder counts as ready and records Paused; a killed holder with nothing pushed reads holder-killed', async () => {
    const { planId, executionId } = await executionWith(['api', 'ui'])
    await inFlight(executionId, 'api')
    await inFlight(executionId, 'ui', 'dev2')
    const hold = placeHold(planId, ['api', 'ui'], 'pt-h4')
    const pauseRow = pause(planId, hold.id, 'pt-4')
    pushedCheckpoint(executionId, pauseRow.id, 'api', 'done')
    deliverPauseMail(pauseRow.id, 'api')
    deliverPauseMail(pauseRow.id, 'ui')
    holderStates.set('dev', { state: 'archived', pendingRequest: false, busy: false, providerLimit: null })
    holderStates.set('dev2', { state: 'killed', pendingRequest: false, busy: false, providerLimit: null })
    tick()
    // The archived holder's pushed checkpoint records Paused (D8: archived is ready).
    expect(pauses.target(pauseRow.id, 'api')!.pausedAt).not.toBeNull()
    // The killed holder's unpushed work never records Paused: holder-killed names it.
    expect(pauses.target(pauseRow.id, 'ui')!.pausedAt).toBeNull()
    const state = stateOf(tickDeps(), pauseRow.id, 'ui')
    if (state.state !== 'pausing') throw new Error(`expected pausing, got ${state.state}`)
    expect(state.causes).toEqual([{ kind: 'no-checkpoint' }, { kind: 'holder-killed' }])
    expect(state.ownerRequired).toBe(true)
  })

  test('a parked or cooling holder reads provider-limit with its reset', async () => {
    const { planId, executionId } = await executionWith(['api', 'ui'])
    await inFlight(executionId, 'api')
    await inFlight(executionId, 'ui', 'dev2')
    const hold = placeHold(planId, ['api', 'ui'], 'pt-h5')
    const pauseRow = pause(planId, hold.id, 'pt-5')
    deliverPauseMail(pauseRow.id, 'api')
    deliverPauseMail(pauseRow.id, 'ui')
    // Cooling, nothing pushed yet: Pausing names the profile and its reset.
    holderStates.set('dev', { state: 'live', pendingRequest: false, busy: false, providerLimit: { profile: 'glm', resetAt: inDays(1) } })
    tick()
    expect(pauses.target(pauseRow.id, 'api')!.pausedAt).toBeNull()
    const cooling = stateOf(tickDeps(), pauseRow.id, 'api')
    if (cooling.state !== 'pausing') throw new Error(`expected pausing, got ${cooling.state}`)
    expect(cooling.causes).toContainEqual({ kind: 'provider-limit', profile: 'glm', resetAt: inDays(1) })
    // Parked, checkpoint pushed: the parked work holds member release, and
    // the resume names the reset (D6).
    pushedCheckpoint(executionId, pauseRow.id, 'ui', 'done')
    holderStates.set('dev2', { state: 'live', pendingRequest: false, busy: false, providerLimit: { profile: 'glm', resetAt: inDays(1) } })
    readinessAnswers.set('dev2', { ready: false, reason: 'it holds parked work (a mailbox manager can cancel it with cancel_message, or the human can cancel or hand it off)' })
    tick()
    expect(pauses.target(pauseRow.id, 'ui')!.pausedAt).toBeNull()
    const parked = stateOf(tickDeps(), pauseRow.id, 'ui')
    if (parked.state !== 'pausing') throw new Error(`expected pausing, got ${parked.state}`)
    expect(parked.causes).toContainEqual({ kind: 'provider-limit', profile: 'glm', resetAt: inDays(1) })
    // The pause mail is never refused for cooling (D6): exactly one mail,
    // sent at the pause, never dead-lettered over the cooling profile.
    const task = executions.change(executionId, 'api')!.taskId!
    const mails = bench.mail.forTask(task).filter(message => message.tags.includes(PLAN_PAUSE_TAG))
    expect(mails).toHaveLength(1)
    expect(mails[0]!.state).not.toBe('dead')
  })

  test('Paused is recorded once: the guarded write keeps the first fact across ticks', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const row = executions.change(executionId, 'api')!
    expect(executions.transition(executionId, 'api', row, { state: 'gating', step: 'reviewing' })).not.toBeNull()
    const hold = placeHold(planId, ['api'], 'pt-h6')
    const pauseRow = pause(planId, hold.id, 'pt-6')
    tick()
    const first = pauses.target(pauseRow.id, 'api')!.pausedAt
    expect(first).not.toBeNull()
    clock += 5_000
    tick()
    tick()
    expect(pauses.target(pauseRow.id, 'api')!.pausedAt).toBe(first)
  })

  test('a finished execution reads every undecided target cancelled and closes the pause', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const row = executions.change(executionId, 'api')!
    expect(executions.transition(executionId, 'api', row, { state: 'gating', step: 'reviewing' })).not.toBeNull()
    const hold = placeHold(planId, ['api'], 'pt-h7')
    const pauseRow = pause(planId, hold.id, 'pt-7')
    holderStates.set('dev', { state: 'live', pendingRequest: true, busy: false, providerLimit: null })
    executions.finishExecution(executionId, 'stopped')
    tick()
    expect(pauses.target(pauseRow.id, 'api')!.decision).toBeNull()
    expect(stateOf(tickDeps(), pauseRow.id, 'api')).toEqual({ state: 'decided', decision: 'cancelled' })
    expect(pauses.get(teamId, pauseRow.id)!.closedAt).not.toBeNull()
    // A closed pause's pass is over: another tick writes nothing.
    clock += 5_000
    tick()
    expect(pauses.get(teamId, pauseRow.id)!.closedAt).not.toBeNull()
  })

  test('the tick delivers a spawning target’s owed mail once its claim lands, once only', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api', 'dev', 'spawning')
    const hold = placeHold(planId, ['api'], 'pt-h8')
    const pauseRow = pause(planId, hold.id, 'pt-8')
    expect(pauses.target(pauseRow.id, 'api')).toMatchObject({ holderSession: null, messageId: null })
    expect(pauseMails(api.taskId)).toBe(0)
    tick()
    expect(pauseMails(api.taskId)).toBe(0)
    // The claim lands; the next pass mails once, and a repeat sends nothing.
    bench.mail.claimSpawned(api.mailId, 'dev')
    tick()
    expect(pauseMails(api.taskId)).toBe(1)
    clock += 5_000
    tick()
    expect(pauseMails(api.taskId)).toBe(1)
    expect(pauses.target(pauseRow.id, 'api')!.holderSession).toBe('dev')
  })

  test('an unclaimed forward successor is not a spawn: spawnUnclaimed stays false (F5)', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api')
    // A provider limit forwarded the work: the original mail reads
    // forwarded, and the handoff reply to a fresh holder is still queued —
    // no claim, so the pause target names no holder.
    const original = bench.mail.get(api.mailId)!
    const successor = bench.mail.enqueue({
      teamId, toKind: 'session', toId: 'dev2', fromKind: 'human', fromSession: null, fromGroup: null,
      originPath: world.repo, body: 'Build api.', taskId: api.taskId, actor: 'system',
      inReplyTo: original, attachThread: true,
      handoff: { fromSession: 'dev', fromProfile: 'glm', claimCommit: null, lastError: 'the profile hit its limit', progress: { toolCalls: 3, tools: ['Read'], filesTouched: [] } },
    })
    bench.mail.markForwarded(api.mailId, `forwarded: ${successor.id}`)
    bench.records.set('dev2', sessionRow('dev2', 'middle-devs', world.feature))
    const hold = placeHold(planId, ['api'], 'pt-h10')
    const pauseRow = pause(planId, hold.id, 'pt-10')
    expect(pauses.target(pauseRow.id, 'api')).toMatchObject({ holderSession: null, messageId: null })
    const factsOfTarget = (): ReturnType<typeof derivePauseTarget>['facts'] => {
      const p = pauses.get(teamId, pauseRow.id)!
      const t = pauses.target(pauseRow.id, 'api')!
      const finished = executions.execution(p.executionId)!.state !== 'running'
      return derivePauseTarget(tickDeps(), p, t, finished, now()).facts
    }
    // The spawn-specific fact never names a forward successor.
    expect(factsOfTarget().spawnUnclaimed).toBe(false)
    // The successor's claim mails the owed pause, as for a spawn.
    bench.mail.claim(successor.id, 'dev2')
    bench.mail.markPushed(successor.id)
    bench.mail.markDelivered(successor.id)
    clock += 5_000
    tick()
    expect(pauses.target(pauseRow.id, 'api')!.holderSession).toBe('dev2')
  })

  test('an unclaimed spawn still reads spawnUnclaimed (F5)', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api', 'dev', 'spawning')
    const hold = placeHold(planId, ['api'], 'pt-h11')
    const pauseRow = pause(planId, hold.id, 'pt-11')
    const p = pauses.get(teamId, pauseRow.id)!
    const t = pauses.target(pauseRow.id, 'api')!
    const facts = derivePauseTarget(tickDeps(), p, t, false, now()).facts
    expect(t.holderSession).toBeNull()
    expect(facts.spawnUnclaimed).toBe(true)
    expect(api.mailId).toBeTruthy()
  })
})

describe('a restart between the claim and the tick (R18, the B5 pattern)', () => {
  test('the rebuilt pass re-derives from the rows alone: one mail, the first Paused fact stands', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const row = executions.change(executionId, 'api')!
    expect(executions.transition(executionId, 'api', row, { state: 'gating', step: 'reviewing' })).not.toBeNull()
    const hold = placeHold(planId, ['api'], 'pt-h9')
    const pauseRow = pause(planId, hold.id, 'pt-9')
    tick()
    const mailed = bench.mail.forTask(row.taskId!).filter(message => message.tags.includes(PLAN_PAUSE_TAG))[0]!
    const firstPausedAt = pauses.target(pauseRow.id, 'api')!.pausedAt
    expect(firstPausedAt).not.toBeNull()
    const sentEvents = (): number =>
      (bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_message_events WHERE message_id = ? AND kind = ?').get(mailed.id, 'sent') as { n: number }).n
    expect(sentEvents()).toBe(1)
    // Reopen the same database through a second connection and rebuild the
    // pass over it — the tick after a restart — with the clock moved, so a
    // rewritten Paused or a second mail would show.
    clock += 5_000
    const reopened = initDatabase({ path: bench.db.db.filename })
    try {
      const mail = new MailboxStore(reopened.db)
      const rebuiltService = new PauseService({
        pauses: new PauseStore(reopened.db, now), holds: new HoldStore(reopened.db, now),
        plans: new PlanStore(reopened.db), planService: bench.service,
        executions: new ExecutionStore(reopened.db),
        assignments: new AssignmentStore(reopened.db, mail), mailbox: mail,
        sessionExists: id => bench.records.has(id), now,
      })
      const deps: PauseTickDeps = {
        pauses: new PauseStore(reopened.db, now), checkpoints: new CheckpointStore(reopened.db, now),
        executions: new ExecutionStore(reopened.db), mailbox: mail,
        deliverOwed: (id, root, pauseId) => rebuiltService.deliverOwed(id, root, pauseId),
        assignmentMessageState: assignmentId => {
          const row = new AssignmentStore(reopened.db, mail).byId(assignmentId)
          return row?.messageId != null ? mail.get(row.messageId)?.state ?? null : null
        },
        readiness, factsOf, now,
      }
      runPauseTick(deps, teamId, world.repo)
      runPauseTick(deps, teamId, world.repo)
      const target = deps.pauses.target(pauseRow.id, 'api')!
      expect(target.pausedAt).toBe(firstPausedAt)
      expect(mail.forTask(row.taskId!).filter(message => message.tags.includes(PLAN_PAUSE_TAG))).toHaveLength(1)
      expect(stateOf(deps, pauseRow.id, 'api')).toEqual({ state: 'paused' })
    } finally {
      reopened.close()
    }
    expect(sentEvents()).toBe(1)
  })
})
