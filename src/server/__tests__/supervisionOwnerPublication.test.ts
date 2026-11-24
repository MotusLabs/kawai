// Table S (owner-publication-handoff design "Table S"; tasks 8.3, 9.1). The
// rows S1–S6 run one supervision input through the real derivation
// (`changeSupervision`) and its result through the real attention sources
// (the plan stall and amend items beside the handoff items), so each row
// asserts the change's cause, its stall and the task's attention together.
// The transitions S7, S9 and S10 run through the production loader
// (`derivePlanSupervision`) and, for S7, the composed monitor over the real
// stores: the handoff moves through the real handoff service and the next
// read shows the wait's new state. S3 and S4 live here, beside the rows they
// share, rather than in the plan attention test file (near its line limit).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { causeLabel, changeSupervision, type HolderFacts, type SupervisionCause, type SupervisionInput, type SupervisionRound } from '../../shared/planSupervision'
import type { TaskHandoff } from '../../shared/taskHandoffs'
import type { AttentionItem } from '../../shared/teamWorkspace'
import { stallBody } from '../plans/supervision/stallAlerts'
import { derivePlanSupervision } from '../plans/supervision/supervisionRead'
import type { PlanAttentionFact } from '../team/planAttention'
import { attentionItems, type AttentionInput } from '../team/workspaceRead'
import { writeGroup, createPlanWorld, type PlanWorld } from './planHarness'
import { createSupervisionBench, MIN, T0, type SupervisionBench } from './supervisionHarness'

const NOW = new Date('2026-10-20T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const holder = (extra: Partial<HolderFacts> = {}): HolderFacts => ({
  session: 'dev', group: 'middle-devs', profile: 'glm', gone: false, turnRunning: false, pendingRequest: null, backgroundTasks: 0, workers: 0,
  dueDirectMail: false, parkedUntil: null, coolingUntil: null, lastTurnEndAt: null, lastTaskMailAt: null, ...extra,
})
const OPEN = { id: 'handoff-1', state: 'open' as const, baseRevision: 1, nextActor: { kind: 'human' as const } }
const input = (extra: Partial<SupervisionInput> = {}): SupervisionInput => ({
  change: 'api', dependsOn: [], state: 'implementing', step: null, stopReason: null, stopDetail: null, landing: null, dependencies: [], parallelLimit: 3,
  attempt: { kind: 'implement', status: 'out' }, rounds: [], effects: [],
  // Delivered three hours ago to an archived holder: without a named wait, a no-progress stall.
  instruction: { messageId: 'msg-1', state: 'delivered', deliveredAt: ago(180), blocker: null, holder: holder({ gone: true }) },
  openCards: [], conditions: [], memberRelease: null, slotHolder: null, candidates: [], results: [], waitEndedAt: null, diagnosis: null, handoff: OPEN,
  ...extra,
})
const handoff = (state: TaskHandoff['state'] = 'open'): TaskHandoff => ({
  id: 'handoff-1', teamId: 'team', taskId: 'task-api', baseRevision: 1, baseContractHash: null, direction: 'v2', acceptance: null, contract: null,
  rationale: 'why', notify: false, payloadHash: 'h', baseCommit: null, evidenceRefs: [], requesterSession: 'lead', requesterGroup: 'leads', requestKey: 'k',
  state, stateReason: null, stateActor: null, publishedRevision: null, publishedPayloadHash: null, supersededBy: null, createdAt: '', updatedAt: '',
})
/** The task's attention for a derived change: the plan sources beside the handoff source. */
function attentionFor(view: ReturnType<typeof changeSupervision>, pending: boolean, amendRationale: string | null = null): AttentionItem[] {
  const fact: PlanAttentionFact = {
    teamId: 'team', planId: 'plan-1', planTitle: 'Wave D', leadGroup: 'lead', executionId: 'exec-1', openCards: [], fixes: [], failedPromotion: null, correctionOpen: false,
    changes: [{ taskId: 'task-api', generation: 1, supervision: view, amendRationale }],
  }
  return attentionItems({
    sessions: [], messages: [], waiting: {}, taskTitle: () => 'API', nameOf: (id: string) => id, pendingAcceptance: [], outboundViolations: [], plans: [fact],
    handoffs: pending ? [{ handoff: handoff(), taskTitle: 'API', requesterName: 'lead', liveOwner: null, requesterLive: true, taskRevision: 1 }] : [],
  } as unknown as AttentionInput)
}
const actions = (items: AttentionItem[]) => items.map(item => `${item.kind}: ${item.nextAction}`)
const ownerPublication = (wait: SupervisionCause | undefined) => (wait?.kind === 'owner-publication' ? wait : null)
const convergence = (awaitingRevision: number | null) => ({
  state: 'gating' as const, step: 'diagnosing' as const,
  diagnosis: { id: 'diagnosis-1', signals: [{ kind: 'S4' as const, counts: [2, 2, 2] as [number, number, number] }], cardId: 'card-d', taskId: 'task-api', awaitingRevision },
})

