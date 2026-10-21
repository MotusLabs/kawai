// The hold service (revision-control 3.1, design D4, D3): the owner's
// place, release (whole, by changes, and narrowing a plan hold with
// `retain`), and extend. Every command refuses an agent first, runs its
// named checks and its hold-store writes inside the one transaction that
// records the D3 event (a refusal, or a failing narrowed insert, writes
// nothing anywhere), replays by `(plan_id, command_id)` over the compared
// payload, and wakes the executor after a committed command only. Closing
// and reopening the plan leaves its holds as they are (D4); a passed
// deadline releases nothing.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import type { FloorMap } from '../../shared/planExecution'
import { ImpactStore } from '../strategy/impactStore'
import { hashStrategyContent } from '../strategy/strategyHash'
import { normalizeStrategyContent } from '../../shared/productStrategy'
import { HoldService, type HoldExtendInput, type HoldPlaceInput, type HoldReleaseInput } from '../plans/revisionControl/holdService'
import { HoldStore } from '../plans/revisionControl/holdStore'

let world: PlanWorld
let bench: PlanBench
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)
const now = () => new Date(NOW)
const inDays = (days: number): string => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString()

let holds: HoldStore
let impact: ImpactStore
let decisions: DecisionStore
let executions: ExecutionStore
let service: HoldService
let teamId: string
let planId: string
let wakeCount = 0
let planCounter = 0

const wake = (): void => { wakeCount += 1 }

beforeAll(async () => {
  world = await createPlanWorld('kawai-hold-service-')
  bench = createPlanBench(world)
  teamId = world.team.teamId
  const db = bench.db.db
  holds = new HoldStore(db, now)
  impact = new ImpactStore(db)
  decisions = new DecisionStore(db)
  executions = new ExecutionStore(db)
  service = new HoldService({
    holds, plans: bench.plans, planService: bench.service, strategies: bench.strategies,
    impact, decisions, executions, wake, now,
  })
  planId = (await newApprovedPlan()).planId
  // A running execution carries `ops`, a change the approved revision lacks (D4's union).
  executions.insertExecution({
    teamId, planId, revision: 1, contentHash: 'hash-exec', reportId: 'report-1', inputHash: 'input-1',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base',
    floor: { version: 1, map: {} as FloorMap }, maxParallel: 3, mergeMethod: 'merge',
    changes: [{ change: 'api', landed: false }, { change: 'ui', landed: false }, { change: 'ops', landed: false }],
  })
})

