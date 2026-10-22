// The pause service's cooling holder, refusals, replay, and mail body
// (revision-control 4.1, design D6, D3): the enqueue path has no cooldown
// refusal for a parked or cooling holder; a replayed command re-runs nothing
// and sends nothing; the same command id with a different payload, a bad
// state, and an unparsable deadline are each refused writing nothing; and the
// attempt and review mail bodies ask for different things. The targets and
// mail tests live in pauseServiceTargets.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { TeamMessage } from '../../shared/team'
import type { AttemptManifest, FloorMap } from '../../shared/planExecution'
import type { PlanHold } from '../../shared/planRevisionControl'
import { LimitEventStore } from '../team/routing/limitEvents'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { ExecutionStore } from '../plans/execution/executionStore'
import { PauseService, PLAN_PAUSE_TAG, pauseBody, type PauseInput } from '../plans/revisionControl/pauseService'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { pauseTargetState, type PauseTargetFacts, type PauseTargetRecord } from '../plans/revisionControl/pauseState'

let world: PlanWorld
let bench: PlanBench
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)
const now = () => new Date(NOW)
const inDays = (days: number): string => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString()

let holds: HoldStore
let pauses: PauseStore
let executions: ExecutionStore
let limits: LimitEventStore
let service: PauseService
let teamId: string
let wakeCount = 0
let planCounter = 0
let dispatchCounter = 0

const wake = (): void => { wakeCount += 1 }

beforeAll(async () => {
  world = await createPlanWorld('kawai-pause-service-')
  bench = createPlanBench(world)
  teamId = world.team.teamId
  const db = bench.db.db
  holds = new HoldStore(db, now)
  pauses = new PauseStore(db, now)
  executions = new ExecutionStore(db)
  limits = new LimitEventStore(db, () => NOW)
  service = new PauseService({
    pauses, holds, plans: bench.plans, planService: bench.service, executions,
    assignments: bench.assignmentStore, mailbox: bench.mail, sessionExists: id => bench.records.has(id), wake, now,
  })
})

afterAll(() => {
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

function expectOk<T>(outcome: { ok: boolean; message?: string; result?: T }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : outcome.message)
  return outcome.result
}

function refused(outcome: { ok: boolean; reason?: string; message?: string }): { reason: string; message: string } {
  if (outcome.ok) throw new Error('expected a refusal')
  return { reason: outcome.reason ?? '', message: outcome.message ?? '' }
}

async function executionWith(changes: string[]): Promise<{ planId: string; executionId: string }> {
  // A change name is owned by one running execution per team (plan-execution D3);
  // every test builds its own plan, so earlier executions finish first.
  for (const row of executions.ownedChanges(teamId)) executions.finishExecution(row.executionId, 'completed')
  const draft = await bench.draftInReview()
  const approved = await bench.approve(draft.planId, draft.revision, `approve-pause-${++planCounter}`)
  if (!approved.ok) throw new Error(approved.message)
  const execution = executions.insertExecution({
    teamId, planId: draft.planId, revision: draft.revision, contentHash: 'hash-exec', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: {} as FloorMap },
    maxParallel: 3, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  })
  return { planId: draft.planId, executionId: execution.id }
}

const manifest = (): AttemptManifest => ({
  version: 1, plan: { id: 'p', revision: 1, contentHash: 'h' }, execution: 'e', task: { id: 't', revision: 1 },
  validation: { reportId: 'r', inputHash: 'i' }, baseline: 'b', startCommit: 's', artifacts: {}, roleProfiles: [],
})

/** A change with a task, an instruction mail, an assignment, an attempt, and `implementing` state. */
async function inFlight(executionId: string, change: string, holder = 'dev',
  claim: 'claim' | 'spawning' | 'queued' = 'claim'): Promise<{ taskId: string; mailId: string; assignmentId: string }> {
  const task = bench.tasks.create({ teamId, title: `${change} work`, direction: 'Build it', creator: { kind: 'human', sessionId: null } })
  const message = bench.mail.enqueue({
    teamId, toKind: 'session', toId: holder, fromKind: 'human', fromSession: null, fromGroup: null,
    originPath: world.repo, body: `Build ${change}.`, taskId: task.id, actor: 'human',
  })
  const inserted = bench.assignmentStore.insert({
    teamId, taskId: task.id, requestKey: `rk-${change}-${++dispatchCounter}`, targetKind: 'session', targetId: holder,
    role: null, instruction: `Build ${change}.`, creator: { kind: 'human', sessionId: null }, messageId: message.id,
  })
  if (claim === 'claim') bench.mail.claim(message.id, holder)
  else if (claim === 'spawning') bench.mail.reserveForSpawn(message.id)
  executions.insertAttempt({ executionId, change, kind: 'implement', assignmentId: inserted.assignment.id, manifest: manifest(), manifestHash: 'mh' })
  const row = executions.change(executionId, change)!
  const updated = executions.transition(executionId, change, row, { state: 'implementing', worktree: world.repo, branch: `${change}-branch`, taskId: task.id })
  if (!updated) throw new Error('the transition to implementing failed')
  return { taskId: task.id, mailId: message.id, assignmentId: inserted.assignment.id }
}

