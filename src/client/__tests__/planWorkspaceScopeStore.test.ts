// The captured workspace scope store and the reset-binding transfer helper
// (plan-workspace §6.3/§6.4): a scope is captured once per session and
// replaced only by an equal-or-explicit write, attempts are kept per team
// and bounded, and the transfer helper sends one CAS bind per binding of the
// replaced session — refusing to act at all when no snapshot was ever
// observed, because a blind expectedVersion=null bind could overwrite a
// concurrent replacement.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ClientMessage, ServerMessage } from '@shared/types'
import type { WorkspaceSnapshot, WorkspaceBindingView } from '@shared/planWorkspace'
import {
  pendingContextSends, sameEnvelope, usePlanWorkspaceScopeStore,
  type CapturedWorkspaceScope,
} from '../stores/planWorkspaceScopeStore'
import { transferBindingsOnReset } from '../utils/planWorkspaceResetTransfer'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'

const scope = (planId: string, revision = 1): CapturedWorkspaceScope => ({
  envelope: {
    teamId: 't', planId,
    version: { kind: 'revision', revision, contentHash: `hash-${revision}` },
  },
  planTitle: `Plan ${planId}`,
  capturedAt: '2026-10-24T09:00:00.000Z',
})

const binding = (role: 'architect' | 'lead', sessionId: string, version: number): WorkspaceBindingView => ({
  role, sessionId, version, availability: 'live', name: sessionId,
})

const snapshotMessage = (teamPath: string, bindings: WorkspaceBindingView[]): Extract<ServerMessage, { type: 'team-plan-workspace-snapshot' }> => ({
  type: 'team-plan-workspace-snapshot', teamPath, teamId: 't', planId: 'p1',
  workspace: { plan: { id: 'p1', title: 'Plan p1', lifecycle: 'open' }, displayedVersion: null, bindings, references: [] } as WorkspaceSnapshot,
})

describe('planWorkspaceScopeStore', () => {
  beforeEach(() => {
    usePlanWorkspaceScopeStore.setState({ scopes: {}, attempts: {} })
    pendingContextSends.clear()
    useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {} })
  })

  test('setScope stores per session and drops on null', () => {
    const store = usePlanWorkspaceScopeStore.getState()
    store.setScope('s1', scope('p1'))
    store.setScope('s2', scope('p2'))
    expect(usePlanWorkspaceScopeStore.getState().scopes.s1).toEqual(scope('p1'))
    store.setScope('s1', null)
    expect(usePlanWorkspaceScopeStore.getState().scopes.s1).toBeUndefined()
    expect(usePlanWorkspaceScopeStore.getState().scopes.s2).toEqual(scope('p2'))
  })

  test('an equal envelope is a no-op (a navigation re-capture never refreshes capturedAt)', () => {
    const store = usePlanWorkspaceScopeStore.getState()
    store.setScope('s1', scope('p1'))
    const first = usePlanWorkspaceScopeStore.getState().scopes.s1
    store.setScope('s1', { ...scope('p1'), capturedAt: '2026-10-24T10:00:00.000Z' })
    expect(usePlanWorkspaceScopeStore.getState().scopes.s1).toBe(first)
  })

  test('a differing envelope replaces; a differing plan alone differs', () => {
    const store = usePlanWorkspaceScopeStore.getState()
    store.setScope('s1', scope('p1'))
    store.setScope('s1', scope('p1', 2))
    expect(usePlanWorkspaceScopeStore.getState().scopes.s1?.envelope.version)
      .toEqual({ kind: 'revision', revision: 2, contentHash: 'hash-2' })
  })

  test('sameEnvelope compares by value', () => {
    expect(sameEnvelope(scope('p1').envelope, scope('p1').envelope)).toBe(true)
    expect(sameEnvelope(scope('p1').envelope, scope('p2').envelope)).toBe(false)
  })

  test('recordAttempt appends per team and keeps the newest five', () => {
    const store = usePlanWorkspaceScopeStore.getState()
    for (let index = 0; index < 7; index++) {
      store.recordAttempt('/repo', {
        at: `2026-10-24T09:0${index}:00.000Z`, newSessionId: `n${index}`, previousSessionId: 'old',
        action: { kind: 'skipped-not-bound' },
      })
    }
    const kept = usePlanWorkspaceScopeStore.getState().attempts['/repo']!
    expect(kept).toHaveLength(5)
    expect(kept[0]!.newSessionId).toBe('n2')
    expect(kept[4]!.newSessionId).toBe('n6')
    expect(usePlanWorkspaceScopeStore.getState().attempts['/other']).toBeUndefined()
  })
})