afterAll(() => {
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

async function newApprovedPlan(): Promise<{ planId: string }> {
  const draft = await bench.draftInReview()
  const approved = await bench.approve(draft.planId, draft.revision, `approve-hold-${++planCounter}`)
  if (!approved.ok) throw new Error(approved.message)
  return { planId: draft.planId }
}

function expectOk<T>(outcome: { ok: boolean; message?: string; result?: T }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : outcome.message)
  return outcome.result
}

function refused(outcome: { ok: boolean; reason?: string; message?: string }): { reason: string; message: string } {
  if (outcome.ok) throw new Error('expected a refusal')
  return { reason: outcome.reason ?? '', message: outcome.message ?? '' }
}

const place = (input: Partial<HoldPlaceInput> & { planId: string; commandId: string }) =>
  service.place(bench.human, {
    scope: 'changes', changes: ['api'], rationale: 'rethink the direction', deadline: inDays(2), cites: null, ...input,
  })

const release = (input: Partial<HoldReleaseInput> & { planId: string; holdId: string; commandId: string }) =>
  service.release(bench.human, { reason: 'done waiting', ...input })

const extend = (input: Partial<HoldExtendInput> & { planId: string; holdId: string; deadline: string; commandId: string }) =>
  service.extend(bench.human, { ...input })

/** The team's strategy's newest review, with a proposal naming `plan`, so the review lists it (D4). */
function reviewListingPlan(plan: string): { strategyId: string; reviewId: string } {
  const { strategyId } = bench.approveStrategy()
  const review = bench.strategies.impactReviews(strategyId).at(-1)
  if (!review) throw new Error('the approved strategy opened no impact review')
  impact.insertProposal({ strategyId, reviewId: review.id, planId: plan, disposition: 'reconsider', rationale: 'direction is wrong', authorSession: 'lead' })
  return { strategyId, reviewId: review.id }
}

/** A review of another team's strategy: outside this team's strategy (D4). */
function foreignReviewId(): string {
  const strategy = bench.strategies.forTeam(world.otherTeam.teamId)
    ?? bench.strategies.create({ productId: 'kawai-other', title: 'Other product', owner: { kind: 'human', sessionId: null }, teamId: world.otherTeam.teamId, worktrees: [world.other] })
  const body = { useCases: [{ ref: 'UC1' }], principles: [{ ref: 'P4' }], decisions: [{ ref: 'D1' }], claims: [{ ref: 'C1', text: 'x', kind: 'hypothesis' }] }
  const submitted = bench.strategies.submitRevision(strategy.id, { author: { kind: 'human', sessionId: null }, content: body })
  if (!submitted.ok) throw new Error(submitted.message)
  const approved = bench.strategies.approve(strategy.id, {
    revision: submitted.revision.revision, contentHash: hashStrategyContent(normalizeStrategyContent(body)),
    commandId: `foreign-strategy-${++planCounter}`, expectedCurrentRevision: bench.strategies.get(strategy.id)!.currentApprovedRevision,
    actor: { kind: 'human', sessionId: null },
  })
  if (!approved.ok) throw new Error(approved.message)
  return bench.strategies.impactReviews(strategy.id).at(-1)!.id
}

function cardOn(plan: string, key: string) {
  return decisions.insertCard({
    teamId, planId: plan, revision: null, change: null, taskId: null,
    question: `Hold question ${key}`, options: [], context: null,
    askedBy: { session: 'lead', group: 'leads', profile: 'default' },
    addressedTo: 'owner', addressedGroup: null, messageId: null,
  })
}

describe('place', () => {
  test('placing a hold on two changes records it with its event and canonical deadline', () => {
    const outcome = expectOk(place({ planId, changes: ['ui', 'api'], rationale: '  wrong direction  ', deadline: '2026-11-03T14:00:00+02:00', commandId: 'pl-1' }))
    expect(outcome.hold.scope).toBe('changes')
    expect(outcome.hold.changes).toEqual(['api', 'ui'])
    expect(outcome.hold.rationale).toBe('wrong direction')
    expect(outcome.hold.deadline).toBe('2026-11-03T12:00:00.000Z')
    expect(outcome.hold.createdAt).not.toBe('')
    expect(bench.plans.eventByCommand(planId, 'pl-1')?.event.kind).toBe('hold-placed')
  })

  test('a whole-plan hold takes no change names, and a changes hold names at least one', () => {
    const withNames = refused(place({ planId, scope: 'plan', changes: ['api'], commandId: 'pl-2' }))
    expect(withNames.message).toContain('takes no change names')
    const empty = refused(place({ planId, scope: 'changes', changes: [], commandId: 'pl-3' }))
    expect(empty.message).toContain('names no change')
    expect(bench.plans.eventByCommand(planId, 'pl-2')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'pl-3')).toBeNull()
  })

  test('a closed plan is refused and writes nothing', async () => {
    const draft = await bench.draftInReview()
    const closed = await bench.service.close(bench.human, { planId: draft.planId, outcome: 'cancelled', reason: 'shelved', commandId: `pl-closed-${++planCounter}` })
    expect(closed.ok).toBe(true)
    const outcome = refused(place({ planId: draft.planId, commandId: 'pl-4' }))
    expect(outcome.reason).toBe('state')
    expect(outcome.message).toContain('only an open plan takes a hold')
    expect(bench.plans.eventByCommand(draft.planId, 'pl-4')).toBeNull()
    expect(holds.forPlan(teamId, draft.planId)).toHaveLength(0)
  })

  test('a deadline in the past or beyond 30 days is refused and writes nothing; exactly 30 days is accepted', () => {
    const past = refused(place({ planId, deadline: inDays(-1), commandId: 'pl-5' }))
    expect(past.message).toContain('not in the future')
    const far = refused(place({ planId, deadline: inDays(31), commandId: 'pl-6' }))
    expect(far.message).toContain('more than 30 days away')
    const exact = expectOk(place({ planId, deadline: inDays(30), commandId: 'pl-7' }))
    expect(exact.hold.deadline).toBe(inDays(30))
    expect(bench.plans.eventByCommand(planId, 'pl-5')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'pl-6')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'pl-7')?.event.kind).toBe('hold-placed')
  })

  test('an empty rationale is refused and writes nothing', () => {
    const outcome = refused(place({ planId, rationale: '   ', commandId: 'pl-8' }))
    expect(outcome.message).toContain('the rationale is empty')
    expect(bench.plans.eventByCommand(planId, 'pl-8')).toBeNull()
  })

  test('unknown or repeated change names are refused and write nothing; a running execution change is holdable', () => {
    const unknown = refused(place({ planId, changes: ['api', 'nope'], commandId: 'pl-9' }))
    expect(unknown.message).toContain('unknown change: nope')
    const repeated = refused(place({ planId, changes: ['api', 'api'], commandId: 'pl-10' }))
    expect(repeated.message).toContain('named twice')
    const ops = expectOk(place({ planId, changes: ['ops'], commandId: 'pl-11' }))
    expect(ops.hold.changes).toEqual(['ops'])
    expect(bench.plans.eventByCommand(planId, 'pl-9')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'pl-10')).toBeNull()
  })

  test('a foreign cite is refused and writes nothing', async () => {
    // The team's own strategy exists, so a foreign review id fails the membership check.
    bench.approveStrategy()
    const foreign = foreignReviewId()
    const outside = refused(place({ planId, cites: { kind: 'impact-review', id: foreign }, commandId: 'pl-12' }))
    expect(outside.message).toContain("does not belong to this team's strategy")
    const otherPlan = (await newApprovedPlan()).planId
    const { reviewId: silent } = reviewListingPlan(otherPlan)
    const notListing = refused(place({ planId, cites: { kind: 'impact-review', id: silent }, commandId: 'pl-13' }))
    expect(notListing.message).toContain('does not list this plan')
    const otherCard = cardOn(otherPlan, 'pl-13')
    const wrongCard = refused(place({ planId, cites: { kind: 'decision-card', id: otherCard.id }, commandId: 'pl-14' }))
    expect(wrongCard.message).toContain('is not a card of this plan')
    expect(bench.plans.eventByCommand(planId, 'pl-12')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'pl-13')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'pl-14')).toBeNull()
  })

  test('a hold may cite a review listing the plan or a card of the plan', async () => {
    const target = (await newApprovedPlan()).planId
    const { reviewId } = reviewListingPlan(target)
    const withReview = expectOk(place({ planId: target, cites: { kind: 'impact-review', id: reviewId }, commandId: 'pl-15' }))
    expect(withReview.hold.cites).toEqual({ kind: 'impact-review', id: reviewId })
    const card = cardOn(target, 'pl-15')
    const withCard = expectOk(place({ planId: target, cites: { kind: 'decision-card', id: card.id }, commandId: 'pl-16' }))
    expect(withCard.hold.cites).toEqual({ kind: 'decision-card', id: card.id })
  })

  test('an agent caller is refused for place, release, and extend, and nothing is written', () => {
    const before = wakeCount
    const agent = bench.agent('dev')
    const placed = refused(service.place(agent, { planId, scope: 'changes', changes: ['api'], rationale: 'r', deadline: inDays(2), cites: null, commandId: 'pl-17' }))
    const released = refused(service.release(agent, { planId, holdId: 'hold-x', reason: 'r', commandId: 'pl-18' }))
    const extended = refused(service.extend(agent, { planId, holdId: 'hold-x', deadline: inDays(3), commandId: 'pl-19' }))
    expect(placed.reason).toBe('forbidden')
    expect(released.reason).toBe('forbidden')
    expect(extended.reason).toBe('forbidden')
    expect(wakeCount).toBe(before)
    expect(bench.plans.eventByCommand(planId, 'pl-17')).toBeNull()
  })
})

