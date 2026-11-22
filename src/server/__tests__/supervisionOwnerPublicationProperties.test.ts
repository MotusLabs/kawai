// Properties P5 and P6 (owner-publication-handoff design "Properties",
// tasks 9.3 and 8.4) over the supervision bench's real stores:
// - P5 limits unchanged: seeded plans (three to five changes, random
//   dependencies, a parallel limit of one to three, changes waiting,
//   implementing, gating on CI or the landing slot, or landed, and a slot
//   holder) read through the execution scheduler (`planSteps` over the real
//   snapshot) and the supervision loader, before and after open handoffs
//   are recorded on random running changes' tasks: the scheduler's whole
//   output, every waiting change's cause and waits, every dependency wait
//   and every landing-slot wait are identical.
// - P6 one derivation: for random pending handoffs (open or stale, owner
//   live, gone or none, requester live or gone), the attention item's owner
//   and the supervision wait's next actor name the same party. (The
//   `task_get` reader joins with the agent reads, task 10.)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { planInput } from '../../shared/__tests__/planFixtures'
import type { ChangeSupervision, SupervisionCause } from '../../shared/planSupervision'
import { executionSnapshot } from '../plans/execution/executionSnapshot'
import { planSteps } from '../plans/execution/executionPlanner'
import { derivePlanSupervision } from '../plans/supervision/supervisionRead'
import { handoffAttentionFacts, handoffAttentionItems } from '../team/handoffAttention'
import { createPlanWorld, writeGroup, type PlanWorld } from './planHarness'
import { propertyCases } from './helpers/propertyCases'
import { createSupervisionBench, MIN, T0, type SupervisionBench } from './supervisionHarness'

let world: PlanWorld
let bench: SupervisionBench
beforeAll(async () => {
  world = await createPlanWorld('kawai-owner-publication-properties-')
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  bench = createSupervisionBench(world)
})
afterAll(() => {
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})
const teamId = () => world.team.teamId
const NOW = new Date(T0 + 30 * MIN)
const swallow = async (run: () => Promise<unknown>) => { try { await run() } catch { /* refused: part of the case */ } }

describe('P5: limits unchanged', () => {
  const CASES = 200
  const strip = (waits: ChangeSupervision['alsoApplying']) => waits.filter(wait => wait.kind === 'dependency' || wait.kind === 'landing-slot' || wait.kind === 'parallel-limit')
  const kept = (cause: SupervisionCause) => (cause.kind === 'dependency' || cause.kind === 'landing-slot' || cause.kind === 'parallel-limit' ? cause : null)
  /** What the scheduler and the limits read: the planner's whole output and each change's limit waits. */
  function limits(planId: string) {
    const snapshot = executionSnapshot(teamId(), world.repo, bench.executions, bench.plans)
    const steps = planSteps(snapshot, NOW.toISOString())
    const changes = derivePlanSupervision(bench.compose().reads, teamId(), planId, NOW)!.changes.map(change => ({
      change: change.change,
      waiting: change.outcome === 'waiting' && kept(change.cause) !== null ? { cause: change.cause, alsoApplying: strip(change.alsoApplying) } : null,
      limitWaits: [kept(change.cause), ...strip(change.alsoApplying)].filter(entry => entry !== null),
    }))
    return { steps, inProgress: snapshot.executions.flatMap(execution => execution.changes).filter(change => ['provisioning', 'implementing', 'gating', 'landing'].includes(change.state)).length, changes }
  }

  // @covers: plan-supervision › A pending publication handoff is a named wait › Execution limits are unchanged
  test('P5: seed 0x0A11CE05, 200 cases — the scheduler, parallel counts, dependency and slot waits are identical with handoffs', async () => {
    const random = mulberry32(0x0A11CE05)
    let withHandoff = 0
    for (let index = 0; index < propertyCases(CASES); index++) {
      bench.db.db.prepare('DELETE FROM plan_landing_slots').run()
      for (const running of bench.executions.runningForTeam(teamId())) bench.executions.finishExecution(running.id, 'completed')
      const count = 3 + Math.floor(random() * 3)
      const names = Array.from({ length: count }, (_, position) => `c${index}x${position}`)
      const base = (planInput().changes as Array<Record<string, unknown>>)[0]!
      const planId = await bench.approvedPlan()
      await bench.revise(planId, {
        changes: names.map((change, position) => ({ ...base, change, acceptance: [], dependsOn: names.slice(0, position).filter(() => random() < 0.35) })),
      })
      const executionId = bench.start(planId)
      bench.db.db.prepare('UPDATE plan_executions SET max_parallel = ? WHERE id = ?').run(1 + Math.floor(random() * 3), executionId)
      const running: string[] = []
      for (const change of names) {
        const roll = random()
        if (roll < 0.35) continue
        if (roll < 0.5) {
          bench.land(executionId, planId, change, `merge-${change}`)
          bench.setChange(executionId, change, { state: 'landed' })
          continue
        }
        const { taskId } = await bench.implementing(executionId, planId, new Date(T0).toISOString(), change)
        const step = pickStep(random)
        if (step !== null) bench.setChange(executionId, change, { state: 'gating', step, taskId })
        running.push(taskId)
      }
      if (random() < 0.5) {
        bench.db.db.prepare("INSERT INTO plan_landing_slots (team_id, holder_kind, holder_id, since) VALUES (?, 'change', ?, ?)").run(teamId(), `${executionId}:${names[0]}`, new Date(T0).toISOString())
      }
      const before = limits(planId)
      for (const taskId of running) {
        if (random() < 0.6) {
          await swallow(() => bench.taskService.handoffs.request({ kind: 'agent', sessionId: 'lead' }, taskId, {
            baseRevision: 1, direction: 'Prepared', rationale: 'why', notify: false, requestKey: `p5-${taskId}`,
          }))
          withHandoff++
        }
      }
      expect([index, limits(planId)]).toEqual([index, before])
    }
    expect(withHandoff).toBeGreaterThan(0)
  }, 600_000)

  function pickStep(random: () => number): 'awaiting-ci' | 'awaiting-slot' | null {
    const roll = random()
    return roll < 0.4 ? null : roll < 0.7 ? 'awaiting-ci' : 'awaiting-slot'
  }
})

