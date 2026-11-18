// The revision-control attention sources (revision-control 9.3, design D13;
// oracles AT1–AT11 and property AP-1 of the design's "Remainder"). The rows
// and the completeness test build each situation in the real stores on a
// fresh test database, read it through the one revision-control reader, and
// project it through the real `ATTENTION_SOURCES`; AP-1 runs seeded command
// sequences over the same seam: one target never raises two items, and items
// exist only for open plans.
import { describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AttentionItem } from '../../shared/teamWorkspace'
import type { FloorMap } from '../../shared/planExecution'
import { attentionItems, type AttentionInput } from '../team/workspaceRead'
import { PlanStore } from '../plans/planStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { CheckpointStore } from '../plans/revisionControl/checkpointStore'
import { readRevisionControl } from '../plans/revisionControl/revisionControlRead'
import { revisionControlFactsOf } from '../plans/planAttention'
import { propertyCases } from './helpers/propertyCases'
import { schemaCopy } from './schemaDb'

const TEAM = 'team-at'
const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-11-18T12:00:00.000Z')
const at = (offsetHours: number) => new Date(NOW.getTime() + offsetHours * HOUR).toISOString()
const KINDS = new Set(['plan-hold-overdue', 'plan-pause-overdue', 'plan-checkpoint-decision'])

/** The real stores over one fresh test database. */
class World {
  readonly db: Database = schemaCopy()
  readonly plans = new PlanStore(this.db)
  readonly executions = new ExecutionStore(this.db)
  readonly holds = new HoldStore(this.db)
  readonly pauses = new PauseStore(this.db)
  readonly checkpoints = new CheckpointStore(this.db)
  private seq = 0

  plan(title = 'Wave R'): string {
    return this.plans.insertPlan({ teamId: TEAM, title, creator: { kind: 'human', sessionId: null } })
  }

  execution(planId: string): string {
    return this.executions.insertExecution({
      teamId: TEAM, planId, revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: {} as FloorMap },
      maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }, { change: 'ui', landed: false }],
    }).id
  }

  hold(planId: string, deadline: string, changes: string[] = []): string {
    return this.holds.insert({
      teamId: TEAM, planId, scope: changes.length > 0 ? 'changes' : 'plan', rationale: 'look again', deadline,
      cites: null, commandId: `hold-cmd-${++this.seq}`, changes,
    }).id
  }

  /** A pause over the hold with one target per change; `gone-` holders read killed. */
  pause(planId: string, executionId: string, holdId: string, deadline: string, targets: Array<{ change: string; holder: string }>): string {
    return this.pauses.insert({ teamId: TEAM, planId, executionId, holdId, deadline, note: null, commandId: `pause-cmd-${++this.seq}` },
      targets.map(target => ({ change: target.change, stage: 'attempt', attemptId: null, assignmentId: `a-${target.change}-${this.seq}`, holderSession: target.holder }))).id
  }

  /** A commit checkpoint whose push failed (the `checkpoint-push-failed` cause). */
  failedPush(executionId: string, pauseId: string, change: string): void {
    const checkpoint = this.checkpoints.insert({
      executionId, change, pauseId, attemptId: null, sessionId: 'live-holder', kind: 'commit', commitSha: 'c0ffee', baselineCommit: 'base',
      manifestHash: 'mh', resultId: null, summary: 'wip', unfinished: null, errorsTests: null, nextSteps: 'finish', effectId: null,
    })
    const effect = this.executions.insertEffect({ executionId, change, roundId: null, kind: 'push-checkpoint', effectKey: `${executionId}:${change}:push-checkpoint:${checkpoint.id}:0`, command: { commit: 'c0ffee' } })
    this.executions.setEffectOutcome(effect.id, { state: 'failed', error: 'rejected' })
    this.checkpoints.setEffect(checkpoint.id, effect.id)
  }

  /** The workspace's attention over every open plan at `now`, through the real sources. */
  items(now: Date): AttentionItem[] {
    const tick = {
      pauses: this.pauses, checkpoints: this.checkpoints, executions: this.executions,
      mailbox: { get: () => null }, deliverOwed: () => [], assignmentMessageState: () => null,
      readiness: () => ({ ready: true, reason: null }),
      factsOf: (id: string) => ({ state: id.startsWith('gone') ? 'killed' as const : 'live' as const, pendingRequest: false, busy: false, providerLimit: null }),
    }
    const reads = { holds: this.holds, pauses: this.pauses, checkpoints: this.checkpoints, executions: this.executions, tick: tick as never }
    const facts = revisionControlFactsOf(this.plans.openPlans(TEAM), (planId, when) => readRevisionControl(reads, TEAM, planId, when), now)
    return attentionItems({
      sessions: [], messages: [], waiting: {}, taskTitle: () => null, nameOf: (id: string) => id,
      pendingAcceptance: [], outboundViolations: [], revisionControl: facts,
    } as unknown as AttentionInput).filter(item => KINDS.has(item.kind))
  }
}