describe('release', () => {
  test('releasing a whole hold stamps it released, trims the reason, and writes the event', async () => {
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(place({ planId: target, changes: ['api', 'ui'], commandId: 're-1' }))
    const outcome = expectOk(release({ planId: target, holdId: placed.hold.id, reason: '  done waiting  ', commandId: 're-2' }))
    expect(outcome.released.releasedAt).not.toBeNull()
    expect(outcome.released.releaseReason).toBe('done waiting')
    expect(outcome.narrowed).toBeNull()
    expect(holds.active(teamId, target)).toHaveLength(0)
    expect(bench.plans.eventByCommand(target, 're-2')?.event.kind).toBe('hold-released')
  })

  test('releasing some changes keeps the hold until its last rows go', async () => {
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(place({ planId: target, changes: ['api', 'ui'], commandId: 're-3' }))
    const first = expectOk(release({ planId: target, holdId: placed.hold.id, changes: ['api'], reason: 'api ok', commandId: 're-4' }))
    expect(first.released.releasedAt).toBeNull()
    expect(first.released.changes).toEqual(['ui'])
    expect(holds.active(teamId, target).map(hold => hold.id)).toEqual([placed.hold.id])
    const last = expectOk(release({ planId: target, holdId: placed.hold.id, changes: ['ui'], reason: 'ui ok', commandId: 're-5' }))
    expect(last.released.releasedAt).not.toBeNull()
    expect(holds.active(teamId, target)).toHaveLength(0)
    expect(bench.plans.eventByCommand(target, 're-5')?.event.kind).toBe('hold-released')
  })

  test('a whole-plan hold cannot be freed by change names; a changes hold cannot retain', async () => {
    const target = (await newApprovedPlan()).planId
    const planHold = expectOk(place({ planId: target, scope: 'plan', changes: [], commandId: 're-6' }))
    const byChanges = refused(release({ planId: target, holdId: planHold.hold.id, changes: ['api'], reason: 'r', commandId: 're-7' }))
    expect(byChanges.message).toContain('narrowed with retain')
    const changesHold = expectOk(place({ planId: target, commandId: 're-8' }))
    const byRetain = refused(release({ planId: target, holdId: changesHold.hold.id, retain: ['api'], reason: 'r', commandId: 're-9' }))
    expect(byRetain.message).toContain('only a whole-plan hold narrows')
    expect(bench.plans.eventByCommand(target, 're-7')).toBeNull()
    expect(bench.plans.eventByCommand(target, 're-9')).toBeNull()
  })

  test('releasing changes the hold does not cover, or names twice, is refused', async () => {
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(place({ planId: target, changes: ['api'], commandId: 're-10' }))
    const uncovered = refused(release({ planId: target, holdId: placed.hold.id, changes: ['ui'], reason: 'r', commandId: 're-11' }))
    expect(uncovered.message).toContain('does not cover ui')
    const twice = refused(release({ planId: target, holdId: placed.hold.id, changes: ['api', 'api'], reason: 'r', commandId: 're-12' }))
    expect(twice.message).toContain('named twice')
    expect(bench.plans.eventByCommand(target, 're-11')).toBeNull()
    expect(bench.plans.eventByCommand(target, 're-12')).toBeNull()
  })

  test('an unknown or already-released hold, or an empty reason, writes nothing', async () => {
    const target = (await newApprovedPlan()).planId
    const unknown = refused(release({ planId: target, holdId: 'hold-nope', reason: 'r', commandId: 're-13' }))
    expect(unknown.reason).toBe('not-found')
    const placed = expectOk(place({ planId: target, commandId: 're-14' }))
    const whole = expectOk(release({ planId: target, holdId: placed.hold.id, reason: 'done', commandId: 're-15' }))
    expect(whole.released.releasedAt).not.toBeNull()
    const again = refused(release({ planId: target, holdId: placed.hold.id, reason: 'again', commandId: 're-16' }))
    expect(again.reason).toBe('state')
    expect(again.message).toContain('already released')
    const second = expectOk(place({ planId: target, commandId: 're-17' }))
    const empty = refused(release({ planId: target, holdId: second.hold.id, reason: '   ', commandId: 're-18' }))
    expect(empty.message).toContain('reason is empty')
    expect(bench.plans.eventByCommand(target, 're-16')).toBeNull()
    expect(bench.plans.eventByCommand(target, 're-18')).toBeNull()
  })
})