describe('P6: one derivation', () => {
  const CASES = 200
  const party = (owner: { kind: string; id: string | null }) => `${owner.kind}:${owner.id ?? ''}`

  // @covers: plan-supervision › A pending publication handoff is a named wait › A stale handoff waits on its requester
  test('P6: seed 0x0A11CE06, 200 cases — attention and the supervision loader name the same next actor', async () => {
    const random = mulberry32(0x0A11CE06)
    const seen = new Set<string>()
    for (let index = 0; index < propertyCases(CASES); index++) {
      for (const id of ['lead', 'lead2']) { bench.gone.delete(id); bench.records.set(id, { ...bench.records.get(id)!, archivedAt: null }) }
      for (const running of bench.executions.runningForTeam(teamId())) bench.executions.finishExecution(running.id, 'completed')
      const planId = await bench.approvedPlan()
      const executionId = bench.start(planId)
      const { taskId } = await bench.implementing(executionId, planId, new Date(T0).toISOString())
      const owned = random() < 0.5
      if (owned) bench.db.db.prepare('UPDATE team_tasks SET owner_session = ? WHERE id = ?').run('lead2', taskId)
      const { handoff } = await bench.taskService.handoffs.request({ kind: 'agent', sessionId: 'lead' }, taskId, {
        baseRevision: 1, direction: 'Prepared', rationale: 'why', notify: false, requestKey: `p6-${index}`,
      })
      if (random() < 0.5) await bench.taskService.publish(bench.human, taskId, { direction: 'Mine', rationale: 'own', notify: false, requestKey: `own-${index}` })
      for (const id of ['lead', 'lead2']) {
        if (random() < 0.4) { bench.gone.add(id); bench.records.set(id, { ...bench.records.get(id)!, archivedAt: new Date().toISOString() }) }
      }
      const manager = { tasks: bench.taskService, results: { ownedByExecution: () => true } }
      const item = handoffAttentionItems(handoffAttentionFacts(manager as never, teamId(), id => id).handoffs).find(entry => entry.link.handoffId === handoff.id)!
      const api = derivePlanSupervision(bench.compose().reads, teamId(), planId, NOW)!.changes.find(change => change.change === 'api')!
      const wait = [api.cause, ...api.alsoApplying].find(entry => entry.kind === 'owner-publication')
      if (wait?.kind !== 'owner-publication') throw new Error(`case ${index}: no owner-publication wait`)
      const actor = wait.nextActor
      const named = actor.kind === 'human' ? 'human:' : actor.kind === 'requester-group' ? `group:${actor.group}` : `session:${actor.sessionId}`
      seen.add(`${wait.state}:${actor.kind}`)
      expect([index, owned, wait.state, party(item.owner)]).toEqual([index, owned, wait.state, named])
    }
    expect([...seen].sort()).toEqual(['open:human', 'open:owner', 'stale:requester', 'stale:requester-group'])
  }, 600_000)
})
