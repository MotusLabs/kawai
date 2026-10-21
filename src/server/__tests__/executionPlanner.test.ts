// The pure planner's scheduling (plan-execution §11.2, the plan-execution
// spec's scheduling scenarios): plan order under the parallel limit, a
// dependent waiting for its landing, a stopped dependency holding its
// dependents while independent work continues, landed work never redone,
// the provision effect due once, and the task-creation dispatch step.
import { describe, expect, test } from 'bun:test'
import type { ChangeState } from '../../shared/planExecution'
import type { ActiveHold } from '../../shared/planRevisionControl'
import { planSteps } from '../plans/execution/executionPlanner'
import type { EffectRow, RoundRow } from '../plans/execution/executionRows'
import type { ExecutionSnapshot, PlannedChange } from '../plans/execution/executionSnapshot'
import type { PlannedStage } from '../plans/execution/executionPlanner'

const change = (name: string, state: ChangeState, over: Partial<PlannedChange> = {}): PlannedChange => ({
  executionId: 'e1', change: name, state, step: null, generation: 0, taskId: null,
  worktree: null, branch: null, baselineCommit: null, prNumber: null, passedAt: null, dependsOn: [], group: 'devs',
  task: null, round: null, newestAttempt: null, landing: null, landingEffect: null, roundEffects: [], ...over,
})

const withTask = (state: ChangeState, task: Partial<NonNullable<PlannedChange['task']>>, over: Partial<PlannedChange> = {}): PlannedChange =>
  change('api', state, { taskId: 't1', ...over, task: { status: 'active', revision: 1, results: [], assignment: null, ...task } })