const placeHold = (planId: string, changes: string[], commandId: string): PlanHold =>
  holds.insert({ teamId, planId, scope: 'changes', rationale: 'rethink the direction', deadline: inDays(10), cites: null, commandId, changes })

const pause = (input: Partial<PauseInput> & { planId: string; holdId: string; commandId: string }) =>
  service.pause(bench.human, { deadline: inDays(2), ...input })

const pauseMails = (taskId: string): TeamMessage[] =>
  bench.mail.forTask(taskId).filter(message => message.tags.includes(PLAN_PAUSE_TAG))

describe('a parked or cooling holder (D6)', () => {
  test('a final limit event on the holder profile still queues exactly one plan-pause mail', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api')
    limits.record({
      profileId: 'glm', sessionId: 'dev', groupId: 'middle-devs', kind: 'rate_limit', final: true, status: 429,
      message: 'limit reached', resetsAt: inDays(1), providerId: 'zai', window: 'five_hour',
    })
    const hold = placeHold(planId, ['api'], 'pa-h9')
    const outcome = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-9' }))
    expect(pauses.targets(outcome.pause.id)[0].holderSession).toBe('dev')
    const mails = pauseMails(api.taskId)
    expect(mails).toHaveLength(1)
    expect(mails[0].state).toBe('queued')
  })

  test('the pure target state reads the cooling holder as Pausing with the provider-limit cause', () => {
    const record: PauseTargetRecord = {
      stage: 'attempt', holderSession: 'dev', withdrawn: false, pausedAt: null, decision: null,
      checkpointKind: null, pushEffectState: null,
    }
    const facts: PauseTargetFacts = {
      executionFinished: false, messageDelivered: false, spawnUnclaimed: false, pendingRequest: false, busy: false,
      providerLimit: { profile: 'glm', resetAt: inDays(1) }, holder: 'live', readiness: { ready: true, reasons: [] },
      deadlinePassed: false,
    }
    const state = pauseTargetState(record, facts)
    if (state.state !== 'pausing') throw new Error(`expected pausing, got ${state.state}`)
    expect(state.causes).toContainEqual({ kind: 'provider-limit', profile: 'glm', resetAt: inDays(1) })
  })
})

