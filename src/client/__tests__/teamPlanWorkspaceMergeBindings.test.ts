// The one authoritative team bindings slot (plan-workspace Q1, review B4):
// both read paths — the per-plan workspace snapshot and the team bindings
// push — reconcile into it per role by the CAS version. These tests drive the
// store's own apply actions, so the merge contract holds through both wire
// sources: an absent slot adopts whole, an older version never replaces
// (version floor), an equal version refreshes availability in place, a newer
// version replaces, and the roles are independent.
import { afterEach, describe, expect, test } from 'bun:test'
import type { WorkspaceBindingView, WorkspaceSnapshot } from '@shared/planWorkspace'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { clearTeamKeyAliases } from '../utils/teamKeyAliases'

afterEach(() => {
  useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {} })
  clearTeamKeyAliases()
})

const bind = (role: 'architect' | 'lead', sessionId: string, version: number,
  availability: WorkspaceBindingView['availability'] = 'live'): WorkspaceBindingView =>
  ({ role, sessionId, version, availability, name: sessionId })

const snapshotOf = (bindings: WorkspaceBindingView[]) =>
  ({ type: 'team-plan-workspace-snapshot' as const, teamPath: '/repo', teamId: 't', planId: 'p1',
    workspace: { plan: { id: 'p1', title: 'Plan p1', lifecycle: 'open' as const },
      displayedVersion: { kind: 'revision' as const, revision: 1, status: 'approved' as const,
        contentHash: 'hash-1-0123456789' },
      bindings, references: [] } as WorkspaceSnapshot })

const pushOf = (bindings: WorkspaceBindingView[]) =>
  ({ type: 'team-plan-workspace-bindings' as const, teamPath: '/repo', teamId: 't', bindings })

const seed = (bindings: WorkspaceBindingView[]) => {
  useTeamPlanWorkspaceStore.getState().applyBindings(pushOf(bindings))
}

const slot = (): WorkspaceBindingView[] => useTeamPlanWorkspaceStore.getState().teamBindings['/repo']
const roleIn = (role: 'architect' | 'lead'): WorkspaceBindingView | undefined =>
  slot().find(entry => entry.role === role)

describe('team bindings slot merge (Q1/B4)', () => {
  test('an absent slot adopts a bindings push whole', () => {
    useTeamPlanWorkspaceStore.getState().applyBindings(pushOf([bind('architect', 's-a', 2), bind('lead', 's-l', 1)]))
    expect(slot()).toEqual([bind('architect', 's-a', 2), bind('lead', 's-l', 1)])
  })

  test('an empty slot adopts too', () => {
    seed([])
    useTeamPlanWorkspaceStore.getState().applyBindings(pushOf([bind('architect', 's-a', 1)]))
    expect(roleIn('architect')?.sessionId).toBe('s-a')
  })

  test('a plan snapshot writes the slot even with no open view (the B3 canonical read)', () => {
    useTeamPlanWorkspaceStore.getState().applySnapshot(snapshotOf([bind('architect', 's-a', 2)]))
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']).toBeUndefined()
    expect(roleIn('architect')?.sessionId).toBe('s-a')
  })

  test('an older version is discarded — bindings push', () => {
    seed([bind('architect', 's-a', 3)])
    useTeamPlanWorkspaceStore.getState().applyBindings(pushOf([bind('architect', 's-old', 2)]))
    expect(roleIn('architect')).toEqual(bind('architect', 's-a', 3))
  })

  test('an older version is discarded — plan snapshot', () => {
    seed([bind('architect', 's-a', 3)])
    useTeamPlanWorkspaceStore.getState().applySnapshot(snapshotOf([bind('architect', 's-old', 2)]))
    expect(roleIn('architect')).toEqual(bind('architect', 's-a', 3))
  })

  test('an equal version refreshes availability — bindings push', () => {
    seed([bind('architect', 's-a', 2, 'live')])
    useTeamPlanWorkspaceStore.getState().applyBindings(pushOf([bind('architect', 's-a', 2, 'archived')]))
    expect(roleIn('architect')?.availability).toBe('archived')
  })

  test('an equal version refreshes availability — plan snapshot', () => {
    seed([bind('architect', 's-a', 2, 'archived')])
    useTeamPlanWorkspaceStore.getState().applySnapshot(snapshotOf([bind('architect', 's-a', 2, 'live')]))
    expect(roleIn('architect')?.availability).toBe('live')
  })

  test('a newer version replaces', () => {
    seed([bind('architect', 's-old', 1)])
    useTeamPlanWorkspaceStore.getState().applyBindings(pushOf([bind('architect', 's-new', 2)]))
    expect(roleIn('architect')).toEqual(bind('architect', 's-new', 2))
  })

  test('roles are independent: a newer push for one role keeps the other as-is', () => {
    seed([bind('architect', 's-a', 2), bind('lead', 's-l', 1)])
    useTeamPlanWorkspaceStore.getState().applyBindings(pushOf([bind('architect', 's-a2', 3)]))
    expect(roleIn('lead')).toEqual(bind('lead', 's-l', 1))
    expect(roleIn('architect')).toEqual(bind('architect', 's-a2', 3))
  })

  test('a role absent from the current slot is adopted beside the existing one', () => {
    seed([bind('architect', 's-a', 2)])
    useTeamPlanWorkspaceStore.getState().applyBindings(pushOf([bind('architect', 's-a', 2), bind('lead', 's-l', 1)]))
    expect(roleIn('lead')).toEqual(bind('lead', 's-l', 1))
    expect(roleIn('architect')).toEqual(bind('architect', 's-a', 2))
  })

  test('a role absent from the incoming set stays bound (a partial snapshot never unbinds)', () => {
    seed([bind('architect', 's-a', 2), bind('lead', 's-l', 1)])
    useTeamPlanWorkspaceStore.getState().applySnapshot(snapshotOf([bind('lead', 's-l', 1)]))
    expect(roleIn('architect')).toEqual(bind('architect', 's-a', 2))
  })
})