describe('narrowing (D4)', () => {
  test('narrowing releases the plan hold and places the narrowed hold with the same rationale, cites, and deadline', async () => {
    const target = (await newApprovedPlan()).planId
    const card = cardOn(target, 'nr')
    const placed = expectOk(place({ planId: target, scope: 'plan', changes: [], rationale: 'whole plan first', deadline: inDays(4), cites: { kind: 'decision-card', id: card.id }, commandId: 'nr-1' }))
    const outcome = expectOk(release({ planId: target, holdId: placed.hold.id, reason: 'keep the changes only', retain: ['ui', 'api'], commandId: 'nr-2' }))
    expect(outcome.released.releasedAt).not.toBeNull()
    expect(outcome.narrowed).not.toBeNull()
    expect(outcome.narrowed!.id).toBe('hold-nr-2-narrowed')
    expect(outcome.narrowed!.scope).toBe('changes')
    expect(outcome.narrowed!.changes).toEqual(['api', 'ui'])
    expect(outcome.narrowed!.rationale).toBe('whole plan first')
    expect(outcome.narrowed!.deadline).toBe(placed.hold.deadline)
    expect(outcome.narrowed!.cites).toEqual({ kind: 'decision-card', id: card.id })
    expect(bench.plans.eventByCommand(target, 'nr-2')?.event.kind).toBe('hold-released')
  })

  test('a narrowing whose narrowed insert fails rolls the whole command back (one transaction)', async () => {
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(place({ planId: target, scope: 'plan', changes: [], commandId: 'nr-3' }))
    // A hold already owning the narrowed id makes the narrowed insert fail
    // after the release has written: the whole command — release and event —
    // must roll back, proving release and insert share one transaction.
    holds.insert({ id: 'hold-nr-4-narrowed', teamId, planId: target, scope: 'changes', rationale: 'blocked', deadline: inDays(4), cites: null, commandId: 'nr-4', changes: ['api'] })
    expect(() => release({ planId: target, holdId: placed.hold.id, reason: 'narrow to api', retain: ['api'], commandId: 'nr-4' })).toThrow()
    expect(holds.get(teamId, placed.hold.id)!.releasedAt).toBeNull()
    expect(bench.plans.eventByCommand(target, 'nr-4')).toBeNull()
  })

  test('a narrowing replay returns the prior outcome and writes nothing', async () => {
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(place({ planId: target, scope: 'plan', changes: [], commandId: 'nr-5' }))
    const first = release({ planId: target, holdId: placed.hold.id, reason: 'keep two', retain: ['ui', 'api'], commandId: 'nr-6' })
    expect(first.ok && !first.replayed).toBe(true)
    const before = holds.forPlan(teamId, target).length
    // The retain list in another order is the same compared payload (D3).
    const replay = release({ planId: target, holdId: placed.hold.id, reason: 'keep two', retain: ['api', 'ui'], commandId: 'nr-6' })
    expect(replay.ok && replay.replayed).toBe(true)
    expect(holds.forPlan(teamId, target)).toHaveLength(before)
    expect(bench.plans.eventByCommand(target, 'nr-6')?.event.kind).toBe('hold-released')
  })

  test('narrowing refuses a retain name the plan does not know, and writes nothing', async () => {
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(place({ planId: target, scope: 'plan', changes: [], commandId: 'nr-7' }))
    const outcome = refused(release({ planId: target, holdId: placed.hold.id, reason: 'keep none', retain: ['nope'], commandId: 'nr-8' }))
    expect(outcome.message).toContain('unknown change: nope')
    expect(holds.get(teamId, placed.hold.id)!.releasedAt).toBeNull()
    expect(holds.get(teamId, 'hold-nr-8-narrowed')).toBeNull()
    expect(bench.plans.eventByCommand(target, 'nr-8')).toBeNull()
  })
})

