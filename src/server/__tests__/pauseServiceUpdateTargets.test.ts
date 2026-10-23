// The pause service's update-attempt targets (revision-control 4.1, design
// D6, O3′): a failed branch update returned to gating is live agent-held
// work — its dispatched attempt's claimant is paused, an owed one names no
// holder, and an upgrade's in-flight old-shape handoff is never the holder.
// Split from pauseServiceTargets.test.ts (CP2a B4); the harness is shared
// with it through pauseTargetsBench.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PlanBench, PlanWorld } from './planHarness'
import { pauseTargetsBench, type PauseTargetsBench } from './pauseTargetsBench'
import type { ExecutionStore } from '../plans/execution/executionStore'
import type { PauseStore } from '../plans/revisionControl/pauseStore'

let world: PlanWorld
let bench: PlanBench
let pauses: PauseStore
let executions: ExecutionStore
let teamId: string
let wired: PauseTargetsBench

beforeAll(async () => {
  wired = await pauseTargetsBench('kawai-pause-update-targets-')
  world = wired.world
  bench = wired.bench
  pauses = wired.pauses
  executions = wired.executions
  teamId = wired.teamId
})

afterAll(() => {
  wired.close()
})

describe('update-attempt targets (O3′)', () => {
  test('an out update attempt keeps its holder in gating: the pause targets its claimant (O3′)', async () => {
    const { planId, executionId } = await wired.executionWith(['api'])
    const api = await wired.inFlight(executionId, 'api')
    // The failed branch update returned the change to gating; its attempt
    // dispatched to dev4 (stamped, key anchored). The update attempt is live
    // agent-held work in gating, so its claimant is paused.
    executions.transition(executionId, 'api', executions.change(executionId, 'api')!, { state: 'gating', step: null })
    const updateMail = bench.mail.enqueue({
      teamId, toKind: 'session', toId: 'dev4', fromKind: 'system', fromSession: null, fromGroup: null,
      originPath: world.repo, body: 'Merge the base.', taskId: api.taskId, actor: 'system',
    })
    bench.mail.claim(updateMail.id, 'dev4')
    const updateAssignment = bench.assignmentStore.insert({
      teamId, taskId: api.taskId, requestKey: `exec:${executionId}:api:attempt:2:0`, targetKind: 'session', targetId: 'dev4',
      role: null, instruction: 'Merge the base.', creator: { kind: 'human', sessionId: null }, messageId: updateMail.id,
    })
    executions.insertAttempt({
      executionId, change: 'api', kind: 'update', assignmentId: updateAssignment.assignment.id,
      manifest: { ...wired.manifest(), answers: { resultId: 'res-1', roundId: 'round-1', failingChecks: [], findingsIds: [] }, update: { base: 'base', files: ['a.txt'] } },
      manifestHash: 'mh-update',
    })
    const hold = wired.placeHold(planId, ['api'], 'pa-h11')
    const outcome = wired.expectOk(wired.pause({ planId, holdId: hold.id, commandId: 'pa-11' }))
    expect(pauses.targets(outcome.pause.id)).toEqual([expect.objectContaining({ change: 'api', stage: 'attempt', holderSession: 'dev4' })])
    expect(wired.pauseMails(api.taskId)).toEqual([expect.objectContaining({ toId: 'dev4' })])
  })

  test('an owed update attempt names no holder: gating with an undispatched row has no active work', async () => {
    const { planId, executionId } = await wired.executionWith(['api'])
    const api = await wired.inFlight(executionId, 'api')
    // The update row was minted but its send never committed: the outstanding
    // assignment is the implement stage's, never the attempt's, so the
    // change has no live work to pause.
    executions.transition(executionId, 'api', executions.change(executionId, 'api')!, { state: 'gating', step: null })
    executions.insertAttempt({
      executionId, change: 'api', kind: 'update', assignmentId: null,
      manifest: { ...wired.manifest(), answers: { resultId: 'res-1', roundId: 'round-1', failingChecks: [], findingsIds: [] }, update: { base: '', files: [] } },
      manifestHash: 'mh-update',
    })
    const hold = wired.placeHold(planId, ['api'], 'pa-h12')
    const outcome = wired.expectOk(wired.pause({ planId, holdId: hold.id, commandId: 'pa-12' }))
    expect(pauses.targets(outcome.pause.id)).toEqual([])
    expect(wired.pauseMails(api.taskId)).toEqual([])
  })

  test("an upgrade's in-flight attempt:update: handoff anchors no row and names no holder (Q5)", async () => {
    const { planId, executionId } = await wired.executionWith(['api'])
    const api = await wired.inFlight(executionId, 'api')
    // A pre-upgrade runtime left a live update handoff under the retired
    // attempt:update: key (no kind-'update' row existed yet to anchor). The
    // rows alone decide: the old key anchors nothing, so dev4 is not the
    // holder, the change reads Kawai-held, and the next failed update
    // re-mints under the uniform key (Q5's upgrade limitation).
    executions.transition(executionId, 'api', executions.change(executionId, 'api')!, { state: 'gating', step: null })
    const oldMail = bench.mail.enqueue({
      teamId, toKind: 'session', toId: 'dev4', fromKind: 'system', fromSession: null, fromGroup: null,
      originPath: world.repo, body: 'Merge the base.', taskId: api.taskId, actor: 'system',
    })
    bench.mail.claim(oldMail.id, 'dev4')
    bench.assignmentStore.insert({
      teamId, taskId: api.taskId, requestKey: `exec:${executionId}:api:attempt:update:2:7`, targetKind: 'session', targetId: 'dev4',
      role: null, instruction: 'Merge the base.', creator: { kind: 'human', sessionId: null }, messageId: oldMail.id,
    })
    const hold = wired.placeHold(planId, ['api'], 'pa-h13')
    const outcome = wired.expectOk(wired.pause({ planId, holdId: hold.id, commandId: 'pa-13' }))
    expect(pauses.targets(outcome.pause.id)).toEqual([])
    expect(wired.service.sides(teamId, outcome.pause.id)).toEqual({ noActiveWork: ['api'], landingInProgress: [] })
    expect(wired.pauseMails(api.taskId)).toEqual([])
  })
})
