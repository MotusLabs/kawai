// The revision-control attention sources (revision-control 9.3, design D13;
// oracles AT1–AT11 and property AP-1 of the design's "Remainder"). The rows
// and the completeness test build each situation in the real stores on a
// fresh test database, read it through the one revision-control reader, and
// project it through the real `ATTENTION_SOURCES`; AP-1 runs seeded command
// sequences over the same seam: one target never raises two items, and items
// exist only for open plans. AT5 once more whole (plan-pause's deadline
// scenario): the composed plan services, a holder whose session is a
// persisted row the pause target links to, the deadline passing on the real
// clock, and `WorkspaceRead.snapshot` — the overdue item rises, and the
// holder's session, row and record alike, is as it was.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { Database } from 'bun:sqlite'
import type { AttentionItem, TeamWorkspaceSnapshot } from '../../shared/teamWorkspace'
import type { FloorMap } from '../../shared/planExecution'
import type { ChatSessionRecord, SessionDatabase } from '../db'
import type { PlanPauseTarget } from '../../shared/planRevisionControl'
import { attentionItems, WorkspaceRead, type AttentionInput } from '../team/workspaceRead'
import { loadGroupCatalog } from '../team/groupCatalog'
import { PlanStore } from '../plans/planStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MemberRelease } from '../team/memberRelease'
import { TeamMailbox } from '../team/TeamMailbox'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { composeExecutionCore, composePlanServices } from '../plans/planComposition'
import { pauseHolderFacts } from '../plans/revisionControl/pauseTick'
import { revisionControlOf } from '../plans/revisionControl/revisionControlServices'
import { inDays, inFlightTarget, settleReceipt, type ComposedStack } from './revisionControlStack'
import { createPlanBench, createPlanWorld, sessionRow, type PlanBench, type PlanWorld } from './planHarness'
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

// --- AT5 whole (plan-pause's deadline scenario): the real workspace read over the composed plan services ---

let live: PlanWorld
let bench: PlanBench
let composed: ReturnType<typeof composePlanServices>
let releases: MemberRelease
/** The `chat_sessions` persistence, as the manager writes a session record through it. */
let sessions: SessionDatabase
/** Every archive the composition's release path asked the manager for. */
const archived: string[] = []
/** The Team page's workspace read over the composed services, for a team whose records are the one given. */
let read: (record: ChatSessionRecord) => TeamWorkspaceSnapshot

/**
 * The construction the server runs — `composePlanServices` over the team services, as
 * revisionControlStack's `composeStack` builds it — with the one difference this file needs:
 * a release archives for real, through the session persistence and the record above it, and
 * says so in `archived`. A double that only refuses would hide a release Kawai should never ask for.
 */
beforeAll(async () => {
  live = await createPlanWorld('kawai-rc-at5-')
  bench = createPlanBench(live)
  sessions = bench.db as SessionDatabase
  const core = composeExecutionCore(bench.db.db), mail = bench.mail
  const teamOf = () => live.team, records = () => bench.records.values(), getSession = (id: string) => bench.records.get(id)
  const tasks = new TaskService(bench.tasks, { getSession, homeDir: live.home, restoreSession: () => undefined, plans: bench.plans, ownership: core.ownership })
  releases = new MemberRelease(bench.db.db, {
    store: mail, tasks: bench.tasks, records, getRecord: getSession, teamOf,
    definition: async () => undefined, cachedDefinition: () => undefined,
    recipient: () => undefined, hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    archive: sessionId => {
      archived.push(sessionId)
      const at = new Date().toISOString()
      sessions.updateChatSession(sessionId, { archivedAt: at })
      const record = bench.records.get(sessionId)
      if (record) bench.records.set(sessionId, { ...record, archivedAt: at })
      return { ok: true }
    },
    notify: () => undefined,
  })
  const caps = new TeamCaps({ homeDir: live.home }), worktrees = new TeamWorktrees()
  const staffing = new WorktreeStaffing(bench.db.db, mail, { records, teamOf, caps, worktrees, spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }) })
  const assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession, records, teamOf, staffing, caps, worktrees, homeDir: live.home, plans: bench.plans, ownership: core.ownership,
  })
  const results = new TaskResultService(tasks, { getSession, assignments, releases, records, homeDir: live.home, ownership: core.ownership, onWrite: id => core.wakes.resultWrite(id) })
  const impact = new ImpactService(new ImpactStore(bench.db.db), { strategies: bench.strategies, plans: bench.plans, mail, getSession })
  composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact, getSession, homeDir: live.home,
    caps: { planExecution: async () => ({ floorChecks: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionCore: core,
    executionTeam: {
      tasks, assignments, results, taskStore: bench.tasks, mailbox: mail, releases,
      teamMailbox: new TeamMailbox(mail, { getSession, homeDir: live.home, tasks: bench.tasks }),
      pendingSpawns: () => [], records,
      identityOf: id => (id === live.team.teamId ? live.team : undefined), teamOfSession: teamOf,
      supervision: { holder: () => null, blocker: () => null, live: () => false },
      // The pause tick's holder facts (revision-control D8) as the manager wires them.
      pauseFacts: pauseHolderFacts({
        getRecord: getSession,
        pendingRequest: () => false, hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
        parkedResumes: id => mail.parkedBy(id).map(row => row.parkedUntil), cooldownUntil: () => null,
      }),
    },
    executionValidation: { prepareStanding: async () => ({}), standing: () => ({ state: 'current', report: { id: 'rep-1', inputHash: 'ih-1', readiness: { carriedConditions: [] } } }) as never },
  })
  bench.service = composed.plans
  await composed.runtime!.start()
  // The Team page's read: the composed PlanService, the real task and mailbox stores, the team's catalog and
  // its records; the manager's other sources (directory, waiting reasons, requests, turn ends, the audit) are empty.
  read = record => new WorkspaceRead({
    plans: composed.plans, tasks, mailbox: { store: mail }, teamRecords: () => [record],
    teams: { catalogForTeam: () => loadGroupCatalog({ groupsRoot: live.team.groupsRoot, homeDir: live.home }) },
    waitingFor: () => ({}), directory: { list: () => [] }, getPendingRequests: () => [],
    groupProfileCounts: () => ({}), teamApprovalDefault: () => null,
    turnEnds: { finishedForTeam: () => [] }, exhaustionEpisodes: () => [],
    outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
  } as never).snapshot(live.team)
})