describe('Table S rows', () => {
  // @covers: plan-supervision › A pending publication handoff is a named wait › A prepared correction waits on the owner
  test('S1: a pending handoff and no other wait reads owner-publication naming its next actor; no stall; the handoff item only', () => {
    const view = changeSupervision(input(), NOW)
    expect(view.outcome).toBe('waiting')
    expect(view.cause).toEqual({ kind: 'owner-publication', handoffId: 'handoff-1', state: 'open', baseRevision: 1, nextActor: { kind: 'human' } })
    expect(causeLabel(view.cause)).toBe('Waiting for the human to publish prepared revision handoff-1 (base revision 1)')
    expect(view.stall).toBeNull()
    expect(actions(attentionFor(view, true))).toEqual(['publication-handoff: Publish prepared revision'])
  })

  // @covers: plan-supervision › A pending publication handoff is a named wait › Another wait stays the cause
  test('S2: another named wait stays the cause, owner-publication also applying, and both items stand', () => {
    const view = changeSupervision(input({ state: 'gating', step: 'awaiting-ci', rounds: [{ id: 'r1', number: 1, outcome: null, decidedAt: null, carriedFrom: null,
      ci: [{ name: 'unit', source: 'actions', conclusion: 'in_progress', link: null, runId: 1, startedAt: ago(5), completedAt: null }], ciPassedAt: null, verdict: null, verdictAt: null, findingsSummary: null, structuredReview: false }] }), NOW)
    expect(view.cause).toEqual({ kind: 'ci', pending: ['unit'] })
    expect(view.alsoApplying.map(wait => wait.kind)).toEqual(['owner-publication'])
    expect(actions(attentionFor(view, true))).toEqual(['publication-handoff: Publish prepared revision'])
  })

  // @covers: plan-supervision › A pending handoff stands for the post-Amend item › One item for the amended contract
  test('S3: a convergence stall awaiting the amended revision keeps its precedence; the handoff item stands for Publish a task revision', () => {
    const view = changeSupervision(input(convergence(2)), NOW)
    expect([view.outcome, view.stall?.kind]).toEqual(['stalled', 'convergence'])
    expect(view.alsoApplying.map(wait => wait.kind)).toContain('owner-publication')
    expect(actions(attentionFor(view, true, 'two things at once'))).toEqual(['publication-handoff: Publish prepared revision'])
  })

  // @covers: plan-supervision › A pending handoff stands for the post-Amend item › Without a handoff the existing item stays
  test('S4: without a handoff the convergence stall keeps the human\'s Publish a task revision, as before', () => {
    const view = changeSupervision(input({ ...convergence(2), handoff: null }), NOW)
    expect(view.stall?.kind).toBe('convergence')
    expect(actions(attentionFor(view, false, 'two things at once'))).toEqual(['plan-stall: Publish a task revision'])
  })

  // @covers: plan-supervision › A stall names a gone holder › A stall with nothing running
  test('S5: without a handoff an archived holder past its deadline stalls no-progress, the stall item and report naming it archived', () => {
    const view = changeSupervision(input({ handoff: null }), NOW)
    expect(view.stall).toMatchObject({ kind: 'no-progress', idle: true, holderGone: true })
    const [item, ...rest] = attentionFor(view, false)
    expect(rest).toEqual([])
    expect(item).toMatchObject({
      kind: 'plan-stall', owner: { kind: 'group', id: 'lead' }, nextAction: 'Unblock the holder',
      cause: 'Change api of plan "Wave D" is stalled: no progress (holder dev archived; no session running api)',
    })
    expect(stallBody({ id: 'plan-1', title: 'Wave D' }, view, input({ handoff: null }), view.stall!)).toContain('Holder: dev (group middle-devs, profile glm), archived.')
    const live = changeSupervision(input({ handoff: null, instruction: { ...input().instruction!, holder: holder() } }), NOW)
    expect(live.stall).toEqual({ kind: 'no-progress', episodeKey: ago(180), anchorAt: ago(180), deadlineAt: live.stall!.kind === 'no-progress' ? live.stall!.deadlineAt : '', idle: true })
  })

  test('S6: a repeating failure keeps its precedence over the handoff, which is listed as also applying', () => {
    const failed = (number: number): SupervisionRound => ({ id: `r${number}`, number, outcome: 'fail' as const, decidedAt: ago(100 - number), carriedFrom: null,
      ci: [{ name: 'unit', source: 'actions' as const, conclusion: 'failure', link: null, runId: number, startedAt: ago(110), completedAt: ago(110) }],
      ciPassedAt: null, verdict: null, verdictAt: null, findingsSummary: null, structuredReview: false })
    const view = changeSupervision(input({ rounds: [failed(1), failed(2)] }), NOW)
    expect([view.outcome, view.stall?.kind]).toEqual(['stalled', 'repeating-failure'])
    expect(view.alsoApplying.map(wait => wait.kind)).toEqual(['owner-publication'])
  })

  test('a waiting change keeps its dependency or parallel-limit cause; the handoff never becomes it', () => {
    expect(changeSupervision(input({ state: 'waiting', dependencies: [{ change: 'db', outcome: 'running' }] }), NOW))
      .toMatchObject({ outcome: 'waiting', cause: { kind: 'dependency', changes: ['db'] }, alsoApplying: [] })
    expect(changeSupervision(input({ state: 'waiting' }), NOW)).toMatchObject({ cause: { kind: 'parallel-limit', limit: 3 }, alsoApplying: [] })
  })

  test("the wait's label names every next actor", () => {
    const label = (state: 'open' | 'stale', nextActor: NonNullable<SupervisionInput['handoff']>['nextActor']) =>
      causeLabel(changeSupervision(input({ handoff: { ...OPEN, state, nextActor } }), NOW).cause)
    expect(label('open', { kind: 'owner', sessionId: 'lead2' })).toBe('Waiting for the task owner lead2 to publish prepared revision handoff-1 (base revision 1)')
    expect(label('stale', { kind: 'requester', sessionId: 'lead' })).toBe('Waiting for the requester lead to re-prepare or withdraw stale handoff handoff-1 (base revision 1)')
    expect(label('stale', { kind: 'requester-group', group: 'leads' })).toBe("Waiting for the requester's group leads to re-prepare or withdraw stale handoff handoff-1 (base revision 1)")
    expect(label('stale', { kind: 'human' })).toBe('Waiting for the human to decline stale handoff handoff-1 (base revision 1)')
  })
})