describe('extend', () => {
  test('extending sets a later canonical deadline and writes the event', () => {
    const placed = expectOk(place({ planId, deadline: inDays(2), commandId: 'ex-1' }))
    const outcome = expectOk(extend({ planId, holdId: placed.hold.id, deadline: inDays(10), reason: '  still deciding  ', commandId: 'ex-2' }))
    expect(outcome.hold.deadline).toBe(inDays(10))
    const event = bench.plans.eventByCommand(planId, 'ex-2')
    expect(event?.event.kind).toBe('hold-extended')
    expect(event?.payload).toMatchObject({ reason: 'still deciding', deadline: inDays(10) })
  })

  test('extend refuses a past, non-later, or beyond-30-days deadline and writes nothing', () => {
    const placed = expectOk(place({ planId, deadline: inDays(2), commandId: 'ex-3' }))
    const past = refused(extend({ planId, holdId: placed.hold.id, deadline: inDays(-1), commandId: 'ex-4' }))
    expect(past.message).toContain('not in the future')
    const earlier = refused(extend({ planId, holdId: placed.hold.id, deadline: inDays(1), commandId: 'ex-5' }))
    expect(earlier.message).toContain('not later')
    const far = refused(extend({ planId, holdId: placed.hold.id, deadline: inDays(40), commandId: 'ex-6' }))
    expect(far.message).toContain('more than 30 days away')
    expect(holds.get(teamId, placed.hold.id)!.deadline).toBe(inDays(2))
    expect(bench.plans.eventByCommand(planId, 'ex-4')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'ex-5')).toBeNull()
    expect(bench.plans.eventByCommand(planId, 'ex-6')).toBeNull()
  })
})