// --- The hold rows (AT1–AT4, AT11) ---
type HoldState = 'active' | 'released' | 'extended'
const HOLD_STATES: HoldState[] = ['active', 'released', 'extended']

/** One hold situation in the stores; returns the hold id, its current deadline, and the plan. */
function holdSituation(world: World, open: boolean, state: HoldState, passed: boolean): { holdId: string; deadline: string; oldDeadline: string } {
  const planId = world.plan()
  // The original deadline: an hour ago when extended (its item existed), else per `passed`.
  const oldDeadline = state === 'extended' ? at(-1) : passed ? at(-0.5) : at(1)
  const holdId = world.hold(planId, oldDeadline)
  let deadline = oldDeadline
  if (state === 'extended') {
    deadline = passed ? at(-0.25) : at(2)
    world.holds.extend({ teamId: TEAM, holdId, deadline })
  }
  if (state === 'released') world.holds.release({ teamId: TEAM, holdId, changes: [], reason: 'done', commandId: `rel-${holdId}` })
  if (!open) world.plans.setLifecycle(planId, 'completed')
  return { holdId, deadline, oldDeadline }
}

/** The hold rows, verbatim: exactly one row per combination (a closed plan is AT4 whatever the rest). */
function holdRow(open: boolean, state: HoldState, passed: boolean): string {
  const rows = [
    { id: 'AT4', match: !open },
    { id: 'AT1', match: open && state === 'active' && passed },
    { id: 'AT11', match: open && state === 'active' && !passed },
    { id: 'AT2', match: open && state === 'released' },
    { id: 'AT3', match: open && state === 'extended' },
  ].filter(row => row.match)
  expect(rows).toHaveLength(1)
  return rows[0]!.id
}

// --- The target rows (AT4–AT10) ---
type TargetState = 'pausing-other' | 'holder-killed' | 'checkpoint-push-failed' | 'paused' | 'decided'
const TARGET_STATES: TargetState[] = ['pausing-other', 'holder-killed', 'checkpoint-push-failed', 'paused', 'decided']

function targetSituation(world: World, open: boolean, state: TargetState, passed: boolean, running: boolean): string {
  const planId = world.plan()
  const executionId = world.execution(planId)
  const holdId = world.hold(planId, at(24), ['api'])
  const pauseId = world.pause(planId, executionId, holdId, passed ? at(-1) : at(1), [{ change: 'api', holder: state === 'holder-killed' ? 'gone-holder' : 'live-holder' }])
  if (state === 'checkpoint-push-failed') world.failedPush(executionId, pauseId, 'api')
  if (state === 'paused') world.pauses.recordPaused(pauseId, 'api', null)
  if (state === 'decided') world.pauses.recordDecision({ pauseId, change: 'api', decision: 'continue', detail: {}, commandId: `decide-${pauseId}` })
  if (!running) world.executions.finishExecution(executionId, 'stopped', 'stopped by the owner')
  if (!open) world.plans.setLifecycle(planId, 'cancelled')
  return pauseId
}

