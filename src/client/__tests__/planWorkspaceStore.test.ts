// The plan workspace store (plan-workspace §5): authoritative snapshots
// keyed by team and plan, composed checklists and documents by their
// subscription keys, keyed command results, and the client-local view state
// that survives tab switches.
// Fixture paths name repository shapes as data, never runtime reads.
// @reads: docs/**
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  useTeamPlanWorkspaceStore, documentKey,
} from '../stores/teamPlanWorkspaceStore'
import type { WorkspaceSnapshot } from '@shared/planWorkspace'

const snapshot = (extra: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  plan: { id: 'p1', title: 'Wave', lifecycle: 'open' },
  displayedVersion: null,
  bindings: [],
  references: [],
  ...extra,
} as WorkspaceSnapshot)

const snapshotMessage = (extra: { teamPath?: string; planId?: string } = {}) => ({
  type: 'team-plan-workspace-snapshot' as const,
  teamPath: '/repo',
  teamId: 't',
  planId: 'p1',
  workspace: snapshot(),
  ...extra,
})

beforeEach(() => {
  useTeamPlanWorkspaceStore.setState({ views: {} })
})

describe('open and close', () => {
  test('open creates the plan view and resets it when another plan is selected', () => {
    const store = useTeamPlanWorkspaceStore.getState()
    store.open('/repo', 'p1')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.planId).toBe('p1')
    // State survives a same-plan re-open (tab switches).
    useTeamPlanWorkspaceStore.getState().selectChange('/repo', 'a')
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.selectedChange).toBe('a')
    // Another plan resets the view whole.
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p2')
    const view = useTeamPlanWorkspaceStore.getState().views['/repo']!
    expect(view.planId).toBe('p2')
    expect(view.selectedChange).toBeNull()
  })

  test('close drops the view; unmount keeps it (no close call)', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    useTeamPlanWorkspaceStore.getState().close('/repo')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']).toBeUndefined()
  })

  test('rekey moves the view when the repository moved', () => {
    useTeamPlanWorkspaceStore.getState().open('/old', 'p1')
    useTeamPlanWorkspaceStore.getState().rekey('/old', '/new')
    expect(useTeamPlanWorkspaceStore.getState().views['/new']?.planId).toBe('p1')
    expect(useTeamPlanWorkspaceStore.getState().views['/old']).toBeUndefined()
  })
})

describe('pushes', () => {
  test('a snapshot for the open plan replaces state whole; another plan is dropped', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    useTeamPlanWorkspaceStore.getState().applySnapshot(snapshotMessage())
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.snapshot?.plan.id).toBe('p1')
    // Another plan's push is dropped whole — even with different content.
    useTeamPlanWorkspaceStore.getState().applySnapshot({
      ...snapshotMessage(), planId: 'other',
      workspace: snapshot({ plan: { id: 'other', title: 'X', lifecycle: 'open' } }),
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.snapshot?.plan.id).toBe('p1')
    // A closed or moved team's push is dropped.
    useTeamPlanWorkspaceStore.getState().applySnapshot({ ...snapshotMessage(), teamPath: '/elsewhere' })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.snapshot?.plan.id).toBe('p1')
  })

  test('a checklist lands by change name; a document by worktree and path', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    useTeamPlanWorkspaceStore.getState().applyChecklist({
      type: 'team-plan-workspace-checklist', teamPath: '/repo', planId: 'p1', changeName: 'api',
      checklist: { sourceHash: 'h', sections: [] }, unavailable: null,
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.checklists.api?.checklist?.sourceHash).toBe('h')
    const view = {
      worktreeId: '/repo', relativePath: 'docs/architecture.md', kind: 'markdown' as const,
      availability: 'current' as const, stale: false, reason: null, executionMatch: 'unknown' as const,
      executionId: null, contentHash: 'abc', size: 10, mtimeMs: 1, text: '# hi',
    }
    useTeamPlanWorkspaceStore.getState().applyDocument({
      type: 'team-plan-workspace-document', teamPath: '/repo', planId: 'p1',
      worktreeId: '/repo', relativePath: 'docs/architecture.md', view,
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.documents[documentKey({ worktreeId: '/repo', relativePath: 'docs/architecture.md' })]?.text).toBe('# hi')
  })
})

describe('commands', () => {
  test('a result settles its request; a refusal names the error; unknown requests are dropped', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    useTeamPlanWorkspaceStore.getState().begin('/repo', 'r1', 'ref-add')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.pending.r1).toBe('ref-add')
    useTeamPlanWorkspaceStore.getState().applyResult({
      type: 'team-plan-workspace-result', teamPath: '/repo', requestId: 'r1', removedRefId: 'x', replayed: false,
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.pending.r1).toBeUndefined()
    useTeamPlanWorkspaceStore.getState().begin('/repo', 'r2', 'bind')
    useTeamPlanWorkspaceStore.getState().applyResult({
      type: 'team-plan-workspace-result', teamPath: '/repo', requestId: 'r2', error: 'Session not found in this team: nope',
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.error).toContain('not found')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.pending.r2).toBeUndefined()
    // A late duplicate settles nothing.
    useTeamPlanWorkspaceStore.getState().applyResult({
      type: 'team-plan-workspace-result', teamPath: '/repo', requestId: 'ghost', error: 'late',
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.error).not.toContain('late')
  })

  test('reconnect clears pending commands without inventing results', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    useTeamPlanWorkspaceStore.getState().begin('/repo', 'r1', 'ref-remove')
    useTeamPlanWorkspaceStore.getState().reconnected('/repo')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.pending).toEqual({})
  })
})

describe('view state', () => {
  test('expansion toggles, selection, document, and filter live client-side', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    const store = useTeamPlanWorkspaceStore.getState()
    store.toggleExpanded('/repo', 'api')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.expanded).toEqual(['api'])
    store.toggleExpanded('/repo', 'api')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.expanded).toEqual([])
    store.selectChange('/repo', 'api')
    store.openDocument('/repo', { worktreeId: '/repo', relativePath: 'docs/architecture.md' })
    store.setFilter('/repo', 'blocked')
    const view = useTeamPlanWorkspaceStore.getState().views['/repo']!
    expect(view.selectedChange).toBe('api')
    expect(view.selectedDocument).toEqual({ worktreeId: '/repo', relativePath: 'docs/architecture.md' })
    expect(view.filter).toBe('blocked')
  })
})