describe('replay and payload identity (D3)', () => {
  test('a same-payload replay of each command returns the prior outcome and writes nothing', async () => {
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(place({ planId: target, commandId: 'rp-1' }))
    const before = holds.forPlan(teamId, target).length
    const placeReplay = place({ planId: target, commandId: 'rp-1' })
    expect(placeReplay.ok && placeReplay.replayed).toBe(true)
    expect(holds.forPlan(teamId, target)).toHaveLength(before)
    const released = expectOk(release({ planId: target, holdId: placed.hold.id, changes: ['api'], reason: 'api can move', commandId: 'rp-2' }))
    // The hold's only row went, so the release set it released; the replay must not write again.
    expect(released.released.releasedAt).not.toBeNull()
    const releaseReplay = release({ planId: target, holdId: placed.hold.id, changes: ['api'], reason: 'api can move', commandId: 'rp-2' })
    expect(releaseReplay.ok && releaseReplay.replayed).toBe(true)
    expect(holds.forPlan(teamId, target)).toHaveLength(before)
    // rp-2 released `placed` wholly; the extension replays on a second hold.
    const other = expectOk(place({ planId: target, scope: 'plan', changes: [], commandId: 'rp-4' }))
    const extended = expectOk(extend({ planId: target, holdId: other.hold.id, deadline: inDays(6), reason: 'longer', commandId: 'rp-3' }))
    expect(extended.hold.deadline).toBe(inDays(6))
    const extendReplay = extend({ planId: target, holdId: other.hold.id, deadline: inDays(6), reason: 'longer', commandId: 'rp-3' })
    expect(extendReplay.ok && extendReplay.replayed).toBe(true)
    expect(holds.get(teamId, other.hold.id)!.deadline).toBe(inDays(6))
  })

  test('the same command id with a different payload is refused naming the field', async () => {
    const first = expectOk(place({ planId, rationale: 'first', commandId: 'pi-1' }))
    const rationale = refused(place({ planId, rationale: 'second', commandId: 'pi-1' }))
    expect(rationale.reason).toBe('payload')
    expect(rationale.message).toContain('different rationale;')
    const released = expectOk(release({ planId, holdId: first.hold.id, changes: [], reason: 'why not', commandId: 'pi-2' }))
    const reason = refused(release({ planId, holdId: released.released.id, changes: [], reason: 'else', commandId: 'pi-2' }))
    expect(reason.reason).toBe('payload')
    expect(reason.message).toContain('different reason;')
    const second = expectOk(place({ planId, commandId: 'pi-3' }))
    const extended = expectOk(extend({ planId, holdId: second.hold.id, deadline: inDays(4), commandId: 'pi-4' }))
    const deadline = refused(extend({ planId, holdId: extended.hold.id, deadline: inDays(6), commandId: 'pi-4' }))
    expect(deadline.reason).toBe('payload')
    expect(deadline.message).toContain('different deadline;')
  })
})