const snapshot = (changes: PlannedChange[], over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot => ({
  teamId: 'team', main: '/repo',
  executions: [{
    row: {
      id: 'e1', teamId: 'team', planId: 'p1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
      maxParallel: 1, mergeMethod: 'merge', state: 'running', outcome: null, stopReason: null, startedAt: '', finishedAt: null,
    },
    changes, finished: false, holds: [], openTargets: [],
  }],
  effects: [], attempts: new Map(), ...over,
})

const steps = (changes: PlannedChange[], over: Partial<ExecutionSnapshot> = {}) => planSteps(snapshot(changes, over), '2026-10-17T00:00:00.000Z')

describe('planSteps scheduling (§11.2)', () => {
  test('a dependent waits for the landing of its dependency', () => {
    const result = steps([
      change('api', 'landed'),
      change('web', 'waiting', { dependsOn: ['api'] }),
      change('late', 'waiting', { dependsOn: ['web'] }),
    ])
    // api landed; web's dependency landed so web schedules; late waits on web.
    expect(result.transitions).toEqual([
      { executionId: 'e1', change: 'web', guard: { state: 'waiting', generation: 0 }, patch: { state: 'provisioning' } },
    ])
  })

  test('the parallel limit holds ready changes back; landed work is not redone', () => {
    const result = steps([change('one', 'waiting'), change('two', 'waiting'), change('done', 'landed')], {
      executions: [{
        row: { ...snapshot([]).executions[0]!.row, maxParallel: 1 }, changes: [change('one', 'waiting'), change('two', 'waiting'), change('done', 'landed')], finished: false, holds: [], openTargets: [],
      }],
    })
    expect(result.transitions.map(step => step.change)).toEqual(['one'])
  })

  test('in-progress work counts against the limit', () => {
    const result = steps([change('busy', 'implementing', { taskId: 't1' }), change('next', 'waiting')])
    expect(result.transitions).toEqual([])
  })

  test('a stopped dependency holds its dependents; independent work continues', () => {
    const result = steps([
      change('api', 'stopped'),
      change('web', 'waiting', { dependsOn: ['api'] }),
      change('cli', 'waiting'),
    ])
    expect(result.transitions.map(step => step.change)).toEqual(['cli'])
  })

  test('a cancelled dependency also holds its dependents', () => {
    const result = steps([change('api', 'cancelled'), change('web', 'waiting', { dependsOn: ['api'] })])
    expect(result.transitions).toEqual([])
  })

  test('plan order: the earliest eligible change in content order goes first', () => {
    const result = steps([change('b', 'waiting'), change('a', 'waiting')])
    expect(result.transitions.map(step => step.change)).toEqual(['b'])
  })

  test('a provisioning change gets one provision effect, keyed by attempt and generation', () => {
    const result = steps([change('api', 'provisioning', { generation: 2 })], { attempts: new Map([['e1:api', 1]]) })
    expect(result.effects).toEqual([{
      executionId: 'e1', change: 'api', kind: 'provision', effectKey: 'e1:api:provision:2:2',
      command: {
        repo: '/repo', path: '/repo/.worktrees/api', branch: 'api',
        base: 'base', baseBranch: 'master', planId: 'p1',
      },
    }])
    // A standing effect under the same key means none is due.
    const standing = planSteps(snapshot([change('api', 'provisioning', { generation: 2 })], {
      attempts: new Map([['e1:api', 1]]),
      effects: [{ id: 'f1', executionId: 'e1', change: 'api', roundId: null, kind: 'provision', effectKey: 'e1:api:provision:2:2', command: {}, state: 'pending', tries: 0, nextAt: null, outcome: null, error: null, createdAt: '', startedAt: null, finishedAt: null }],
    }), 'now')
    expect(standing.effects).toEqual([])
  })

  test('an implementing change without a task gets its dispatch step; with one, nothing', () => {
    const due = steps([change('api', 'implementing')])
    expect(due.dispatches).toEqual([{ executionId: 'e1', change: 'api', group: 'devs', kind: 'implement' }])
    const done = steps([change('api', 'implementing', { taskId: 't1' })])
    expect(done.dispatches).toEqual([])
    const groupless = steps([change('api', 'implementing', { group: null })])
    expect(groupless.dispatches).toEqual([])
  })

  test('a closed task stops its change as task-closed, even when the close dead-lettered the instruction', () => {
    const failed = { id: 'a1', state: 'failed', reason: 'task-closed', requestKey: null }
    const closed = steps([withTask('implementing', { status: 'cancelled', assignment: failed })])
    expect(closed.transitions).toMatchObject([{ change: 'api', patch: { state: 'stopped', stopReason: 'task-closed', stopDetail: { resumeState: 'implementing' } } }])
    // An open task whose instruction failed stops as instruction-failed.
    const open = steps([withTask('implementing', { status: 'active', assignment: failed })])
    expect(open.transitions).toMatchObject([{ change: 'api', patch: { state: 'stopped', stopReason: 'instruction-failed', stopDetail: { resumeState: 'implementing' } } }])
  })
})

describe('the resumed landing windows (A2\'s fallback; effect lifecycle)', () => {
  const round = (): RoundRow => ({
    id: 'r1', executionId: 'e1', change: 'api', attemptId: 'a1', number: 1, resultId: 'res-1', commitSha: 'c1',
    fixRound: false, carriedFrom: null, pushedAt: 't', ciWindowFrom: null, ci: null, rerunAt: null,
    reviewAssignmentId: null, verdictFindingsId: null, extra: null, outcome: 'pass', decidedAt: 't',
  })
  const effect = (over: Partial<EffectRow>): EffectRow => ({
    id: 'fx1', executionId: 'e1', change: 'api', roundId: 'r1', kind: 'merge', effectKey: 'k', command: {},
    state: 'done', tries: 0, nextAt: null, outcome: { merged: true }, error: null, createdAt: '', startedAt: null, finishedAt: null, ...over,
  })
  const resumed = (landingEffect: EffectRow | null, over: Partial<PlannedChange> = {}): PlannedChange =>
    change('api', 'gating', {
      step: 'awaiting-slot', taskId: 't1', passedAt: 't', round: round(), landingEffect,
      task: { status: 'active', revision: 1, results: [], assignment: null }, ...over,
    })
  const verdict = (result: ReturnType<typeof planSteps>): PlannedStage | undefined =>
    result.stages.find(stage => stage.kind === 'landing-outcome')

  test('a live row plans nothing until it settles (I-A); a pending one waits for the slot', () => {
    for (const state of ['running', 'unknown'] as const) {
      const result = steps([resumed(effect({ state }))])
      expect(verdict(result)).toBeUndefined()
      expect(result.stages).toEqual([])
    }
    const pending = steps([resumed(effect({ state: 'pending' }))])
    expect(verdict(pending)).toBeUndefined()
    // The passed round's landing stage plans, waits for the slot, and the
    // stage adopts the queued row (A1) when it re-enters.
    expect(pending.stages.map(stage => stage.kind)).toEqual(['landing'])
  })

  test('a done verdict of any landing kind is applied, a refused merge included', () => {
    expect(verdict(steps([resumed(effect({}))]))).toMatchObject({ change: 'api', effectId: 'fx1' })
    expect(verdict(steps([resumed(effect({ outcome: { merged: false, baseMoved: true } }))]))).toMatchObject({ effectId: 'fx1' })
    expect(verdict(steps([resumed(effect({ kind: 'fast-forward', outcome: { fastForwarded: false, refused: true, head: 'h' } }))]))).toMatchObject({ effectId: 'fx1' })
    expect(verdict(steps([resumed(effect({ kind: 'update-branch', outcome: { requested: true } }))]))).toMatchObject({ effectId: 'fx1' })
  })

  test('a failed row is applied only when its outcome carries a stop verdict', () => {
    expect(verdict(steps([resumed(effect({ state: 'failed', outcome: { stop: 'pr-closed', detail: { message: 'closed' } }, error: 'stopped as pr-closed' }))]))).toMatchObject({ effectId: 'fx1' })
    const plainly = steps([resumed(effect({ state: 'failed', outcome: null, error: 'rejected' }))])
    expect(verdict(plainly)).toBeUndefined()
  })

  test('the window needs the effect of the change\'s current round', () => {
    expect(verdict(steps([resumed(effect({ roundId: 'r0' }))]))).toBeUndefined()
    // No landing effect at all: an ordinary waiting change — the passed
    // round's landing stage plans.
    expect(steps([resumed(null)]).stages.map(stage => stage.kind)).toEqual(['landing'])
  })

  test('no newer result supersedes the round while the resumed row stands', () => {
    const withNewer = steps([resumed(effect({ state: 'pending' }), {
      task: { status: 'active', revision: 1, results: [{ id: 'res-2', commit: 'c2', taskRevision: 1, submittedBySession: null }], assignment: null },
    })])
    expect(withNewer.stages.filter(stage => stage.kind === 'result')).toEqual([])
  })

  test('a verdict that settled behind an up-to-date step is applied: a merged merge, a moved update', () => {
    const drifted = (kind: EffectRow['kind'], outcome: unknown): PlannedChange =>
      change('api', 'landing', {
        step: 'up-to-date', taskId: 't1', passedAt: 't', round: round(),
        landingEffect: effect({ kind, outcome }),
        task: { status: 'active', revision: 1, results: [], assignment: null },
      })
    expect(verdict(steps([drifted('merge', { merged: true })]))).toMatchObject({ effectId: 'fx1' })
    expect(verdict(steps([drifted('update-branch', { requested: true, moved: true })]))).toMatchObject({ effectId: 'fx1' })
    // A refused merge re-runs the stage from the up-to-date step instead.
    const refused = steps([drifted('merge', { merged: false })])
    expect(verdict(refused)).toBeUndefined()
    expect(refused.stages.map(stage => stage.kind)).toEqual(['landing'])
  })
})
// Appended to src/server/__tests__/executionPlanner.test.ts (commit 2):
// the hold gate in the pure planner (revision-control 3.2).

describe('planSteps under holds (revision-control 3.2)', () => {
  const hold = (name: string): ActiveHold => ({ id: `h-${name}`, scope: 'changes', changes: [name] })
  const planHold: ActiveHold[] = [{ id: 'h-plan', scope: 'plan', changes: [] }]
  const withHolds = (changes: PlannedChange[], holds: ActiveHold[]) =>
    steps(changes, { executions: [{ ...snapshot(changes).executions[0]!, changes, holds, openTargets: [] }] })

  test("a held change's provisioning transition and provision effect are withheld, whole-plan or by change", () => {
    expect(withHolds([change('api', 'waiting')], [hold('api')]).transitions).toEqual([])
    expect(withHolds([change('api', 'waiting')], planHold).transitions).toEqual([])
    expect(withHolds([change('api', 'provisioning')], [hold('api')]).effects).toEqual([])
    expect(withHolds([change('api', 'provisioning')], planHold).effects).toEqual([])
  })

  test("a held change's implement dispatch and redispatch stage are withheld", () => {
    expect(withHolds([change('api', 'implementing')], [hold('api')]).dispatches).toEqual([])
    const retry = withHolds([change('api', 'implementing', { taskId: 't1', step: 'redispatch' })], [hold('api')])
    expect(retry.stages).toEqual([])
    // The redispatch stage of an unheld change still plans.
    const free = steps([change('api', 'implementing', { taskId: 't1', step: 'redispatch' })])
    expect(free.stages.map(stage => stage.kind)).toEqual(['redispatch'])
  })

  test("a failed round's fix decision still plans under a hold; the owed fix dispatches once released", () => {
    // The failed round is a decision: the fixes entry is emitted however the gate reads.
    const gating = withTask('gating', {
      assignment: { id: 'a1', state: 'delivered', reason: null, requestKey: 'exec:e1:api:attempt:1:0' },
      results: [{ id: 'r1', commit: 'c1', taskRevision: 1, submittedBySession: 'dev' }],
    }, { round: { id: 'round-1', executionId: 'e1', change: 'api', number: 1, attemptId: 'at1', resultId: 'r1', commitSha: 'c1', fixRound: false, pushedAt: 't', outcome: 'fail' } as unknown as PlannedChange['round'] })
    expect(withHolds([gating], [hold('api')]).fixes.map(fix => fix.change)).toEqual(['api'])
    // The owed marker: the newest attempt is a fix whose handoff never
    // dispatched (the assignment still carries the implement attempt's key).
    const owed = withTask('implementing', { assignment: { id: 'a1', state: 'delivered', reason: null, requestKey: 'exec:e1:api:attempt:1:0' } }, { newestAttempt: { number: 2, kind: 'fix' } })
    expect(withHolds([owed], [hold('api')]).dispatches).toEqual([])
    expect(withHolds([owed], []).dispatches).toEqual([{ executionId: 'e1', change: 'api', group: 'devs', kind: 'fix' }])
    // Already dispatched: the assignment carries the fix attempt's key, nothing is owed.
    const done = withTask('implementing', { assignment: { id: 'a2', state: 'delivered', reason: null, requestKey: 'exec:e1:api:attempt:2:1' } }, { newestAttempt: { number: 2, kind: 'fix' } })
    expect(withHolds([done], []).dispatches).toEqual([])
  })

  test('a changes hold leaves an unheld sibling advancing', () => {
    const result = withHolds([change('api', 'waiting'), change('web', 'waiting')], [hold('api')])
    expect(result.transitions.map(step => step.change)).toEqual(['web'])
  })
})