describe('Table S transitions through the loader and the monitor', () => {
  let world: PlanWorld
  let bench: SupervisionBench
  beforeAll(async () => {
    world = await createPlanWorld('kawai-owner-publication-')
    writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  })
  afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
  /** A fresh bench whose holder `dev` is archived. */
  const fresh = () => {
    bench?.db.close()
    bench = createSupervisionBench(world)
    bench.holder.gone = true
    bench.gone.add('dev')
  }
  beforeEach(fresh)
  afterEach(() => bench.db.close())
  /** An implementing change whose archived holder got its instruction at T0, with an open handoff on its ownerless task. */
  async function waiting() {
    const planId = await bench.approvedPlan()
    const executionId = bench.start(planId)
    const { taskId } = await bench.implementing(executionId, planId, new Date(T0).toISOString())
    const requested = await bench.taskService.handoffs.request({ kind: 'agent', sessionId: 'lead' }, taskId, {
      baseRevision: 1, direction: 'Prepared', rationale: 'why', notify: false, requestKey: 'k1',
    })
    return { planId, executionId, taskId, handoffId: requested.handoff.id }
  }
  const api = (planId: string, minutes = 180) => derivePlanSupervision(bench.compose().reads, world.team.teamId, planId, new Date(T0 + minutes * MIN))!
    .changes.find(change => change.change === 'api')!
  const wait = (planId: string) => {
    const view = api(planId)
    return ownerPublication(view.cause) ?? ownerPublication(view.alsoApplying.find(entry => entry.kind === 'owner-publication'))
  }

  test('S1 through the loader: the archived holder\'s change reads owner-publication with the human as next actor', async () => {
    const { planId, handoffId } = await waiting()
    expect(api(planId)).toMatchObject({ outcome: 'waiting', stall: null, cause: { kind: 'owner-publication', handoffId, state: 'open', nextActor: { kind: 'human' } } })
  })

  // @covers: plan-supervision › A pending publication handoff is a named wait › A stale handoff waits on its requester
  test('S9: another publication makes it stale; the wait stays, naming the live requester, then its group once the requester is gone', async () => {
    const { planId, taskId, handoffId } = await waiting()
    await bench.taskService.publish(bench.human, taskId, { direction: 'Mine', rationale: 'own edit', notify: false, requestKey: 'own' })
    expect(wait(planId)).toEqual({ kind: 'owner-publication', handoffId, state: 'stale', baseRevision: 1, nextActor: { kind: 'requester', sessionId: 'lead' } })
    bench.gone.add('lead')
    expect(wait(planId)?.nextActor).toEqual({ kind: 'requester-group', group: 'leads' })
  })

  // @covers: plan-supervision › A pending publication handoff is a named wait › An ended handoff ends the wait
  test('S10: declining, withdrawing or closing ends the wait; the stall rules apply again', async () => {
    const declined = await waiting()
    await bench.taskService.handoffs.settle(bench.human, declined.handoffId, 'decline', 'no')
    expect(wait(declined.planId)).toBeNull()
    expect(api(declined.planId).stall?.kind).toBe('no-progress')
    fresh()
    const withdrawn = await waiting()
    await bench.taskService.handoffs.settle({ kind: 'agent', sessionId: 'lead' }, withdrawn.handoffId, 'withdraw', 'not needed')
    expect(wait(withdrawn.planId)).toBeNull()
    fresh()
    const closed = await waiting()
    await bench.taskService.setStatus(bench.human, closed.taskId, 'cancelled', 'dropped')
    expect(wait(closed.planId)).toBeNull()
  })

  // @covers: plan-supervision › A pending publication handoff is a named wait › Publication ends the wait
  test('S7: publishing ends the wait; the publication is no progress and the transition raises no stall alert through the monitor', async () => {
    const { planId, taskId, handoffId } = await waiting()
    bench.clock.at = T0 + 180 * MIN
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(bench.messagesTagged('plan-stall')).toEqual([])
    await bench.taskService.handoffs.publish(bench.human, taskId, handoffId, [])
    monitor.notify(world.team.teamId)
    await monitor.idle()
    const view = derivePlanSupervision(bench.compose().reads, world.team.teamId, planId, new Date(bench.clock.at))!.changes.find(change => change.change === 'api')!
    expect([ownerPublication(view.cause), view.alsoApplying.filter(entry => entry.kind === 'owner-publication'), view.progress]).toEqual([null, [], null])
    expect(bench.messagesTagged('plan-stall')).toEqual([])
    monitor.stop()
  })
})
