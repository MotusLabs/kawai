// A reply in flight across a team-key move (team-workspace-pages D2) still
// reaches its view: one-shot request results must settle their action.
import { afterEach, describe, expect, test } from 'bun:test'
import { rekeyTeamViewsForTests } from '../stores/teamViewMigration'
import { handleStrategyMessage } from '../protocol/strategyMessages'
import { handleTeamMessage } from '../protocol/teamMessages'
import type { MessageRouterDeps } from '../protocol/types'
import { useStrategyStore } from '../stores/strategyStore'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamAuditStore } from '../stores/teamAuditStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { aliasTeamKey, clearTeamKeyAliases, routedTeamPath } from '../utils/teamKeyAliases'

const deps = {} as MessageRouterDeps

afterEach(() => {
  clearTeamKeyAliases()
  useTeamTaskStore.setState({ views: {} })
  useStrategyStore.setState({ views: {} })
  useTeamPlanStore.setState({ views: {} })
  useTeamAuditStore.setState({ views: {} })
})

describe('routedTeamPath', () => {
  test('a moved key routes to its new key; a live view under the old key wins', () => {
    aliasTeamKey('/repo/wt', '/repo')
    expect(routedTeamPath('/repo/wt', {})).toBe('/repo')
    expect(routedTeamPath('/repo/wt', { '/repo/wt': {} })).toBe('/repo/wt')
    expect(routedTeamPath('/elsewhere', {})).toBe('/elsewhere')
  })

  test('chained moves follow the latest key, and a key moved back is no alias', () => {
    aliasTeamKey('/a', '/b')
    aliasTeamKey('/b', '/c')
    expect(routedTeamPath('/a', {})).toBe('/c')
    expect(routedTeamPath('/b', {})).toBe('/c')
    aliasTeamKey('/c', '/a')
    expect(routedTeamPath('/a', {})).toBe('/a')
    expect(routedTeamPath('/c', {})).toBe('/a')
  })
})

test('the audit view follows the rekey (findings-bee1aa24)', () => {
  useTeamAuditStore.getState().open('/repo/wt')
  rekeyTeamViewsForTests('/repo/wt', '/repo')
  expect(useTeamAuditStore.getState().views['/repo']?.open).toBe(true)
  expect(useTeamAuditStore.getState().views['/repo/wt']).toBeUndefined()
  useTeamAuditStore.setState({ views: {} })
})

test('a task action result sent before a rekey settles under the new key', () => {
  const tasks = useTeamTaskStore.getState()
  tasks.open('/repo/wt')
  tasks.begin('/repo/wt', 'r1', 'note')
  rekeyTeamViewsForTests('/repo/wt', '/repo')
  expect(useTeamTaskStore.getState().views['/repo']!.pending).toEqual({ r1: 'note' })
  handleTeamMessage({ type: 'team-task-result', teamPath: '/repo/wt', requestId: 'r1', error: 'refused' }, deps)
  expect(useTeamTaskStore.getState().views['/repo']).toMatchObject({ pending: {}, error: 'refused' })
})

test('a strategy action result sent before a rekey settles under the new key', () => {
  const strategy = useStrategyStore.getState()
  strategy.open('/repo/wt')
  strategy.begin('/repo/wt', 'r1', 'submit')
  rekeyTeamViewsForTests('/repo/wt', '/repo')
  handleStrategyMessage({ type: 'strategy-result', teamPath: '/repo/wt', requestId: 'r1', error: 'stale' }, deps)
  const view = useStrategyStore.getState().views['/repo']!
  expect(Object.keys(view.pending)).toEqual([])
})

test('the view migration moves the plan views with their team', () => {
  useTeamPlanStore.getState().open('/repo/wt', 'p1')
  rekeyTeamViewsForTests('/repo/wt', '/repo')
  expect(useTeamPlanStore.getState().views['/repo/wt']).toBeUndefined()
  expect(useTeamPlanStore.getState().views['/repo']?.selected).toBe('p1')
})

test('a plan command result sent before a rekey settles under the new key, keeping its selection and armed command', () => {
  const plans = useTeamPlanStore.getState()
  plans.open('/repo/wt', 'p1')
  plans.arm('/repo/wt', 'approve:p1:2')
  const commandId = plans.command('/repo/wt', 'approve:p1:2', 'x', 'r1')
  plans.begin('/repo/wt', 'r1', 'approve')
  rekeyTeamViewsForTests('/repo/wt', '/repo')
  expect(useTeamPlanStore.getState().views['/repo/wt']).toBeUndefined()
  expect(useTeamPlanStore.getState().views['/repo']).toMatchObject({ selected: 'p1', pending: { r1: 'approve' } })
  handleTeamMessage({ type: 'team-plan-result', teamPath: '/repo/wt', requestId: 'r1', error: 'stale' }, deps)
  const view = useTeamPlanStore.getState().views['/repo']!
  expect(view.pending).toEqual({})
  expect(view.error).toBe('stale')
  expect(view.commands['approve:p1:2']).toEqual({ commandId, payload: 'x', refused: true })
})