describe('lifecycle and clocks', () => {
  test('closing and reopening the plan leaves holds unchanged', async () => {
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(place({ planId: target, commandId: 'lc-1' }))
    const closed = await bench.service.close(bench.human, { planId: target, outcome: 'cancelled', reason: 'shelved', commandId: `lc-close-${++planCounter}` })
    expect(closed.ok).toBe(true)
    expect(holds.active(teamId, target).map(hold => hold.id)).toEqual([placed.hold.id])
    const reopened = await bench.service.reopen(bench.human, { planId: target, commandId: `lc-reopen-${++planCounter}` })
    expect(reopened.ok).toBe(true)
    expect(holds.active(teamId, target).map(hold => hold.id)).toEqual([placed.hold.id])
    // The hold still works after reopening: extending it succeeds.
    const extended = expectOk(extend({ planId: target, holdId: placed.hold.id, deadline: inDays(9), reason: 'still deciding', commandId: 'lc-2' }))
    expect(extended.hold.deadline).toBe(inDays(9))
  })

  test('a passed deadline releases nothing (D4)', async () => {
    let clock = NOW
    const local = new HoldService({
      ...service.deps, holds: new HoldStore(bench.db.db, () => new Date(clock)), now: () => new Date(clock),
    })
    const target = (await newApprovedPlan()).planId
    const placed = expectOk(local.place(bench.human, { planId: target, scope: 'changes', changes: ['api'], rationale: 'r', deadline: inDays(1), cites: null, commandId: 'pd-1' }))
    clock = NOW + 3 * 24 * 60 * 60 * 1000
    expect(holds.active(teamId, target).map(hold => hold.id)).toEqual([placed.hold.id])
  })

  test('a deadline exactly now is refused for place and extend (M2)', () => {
    const placed = refused(place({ planId, deadline: inDays(0), commandId: 'pn-1' }))
    expect(placed.message).toContain('not in the future')
    expect(bench.plans.eventByCommand(planId, 'pn-1')).toBeNull()
    const held = expectOk(place({ planId, deadline: inDays(2), commandId: 'pn-2' }))
    const extended = refused(extend({ planId, holdId: held.hold.id, deadline: inDays(0), commandId: 'pn-3' }))
    expect(extended.message).toContain('not in the future')
    expect(holds.get(teamId, held.hold.id)!.deadline).toBe(inDays(2))
    expect(bench.plans.eventByCommand(planId, 'pn-3')).toBeNull()
  })

  test('the executor wake and the plan-detail push fire once per committed command, never on a replay or a refusal', () => {
    const before = wakeCount
    let pushes = 0
    const stop = bench.plans.subscribe(() => { pushes += 1 })
    const placed = expectOk(place({ planId, commandId: 'wk-1' }))
    expect(wakeCount - before).toBe(1)
    expect(pushes).toBe(1)
    const replay = place({ planId, commandId: 'wk-1' })
    expect(replay.ok && replay.replayed).toBe(true)
    expect(wakeCount - before).toBe(1)
    expect(pushes).toBe(1)
    const failed = place({ planId, changes: ['nope'], commandId: 'wk-2' })
    expect(failed.ok).toBe(false)
    expect(wakeCount - before).toBe(1)
    expect(pushes).toBe(1)
    const released = expectOk(release({ planId, holdId: placed.hold.id, reason: 'done waiting', commandId: 'wk-3' }))
    expect(released.released.releasedAt).not.toBeNull()
    expect(wakeCount - before).toBe(2)
    expect(pushes).toBe(2)
    stop()
  })
})