function targetRow(open: boolean, state: TargetState, passed: boolean, running: boolean): string {
  const rows = [
    { id: 'AT4', match: !open },
    { id: 'AT9', match: open && !running },
    { id: 'AT8', match: open && running && state === 'decided' },
    { id: 'AT6', match: open && running && state === 'paused' },
    { id: 'AT7', match: open && running && (state === 'holder-killed' || state === 'checkpoint-push-failed') },
    { id: 'AT5', match: open && running && state === 'pausing-other' && passed },
    { id: 'AT10', match: open && running && state === 'pausing-other' && !passed },
  ].filter(row => row.match)
  expect(rows).toHaveLength(1)
  return rows[0]!.id
}

/** Each row's items, as the table states them. */
function expectedTargetItems(row: string, pauseId: string): Array<{ id: string; kind: string; nextAction: string }> {
  switch (row) {
    case 'AT5': return [{ id: `plan-pause-overdue:${pauseId}:api`, kind: 'plan-pause-overdue', nextAction: 'Unblock the holder, or restart or stop' }]
    case 'AT6': return [{ id: `plan-checkpoint:${pauseId}:api`, kind: 'plan-checkpoint-decision', nextAction: 'Continue, adapt, restart, or stop' }]
    case 'AT7': return [{ id: `plan-checkpoint:${pauseId}:api`, kind: 'plan-checkpoint-decision', nextAction: 'Restart or stop' }]
    default: return []
  }
}

const shape = (items: AttentionItem[]) => items.map(item => ({ id: item.id, kind: item.kind, nextAction: item.nextAction }))

