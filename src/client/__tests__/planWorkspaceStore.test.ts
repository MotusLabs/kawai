// The plan workspace store (plan-workspace §5): authoritative snapshots
// keyed by team and plan, composed checklists and documents by their
// subscription keys, keyed command results, and the client-local view state
// that survives tab switches.
// Fixture paths name repository shapes as data, never runtime reads —
// declared for the reads guard.
// @reads: docs/**, openspec/**
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
  useTeamPlanWorkspaceStore.setState({ views: {}, retained: {} })
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

  test('an artifact enumeration lands by change name; other plans and teams are dropped', () => {
    const store = useTeamPlanWorkspaceStore.getState()
    store.open('/repo', 'p1')
    store.applyArtifacts({
      type: 'team-plan-workspace-artifacts', teamPath: '/repo', planId: 'p1', changeName: 'api',
      view: {
        ok: true, changeName: 'api', source: { kind: 'main', worktreeId: '/repo' },
        artifacts: [{ kind: 'proposal', relativePath: 'openspec/changes/api/proposal.md' }],
      },
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.artifacts.api).toMatchObject({ ok: true })
    // A late push for another change lands under its own key and never
    // overwrites the selected change's enumeration.
    store.applyArtifacts({
      type: 'team-plan-workspace-artifacts', teamPath: '/repo', planId: 'p1', changeName: 'web',
      view: { ok: false, state: 'missing', message: 'stale' },
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.artifacts.api).toMatchObject({ ok: true })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.artifacts.web).toMatchObject({ ok: false })
    // Another plan's enumeration is dropped; so is another team's.
    store.applyArtifacts({
      type: 'team-plan-workspace-artifacts', teamPath: '/repo', planId: 'other', changeName: 'api',
      view: { ok: false, state: 'missing', message: 'x' },
    })
    store.applyArtifacts({
      type: 'team-plan-workspace-artifacts', teamPath: '/elsewhere', planId: 'p1', changeName: 'api',
      view: { ok: false, state: 'missing', message: 'x' },
    })
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.artifacts.api).toMatchObject({ ok: true })
    // Selecting another plan resets the view, enumerations included.
    store.open('/repo', 'p2')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.artifacts).toEqual({})
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

describe('roles, panes, and the url notice (plan-workspace 7.1-7.2)', () => {
  beforeEach(() => {
    useTeamPlanWorkspaceStore.setState({ views: {}, roles: {}, panes: {}, retained: {} })
  })

  test('the role is per-team, defaults to Architect, and survives a plan switch', () => {
    const store = useTeamPlanWorkspaceStore.getState()
    expect(store.roles['/repo']).toBeUndefined()
    store.setRole('/repo', 'lead')
    store.setRole('/other', 'architect')
    expect(useTeamPlanWorkspaceStore.getState().roles).toEqual({ '/repo': 'lead', '/other': 'architect' })
    // A same-role write is a no-op (no re-render churn).
    store.setRole('/repo', 'lead')
    expect(useTeamPlanWorkspaceStore.getState().roles['/repo']).toBe('lead')
    // rekey moves the role with the team.
    useTeamPlanWorkspaceStore.getState().rekey('/repo', '/moved')
    expect(useTeamPlanWorkspaceStore.getState().roles).toEqual({ '/moved': 'lead', '/other': 'architect' })
  })

  test('pane sizing clamps to its bounds and defaults fill the gaps', () => {
    const store = useTeamPlanWorkspaceStore.getState()
    store.setReaderFraction('/repo', 0.9)
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.readerFraction).toBe(0.7)
    store.setReaderFraction('/repo', 0.01)
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.readerFraction).toBe(0.15)
    store.setReaderFraction('/repo', 0.51)
    store.setNarrowPane('/repo', 'documents')
    store.setExpandedPane('/repo', 'reader')
    store.setConversationOpen('/repo', false)
    const panes = useTeamPlanWorkspaceStore.getState().panes['/repo']!
    expect(panes.readerFraction).toBe(0.51)
    expect(panes.narrowPane).toBe('documents')
    expect(panes.expandedPane).toBe('reader')
    expect(panes.conversationOpen).toBe(false)
    // rekey moves the panes too; a team with no entry stays default-shaped.
    useTeamPlanWorkspaceStore.getState().rekey('/repo', '/moved')
    expect(useTeamPlanWorkspaceStore.getState().panes['/moved']?.readerFraction).toBe(0.51)
    expect(useTeamPlanWorkspaceStore.getState().panes['/moved']?.narrowPane).toBe('documents')
  })

  test('the url notice rides the view: written, cleared, and reset with the plan', () => {
    const store = useTeamPlanWorkspaceStore.getState()
    store.open('/repo', 'p1')
    store.setUrlNotice('/repo', 'Link names revision 9 — showing the default version.')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.urlNotice).toContain('revision 9')
    store.setUrlNotice('/repo', null)
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.urlNotice).toBeNull()
    // A team with no view writes nothing and throws nothing.
    store.setUrlNotice('/ghost', 'boo')
    expect(useTeamPlanWorkspaceStore.getState().views['/ghost']).toBeUndefined()
  })
})