afterAll(() => {
  composed.runtime?.stop()
  bench.db.close()
  fs.rmSync(live.root, { recursive: true, force: true })
})

describe('AT5 through the real workspace read', () => {
  // @covers: plan-pause › Pausing never resolves a pending request › The pause deadline passes
  test('the overdue item asks the owner to unblock the holder, and the linked holder\'s persisted session is untouched', async () => {
    const holder = 'api-dev', teamId = live.team.teamId
    // `inFlightTarget` reads only its stack's execution store; this file's composition stands in for the rest.
    const { planId, executionId, taskId } = await inFlightTarget(live, bench, { executionStore: composed.executionStore } as unknown as ComposedStack, holder, 'attempt')
    // The holder's session as the manager keeps a spawned member: one persisted row, and the record over it.
    const at = new Date().toISOString()
    const record = sessions.insertChatSession({ ...sessionRow(holder, 'leads', live.feature), name: 'Api dev', createdAt: at, lastActivityAt: at, spawned: true, taskId })
    bench.records.set(holder, record)
    const row = (): unknown => sessions.db.prepare('SELECT * FROM chat_sessions WHERE session_id = ?').get(holder)
    const before = { row: row(), record: structuredClone(record) }
    expect(before.row).toMatchObject({ session_id: holder, archived_at: null, status: 'waiting', task_id: taskId, spawned: 1 })
    // Untouched, the row and the record alike: no archive asked of the manager, and no release left pending.
    const untouched = (): void => {
      expect(row()).toEqual(before.row)
      expect(bench.records.get(holder)).toEqual(before.record)
      expect(archived).toEqual([])
      expect(releases.pendingFor(holder)).toBe(false)
    }
    const runtime = composed.runtime!
    const tick = async (): Promise<void> => { runtime.command(teamId); await runtime.idle() }
    const placed = composed.holds.place(bench.human, {
      planId, scope: 'changes', rationale: 'rethink the direction', deadline: inDays(2), cites: null, commandId: 'at5-hold', changes: ['api'],
    })
    if (!placed.ok || !placed.result) throw new Error(placed.ok ? 'the hold wrote nothing' : placed.message)
    // The service refuses a deadline that is not in the future: the clock itself has to pass this one.
    const deadline = Date.now() + 3000
    const paused = await composed.pauses!.pause(bench.human, { planId, holdId: placed.result.hold.id, deadline: new Date(deadline).toISOString(), commandId: 'at5-pause' })
    if (!paused.ok || !paused.result) throw new Error(paused.ok ? 'the pause wrote nothing' : paused.message)
    const { pause } = paused.result
    const target = (): PlanPauseTarget | null => composed.pauses!.deps.pauses.target(pause.id, 'api')
    // Linked: the instruction's claimant is the target's holder, and the pause mail reached them.
    expect(target()).toMatchObject({ stage: 'attempt', holderSession: holder, pausedAt: null, decision: null })
    settleReceipt(bench, target()!.messageId!, holder)
    await tick()
    // Before the deadline: still Pausing with no checkpoint to finish with, no item, and the holder as they were.
    expect(Date.now()).toBeLessThan(deadline)
    expect(revisionControlOf(composed.plans)!.read(teamId, planId).pauses[0]!.targets[0]).toMatchObject({ holderSession: holder, state: { state: 'pausing', causes: [{ kind: 'no-checkpoint' }] } })
    expect(read(record).attention).toEqual([])
    untouched()
    const held = { target: target(), members: read(record).members, journal: bench.tasks.journal(taskId) }
    expect(held.members.flatMap(group => group.members).map(member => member.sessionId)).toContain(holder)
    await Bun.sleep(Math.max(0, deadline - Date.now()) + 50)
    // Past the deadline the executor's own pause pass runs first, then the Team page's read.
    await tick()
    untouched()
    expect(read(record).attention).toEqual([{
      id: `plan-pause-overdue:${pause.id}:api`, kind: 'plan-pause-overdue',
      cause: expect.stringContaining(`is still Pausing after the pause deadline ${pause.deadline}`) as never,
      owner: { kind: 'human', id: null, label: 'Human' }, impact: {},
      nextAction: 'Unblock the holder, or restart or stop', link: { kind: 'plan', id: planId, planId, change: 'api' }, requiresHuman: true,
    }])
    untouched()
    // Nothing else moved either: the target, the holder's seat among the team's members, the task's journal, the change still in flight.
    expect({ target: target(), members: read(record).members, journal: bench.tasks.journal(taskId) }).toEqual(held)
    expect(composed.executionStore.execution(executionId)!.state).toBe('running')
  })
})