describe('the revision-control attention rows (AT)', () => {
  const holdCase = ({ id, open, state, passed }: { id: string; situation: string; open: boolean; state: HoldState; passed: boolean }) => {
    const world = new World()
    const { holdId, deadline, oldDeadline } = holdSituation(world, open, state, passed)
    expect(holdRow(open, state, passed)).toBe(id)
    const items = world.items(NOW)
    if (id === 'AT1') {
      expect(shape(items)).toEqual([{ id: `plan-hold-overdue:${holdId}:${deadline}`, kind: 'plan-hold-overdue', nextAction: 'Release or extend the hold' }])
      expect(items[0]).toMatchObject({ owner: { kind: 'human' }, requiresHuman: true, link: { kind: 'plan' } })
    } else {
      expect(items).toEqual([])
    }
    if (id === 'AT3') {
      // The old key never returns; a new key appears only once the new deadline passes.
      expect(items.map(item => item.id)).not.toContain(`plan-hold-overdue:${holdId}:${oldDeadline}`)
      expect(world.items(new Date(Date.parse(deadline) + 1)).map(item => item.id)).toEqual([`plan-hold-overdue:${holdId}:${deadline}`])
    }
  }
  // @covers: plan-holds › Holds are released only by the owner › The deadline passes
  test('AT1: open plan, active hold, deadline passed', () => holdCase({ id: 'AT1', situation: 'open plan, active hold, deadline passed', open: true, state: 'active' as HoldState, passed: true }))
  test('AT2: the hold released', () => holdCase({ id: 'AT2', situation: 'the hold released', open: true, state: 'released' as HoldState, passed: true }))
  // @covers: plan-holds › Holds are visible to the owner and agents › Extending clears the item
  test('AT3: the hold extended to a later deadline', () => holdCase({ id: 'AT3', situation: 'the hold extended to a later deadline', open: true, state: 'extended' as HoldState, passed: false }))
  test('AT4: the plan closed', () => holdCase({ id: 'AT4', situation: 'the plan closed', open: false, state: 'active' as HoldState, passed: true }))
  test('AT11: open plan, active hold, deadline not passed', () => holdCase({ id: 'AT11', situation: 'open plan, active hold, deadline not passed', open: true, state: 'active' as HoldState, passed: false }))

  const targetCase = ({ id, state, passed, running }: { id: string; situation: string; state: TargetState; passed: boolean; running: boolean }) => {
    const world = new World()
    const pauseId = targetSituation(world, true, state, passed, running)
    expect(targetRow(true, state, passed, running)).toBe(id)
    expect(shape(world.items(NOW))).toEqual(expectedTargetItems(id, pauseId))
  }
  // @covers: plan-pause › Pausing never resolves a pending request › The pause deadline passes
  test('AT5: target Pausing for another cause, pause deadline passed', () => targetCase({ id: 'AT5', situation: 'target Pausing for another cause, pause deadline passed', state: 'pausing-other' as TargetState, passed: true, running: true }))
  // @covers: plan-pause › Pauses are visible to the owner and agents › A paused change's cause
  test('AT6: target Paused, undecided, before the deadline', () => targetCase({ id: 'AT6', situation: 'target Paused, undecided, before the deadline', state: 'paused' as TargetState, passed: false, running: true }))
  test('AT6: target Paused, undecided, after the deadline', () => targetCase({ id: 'AT6', situation: 'target Paused, undecided, after the deadline', state: 'paused' as TargetState, passed: true, running: true }))
  test('AT7: target Pausing as holder-killed, after the deadline', () => targetCase({ id: 'AT7', situation: 'target Pausing as holder-killed, after the deadline', state: 'holder-killed' as TargetState, passed: true, running: true }))
  // @covers: plan-pause › Pausing never resolves a pending request › A failed checkpoint push past the deadline
  test('AT7: target Pausing as checkpoint-push-failed, before the deadline', () => targetCase({ id: 'AT7', situation: 'target Pausing as checkpoint-push-failed, before the deadline', state: 'checkpoint-push-failed' as TargetState, passed: false, running: true }))
  test('AT8: target decided', () => targetCase({ id: 'AT8', situation: 'target decided', state: 'decided' as TargetState, passed: true, running: true }))
  // @covers: plan-pause › Pauses are visible to the owner and agents › Stop clears decisions
  test('AT9: execution stopped or finished', () => targetCase({ id: 'AT9', situation: 'execution stopped or finished', state: 'paused' as TargetState, passed: true, running: false }))
  test('AT10: target Pausing for another cause, deadline not passed', () => targetCase({ id: 'AT10', situation: 'target Pausing for another cause, deadline not passed', state: 'pausing-other' as TargetState, passed: false, running: true }))

  // @covers: plan-pause › Pausing never resolves a pending request › A failed checkpoint push past the deadline
  test('completeness: every axis combination matches exactly one row and yields that row\'s items', () => {
    let combinations = 0
    for (const open of [true, false]) {
      for (const state of HOLD_STATES) {
        for (const passed of [true, false]) {
          const world = new World()
          const { holdId, deadline } = holdSituation(world, open, state, passed)
          const row = holdRow(open, state, passed)
          const due = (row === 'AT1' || (row === 'AT3' && passed)) ? [`plan-hold-overdue:${holdId}:${deadline}`] : []
          expect(world.items(NOW).map(item => item.id)).toEqual(due)
          combinations += 1
        }
      }
      for (const state of TARGET_STATES) {
        for (const passed of [true, false]) {
          for (const running of [true, false]) {
            const world = new World()
            const pauseId = targetSituation(world, open, state, passed, running)
            expect(shape(world.items(NOW))).toEqual(expectedTargetItems(targetRow(open, state, passed, running), pauseId))
            combinations += 1
          }
        }
      }
    }
    expect(combinations).toBe(2 * 3 * 2 + 2 * 5 * 2 * 2)
  })
})

// --- AP-1: one target never raises two items; items exist only for open plans ---

