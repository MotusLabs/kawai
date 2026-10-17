// The pure planner's scheduling (plan-execution §11.2, the plan-execution
// spec's scheduling scenarios): plan order under the parallel limit, a
// dependent waiting for its landing, a stopped dependency holding its
// dependents while independent work continues, landed work never redone,
// the provision effect due once, and the task-creation dispatch step.
import { describe, expect, test } from 'bun:test'
import type { ChangeState } from '../../shared/planExecution'
import { planSteps } from '../plans/execution/executionPlanner'
import type { ExecutionSnapshot, PlannedChange } from '../plans/execution/executionSnapshot'

const change = (name: string, state: ChangeState, over: Partial<PlannedChange> = {}): PlannedChange => ({
  executionId: 'e1', change: name, state, step: null, generation: 0, taskId: null,
  worktree: null, branch: null, baselineCommit: null, prNumber: null, passedAt: null, dependsOn: [], group: 'devs',
  task: null, round: null, landing: null, ...over,
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
    changes,
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
        row: { ...snapshot([]).executions[0]!.row, maxParallel: 1 }, changes: [change('one', 'waiting'), change('two', 'waiting'), change('done', 'landed')],
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
    expect(due.dispatches).toEqual([{ executionId: 'e1', change: 'api', group: 'devs' }])
    const done = steps([change('api', 'implementing', { taskId: 't1' })])
    expect(done.dispatches).toEqual([])
    const groupless = steps([change('api', 'implementing', { group: null })])
    expect(groupless.dispatches).toEqual([])
  })
})