describe('plan-scoped retention (plan-workspace 7.1 r2)', () => {
  test('a switch retains each plan’s view state; B never sees A’s, and A→B→A restores A', () => {
    const store = useTeamPlanWorkspaceStore.getState()
    store.open('/repo', 'pA')
    store.toggleExpanded('/repo', 'a')
    store.setFilter('/repo', 'active')
    store.selectChange('/repo', 'chg-1')
    store.openDocument('/repo', { worktreeId: '/repo', relativePath: 'docs/a.md' })
    store.setExpandedPane('/repo', 'reader')
    // Plan B was never visited: a fresh view, and never A's pane expansion.
    store.open('/repo', 'pB')
    const fresh = useTeamPlanWorkspaceStore.getState().views['/repo']!
    expect(fresh.planId).toBe('pB')
    expect(fresh.expanded).toEqual([])
    expect(fresh.filter).toBe('all')
    expect(fresh.selectedChange).toBeNull()
    expect(fresh.selectedDocument).toBeNull()
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.expandedPane).toBeNull()
    // B's own state is kept apart from A's.
    store.toggleExpanded('/repo', 'b')
    // Returning to A restores exactly what A had.
    store.open('/repo', 'pA')
    const restored = useTeamPlanWorkspaceStore.getState().views['/repo']!
    expect(restored.expanded).toEqual(['a'])
    expect(restored.filter).toBe('active')
    expect(restored.selectedChange).toBe('chg-1')
    expect(restored.selectedDocument).toEqual({ worktreeId: '/repo', relativePath: 'docs/a.md' })
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.expandedPane).toBe('reader')
    // And B resumes its own state, still without A's.
    store.open('/repo', 'pB')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.expanded).toEqual(['b'])
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.expandedPane).toBeNull()
  })

  test('closing the tab retains the view; reopening the same plan resumes it', () => {
    const store = useTeamPlanWorkspaceStore.getState()
    store.open('/repo', 'p1')
    store.toggleExpanded('/repo', 'a')
    store.selectChange('/repo', 'chg-9')
    store.setExpandedPane('/repo', 'conversation')
    store.close('/repo')
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']).toBeUndefined()
    expect(useTeamPlanWorkspaceStore.getState().retained['/repo\0p1']).toBeDefined()
    store.open('/repo', 'p1')
    const view = useTeamPlanWorkspaceStore.getState().views['/repo']!
    expect(view.expanded).toEqual(['a'])
    expect(view.selectedChange).toBe('chg-9')
    expect(useTeamPlanWorkspaceStore.getState().panes['/repo']?.expandedPane).toBe('conversation')
  })

  test('rekey moves the retained state with the team', () => {
    const store = useTeamPlanWorkspaceStore.getState()
    store.open('/old', 'p1')
    store.toggleExpanded('/old', 'x')
    store.close('/old')
    store.rekey('/old', '/new')
    expect(useTeamPlanWorkspaceStore.getState().retained['/old\0p1']).toBeUndefined()
    store.open('/new', 'p1')
    expect(useTeamPlanWorkspaceStore.getState().views['/new']?.expanded).toEqual(['x'])
  })
})
