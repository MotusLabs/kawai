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
// - P6 one derivation (D9 and S7, as bound): for random pending handoffs
//   (open or stale, owner live or none, requester live or gone) the
//   attention item's owner, the supervision wait's state and next actor, and
//   `task_get`'s row name the same state and party; for published handoffs
//   built to each `handoffPhase` with random notices, delivery,
//   acknowledgement, holder and closure, Table W's independent row gives the
//   follow-up item (or its suppression) and the phase `task_get` names,
//   and the loader's pending-only projection lists no owner-publication
//   wait, as cause or also applying.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { planInput } from '../../shared/__tests__/planFixtures'
import type { ChangeSupervision, SupervisionCause } from '../../shared/planSupervision'
import { executionSnapshot } from '../plans/execution/executionSnapshot'
import { planSteps } from '../plans/execution/executionPlanner'
import { derivePlanSupervision } from '../plans/supervision/supervisionRead'
import { handoffAttentionFacts, handoffAttentionItems, handoffFollowUpItems } from '../team/handoffAttention'
import { handoffRead } from '../team/taskHandoffRead'
import { HANDOFF_PHASES, type HandoffNextActor, type HandoffNoticeState, type HandoffPhase } from '../../shared/taskHandoffs'
import { shown, W_PUBLISHED, type PublishedAxes } from './helpers/handoffWTable'
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
  const named = (next: HandoffNextActor) => next.kind === 'human' ? 'human:' : next.kind === 'requester-group' ? `group:${next.group}` : `session:${next.sessionId}`
  /** Table W's published row id → the phase it names (design "Table W"), independent of `handoffPhase`. */
  const PHASE_OF_ROW: Record<string, HandoffPhase> = {
    W5: 'task-closed', W6: 'acknowledged', W7: 'no-holder', W8: 'no-holder', W12d: 'delivered-awaiting-ack',
    W9: 'notice-uncertain', W12: 'notice-queued', W10: 'notice-failed', W11: 'not-notified',
  }
  const archive = (id: string) => { bench.gone.add(id); bench.records.set(id, { ...bench.records.get(id)!, archivedAt: new Date().toISOString() }) }
  const revive = (id: string) => { bench.gone.delete(id); bench.records.set(id, { ...bench.records.get(id)!, archivedAt: null }) }
  const manager = () => ({ tasks: bench.taskService, results: { ownedByExecution: () => true } })
  const loaderWaits = (planId: string) => {
    const api = derivePlanSupervision(bench.compose().reads, teamId(), planId, NOW)!.changes.find(change => change.change === 'api')!
    return [api.cause, ...api.alsoApplying].filter(entry => entry.kind === 'owner-publication')
  }
  /** One revision notice to the claimant from the real `TaskNotices.write`, moved to `state`. */
  const notice = (taskId: string, state: HandoffNoticeState) => {
    const store = bench.taskService.store
    const task = store.get(taskId)!
    const [sent] = store.notices!.write(task, store.revisions(taskId).at(-1)!, {
      sender: { actor: { kind: 'human', sessionId: null }, fromGroup: null, originPath: world.repo },
      requestKey: `p6-notice-${crypto.randomUUID()}`, sessionExists: () => true,
    })
    if (!sent) throw new Error('no claimant to notify')
    if (state === 'queued') return
    bench.mail.claim(sent.messageId, 'dev')
    if (state === 'delivered') { bench.mail.markPushed(sent.messageId, undefined, task.revision); bench.mail.markDelivered(sent.messageId) }
    else if (state === 'uncertain') bench.mail.holdUncertain(sent.messageId, 'push outcome unknown')
    else bench.mail.deadLetter(sent.messageId, 'push failed')
  }
  const taskMail = (taskId: string) => {
    const message = bench.mail.enqueue({ teamId: teamId(), toKind: 'session', toId: 'dev', fromKind: 'human', fromSession: null, fromGroup: null,
      originPath: world.repo, body: 'A note', taskId })
    bench.mail.claim(message.id, 'dev')
    bench.mail.markPushed(message.id, undefined, bench.taskService.store.get(taskId)!.revision)
    bench.mail.markDelivered(message.id)
  }
  const pick = <T,>(random: () => number, options: readonly T[]): T => options[Math.floor(random() * options.length)]!

  // @covers: plan-supervision › A pending publication handoff is a named wait › A stale handoff waits on its requester
  // @covers: plan-supervision › A pending publication handoff is a named wait › Publication ends the wait
  test('P6: seed 0x0A11CE06, 200 cases — attention, the supervision loader and task_get derive pending next actors and published phases alike', async () => {
    const random = mulberry32(0x0A11CE06)
    const seen = new Set<string>()
    for (let index = 0; index < propertyCases(CASES); index++) {
      for (const id of ['lead', 'lead2', 'dev']) revive(id)
      for (const running of bench.executions.runningForTeam(teamId())) bench.executions.finishExecution(running.id, 'completed')
      const planId = await bench.approvedPlan()
      const executionId = bench.start(planId)
      const { taskId } = await bench.implementing(executionId, planId, new Date(T0).toISOString())
      if (index % 2 === 0) {
        // Pending: one state and next actor in all three readers.
        const owned = random() < 0.5
        if (owned) bench.db.db.prepare('UPDATE team_tasks SET owner_session = ? WHERE id = ?').run('lead2', taskId)
        const { handoff } = await bench.taskService.handoffs.request({ kind: 'agent', sessionId: 'lead' }, taskId, {
          baseRevision: 1, direction: 'Prepared', rationale: 'why', notify: false, requestKey: `p6-${index}`,
        })
        if (random() < 0.5) await bench.taskService.publish(bench.human, taskId, { direction: 'Mine', rationale: 'own', notify: false, requestKey: `own-${index}` })
        for (const id of ['lead', 'lead2']) if (random() < 0.4) archive(id)
        const item = handoffAttentionItems(handoffAttentionFacts(manager() as never, teamId(), id => id).handoffs).find(entry => entry.link.handoffId === handoff.id)!
        const [wait] = loaderWaits(planId)
        if (wait?.kind !== 'owner-publication') throw new Error(`case ${index}: no owner-publication wait`)
        const fromTaskGet = handoffRead(bench.taskService, bench.taskService.store.get(taskId)!).handoffs.find(entry => entry.id === handoff.id)!
        seen.add(`${wait.state}:${wait.nextActor.kind}`)
        expect([index, owned, wait.state, party(item.owner), fromTaskGet.state, named(fromTaskGet.nextActor!)])
          .toEqual([index, owned, wait.state, named(wait.nextActor), wait.state, named(wait.nextActor)])
        continue
      }
      // Published: the facts of one target phase, the rest random; Table W's
      // independent row gives the item and the phase task_get must name, and
      // the loader's S7 projection lists no owner-publication wait at all.
      const target = HANDOFF_PHASES[(index >> 1) % HANDOFF_PHASES.length]!
      const { handoff } = await bench.taskService.handoffs.request({ kind: 'agent', sessionId: 'lead' }, taskId, {
        baseRevision: 1, direction: 'Prepared', rationale: 'why', notify: false, requestKey: `p6-${index}`,
      })
      await bench.taskService.handoffs.publish(bench.human, taskId, handoff.id, [])
      const extra = pick(random, [[], ['failed'], ['queued'], ['failed', 'queued']] as HandoffNoticeState[][])
      const facts: PublishedAxes = { closed: false, claimant: 'live', acked: false, delivered: false, notices: [], owns: true }
      const write = (states: HandoffNoticeState[]) => {
        for (const state of states) { notice(taskId, state); if (state === 'delivered') facts.delivered = true; else facts.notices.push(state) }
      }
      if (target === 'task-closed') {
        write(extra)
        if (random() < 0.5) { await bench.taskService.acknowledge({ kind: 'agent', sessionId: 'dev' }, taskId, 2); facts.acked = true }
        await bench.taskService.setStatus(bench.human, taskId, 'cancelled')
        facts.closed = true
      } else if (target === 'acknowledged') {
        write(extra)
        await bench.taskService.acknowledge({ kind: 'agent', sessionId: 'dev' }, taskId, 2)
        facts.acked = true
        if (random() < 0.5) { archive('dev'); facts.claimant = 'gone' }
      } else if (target === 'no-holder') {
        write(extra)
        archive('dev'); facts.claimant = 'gone'
      } else if (target === 'delivered-awaiting-ack') {
        write(extra)
        if (random() < 0.5) write(['delivered'])
        else { taskMail(taskId); facts.delivered = true }
      } else if (target === 'notice-uncertain') write([...extra, 'uncertain'])
      else if (target === 'notice-queued') write([...extra.filter(state => state !== 'queued'), 'queued'])
      else if (target === 'notice-failed') write(['failed', ...(random() < 0.5 ? ['failed' as const] : [])])
      const rows = W_PUBLISHED.filter(row => row.match(facts))
      expect([index, rows.length]).toEqual([index, 1])
      const [row] = rows
      const items = shown(handoffFollowUpItems(handoffAttentionFacts(manager() as never, teamId(), id => id).handoffFollowUps)
        .filter(entry => entry.impact?.taskId === taskId))
      const fromTaskGet = handoffRead(bench.taskService, bench.taskService.store.get(taskId)!).handoffs.find(entry => entry.id === handoff.id)!
      seen.add(`published:${PHASE_OF_ROW[row!.id]}`)
      expect([index, target, row!.id, fromTaskGet.state, fromTaskGet.phase, items, loaderWaits(planId)])
        .toEqual([index, target, row!.id, 'published', PHASE_OF_ROW[row!.id], row!.expect ? [row!.expect] : [], []])
    }
    expect([...seen].sort()).toEqual([...['open:human', 'open:owner', 'stale:requester', 'stale:requester-group'],
      ...HANDOFF_PHASES.map(phase => `published:${phase}`)].sort())
  }, 600_000)
})