/** mulberry32: a small seeded generator, no dependency. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0x4c0d
const CASES = 300
const STEPS = 12

describe('property AP-1', () => {
  test('AP-1: one target never raises two items, and items exist only for open plans (seed 0x4C0D, 300 cases)', () => {
    const ops = ['place', 'extend', 'release', 'pause', 'paused', 'decide', 'stop', 'close', 'reopen', 'later'] as const
    for (let index = 0; index < propertyCases(CASES); index += 1) {
      const random = rng(SEED + index)
      const pick = <T>(list: readonly T[]): T | undefined => (list.length === 0 ? undefined : list[Math.floor(random() * list.length)])
      const world = new World()
      const planId = world.plan(`case ${index}`)
      let executionId = world.execution(planId)
      let now = NOW
      const trace: string[] = []
      for (let step = 0; step < STEPS; step += 1) {
        const op = pick(ops)!
        trace.push(op)
        const active = world.holds.active(TEAM, planId)
        const offset = (random() * 4 - 1.5) * HOUR
        const deadline = new Date(now.getTime() + offset).toISOString()
        const open = world.pauses.forPlan(TEAM, planId, true)
        const undecided = open.flatMap(pause => world.pauses.targets(pause.id).filter(target => target.decision === null).map(target => ({ pause, target })))
        switch (op) {
          case 'place': world.hold(planId, deadline, random() < 0.5 ? [] : [pick(['api', 'ui'])!]); break
          case 'extend': { const hold = pick(active); if (hold) world.holds.extend({ teamId: TEAM, holdId: hold.id, deadline: new Date(Date.parse(hold.deadline) + Math.abs(offset) + 1).toISOString() }); break }
          case 'release': { const hold = pick(active); if (hold) world.holds.release({ teamId: TEAM, holdId: hold.id, changes: [], reason: 'r', commandId: `rel-${index}-${step}` }); break }
          case 'pause': {
            const hold = pick(active)
            if (!hold) break
            if (world.executions.execution(executionId)!.state !== 'running') executionId = world.execution(planId)
            const changes = (hold.scope === 'plan' ? ['api', 'ui'] : hold.changes)
            const pauseId = world.pause(planId, executionId, hold.id, deadline, changes.map(change => ({ change, holder: pick(['live-holder', 'gone-holder'])! })))
            if (random() < 0.3) world.failedPush(executionId, pauseId, changes[0]!)
            break
          }
          case 'paused': { const entry = pick(undecided); if (entry) world.pauses.recordPaused(entry.pause.id, entry.target.change, null); break }
          case 'decide': {
            const entry = pick(undecided)
            if (entry) {
              world.pauses.recordDecision({ pauseId: entry.pause.id, change: entry.target.change, decision: pick(['continue', 'adapt', 'restart'] as const)!, detail: {}, commandId: `d-${index}-${step}` })
              world.pauses.closeIfDecided(entry.pause.id)
            }
            break
          }
          case 'stop': world.executions.finishExecution(executionId, 'stopped', 'stop'); break
          case 'close': world.plans.setLifecycle(planId, 'cancelled'); break
          case 'reopen': world.plans.setLifecycle(planId, 'open'); break
          case 'later': now = new Date(now.getTime() + random() * 3 * HOUR); break
        }
        const items = world.items(now)
        const context = `case ${index} (seed ${SEED + index}) after ${trace.join(' > ')}`
        // Items exist only for open plans.
        if (world.plans.get(planId)!.lifecycle !== 'open') expect(items, context).toEqual([])
        // One target never raises two items; every id is unique.
        const perTarget = items.filter(item => item.kind !== 'plan-hold-overdue').map(item => item.id.split(':').slice(1).join(':'))
        expect(new Set(perTarget).size, context).toBe(perTarget.length)
        expect(new Set(items.map(item => item.id)).size, context).toBe(items.length)
      }
    }
  })
})
