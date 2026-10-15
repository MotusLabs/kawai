// A reply in flight across a team-key move (team-workspace-pages D2) still
// reaches its view: one-shot request results must settle their action.
import { afterEach, describe, expect, test } from 'bun:test'
import { rekeyTeamViewsForTests } from '../stores/teamViewMigration'
import { handleStrategyMessage } from '../protocol/strategyMessages'
import { handleTeamMessage } from '../protocol/teamMessages'
import type { MessageRouterDeps } from '../protocol/types'
import { useStrategyStore } from '../stores/strategyStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { aliasTeamKey, clearTeamKeyAliases, routedTeamPath } from '../utils/teamKeyAliases'

const deps = {} as MessageRouterDeps

afterEach(() => {
  clearTeamKeyAliases()
  useTeamTaskStore.setState({ views: {} })
  useStrategyStore.setState({ views: {} })
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