describe('refusals, replay, and payload identity (D3)', () => {
  test('an agent caller is refused and nothing is written', async () => {
    const { planId, executionId } = await executionWith(['api'])
    const api = await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api'], 'pa-h10')
    const outcome = refused(service.pause(bench.agent('dev'), { planId, holdId: hold.id, deadline: inDays(2), commandId: 'pa-10' }))
    expect(outcome.reason).toBe('forbidden')
    expect(bench.plans.eventByCommand(planId, 'pa-10')).toBeNull()
    expect(pauses.forPlan(teamId, planId)).toHaveLength(0)
    expect(pauseMails(api.taskId)).toHaveLength(0)
  })

  test('a replay returns the prior outcome and sends nothing', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api'], 'pa-h11')
    const first = pause({ planId, holdId: hold.id, note: 'hold on', commandId: 'pa-11' })
    expect(first.ok && !first.replayed).toBe(true)
    const pauseMailCount = () =>
      (bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages WHERE tags LIKE ?').get(`%${PLAN_PAUSE_TAG}%`) as { n: number }).n
    const mailCount = pauseMailCount()
    const before = wakeCount
    const replay = pause({ planId, holdId: hold.id, note: 'hold on', commandId: 'pa-11' })
    expect(replay.ok && replay.replayed).toBe(true)
    expect(replay.result).toBeUndefined()
    expect(pauses.forPlan(teamId, planId)).toHaveLength(1)
    expect(pauseMailCount()).toBe(mailCount)
    expect(wakeCount).toBe(before)
    expect(bench.plans.eventByCommand(planId, 'pa-11')?.event.kind).toBe('pause-requested')
  })

  test('the same command id with a different payload is refused naming the field', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api'], 'pa-h12')
    expect(pause({ planId, holdId: hold.id, note: 'first', commandId: 'pa-12' }).ok).toBe(true)
    const changed = refused(pause({ planId, holdId: hold.id, note: 'second', commandId: 'pa-12' }))
    expect(changed.reason).toBe('payload')
    expect(changed.message).toContain('different note')
  })

  test('state refusals name every failure and write nothing', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api'], 'pa-h13')
    const unknown = refused(pause({ planId, holdId: 'hold-nope', commandId: 'pa-13' }))
    expect(unknown.reason).toBe('not-found')
    const past = refused(pause({ planId, holdId: hold.id, deadline: inDays(-1), commandId: 'pa-14' }))
    expect(past.message).toContain('not in the future')
    const open = expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-15' }))
    const again = refused(pause({ planId, holdId: hold.id, commandId: 'pa-16' }))
    expect(again.message).toContain('an open pause already covers')
    expect(bench.plans.eventByCommand(planId, 'pa-13')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'pa-14')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'pa-16')).toBeNull()
    // A released hold refuses, and so does a plan with no running execution.
    const other = await executionWith(['api'])
    const released = placeHold(other.planId, ['api'], 'pa-h14')
    holds.release({ teamId, holdId: released.id, changes: [], reason: 'done', commandId: 'pa-h14-r' })
    const stopped = refused(pause({ planId: other.planId, holdId: released.id, commandId: 'pa-17' }))
    expect(stopped.message).toContain('is released')
    executions.finishExecution(other.executionId, 'completed')
    const orphanHold = placeHold(other.planId, ['api'], 'pa-h15')
    const noRun = refused(pause({ planId: other.planId, holdId: orphanHold.id, commandId: 'pa-18' }))
    expect(noRun.message).toContain('no running execution')
    expect(bench.plans.eventByCommand(planId, 'pa-15')?.event.kind).toBe('pause-requested')
    void open
  })

  test('a refusal names every failure: no running execution beside an open pause on the hold', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api'], 'pa-hN1')
    expectOk(pause({ planId, holdId: hold.id, commandId: 'pa-n1a' }))
    executions.finishExecution(executionId, 'completed')
    const both = refused(pause({ planId, holdId: hold.id, commandId: 'pa-n1b' }))
    expect(both.reason).toBe('state')
    expect(both.message).toContain('no running execution')
    expect(both.message).toContain('an open pause already covers')
  })

  test('an unparsable deadline is an invalid refusal written nowhere', async () => {
    const { planId, executionId } = await executionWith(['api'])
    await inFlight(executionId, 'api')
    const hold = placeHold(planId, ['api'], 'pa-h16')
    const outcome = refused(pause({ planId, holdId: hold.id, deadline: 'not-a-date', commandId: 'pa-19' }))
    expect(outcome.reason).toBe('invalid')
    expect(bench.plans.eventByCommand(planId, 'pa-19')).toBeNull()
    expect(pauses.forPlan(teamId, planId)).toHaveLength(0)
  })
})

describe('the pause mail body (D6)', () => {
  test('an attempt asks for a commit and a checkpoint; a review asks only to stop', () => {
    const plan = { id: 'p1', title: 'Wave' }
    const hold = { id: 'h1', rationale: 'rethink' }
    const attempt = pauseBody(plan, hold, inDays(2), { change: 'api', stage: 'attempt', taskId: 't1', branch: 'api-b' })
    expect(attempt).toContain('rethink')
    expect(attempt).toContain(inDays(2))
    expect(attempt).toContain('Commit all work in progress on the change branch (api-b)')
    expect(attempt).toContain('task_checkpoint(task_id: t1')
    const bare = pauseBody(plan, hold, inDays(2), { change: 'api', stage: 'attempt', taskId: null, branch: null })
    expect(bare).not.toContain('task_checkpoint')
    expect(bare).toContain('change branch;')
    const review = pauseBody(plan, hold, inDays(2), { change: 'api', stage: 'review', taskId: 't1', branch: null })
    expect(review).toContain('Submit nothing further for this review, and stop.')
    expect(review).not.toContain('task_checkpoint')
  })
})
