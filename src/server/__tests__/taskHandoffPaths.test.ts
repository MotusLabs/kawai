// The publication and close paths that bypass TaskService.publish and
// setStatus's callers (owner-publication-handoff D4, task 5.1, H28/H28b):
// the pause resolution's Adapt publishes through `tasks.store.publish`
// under its `pause:` key and turns a pending handoff stale (H20) or leaves
// a stale one stale (H21); the owner's override cancels an earlier fix task
// through `prepareStatus().commit`, closing that task's handoff (H28b),
// while an override that closes no handoff's task changes no handoff (H28).
// Both run through their real services and benches.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { TaskService } from '../team/TaskService'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench } from './decisionHarness'
import { pauseResolveBench, type PauseResolveBench } from './pauseResolveBench'

/** Seed an open handoff on the task's current revision as `requester` of `group` would have requested it. */
function seedOpen(tasks: TaskService, taskId: string, requester: string, group: string, key = 'k1') {
  const task = tasks.store.get(taskId)!
  return tasks.store.atomically(() => tasks.handoffs.store.insert({
    teamId: task.teamId, taskId, baseRevision: task.revision, baseContractHash: null, direction: 'Prepared', acceptance: null, contract: null,
    rationale: 'why', notify: false, baseCommit: null, evidenceRefs: [], requesterSession: requester, requesterGroup: group, requestKey: key,
  }, new Date().toISOString()))
}
const digest = (tasks: TaskService) => ['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups']
  .map(table => tasks.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
const wakeupsOf = (tasks: TaskService, id: string) =>
  (tasks.store.db.prepare('SELECT transition FROM team_task_handoff_wakeups WHERE handoff_id = ? ORDER BY rowid').all(id) as Array<{ transition: string }>).map(row => row.transition)

describe("the pause resolution's Adapt", () => {
  let wired: PauseResolveBench
  beforeAll(async () => { wired = await pauseResolveBench('handoff-adapt') })
  afterAll(() => wired.close())

  test('H20: Adapt publishes under its pause: key and turns the open handoff stale naming that revision, with one wakeup', async () => {
    const world = await wired.pausedAttempt()
    const handoff = seedOpen(wired.tasks, world.taskId, 'dev2', 'middle-devs')
    const before = wired.tasks.store.get(world.taskId)!.revision
    const outcome = await wired.service.resolve(wired.bench.human, {
      planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Reworked direction', rationale: 'the lead rethought it', commandId: 'adapt-h20',
    })
    expect(outcome.ok).toBe(true)
    const revision = wired.tasks.store.get(world.taskId)!.revision
    expect(revision).toBe(before + 1)
    expect(wired.tasks.store.db.prepare('SELECT request_key, handoff_id FROM team_task_revisions WHERE task_id = ? AND revision = ?').get(world.taskId, revision))
      .toEqual({ request_key: 'pause:adapt-h20', handoff_id: null })
    expect(wired.tasks.handoffs.store.get(handoff.id)).toMatchObject({ state: 'stale', stateReason: `revision ${revision} was published` })
    expect(wakeupsOf(wired.tasks, handoff.id)).toEqual(['stale'])
  })

  test('H21: Adapt over a task whose handoff is already stale keeps it stale with no second wakeup', async () => {
    const world = await wired.pausedAttempt()
    const handoff = seedOpen(wired.tasks, world.taskId, 'dev2', 'middle-devs')
    wired.republish(world.taskId)
    const stale = wired.tasks.handoffs.store.get(handoff.id)
    expect(stale!.state).toBe('stale')
    const outcome = await wired.service.resolve(wired.bench.human, {
      planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Reworked again', rationale: 'again', commandId: 'adapt-h21',
    })
    expect(outcome.ok).toBe(true)
    expect(wired.tasks.handoffs.store.get(handoff.id)).toEqual(stale)
    expect(wakeupsOf(wired.tasks, handoff.id)).toEqual(['stale'])
  })
})

describe("the owner's override", () => {
  let world: PlanWorld
  beforeAll(async () => { world = await createPlanWorld('kawai-handoff-override-') })
  afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

  // @covers: task-publication-handoffs › A handoff ends only by an explicit disposition › An override's cancellation closes the handoff
  test("H28 then H28b: an override closing no handoff's task changes no handoff; one cancelling the earlier fix task closes its handoff only", async () => {
    const bench = createDecisionBench(world)
    try {
      const planId = await bench.approvedPlan(true)
      const taskId = await bench.onTask('dev', planId)
      const asked = await bench.decide.ask({ kind: 'agent', sessionId: 'dev' }, { question: 'Which store?', options: ['SQLite', 'Files'] })
      const first = await bench.decide.record({ kind: 'agent', sessionId: 'lead' }, { plan_id: planId, card_id: asked.card.id, option_index: 1, rationale: 'Durable' })
      const onWork = seedOpen(bench.taskService, taskId, 'lead', 'leads', 'work')
      const before = digest(bench.taskService)
      const one = await bench.decide.override(bench.human, { planId, cardId: asked.card.id, expectedDecisionId: first.decision.id, choice: 'Files', rationale: 'r', commandId: 'o-1' })
      // H28: the decision and its new fix task leave every handoff row as it was.
      expect(digest(bench.taskService)).toEqual(before)
      const onFix = seedOpen(bench.taskService, one.fixTaskId!, 'lead', 'leads', 'fix')
      const fixRevision = bench.taskService.store.get(one.fixTaskId!)!.revision
      await bench.decide.override(bench.human, { planId, cardId: asked.card.id, expectedDecisionId: one.decision.id, choice: 'SQLite', rationale: 'back', commandId: 'o-2' })
      expect(bench.taskService.store.get(one.fixTaskId!)!.status).toBe('cancelled')
      // H28b: the cancellation closes the fix task's handoff through H27 and nothing else.
      expect(bench.taskService.handoffs.store.get(onFix.id)).toMatchObject({ state: 'closed', stateReason: 'the task is cancelled', publishedRevision: null })
      expect(bench.taskService.handoffs.store.associatedRevision(one.fixTaskId!, onFix.id)).toBeNull()
      expect(bench.taskService.store.get(one.fixTaskId!)!.revision).toBe(fixRevision)
      expect(wakeupsOf(bench.taskService, onFix.id)).toEqual(['closed'])
      expect(bench.taskService.handoffs.store.get(onWork.id)).toEqual(onWork)
      expect(wakeupsOf(bench.taskService, onWork.id)).toEqual([])
    } finally {
      bench.db.close()
    }
  })
})
