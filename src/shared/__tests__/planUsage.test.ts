// Pure plan usage aggregation (plan-supervision D14): ordering of change,
// unlisted-change, and fix rows, and null group/profile rows sorted last.
import { expect, test } from 'bun:test'
import { planUsage, type PlanUsageTurn } from '../planUsage'

const turn = (extra: Partial<PlanUsageTurn>): PlanUsageTurn => ({
  taskId: 'task-a', groupId: 'g', profileId: 'p', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  numTurns: 1, change: 'a', fix: null, ...extra,
})

test('listed changes in order, then unlisted by name, then fix tasks by id', () => {
  const view = planUsage([
    turn({ taskId: 'task-z', change: null, fix: { sourceKind: 'promotion' } }),
    turn({ change: 'zeta' }),
    turn({ change: 'b' }),
    turn({ change: 'alpha' }),
    turn({ change: 'a' }),
    turn({ taskId: 'task-y', change: null, fix: { sourceKind: 'override' } }),
  ], ['b', 'a'])
  expect(view.byChange.map(row => (row.kind === 'fix' ? row.taskId : row.change))).toEqual(['b', 'a', 'alpha', 'zeta', 'task-y', 'task-z'])
})

test('null group and profile sort last; empty input reads zero', () => {
  const view = planUsage([turn({ groupId: null }), turn({ profileId: null }), turn({})])
  expect(view.byGroupProfile.map(row => [row.group, row.profile])).toEqual([['g', 'p'], ['g', null], [null, 'p']])
  expect(planUsage([]).total).toEqual({ turns: 0, steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
})
