// Protocol dispatch for the plan workspace pushes (plan-workspace §5): the
// server's pushes must reach the store through the real `handleTeamMessage`
// entrypoint, not only through direct store calls — review findings F1 found
// the artifacts enumeration dispatch missing from both routing layers while
// store-level tests kept passing and production stayed on "Loading…" forever.
// Fixture paths name repository shapes as data, never runtime reads —
// declared for the reads guard.
// @reads: docs/**, openspec/**
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ServerMessage } from '@shared/types'
import { handleTeamMessage } from '../protocol/teamMessages'
import { useTeamPlanWorkspaceStore } from '../stores/teamPlanWorkspaceStore'
import { aliasTeamKey, clearTeamKeyAliases } from '../utils/teamKeyAliases'

type ArtifactsPush = Extract<ServerMessage, { type: 'team-plan-workspace-artifacts' }>
type SnapshotPush = Extract<ServerMessage, { type: 'team-plan-workspace-snapshot' }>

const okView = {
  ok: true as const,
  changeName: 'api',
  source: { kind: 'main' as const, worktreeId: '/repo' },
  artifacts: [{ kind: 'proposal' as const, relativePath: 'openspec/changes/api/proposal.md' }],
}

const push = (extra: Partial<ArtifactsPush> = {}): ArtifactsPush => ({
  type: 'team-plan-workspace-artifacts',
  teamPath: '/repo', planId: 'p1', changeName: 'api', view: okView, ...extra,
})

const fire = (message: ServerMessage) => handleTeamMessage(message as never, {} as never)

beforeEach(() => {
  clearTeamKeyAliases()
  useTeamPlanWorkspaceStore.setState({ views: {} })
})

describe('plan workspace protocol dispatch', () => {
  test('an artifacts push through handleTeamMessage lands in the open workspace view', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    fire(push())
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.artifacts.api).toMatchObject({ ok: true })
    // A later push for another change lands under its own key.
    fire(push({ changeName: 'web', view: { ok: false, state: 'missing', message: 'gone' } }))
    const view = useTeamPlanWorkspaceStore.getState().views['/repo']!
    expect(view.artifacts.api).toMatchObject({ ok: true })
    expect(view.artifacts.web).toMatchObject({ ok: false, state: 'missing' })
  })

  test('pushes for another plan or an unopened team change nothing', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    fire(push())
    fire(push({ planId: 'other', view: { ok: false, state: 'uncontained', message: 'wrong plan' } }))
    fire(push({ teamPath: '/elsewhere', changeName: 'web', view: { ok: false, state: 'missing', message: 'wrong team' } }))
    const view = useTeamPlanWorkspaceStore.getState().views['/repo']!
    expect(view.artifacts.api).toMatchObject({ ok: true })
    expect(view.artifacts.web).toBeUndefined()
    expect(useTeamPlanWorkspaceStore.getState().views['/elsewhere']).toBeUndefined()
  })

  test('a push under a moved team key routes to the new view', () => {
    useTeamPlanWorkspaceStore.getState().open('/old', 'p1')
    useTeamPlanWorkspaceStore.getState().rekey('/old', '/new')
    aliasTeamKey('/old', '/new')
    fire(push({ teamPath: '/old' }))
    expect(useTeamPlanWorkspaceStore.getState().views['/new']?.artifacts.api).toMatchObject({ ok: true })
    expect(useTeamPlanWorkspaceStore.getState().views['/old']).toBeUndefined()
  })

  test('the snapshot sibling still routes through the same entrypoint', () => {
    useTeamPlanWorkspaceStore.getState().open('/repo', 'p1')
    fire({
      type: 'team-plan-workspace-snapshot', teamPath: '/repo', teamId: 't', planId: 'p1',
      workspace: { plan: { id: 'p1', title: 'Wave', lifecycle: 'open' }, displayedVersion: null, bindings: [], references: [] },
    } as SnapshotPush)
    expect(useTeamPlanWorkspaceStore.getState().views['/repo']?.snapshot?.plan.id).toBe('p1')
  })
})