describe('transferBindingsOnReset', () => {
  beforeEach(() => {
    usePlanWorkspaceScopeStore.setState({ scopes: {}, attempts: {} })
    pendingContextSends.clear()
    useTeamPlanWorkspaceStore.setState({ views: {}, teamBindings: {} })
  })

  const observe = (teamPath: string, bindings: WorkspaceBindingView[]) => {
    useTeamPlanWorkspaceStore.getState().open(teamPath, 'p1')
    useTeamPlanWorkspaceStore.getState().applySnapshot(snapshotMessage(teamPath, bindings))
  }

  test('each binding of the replaced session is re-bound by CAS with the last observed version', () => {
    observe('/repo', [binding('architect', 'old', 3), binding('lead', 'lead-session', 1)])
    const sent: ClientMessage[] = []
    transferBindingsOnReset(message => { sent.push(message) }, 'new-chat', 'old')
    const binds = sent.filter(message => message.type === 'team-plan-workspace-bind')
    expect(binds).toHaveLength(1)
    expect(binds[0]).toMatchObject({
      teamPath: '/repo', role: 'architect', sessionId: 'new-chat', expectedVersion: 3,
    })
    const attempts = usePlanWorkspaceScopeStore.getState().attempts['/repo']!
    expect(attempts).toEqual([{
      at: attempts[0]!.at, newSessionId: 'new-chat', previousSessionId: 'old',
      action: { kind: 'sent', role: 'architect', expectedVersion: 3, teamPath: '/repo',
        requestId: expect.any(String) },
    }])
  })

  test('a binding known only through the bindings push — never a plan snapshot — transfers the same (B3)', () => {
    useTeamPlanWorkspaceStore.getState().applyBindings({
      type: 'team-plan-workspace-bindings', teamPath: '/repo', teamId: 't',
      bindings: [binding('architect', 'old', 4)],
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']).toBeUndefined()
    const sent: ClientMessage[] = []
    transferBindingsOnReset(message => { sent.push(message) }, 'new-chat', 'old')
    expect(sent.filter(message => message.type === 'team-plan-workspace-bind'))
      .toMatchObject([{ teamPath: '/repo', role: 'architect', sessionId: 'new-chat', expectedVersion: 4 }])
  })

  test('a session bound as a role in two teams transfers in both', () => {
    observe('/repo', [binding('lead', 'old', 5)])
    observe('/other-repo', [binding('architect', 'old', 2)])
    const sent: ClientMessage[] = []
    transferBindingsOnReset(message => { sent.push(message) }, 'new-chat', 'old')
    const binds = sent.filter(message => message.type === 'team-plan-workspace-bind')
    expect(binds.map(message => [message.teamPath, message.role, message.expectedVersion]).sort())
      .toEqual([['/other-repo', 'architect', 2], ['/repo', 'lead', 5]])
    expect(Object.keys(usePlanWorkspaceScopeStore.getState().attempts).sort())
      .toEqual(['/other-repo', '/repo'])
  })

  test('an unbound reset records skipped-not-bound when bindings were observed', () => {
    observe('/repo', [binding('architect', 'someone-else', 1)])
    const sent: ClientMessage[] = []
    transferBindingsOnReset(message => { sent.push(message) }, 'new-chat', 'old')
    expect(sent).toEqual([])
    expect(usePlanWorkspaceScopeStore.getState().attempts['/repo']).toEqual([{
      at: expect.any(String), newSessionId: 'new-chat', previousSessionId: 'old',
      action: { kind: 'skipped-not-bound' },
    }])
  })

  test('with no observed bindings the helper refuses to act at all', () => {
    const sent: ClientMessage[] = []
    transferBindingsOnReset(message => { sent.push(message) }, 'new-chat', 'old')
    expect(sent).toEqual([])
    const all = Object.values(usePlanWorkspaceScopeStore.getState().attempts).flat()
    expect(all).toEqual([{
      at: expect.any(String), newSessionId: 'new-chat', previousSessionId: 'old',
      action: { kind: 'skipped-unknown', teamPath: '' },
    }])
  })

  test('a view still loading counts as unknown, not as permission', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    const sent: ClientMessage[] = []
    transferBindingsOnReset(message => { sent.push(message) }, 'new-chat', 'old')
    expect(sent).toEqual([])
    const all = Object.values(usePlanWorkspaceScopeStore.getState().attempts).flat()
    expect(all[0]!.action).toEqual({ kind: 'skipped-unknown', teamPath: '' })
  })

  test('pendingContextSends is a plain module map the surface owns', () => {
    pendingContextSends.set('s1', { text: 'hi', scope: scope('p1'), requestId: 'req-1' })
    expect(pendingContextSends.get('s1')!.text).toBe('hi')
    expect(pendingContextSends.get('s1')!.requestId).toBe('req-1')
    pendingContextSends.delete('s1')
    expect(pendingContextSends.has('s1')).toBe(false)
  })
})
